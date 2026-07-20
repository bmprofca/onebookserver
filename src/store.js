import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuid } from 'uuid';
import { getDocument, getPool, initDb, setDocument } from './db.js';
const __dirname = dirname(fileURLToPath(import.meta.url));
export const dataDir = join(__dirname, '..', 'data');
const shopFile = join(dataDir, 'shop.json');
const authFile = join(dataDir, 'auth.json');
export const DEFAULT_CASH_ACCOUNT_ID = 'cash-default';
export const DEFAULT_ACTION_CONFIRM_CODE = '123456';
/** Per-shop edit/delete confirmation codes (not sent to clients). */
const shopActionCodes = new Map();
export function getActionConfirmCode(appId) {
    return shopActionCodes.get(appId) || DEFAULT_ACTION_CONFIRM_CODE;
}
export function setActionConfirmCode(appId, code) {
    const normalized = String(code || '')
        .replace(/\D/g, '')
        .slice(0, 6);
    shopActionCodes.set(appId, normalized || DEFAULT_ACTION_CONFIRM_CODE);
}
const SHOP_DOC = 'shop_state';
const AUTH_DOC = 'auth_store';
/** In-memory caches (source of truth synced to MySQL tables). */
let authCache = null;
/** Keyed by shop appId — supports many shopkeepers / shops. */
const shopCaches = new Map();
/** Draft shop for a shopkeeper who has not finished setup (keyed by owner user id). */
const draftByOwner = new Map();
let persistChain = Promise.resolve();
function generateAppId() {
    const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
    return `SHOP-${part()}-${part()}`;
}
/**
 * Double-entry: each tx can move cash/bank and customer due in opposite directions.
 * Receive → Cash ↑ · Customer due ↓
 * Pay → Cash ↓ · Customer due ↑
 * Credit sale → Customer due ↑ · Cash unchanged
 * Cash sale → Cash ↑ · no customer
 * Credit purchase → Party due ↓ · Cash unchanged
 * Cash purchase → Cash ↓ · no party
 */
export function cashEffect(tx) {
    if (tx.category === 'adjustment')
        return 0;
    if (!tx.cashAccountId)
        return 0;
    if (tx.category === 'sales')
        return tx.amount;
    if (tx.category === 'purchase')
        return -tx.amount;
    return tx.type === 'receipt' ? tx.amount : -tx.amount;
}
export function customerEffect(tx) {
    return tx.type === 'receipt' ? -tx.amount : tx.amount;
}
export function calcTotals(openingBalance, transactions) {
    const totalReceipts = transactions
        .filter((t) => t.type === 'receipt')
        .reduce((sum, t) => sum + t.amount, 0);
    const totalPayments = transactions
        .filter((t) => t.type === 'payment')
        .reduce((sum, t) => sum + t.amount, 0);
    return {
        totalReceipts,
        totalPayments,
        // Customer / receivable ledger: Out = + due, In = − due
        liveBalance: openingBalance + totalPayments - totalReceipts,
    };
}
export function calcAccountBalance(account, transactions) {
    const txs = transactions.filter((t) => t.cashAccountId === account.id && t.category !== 'adjustment');
    let totalIn = 0;
    let totalOut = 0;
    let net = 0;
    for (const t of txs) {
        const effect = cashEffect(t);
        net += effect;
        if (effect > 0)
            totalIn += effect;
        else if (effect < 0)
            totalOut += -effect;
    }
    return {
        totalReceipts: totalIn,
        totalPayments: totalOut,
        closingBalance: account.openingBalance + net,
        txCount: txs.length,
    };
}
export function defaultCashAccount(openingBalance = 0, createdAt) {
    return {
        id: DEFAULT_CASH_ACCOUNT_ID,
        name: 'Cash',
        kind: 'cash',
        bankName: null,
        accountName: null,
        accountNumber: null,
        ifscCode: null,
        branch: null,
        isSystem: true,
        openingBalance,
        createdAt: createdAt ?? new Date().toISOString(),
    };
}
function normalizeCashAccount(account) {
    const kind = account.kind ?? (account.isSystem ? 'cash' : 'bank');
    return {
        ...account,
        kind,
        bankName: account.bankName ?? null,
        accountName: account.accountName ?? null,
        accountNumber: account.accountNumber ?? null,
        ifscCode: account.ifscCode ?? null,
        branch: account.branch ?? null,
    };
}
export function ensureCashAccounts(state) {
    if (!Array.isArray(state.cashAccounts))
        state.cashAccounts = [];
    state.cashAccounts = state.cashAccounts.map(normalizeCashAccount);
    let system = state.cashAccounts.find((a) => a.isSystem || a.id === DEFAULT_CASH_ACCOUNT_ID);
    if (!system) {
        system = defaultCashAccount(state.openingBalance ?? 0, state.createdAt);
        state.cashAccounts.unshift(system);
    }
    else {
        system.isSystem = true;
        system.kind = 'cash';
        if (!system.id)
            system.id = DEFAULT_CASH_ACCOUNT_ID;
        // Shop opening balance is the Cash account opening balance.
        if (typeof state.openingBalance === 'number' && !Number.isNaN(state.openingBalance)) {
            system.openingBalance = state.openingBalance;
        }
    }
    state.transactions = (state.transactions ?? []).map((tx) => {
        const category = tx.category || (tx.type === 'receipt' ? 'receipt' : 'payment');
        const keepCashNull = category === 'adjustment' ||
            (category === 'sales' && !tx.cashAccountId) ||
            (category === 'purchase' && !tx.cashAccountId);
        if (keepCashNull) {
            return {
                ...tx,
                category,
                cashAccountId: null,
                cashAccountName: null,
                attachmentName: tx.attachmentName ?? null,
                attachmentPath: tx.attachmentPath ?? null,
            };
        }
        if (tx.cashAccountId) {
            return {
                ...tx,
                category,
                attachmentName: tx.attachmentName ?? null,
                attachmentPath: tx.attachmentPath ?? null,
            };
        }
        return {
            ...tx,
            category,
            cashAccountId: system.id,
            cashAccountName: system.name,
            attachmentName: tx.attachmentName ?? null,
            attachmentPath: tx.attachmentPath ?? null,
        };
    });
    return state;
}
export function emptyState() {
    const createdAt = new Date().toISOString();
    const state = {
        appId: generateAppId(),
        shopName: '',
        shopAddress: '',
        openingBalance: 0,
        users: [],
        activeUserId: null,
        cashAccounts: [defaultCashAccount(0, createdAt)],
        transactions: [],
        recurringBillings: [],
        services: [],
        todos: [],
        dayCloses: [],
        setupComplete: false,
        createdAt,
    };
    setActionConfirmCode(state.appId, DEFAULT_ACTION_CONFIRM_CODE);
    return state;
}
export function emptyAuth() {
    return { accounts: [], sessions: [], otps: [], pendingRegistrations: [] };
}
function normalizeLegacyPeriod(dateOnly, interval) {
    const date = new Date(`${dateOnly}T12:00:00`);
    if (Number.isNaN(date.getTime()) || interval === 'daily')
        return dateOnly;
    if (interval === 'weekly') {
        date.setDate(date.getDate() + (date.getDay() === 0 ? -6 : 1 - date.getDay()));
    }
    else if (interval === 'every_15_days') {
        date.setDate(date.getDate() <= 15 ? 1 : 16);
    }
    else if (interval === 'monthly') {
        date.setDate(1);
    }
    else if (interval === 'quarterly') {
        date.setMonth(Math.floor(date.getMonth() / 3) * 3, 1);
    }
    else if (interval === 'half_yearly') {
        date.setMonth(date.getMonth() < 6 ? 0 : 6, 1);
    }
    else {
        date.setMonth(0, 1);
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function legacyBillingDate(periodStart, interval) {
    const date = new Date(`${periodStart}T12:00:00`);
    if (interval === 'weekly')
        date.setDate(date.getDate() + 7);
    else if (interval === 'every_15_days') {
        if (date.getDate() <= 15)
            date.setDate(16);
        else
            date.setMonth(date.getMonth() + 1, 1);
    }
    else if (interval === 'monthly')
        date.setMonth(date.getMonth() + 1, 1);
    else if (interval === 'quarterly')
        date.setMonth(date.getMonth() + 3, 1);
    else if (interval === 'half_yearly')
        date.setMonth(date.getMonth() + 6, 1);
    else if (interval === 'yearly')
        date.setFullYear(date.getFullYear() + 1, 0, 1);
    else
        date.setDate(date.getDate() + 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function normalizeState(raw) {
    raw.shopAddress = raw.shopAddress ?? '';
    raw.users = (raw.users ?? []).map((u) => ({
        ...u,
        phone: u.phone ?? '',
        email: u.email ?? null,
        role: u.role ?? 'shopkeeper',
    }));
    raw.transactions = (raw.transactions ?? []).map((tx) => ({
        ...tx,
        recurringBillingId: tx.recurringBillingId ?? null,
        recurringOccurrenceDate: tx.recurringOccurrenceDate ?? null,
        serviceId: tx.serviceId ?? null,
        serviceName: tx.serviceName ?? null,
    }));
    raw.recurringBillings = (raw.recurringBillings ?? []).map((billing) => {
        const legacy = !Number(billing.billingDelayDays);
        const effectiveDate = legacy
            ? normalizeLegacyPeriod(billing.effectiveDate, billing.interval)
            : billing.effectiveDate;
        const nextPeriodStartDate = legacy
            ? normalizeLegacyPeriod(billing.nextRunDate, billing.interval)
            : (billing.nextPeriodStartDate ?? effectiveDate);
        return {
            ...billing,
            customerPhone: billing.customerPhone ?? '',
            serviceId: billing.serviceId ?? null,
            serviceName: billing.serviceName ?? null,
            transactionCategory: billing.transactionCategory ?? 'sales',
            effectiveDate,
            nextPeriodStartDate,
            lastPeriodStartDate: billing.lastPeriodStartDate ?? null,
            billingDelayDays: legacy ? 1 : Number(billing.billingDelayDays),
            nextRunDate: legacy
                ? legacyBillingDate(nextPeriodStartDate, billing.interval)
                : billing.nextRunDate,
            lastRunDate: billing.lastRunDate ?? null,
            autoBilling: billing.autoBilling ?? true,
            active: billing.active ?? true,
        };
    });
    raw.services = (raw.services ?? []).map((service) => ({
        ...service,
        amount: Number(service.amount) || 0,
        description: service.description ?? '',
    }));
    raw.todos = (raw.todos ?? []).map((todo) => ({
        ...todo,
        notes: todo.notes ?? '',
        activity: todo.activity || 'custom',
        dueTime: todo.dueTime || '09:00',
        done: Boolean(todo.done),
        remind3DaysBefore: true,
        remind1DayBefore: true,
        remindOnDueMorning: true,
        whatsappReminder: Boolean(todo.whatsappReminder),
        customerId: todo.customerId ?? null,
        customerName: todo.customerName ?? null,
        customerPhone: todo.customerPhone ?? null,
        reminded3DaysOn: todo.reminded3DaysOn ?? null,
        reminded1DayOn: todo.reminded1DayOn ?? null,
        remindedDueOn: todo.remindedDueOn ?? null,
    }));
    return ensureCashAccounts(raw);
}
function normalizeAuth(raw) {
    return {
        accounts: (raw.accounts ?? []).map((a) => ({
            ...a,
            email: a.email ?? null,
            phoneVerified: a.phoneVerified ?? true,
        })),
        sessions: raw.sessions ?? [],
        otps: (raw.otps ?? []).map((o) => ({
            ...o,
            purpose: o.purpose ?? 'login',
        })),
        pendingRegistrations: (raw.pendingRegistrations ?? []).map((p) => ({
            ...p,
            shopName: p.shopName ?? '',
            shopAddress: p.shopAddress ?? '',
        })),
    };
}
function readJsonFile(path) {
    try {
        if (!existsSync(path))
            return null;
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
function enqueuePersist(task) {
    persistChain = persistChain
        .then(task)
        .catch((err) => {
        console.error('[MySQL] persist failed:', err instanceof Error ? err.message : err);
    });
}
function toMysqlDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return new Date().toISOString().slice(0, 23).replace('T', ' ');
    return d.toISOString().slice(0, 23).replace('T', ' ');
}
function fromMysqlDate(value) {
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === 'string') {
        const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
        return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    return new Date().toISOString();
}
function fromMysqlDateOnly(value) {
    if (value instanceof Date)
        return value.toISOString().slice(0, 10);
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
        return value.slice(0, 10);
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime())
        ? new Date().toISOString().slice(0, 10)
        : parsed.toISOString().slice(0, 10);
}
async function countUsers() {
    const [rows] = await getPool().query('SELECT COUNT(*) AS c FROM users');
    return Number(rows[0]?.c ?? 0);
}
async function persistAuth(auth) {
    const p = getPool();
    const conn = await p.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM sessions');
        await conn.query('DELETE FROM otps');
        await conn.query('DELETE FROM pending_registrations');
        // Upsert users (do not wipe — shops may reference them). Replace by full sync:
        await conn.query('DELETE FROM users');
        for (const a of auth.accounts) {
            await conn.query(`INSERT INTO users (id, name, phone, email, role, phone_verified, shop_app_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
                a.id,
                a.name,
                a.phone,
                a.email ?? null,
                a.role,
                a.phoneVerified ? 1 : 0,
                a.shopAppId,
                toMysqlDate(a.createdAt),
            ]);
        }
        for (const s of auth.sessions) {
            await conn.query(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`, [s.token, s.userId, toMysqlDate(s.createdAt), s.expiresAt]);
        }
        for (const o of auth.otps) {
            await conn.query(`INSERT INTO otps (phone, code, purpose, expires_at) VALUES (?, ?, ?, ?)`, [o.phone, o.code, o.purpose, o.expiresAt]);
        }
        for (const pr of auth.pendingRegistrations) {
            await conn.query(`INSERT INTO pending_registrations
          (phone, name, shop_name, shop_address, role, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                pr.phone,
                pr.name,
                pr.shopName,
                pr.shopAddress,
                pr.role,
                toMysqlDate(pr.createdAt),
                pr.expiresAt,
            ]);
        }
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
}
async function persistShop(state, ownerUserId) {
    const p = getPool();
    const conn = await p.getConnection();
    try {
        await conn.beginTransaction();
        const appId = state.appId;
        await conn.query(`INSERT INTO shops
        (app_id, shop_name, shop_address, opening_balance, setup_complete, owner_user_id, active_user_id, action_confirm_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         shop_name = VALUES(shop_name),
         shop_address = VALUES(shop_address),
         opening_balance = VALUES(opening_balance),
         setup_complete = VALUES(setup_complete),
         owner_user_id = COALESCE(VALUES(owner_user_id), owner_user_id),
         active_user_id = VALUES(active_user_id),
         action_confirm_code = VALUES(action_confirm_code)`, [
            appId,
            state.shopName,
            state.shopAddress ?? '',
            state.openingBalance,
            state.setupComplete ? 1 : 0,
            ownerUserId ?? state.users.find((u) => u.role === 'shopkeeper')?.id ?? null,
            state.activeUserId,
            getActionConfirmCode(appId),
            toMysqlDate(state.createdAt),
        ]);
        await conn.query('DELETE FROM cash_accounts WHERE shop_app_id = ?', [appId]);
        await conn.query('DELETE FROM bank_accounts WHERE shop_app_id = ?', [appId]);
        for (const a of state.cashAccounts) {
            if (a.kind === 'bank' && !a.isSystem) {
                await conn.query(`INSERT INTO bank_accounts
            (id, shop_app_id, bank_name, account_name, account_number, ifsc_code, branch, opening_balance, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    a.id,
                    appId,
                    a.bankName || a.name,
                    a.accountName || a.name,
                    a.accountNumber || null,
                    a.ifscCode || null,
                    a.branch || null,
                    a.openingBalance,
                    toMysqlDate(a.createdAt),
                    toMysqlDate(new Date().toISOString()),
                ]);
            }
            else {
                await conn.query(`INSERT INTO cash_accounts
            (id, shop_app_id, name, kind, bank_name, account_name, account_number, is_system, opening_balance, created_at)
           VALUES (?, ?, ?, 'cash', NULL, NULL, NULL, ?, ?, ?)`, [
                    a.id,
                    appId,
                    a.name || 'Cash',
                    a.isSystem || a.id === DEFAULT_CASH_ACCOUNT_ID ? 1 : 0,
                    a.openingBalance,
                    toMysqlDate(a.createdAt),
                ]);
            }
        }
        await conn.query('DELETE FROM transactions WHERE shop_app_id = ?', [appId]);
        for (const t of state.transactions) {
            const category = t.category ||
                (t.type === 'receipt' ? 'receipt' : 'payment');
            await conn.query(`INSERT INTO transactions
          (id, shop_app_id, type, category, amount, remarks,
           recorded_by_user_id, recorded_by_name,
           customer_user_id, customer_name, customer_phone,
           cash_account_id, cash_account_name,
           attachment_name, attachment_path,
           recurring_billing_id, recurring_occurrence_date,
           service_id, service_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                t.id,
                appId,
                t.type,
                category,
                t.amount,
                t.remarks ?? '',
                t.userId,
                t.userName,
                t.customerId,
                t.customerName,
                t.customerPhone,
                t.category === 'adjustment' ||
                    (t.category === 'sales' && !t.cashAccountId) ||
                    (t.category === 'purchase' && !t.cashAccountId)
                    ? null
                    : (t.cashAccountId ?? DEFAULT_CASH_ACCOUNT_ID),
                t.category === 'adjustment' ||
                    (t.category === 'sales' && !t.cashAccountId) ||
                    (t.category === 'purchase' && !t.cashAccountId)
                    ? null
                    : (t.cashAccountName ?? 'Cash'),
                t.attachmentName ?? null,
                t.attachmentPath ?? null,
                t.recurringBillingId ?? null,
                t.recurringOccurrenceDate ?? null,
                t.serviceId ?? null,
                t.serviceName ?? null,
                toMysqlDate(t.createdAt),
            ]);
        }
        await conn.query('DELETE FROM recurring_billings WHERE shop_app_id = ?', [appId]);
        for (const billing of state.recurringBillings) {
            await conn.query(`INSERT INTO recurring_billings
          (id, shop_app_id, customer_user_id, customer_name, customer_phone,
           amount, remarks, service_id, service_name, transaction_category,
           billing_interval, effective_date, next_period_start_date, last_period_start_date,
           billing_delay_days, next_run_date, last_run_date, auto_billing, active,
           created_by_user_id, created_by_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                billing.id,
                appId,
                billing.customerId,
                billing.customerName,
                billing.customerPhone,
                billing.amount,
                billing.remarks,
                billing.serviceId ?? null,
                billing.serviceName ?? null,
                billing.transactionCategory,
                billing.interval,
                billing.effectiveDate,
                billing.nextPeriodStartDate,
                billing.lastPeriodStartDate,
                billing.billingDelayDays,
                billing.nextRunDate,
                billing.lastRunDate,
                billing.autoBilling ? 1 : 0,
                billing.active ? 1 : 0,
                billing.createdByUserId,
                billing.createdByName,
                toMysqlDate(billing.createdAt),
                toMysqlDate(billing.updatedAt),
            ]);
        }
        await conn.query('DELETE FROM shop_services WHERE shop_app_id = ?', [appId]);
        for (const service of state.services) {
            await conn.query(`INSERT INTO shop_services
          (id, shop_app_id, name, amount, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                service.id,
                appId,
                service.name,
                service.amount,
                service.description ?? '',
                toMysqlDate(service.createdAt),
                toMysqlDate(service.updatedAt),
            ]);
        }
        await conn.query('DELETE FROM shop_todos WHERE shop_app_id = ?', [appId]);
        for (const todo of state.todos ?? []) {
            await conn.query(`INSERT INTO shop_todos
          (id, shop_app_id, title, notes, activity, due_date, due_time, done,
           remind_3_days, remind_1_day, remind_due_morning, whatsapp_reminder,
           customer_user_id, customer_name, customer_phone,
           reminded_3_days_on, reminded_1_day_on, reminded_due_on,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                todo.id,
                appId,
                todo.title,
                todo.notes ?? '',
                todo.activity || 'custom',
                todo.dueDate,
                todo.dueTime || '09:00',
                todo.done ? 1 : 0,
                1,
                1,
                1,
                todo.whatsappReminder ? 1 : 0,
                todo.customerId ?? null,
                todo.customerName ?? null,
                todo.customerPhone ?? null,
                todo.reminded3DaysOn,
                todo.reminded1DayOn,
                todo.remindedDueOn,
                toMysqlDate(todo.createdAt),
                toMysqlDate(todo.updatedAt),
            ]);
        }
        await conn.query('DELETE FROM day_closes WHERE shop_app_id = ?', [appId]);
        for (const d of state.dayCloses) {
            await conn.query(`INSERT INTO day_closes
          (id, shop_app_id, close_date, opening_balance, closing_balance,
           total_receipts, total_payments, transaction_count, closed_at, closed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                d.id,
                appId,
                d.date,
                d.openingBalance,
                d.closingBalance,
                d.totalReceipts,
                d.totalPayments,
                d.transactionCount,
                toMysqlDate(d.closedAt),
                d.closedBy,
            ]);
        }
        // Sync shop member rows into users (customers + shopkeepers listed on shop)
        // Keep global auth accounts as the login source; shop.users mirrors for UI.
        // Ensure each shop user has a users row with this shop_app_id when they login via auth.
        for (const u of state.users) {
            await conn.query(`INSERT INTO users (id, name, phone, email, role, phone_verified, shop_app_id, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           email = VALUES(email),
           role = VALUES(role),
           shop_app_id = VALUES(shop_app_id)`, [
                u.id,
                u.name,
                u.phone,
                u.email ?? null,
                u.role,
                appId,
                toMysqlDate(u.createdAt),
            ]);
        }
        await conn.commit();
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
}
async function loadAuthFromDb() {
    const p = getPool();
    const [userRows] = await p.query('SELECT * FROM users ORDER BY created_at ASC');
    const [sessionRows] = await p.query('SELECT * FROM sessions');
    const [otpRows] = await p.query('SELECT * FROM otps');
    const [pendingRows] = await p.query('SELECT * FROM pending_registrations');
    const accounts = userRows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        phone: String(r.phone),
        email: r.email == null ? null : String(r.email),
        role: r.role,
        shopAppId: r.shop_app_id == null ? null : String(r.shop_app_id),
        phoneVerified: Boolean(r.phone_verified),
        createdAt: fromMysqlDate(r.created_at),
    }));
    const sessions = sessionRows.map((r) => ({
        token: String(r.token),
        userId: String(r.user_id),
        createdAt: fromMysqlDate(r.created_at),
        expiresAt: Number(r.expires_at),
    }));
    const otps = otpRows.map((r) => ({
        phone: String(r.phone),
        code: String(r.code),
        purpose: r.purpose,
        expiresAt: Number(r.expires_at),
    }));
    const pendingRegistrations = pendingRows.map((r) => ({
        phone: String(r.phone),
        name: String(r.name),
        shopName: String(r.shop_name ?? ''),
        shopAddress: String(r.shop_address ?? ''),
        role: r.role,
        createdAt: fromMysqlDate(r.created_at),
        expiresAt: Number(r.expires_at),
    }));
    return normalizeAuth({ accounts, sessions, otps, pendingRegistrations });
}
async function loadShopFromDb(appId) {
    const p = getPool();
    const [shopRows] = await p.query('SELECT * FROM shops WHERE app_id = ? LIMIT 1', [appId]);
    if (!shopRows.length)
        return null;
    const s = shopRows[0];
    setActionConfirmCode(String(s.app_id), s.action_confirm_code == null ? DEFAULT_ACTION_CONFIRM_CODE : String(s.action_confirm_code));
    const [userRows] = await p.query('SELECT * FROM users WHERE shop_app_id = ? ORDER BY created_at ASC', [appId]);
    const [cashRows] = await p.query('SELECT * FROM cash_accounts WHERE shop_app_id = ? ORDER BY created_at ASC', [appId]);
    const [bankRows] = await p.query('SELECT * FROM bank_accounts WHERE shop_app_id = ? ORDER BY created_at ASC', [appId]);
    const [txRows] = await p.query('SELECT * FROM transactions WHERE shop_app_id = ? ORDER BY created_at DESC', [appId]);
    const [recurringRows] = await p.query('SELECT * FROM recurring_billings WHERE shop_app_id = ? ORDER BY created_at DESC', [appId]);
    const [serviceRows] = await p.query('SELECT * FROM shop_services WHERE shop_app_id = ? ORDER BY name ASC', [appId]);
    const [todoRows] = await p.query('SELECT * FROM shop_todos WHERE shop_app_id = ? ORDER BY due_date ASC, created_at DESC', [appId]);
    const [dayRows] = await p.query('SELECT * FROM day_closes WHERE shop_app_id = ? ORDER BY closed_at DESC', [appId]);
    const cashAccounts = [
        ...cashRows.map((a) => ({
            id: String(a.id),
            name: String(a.name),
            kind: 'cash',
            bankName: null,
            accountName: null,
            accountNumber: null,
            ifscCode: null,
            branch: null,
            isSystem: Boolean(a.is_system),
            openingBalance: Number(a.opening_balance),
            createdAt: fromMysqlDate(a.created_at),
        })),
        ...bankRows.map((a) => {
            const bankName = String(a.bank_name);
            const accountName = String(a.account_name);
            return {
                id: String(a.id),
                name: `${bankName} · ${accountName}`,
                kind: 'bank',
                bankName,
                accountName,
                accountNumber: a.account_number == null ? null : String(a.account_number),
                ifscCode: a.ifsc_code == null ? null : String(a.ifsc_code),
                branch: a.branch == null ? null : String(a.branch),
                isSystem: false,
                openingBalance: Number(a.opening_balance),
                createdAt: fromMysqlDate(a.created_at),
            };
        }),
    ];
    const state = {
        appId: String(s.app_id),
        shopName: String(s.shop_name ?? ''),
        shopAddress: String(s.shop_address ?? ''),
        openingBalance: Number(s.opening_balance),
        setupComplete: Boolean(s.setup_complete),
        activeUserId: s.active_user_id == null ? null : String(s.active_user_id),
        createdAt: fromMysqlDate(s.created_at),
        users: userRows.map((u) => ({
            id: String(u.id),
            name: String(u.name),
            phone: String(u.phone),
            email: u.email == null ? null : String(u.email),
            role: u.role,
            createdAt: fromMysqlDate(u.created_at),
        })),
        cashAccounts,
        transactions: txRows.map((t) => ({
            id: String(t.id),
            type: t.type,
            category: t.category,
            amount: Number(t.amount),
            remarks: String(t.remarks ?? ''),
            userId: String(t.recorded_by_user_id),
            userName: String(t.recorded_by_name),
            customerId: t.customer_user_id == null ? null : String(t.customer_user_id),
            customerName: t.customer_name == null ? null : String(t.customer_name),
            customerPhone: t.customer_phone == null ? null : String(t.customer_phone),
            cashAccountId: t.cash_account_id == null ? null : String(t.cash_account_id),
            cashAccountName: t.cash_account_name == null ? null : String(t.cash_account_name),
            attachmentName: t.attachment_name == null ? null : String(t.attachment_name),
            attachmentPath: t.attachment_path == null ? null : String(t.attachment_path),
            recurringBillingId: t.recurring_billing_id == null ? null : String(t.recurring_billing_id),
            recurringOccurrenceDate: t.recurring_occurrence_date == null
                ? null
                : fromMysqlDateOnly(t.recurring_occurrence_date),
            serviceId: t.service_id == null ? null : String(t.service_id),
            serviceName: t.service_name == null ? null : String(t.service_name),
            createdAt: fromMysqlDate(t.created_at),
        })),
        recurringBillings: recurringRows.map((billing) => ({
            id: String(billing.id),
            customerId: String(billing.customer_user_id),
            customerName: String(billing.customer_name),
            customerPhone: String(billing.customer_phone ?? ''),
            amount: Number(billing.amount),
            remarks: String(billing.remarks ?? ''),
            serviceId: billing.service_id == null ? null : String(billing.service_id),
            serviceName: billing.service_name == null ? null : String(billing.service_name),
            transactionCategory: billing.transaction_category === 'purchase' ? 'purchase' : 'sales',
            interval: billing.billing_interval,
            effectiveDate: fromMysqlDateOnly(billing.effective_date),
            nextPeriodStartDate: billing.next_period_start_date == null
                ? fromMysqlDateOnly(billing.effective_date)
                : fromMysqlDateOnly(billing.next_period_start_date),
            lastPeriodStartDate: billing.last_period_start_date == null
                ? null
                : fromMysqlDateOnly(billing.last_period_start_date),
            billingDelayDays: Number(billing.billing_delay_days ?? 0),
            nextRunDate: fromMysqlDateOnly(billing.next_run_date),
            lastRunDate: billing.last_run_date == null
                ? null
                : fromMysqlDateOnly(billing.last_run_date),
            autoBilling: Boolean(billing.auto_billing),
            active: Boolean(billing.active),
            createdByUserId: String(billing.created_by_user_id),
            createdByName: String(billing.created_by_name),
            createdAt: fromMysqlDate(billing.created_at),
            updatedAt: fromMysqlDate(billing.updated_at),
        })),
        services: serviceRows.map((service) => ({
            id: String(service.id),
            name: String(service.name),
            amount: Number(service.amount),
            description: String(service.description ?? ''),
            createdAt: fromMysqlDate(service.created_at),
            updatedAt: fromMysqlDate(service.updated_at),
        })),
        todos: todoRows.map((todo) => ({
            id: String(todo.id),
            title: String(todo.title),
            notes: String(todo.notes ?? ''),
            activity: String(todo.activity ?? 'custom'),
            dueDate: fromMysqlDateOnly(todo.due_date),
            dueTime: String(todo.due_time ?? '09:00').slice(0, 5),
            done: Boolean(todo.done),
            remind3DaysBefore: true,
            remind1DayBefore: true,
            remindOnDueMorning: true,
            whatsappReminder: Boolean(todo.whatsapp_reminder),
            customerId: todo.customer_user_id == null ? null : String(todo.customer_user_id),
            customerName: todo.customer_name == null ? null : String(todo.customer_name),
            customerPhone: todo.customer_phone == null ? null : String(todo.customer_phone),
            reminded3DaysOn: todo.reminded_3_days_on == null ? null : fromMysqlDateOnly(todo.reminded_3_days_on),
            reminded1DayOn: todo.reminded_1_day_on == null ? null : fromMysqlDateOnly(todo.reminded_1_day_on),
            remindedDueOn: todo.reminded_due_on == null ? null : fromMysqlDateOnly(todo.reminded_due_on),
            createdAt: fromMysqlDate(todo.created_at),
            updatedAt: fromMysqlDate(todo.updated_at),
        })),
        dayCloses: dayRows.map((d) => ({
            id: String(d.id),
            date: fromMysqlDateOnly(d.close_date),
            openingBalance: Number(d.opening_balance),
            closingBalance: Number(d.closing_balance),
            totalReceipts: Number(d.total_receipts),
            totalPayments: Number(d.total_payments),
            transactionCount: Number(d.transaction_count),
            closedAt: fromMysqlDate(d.closed_at),
            closedBy: String(d.closed_by),
        })),
    };
    return normalizeState(state);
}
async function migrateFromDocumentsIfNeeded() {
    const p = getPool();
    const [shopCountRows] = await p.query('SELECT COUNT(*) AS c FROM shops');
    const shopCount = Number(shopCountRows[0]?.c ?? 0);
    const userCount = await countUsers();
    if (userCount > 0 && shopCount > 0) {
        console.log('[MySQL] Relational tables already populated');
        return;
    }
    let shop = await getDocument(SHOP_DOC);
    let auth = await getDocument(AUTH_DOC);
    if (!shop) {
        const fromFile = readJsonFile(shopFile);
        shop = fromFile ? normalizeState(fromFile) : null;
    }
    else {
        shop = normalizeState(shop);
    }
    if (!auth) {
        const fromFile = readJsonFile(authFile);
        auth = fromFile ? normalizeAuth(fromFile) : emptyAuth();
    }
    else {
        auth = normalizeAuth(auth);
    }
    // If users already in DB but auth doc empty, load from DB
    if (userCount > 0 && auth.accounts.length === 0) {
        auth = await loadAuthFromDb();
    }
    if (!shop && auth.accounts.length === 0) {
        console.log('[MySQL] Fresh install — empty relational tables');
        return;
    }
    if (!shop)
        shop = emptyState();
    for (const u of shop.users) {
        const existing = auth.accounts.find((a) => a.id === u.id || a.phone === u.phone);
        if (existing) {
            existing.shopAppId = shop.appId;
            existing.name = u.name;
            existing.role = u.role;
        }
        else {
            auth.accounts.push({
                id: u.id,
                name: u.name,
                phone: u.phone,
                email: u.email ?? null,
                role: u.role,
                shopAppId: shop.appId,
                phoneVerified: true,
                createdAt: u.createdAt,
            });
        }
    }
    await persistAuth(auth);
    const owner = auth.accounts.find((a) => a.role === 'shopkeeper' && a.shopAppId === shop.appId)?.id ??
        shop.users.find((u) => u.role === 'shopkeeper')?.id ??
        null;
    await persistShop(shop, owner);
    await setDocument(SHOP_DOC, shop);
    await setDocument(AUTH_DOC, auth);
    console.log(`[MySQL] Migrated to relational tables: ${auth.accounts.length} users, shop ${shop.appId}`);
}
/** Connect to MySQL, ensure schema, migrate, load caches. */
export async function initStore() {
    await initDb();
    await migrateFromDocumentsIfNeeded();
    authCache = await loadAuthFromDb();
    const [shopRows] = await getPool().query('SELECT app_id FROM shops');
    shopCaches.clear();
    draftByOwner.clear();
    for (const row of shopRows) {
        const appId = String(row.app_id);
        const state = await loadShopFromDb(appId);
        if (state)
            shopCaches.set(appId, state);
    }
    // If no shops yet but we have incomplete setup from docs — handled by migrate
    if (shopCaches.size === 0) {
        const doc = await getDocument(SHOP_DOC);
        if (doc?.appId) {
            const state = normalizeState(doc);
            shopCaches.set(state.appId, state);
        }
    }
    console.log(`[MySQL] Loaded ${authCache.accounts.length} users, ${shopCaches.size} shop(s)`);
}
export function loadAuth() {
    if (!authCache)
        throw new Error('Store not initialized');
    return normalizeAuth(structuredClone(authCache));
}
export function saveAuth(auth) {
    const next = normalizeAuth(structuredClone(auth));
    authCache = next;
    enqueuePersist(() => persistAuth(next));
}
/**
 * Load shop state for the logged-in account.
 * - Shopkeeper: their shop (by shopAppId or draft)
 * - Customer: the shop they belong to
 * - Fallback: first shop / empty (legacy single-shop)
 */
export function loadState(account) {
    if (account?.shopAppId) {
        const cached = shopCaches.get(account.shopAppId);
        if (cached)
            return normalizeState(structuredClone(cached));
    }
    if (account?.role === 'shopkeeper' && account.id) {
        const draft = draftByOwner.get(account.id);
        if (draft)
            return normalizeState(structuredClone(draft));
    }
    // Legacy / first shop
    const first = shopCaches.values().next().value;
    if (first)
        return normalizeState(structuredClone(first));
    return emptyState();
}
export function saveState(state, account) {
    const next = normalizeState(structuredClone(state));
    shopCaches.set(next.appId, next);
    if (!next.setupComplete && account?.role === 'shopkeeper') {
        draftByOwner.set(account.id, next);
    }
    // Keep all auth accounts for this shop linked
    if (authCache) {
        for (const u of next.users) {
            const idx = authCache.accounts.findIndex((a) => a.id === u.id || a.phone === u.phone);
            if (idx >= 0) {
                authCache.accounts[idx] = {
                    ...authCache.accounts[idx],
                    name: u.name,
                    phone: u.phone,
                    role: u.role,
                    shopAppId: next.appId,
                };
            }
        }
    }
    const ownerId = account?.role === 'shopkeeper'
        ? account.id
        : next.users.find((u) => u.role === 'shopkeeper')?.id ?? null;
    enqueuePersist(async () => {
        await persistShop(next, ownerId);
        if (authCache)
            await persistAuth(authCache);
        await setDocument(SHOP_DOC, next);
        if (authCache)
            await setDocument(AUTH_DOC, authCache);
    });
}
export async function flushStore() {
    await persistChain;
}
export function newId() {
    return uuid();
}
/** Unique transaction id embedding local timestamp + random suffix (fits CHAR(36)). */
export function newTxId(at = new Date()) {
    const p = (n, w) => String(n).padStart(w, '0');
    const stamp = `${at.getFullYear()}${p(at.getMonth() + 1, 2)}${p(at.getDate(), 2)}` +
        `${p(at.getHours(), 2)}${p(at.getMinutes(), 2)}${p(at.getSeconds(), 2)}${p(at.getMilliseconds(), 3)}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TX${stamp}${rand}`;
}
/** Ensure createdAt is unique within the shop so Open/Close order is deterministic. */
export function uniqueTxCreatedAt(existing, desired) {
    let t = desired.getTime();
    if (Number.isNaN(t))
        t = Date.now();
    const used = new Set(existing.map((tx) => new Date(tx.createdAt).getTime()));
    while (used.has(t))
        t += 1;
    return new Date(t).toISOString();
}
export function normalizePhone(phone) {
    return phone.replace(/\D/g, '').slice(-10);
}
export function isValidPhone(phone) {
    return /^\d{10}$/.test(normalizePhone(phone));
}
/** True if this mobile already exists in the MySQL users table. */
export async function phoneExistsInDatabase(phone, excludeUserId) {
    const normalized = normalizePhone(phone);
    if (!/^\d{10}$/.test(normalized))
        return false;
    const [rows] = excludeUserId
        ? await getPool().query('SELECT id FROM users WHERE phone = ? AND id <> ? LIMIT 1', [normalized, excludeUserId])
        : await getPool().query('SELECT id FROM users WHERE phone = ? LIMIT 1', [normalized]);
    return rows.length > 0;
}
/** 6-digit OTP. Uses crypto when available; falls back for very old runtimes. */
export function generateOtp() {
    const n = Math.floor(Math.random() * 1_000_000);
    return String(n).padStart(6, '0');
}
/** Fixed demo OTP used only when WhatsApp delivery is not configured. */
export function generateDemoOtp() {
    return '123456';
}
/** Ensure a draft shop exists for a new shopkeeper before setup completes. */
export function ensureShopkeeperDraft(account, seed) {
    if (account.shopAppId) {
        const existing = shopCaches.get(account.shopAppId);
        if (existing)
            return normalizeState(structuredClone(existing));
    }
    let draft = draftByOwner.get(account.id);
    if (!draft) {
        draft = emptyState();
        if (seed?.shopName)
            draft.shopName = seed.shopName;
        if (seed?.shopAddress)
            draft.shopAddress = seed.shopAddress;
        draft.users = [
            {
                id: account.id,
                name: account.name,
                phone: account.phone,
                email: account.email ?? null,
                role: 'shopkeeper',
                createdAt: account.createdAt,
            },
        ];
        draft.activeUserId = account.id;
        draftByOwner.set(account.id, draft);
        shopCaches.set(draft.appId, draft);
    }
    return normalizeState(structuredClone(draft));
}
