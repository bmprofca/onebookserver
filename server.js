import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createSession, publicAccount, requireAuth, requireShopkeeper, } from './src/auth.js';
import { deleteAttachmentFile, ensureUploadsDir, saveAttachmentData, UPLOADS_DIR, } from './src/attachments.js';
import { calcTotals, DEFAULT_CASH_ACCOUNT_ID, defaultCashAccount, emptyState, ensureCashAccounts, flushStore, generateDemoOtp, generateOtp, ensureShopkeeperDraft, getActionConfirmCode, getShopByAppId, initStore, isSystemCashAccountId, isValidPhone, loadAuth, loadState, newId, newTxId, normalizePhone, phoneExistsInShop, profilesForPhone, uniqueTxCreatedAt, saveAuth, saveShopByAppId, saveState, writeCustomerOpeningBalance, } from './src/store.js';
import { consumeProfileTicket, issueProfileTicket, peekProfileTicket } from './src/profileTickets.js';
import { isWhatsAppOtpConfigured, sendWhatsAppOtp, sendPaymentReminderWhatsApp, isPaymentReminderWhatsAppConfigured } from './src/onechatting.js';
import { isSmsOtpConfigured, sendSmsOtp } from './src/fast2sms.js';
import { applyResumeSchedule, billingDateForPeriod, createRecurringBilling, daysAfterPeriodEnd, isBillingDateAllowed, isDateOnly, lastGeneratedBillDate, localDateString, materializeRecurringBillings, minResumeBillingDate, postNextRecurringBill, RECURRING_INTERVALS, } from './src/recurring.js';
import { buildJoinPageHtml } from './src/joinPageHtml.js';
import { getAppVersionInfo } from './src/appVersion.js';
import {
    insertWhatsAppMessageLog,
    listWhatsAppMessageLogs,
    summarizeWhatsAppLogs,
    whatsappMessageUnitCost,
} from './src/whatsappLogs.js';
import {
    broadcastWhatsAppMessages,
    createWhatsAppCampaign,
    createWhatsAppTemplate,
    deleteWhatsAppCampaign,
    deleteWhatsAppTemplate,
    fetchRemoteWhatsAppTemplates,
    getWhatsAppConfig,
    listWhatsAppActivities,
    listWhatsAppTemplateVariables,
    listWhatsAppCampaigns,
    listWhatsAppChatMessages,
    listWhatsAppChats,
    listWhatsAppTemplates,
    refreshWhatsAppConnectionStatus,
    refreshWhatsAppTemplate,
    resolveWhatsAppTemplateForActivity,
    disconnectWhatsAppConfig,
    saveWhatsAppActivityMap,
    saveWhatsAppConfig,
    sendWhatsAppCampaignMessage,
    sendWhatsAppChatTemplate,
    sendWhatsAppChatTextMessage,
    sendWhatsAppChatMediaMessage,
    syncRemoteWhatsAppTemplates,
    syncWhatsAppInbox,
    updateWhatsAppCampaign,
    updateWhatsAppTemplate,
    getWhatsAppChatThread,
    markWhatsAppChatRead,
    markWhatsAppChatUnread,
    assignWhatsAppChat,
    getWhatsAppLiveSession,
    getShopWhatsAppChatCredentials,
} from './src/whatsappManager.js';
import {
    getPlatformWhatsAppTokens,
    savePlatformWhatsAppTokens,
} from './src/platformWhatsApp.js';
import {
    buildAmortizationSchedule,
    calculateEmi,
    createCustomerLoan,
    getLoanWithSchedule,
    getShopLoanOverview,
    listLoansForCustomer,
    materializeLoanEmis,
    payLoanEmi,
    precloseLoan,
    updateCustomerLoan,
} from './src/loans.js';
const app = express();
const PORT = Number(process.env.PORT || 4000);
const OTP_TTL_MS = 1000 * 60 * 5;
function resolveService(state, serviceId) {
    const id = String(serviceId ?? '').trim();
    if (!id)
        return { ok: true, service: null };
    const service = state.services.find((item) => item.id === id) ?? null;
    if (!service)
        return { ok: false, error: 'Service not found' };
    return { ok: true, service };
}
function serviceRemarks(service, fallback = '') {
    const desc = service.description.trim();
    if (desc)
        return `${service.name} — ${desc}`;
    return service.name || fallback;
}
function configuredOtpChannels() {
    const raw = (process.env.OTP_CHANNELS || '').trim().toLowerCase();
    const requested = raw
        ? raw
            .split(',')
            .map((c) => c.trim())
            .filter((c) => c === 'whatsapp' || c === 'sms')
        : ['whatsapp', 'sms'];
    const channels = [];
    for (const channel of requested) {
        if (channel === 'whatsapp' && isWhatsAppOtpConfigured())
            channels.push('whatsapp');
        if (channel === 'sms' && isSmsOtpConfigured())
            channels.push('sms');
    }
    return [...new Set(channels)];
}
function toDeliveryChannel(sent) {
    if (sent.includes('whatsapp') && sent.includes('sms'))
        return 'whatsapp+sms';
    if (sent.includes('sms'))
        return 'sms';
    if (sent.includes('whatsapp'))
        return 'whatsapp';
    return 'demo';
}

/**
 * Parse customer opening balance from request body.
 * Accepts either signed `openingBalance`, or `openingAmount` + `openingSide`
 * (`receivable` | `payable`). Returns null when invalid.
 */
function parseCustomerOpeningBalance(body) {
    if (body?.openingAmount !== undefined || body?.openingSide !== undefined) {
        const raw = String(body.openingAmount ?? '').trim();
        if (!raw || raw === '0' || raw === '0.0' || raw === '0.00')
            return 0;
        const amount = Number(raw);
        if (!Number.isFinite(amount) || amount < 0 || amount > 999999999)
            return null;
        const side = String(body.openingSide ?? 'receivable').toLowerCase();
        if (side === 'payable')
            return -Math.abs(amount);
        if (side === 'receivable')
            return Math.abs(amount);
        return null;
    }
    if (body?.openingBalance === undefined || body?.openingBalance === null || body?.openingBalance === '')
        return 0;
    const signed = Number(body.openingBalance);
    if (!Number.isFinite(signed) || Math.abs(signed) > 999999999)
        return null;
    return Math.round(signed * 100) / 100;
}

function otpSentMessage(channel, purpose) {
    if (purpose === 'register') {
        if (channel === 'whatsapp+sms') {
            return 'OTP sent on WhatsApp and SMS. Confirm your mobile number to complete registration.';
        }
        if (channel === 'sms') {
            return 'OTP sent by SMS. Confirm your mobile number to complete registration.';
        }
        if (channel === 'whatsapp') {
            return 'OTP sent on WhatsApp. Confirm your mobile number to complete registration.';
        }
        return 'OTP sent. Confirm your mobile number to complete registration.';
    }
    if (channel === 'whatsapp+sms')
        return 'OTP sent on WhatsApp and SMS';
    if (channel === 'sms')
        return 'OTP sent by SMS';
    if (channel === 'whatsapp')
        return 'OTP sent on WhatsApp';
    return 'OTP sent';
}
/** Generate OTP and deliver via WhatsApp and/or SMS when configured. */
async function issueOtp(phone, purpose) {
    const channels = configuredOtpChannels();
    const requireBoth = process.env.OTP_REQUIRE_BOTH === '1' ||
        (channels.includes('whatsapp') && channels.includes('sms'));
    const demoFallback = process.env.OTP_DEMO_FALLBACK === '1' || channels.length === 0;
    const code = channels.length > 0 ? generateOtp() : generateDemoOtp();
    if (channels.length > 0) {
        const sent = [];
        const errors = [];
        // Send in parallel so WhatsApp + SMS arrive together.
        const jobs = [];
        if (channels.includes('whatsapp')) {
            jobs.push(sendWhatsAppOtp(phone, code).then((result) => {
                if (result.ok)
                    sent.push('whatsapp');
                else
                    errors.push(`WhatsApp: ${result.error}`);
            }));
        }
        if (channels.includes('sms')) {
            jobs.push(sendSmsOtp(phone, code, { purpose }).then((result) => {
                if (result.ok)
                    sent.push('sms');
                else
                    errors.push(`SMS: ${result.error}`);
            }));
        }
        await Promise.all(jobs);
        const missing = channels.filter((c) => !sent.includes(c));
        if (sent.length === 0) {
            return {
                ok: false,
                status: 502,
                error: `Could not send OTP (${errors.join('; ') || 'WhatsApp and SMS both failed'}). Try again in a moment.`,
            };
        }
        // Prefer both channels, but do not block login/register if one provider is down.
        if (requireBoth && missing.length > 0) {
            console.warn(
                `[OTP ${purpose}] ${phone} partial delivery — missing ${missing.join(' and ')} (${errors.join('; ') || 'unknown'})`,
            );
        }
        const channel = toDeliveryChannel(sent);
        console.log(`[OTP ${purpose}] ${phone} → ${channel}`);
        return {
            ok: true,
            code,
            channel,
            expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        };
    }
    if (!demoFallback) {
        return {
            ok: false,
            status: 503,
            error: 'OTP delivery is not configured. Set OneChatting and/or Fast2SMS credentials.',
        };
    }
    console.log(`[OTP ${purpose}] ${phone} → ${code} (demo fallback)`);
    return {
        ok: true,
        code,
        channel: 'demo',
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    };
}
ensureUploadsDir();
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(
    '/uploads',
    express.static(UPLOADS_DIR, { fallthrough: true }),
    async (req, res, next) => {
        const fallbackBase = (process.env.UPLOADS_FALLBACK_BASE || '').replace(/\/$/, '');
        if (!fallbackBase) {
            res.status(404).end();
            return;
        }
        const file = path.basename(req.path || '');
        if (!file || file.includes('..')) {
            res.status(404).end();
            return;
        }
        const remoteUrl = `${fallbackBase}/uploads/${encodeURIComponent(file)}`;
        try {
            const remote = await fetch(remoteUrl);
            if (!remote.ok) {
                res.status(404).end();
                return;
            }
            const contentType = remote.headers.get('content-type') || 'application/octet-stream';
            const buffer = Buffer.from(await remote.arrayBuffer());
            const localPath = path.join(UPLOADS_DIR, file);
            try {
                fs.writeFileSync(localPath, buffer);
            }
            catch {
                // cache is best-effort
            }
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.send(buffer);
        }
        catch (err) {
            console.error('[uploads] fallback failed', remoteUrl, err);
            next();
        }
    },
);
/** Require shops.action_confirm_code for edit/delete (dev default 123456). */
function requireActionConfirmCode(req, res, state) {
    const code = String(req.body?.confirmCode ?? '').replace(/\D/g, '').slice(0, 6);
    const expected = getActionConfirmCode(state.appId);
    if (!code || code !== expected) {
        res.status(403).json({ error: 'Invalid confirmation code' });
        return false;
    }
    return true;
}
app.get('/api/health', (_req, res) => {
    res.json({ ok: true, openingBalance: true });
});

/** Public: latest Android/app build for in-app update prompt. */
app.get('/api/app/version', (_req, res) => {
    res.json(getAppVersionInfo());
});

function publicJoinBaseUrl(req) {
    const configured = (process.env.PUBLIC_JOIN_BASE || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
    if (configured)
        return configured;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
    if (host)
        return `${proto}://${host}`;
    return 'https://onebookserver.onesaasbackend.com';
}

/** Shopkeeper: get this shop’s unique customer-join QR URL. */
app.get('/api/shop/join-qr', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!state.setupComplete || !state.appId) {
        res.status(400).json({ error: 'Complete shop setup first' });
        return;
    }
    if (req.account.shopAppId && req.account.shopAppId !== state.appId) {
        res.status(403).json({ error: 'Shop mismatch — sign in again' });
        return;
    }
    const joinUrl = `${publicJoinBaseUrl(req)}/join/${encodeURIComponent(state.appId)}`;
    res.json({
        appId: state.appId,
        shopName: state.shopName,
        joinUrl,
    });
});

/** Public: shop info for join page. */
app.get('/api/public/join/:appId', (req, res) => {
    const appId = String(req.params.appId || '').trim();
    const shop = getShopByAppId(appId);
    if (!shop || !shop.setupComplete) {
        res.status(404).json({ error: 'Shop not found' });
        return;
    }
    res.json({
        appId: shop.appId,
        shopName: shop.shopName,
    });
});

/** Public: customer self-registers into a specific shop via QR. */
app.post('/api/public/join/:appId', async (req, res) => {
    const appId = String(req.params.appId || '').trim();
    const shop = getShopByAppId(appId);
    if (!shop || !shop.setupComplete) {
        res.status(404).json({ error: 'Shop not found' });
        return;
    }
    const name = String(req.body?.name ?? '').trim();
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }
    if (!isValidPhone(phone)) {
        res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
        return;
    }
    if (shop.users.some((u) => u.role === 'customer' && normalizePhone(u.phone) === phone)) {
        res.status(409).json({ error: 'This mobile is already linked to this shop' });
        return;
    }
    const auth = loadAuth();
    if (auth.accounts.some((a) => a.role === 'customer' && normalizePhone(a.phone) === phone && a.shopAppId === shop.appId)) {
        res.status(409).json({
            error: 'This mobile is already linked to this shop. Login with OTP instead.',
        });
        return;
    }
    try {
        if (await phoneExistsInShop(phone, shop.appId)) {
            res.status(409).json({ error: 'This mobile is already linked to this shop' });
            return;
        }
    }
    catch (err) {
        console.error('[join] phone lookup failed', err);
        res.status(500).json({ error: 'Could not validate mobile number' });
        return;
    }
    const userId = newId();
    const createdAt = new Date().toISOString();
    const user = {
        id: userId,
        name,
        phone,
        email: null,
        role: 'customer',
        createdAt,
    };
    shop.users.push(user);
    try {
        saveShopByAppId(shop);
        auth.accounts.push({
            id: userId,
            name,
            phone,
            email: null,
            role: 'customer',
            shopAppId: shop.appId,
            phoneVerified: false,
            createdAt,
        });
        saveAuth(auth);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Duplicate|ER_DUP_ENTRY/i.test(msg)) {
            res.status(409).json({ error: 'This mobile is already linked to this shop' });
            return;
        }
        console.error('[join] create failed', err);
        res.status(500).json({ error: 'Could not save customer' });
        return;
    }
    res.status(201).json({
        ok: true,
        shopName: shop.shopName,
        customer: { id: userId, name, phone },
        message: `Connected to ${shop.shopName}. You can login with OTP using ${phone}.`,
    });
});

/** Public HTML join page (works when customers scan QR from phone camera). */
app.get('/join/:appId', (req, res) => {
    const appId = String(req.params.appId || '').trim();
    const shop = getShopByAppId(appId);
    const shopName = shop?.setupComplete ? shop.shopName : '';
    res.type('html').send(buildJoinPageHtml({ appId, shopName }));
});

function shopPublic(state) {
    return {
        appId: state.appId,
        shopName: state.shopName,
        shopAddress: state.shopAddress ?? '',
        setupComplete: state.setupComplete,
    };
}
app.post('/api/auth/register', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    const shopName = String(req.body?.shopName ?? '').trim();
    const shopAddress = String(req.body?.shopAddress ?? '').trim();
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }
    if (!shopName) {
        res.status(400).json({ error: 'Business name is required' });
        return;
    }
    if (shopName.length > 80) {
        res.status(400).json({ error: 'Business name is too long' });
        return;
    }
    if (!shopAddress) {
        res.status(400).json({ error: 'Business address is required' });
        return;
    }
    if (shopAddress.length > 240) {
        res.status(400).json({ error: 'Business address is too long' });
        return;
    }
    if (!isValidPhone(phone)) {
        res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
        return;
    }
    const auth = loadAuth();
    const existing = auth.accounts.find((a) => a.phone === phone);
    if (existing?.phoneVerified) {
        res.status(409).json({ error: 'Phone already registered. Please login.' });
        return;
    }
    const issued = await issueOtp(phone, 'register');
    if (!issued.ok) {
        res.status(issued.status).json({ error: issued.error });
        return;
    }
    // Replace any previous pending registration / OTP for this phone
    auth.pendingRegistrations = auth.pendingRegistrations.filter((p) => p.phone !== phone);
    auth.otps = auth.otps.filter((o) => o.phone !== phone);
    auth.pendingRegistrations.push({
        name,
        phone,
        shopName,
        shopAddress,
        role: 'shopkeeper',
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + OTP_TTL_MS,
    });
    auth.otps.push({
        phone,
        code: issued.code,
        purpose: 'register',
        expiresAt: Date.now() + OTP_TTL_MS,
    });
    saveAuth(auth);
    res.status(201).json({
        message: otpSentMessage(issued.channel, 'register'),
        phone,
        channel: issued.channel,
        ...(issued.channel === 'demo' ? { devOtp: issued.code } : {}),
        expiresInSeconds: issued.expiresInSeconds,
    });
});
app.post('/api/auth/verify-register', (req, res) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    const code = String(req.body?.otp ?? '').trim();
    if (!isValidPhone(phone) || !/^\d{6}$/.test(code)) {
        res.status(400).json({ error: 'Valid phone and 6-digit OTP are required' });
        return;
    }
    const auth = loadAuth();
    const pending = auth.pendingRegistrations.find((p) => p.phone === phone);
    if (!pending || pending.expiresAt < Date.now()) {
        res.status(400).json({ error: 'Registration expired. Please register again.' });
        return;
    }
    const otp = auth.otps.find((o) => o.phone === phone && o.purpose === 'register');
    if (!otp || otp.expiresAt < Date.now() || otp.code !== code) {
        res.status(401).json({ error: 'Invalid or expired OTP' });
        return;
    }
    // Remove unfinished shopkeeper drafts for this phone only (keep other profiles)
    auth.accounts = auth.accounts.filter((a) => !(a.phone === phone && a.role === 'shopkeeper' && !a.shopAppId && !a.phoneVerified));
    if (auth.accounts.some((a) => a.phone === phone && a.role === 'shopkeeper' && a.phoneVerified)) {
        res.status(409).json({ error: 'Phone already has a business. Login and open Create business.' });
        return;
    }
    const account = {
        id: newId(),
        name: pending.name,
        phone: pending.phone,
        email: null,
        role: pending.role,
        shopAppId: null,
        phoneVerified: true,
        createdAt: new Date().toISOString(),
    };
    // Create this shopkeeper's shop draft (multi-tenant: each admin gets their own shop)
    const draft = ensureShopkeeperDraft(account, {
        shopName: pending.shopName,
        shopAddress: pending.shopAddress,
    });
    account.shopAppId = draft.appId;
    auth.accounts.push(account);
    auth.pendingRegistrations = auth.pendingRegistrations.filter((p) => p.phone !== phone);
    auth.otps = auth.otps.filter((o) => o.phone !== phone);
    saveAuth(auth);
    const token = createSession(account.id);
    saveState(draft, account);
    res.status(201).json({
        message: 'Registration confirmed',
        token,
        account: publicAccount(account),
        shop: shopPublic(draft),
    });
});
app.post('/api/auth/request-otp', async (req, res) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    if (!isValidPhone(phone)) {
        res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
        return;
    }
    const auth = loadAuth();
    const accounts = auth.accounts.filter((a) => a.phone === phone);
    if (accounts.length === 0) {
        res.status(404).json({ error: 'Phone not registered. Please register first.' });
        return;
    }
    const issued = await issueOtp(phone, 'login');
    if (!issued.ok) {
        res.status(issued.status).json({ error: issued.error });
        return;
    }
    auth.otps = auth.otps.filter((o) => !(o.phone === phone && o.purpose === 'login'));
    auth.otps.push({
        phone,
        code: issued.code,
        purpose: 'login',
        expiresAt: Date.now() + OTP_TTL_MS,
    });
    saveAuth(auth);
    res.json({
        message: otpSentMessage(issued.channel, 'login'),
        phone,
        channel: issued.channel,
        ...(issued.channel === 'demo' ? { devOtp: issued.code } : {}),
        expiresInSeconds: issued.expiresInSeconds,
        profileCount: accounts.length,
    });
});
app.post('/api/auth/verify-otp', (req, res) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    const code = String(req.body?.otp ?? '').trim();
    if (!isValidPhone(phone) || !/^\d{6}$/.test(code)) {
        res.status(400).json({ error: 'Valid phone and 6-digit OTP are required' });
        return;
    }
    const auth = loadAuth();
    const otp = auth.otps.find((o) => o.phone === phone && o.purpose === 'login');
    if (!otp || otp.expiresAt < Date.now() || otp.code !== code) {
        res.status(401).json({ error: 'Invalid or expired OTP' });
        return;
    }
    const matches = auth.accounts
        .map((a, idx) => ({ a, idx }))
        .filter(({ a }) => a.phone === phone);
    if (matches.length === 0) {
        res.status(404).json({ error: 'Account not found' });
        return;
    }
    for (const { idx } of matches) {
        auth.accounts[idx] = { ...auth.accounts[idx], phoneVerified: true };
    }
    auth.otps = auth.otps.filter((o) => !(o.phone === phone && o.purpose === 'login'));
    saveAuth(auth);
    const profileTicket = issueProfileTicket(phone);
    const profiles = profilesForPhone(phone);
    res.json({
        profileTicket,
        phone,
        profiles,
        expiresInSeconds: 15 * 60,
    });
});
app.post('/api/auth/select-profile', (req, res) => {
    const ticket = String(req.body?.profileTicket ?? '');
    const accountId = String(req.body?.accountId ?? '');
    const phone = peekProfileTicket(ticket);
    if (!phone) {
        res.status(401).json({ error: 'Session expired. Please login again.' });
        return;
    }
    const auth = loadAuth();
    const account = auth.accounts.find((a) => a.id === accountId && a.phone === phone);
    if (!account) {
        res.status(404).json({ error: 'Profile not found for this mobile' });
        return;
    }
    consumeProfileTicket(ticket);
    const token = createSession(account.id);
    const state = loadState(account);
    res.json({
        token,
        account: publicAccount(account),
        shop: shopPublic(state),
        message: account.role === 'shopkeeper' ? `Opened ${state.shopName || 'your business'}` : `Opened as customer · ${state.shopName || 'shop'}`,
    });
});
app.post('/api/auth/create-shop', (req, res) => {
    const ticket = String(req.body?.profileTicket ?? '');
    const shopName = String(req.body?.shopName ?? '').trim();
    const shopAddress = String(req.body?.shopAddress ?? '').trim();
    let name = String(req.body?.name ?? '').trim();
    let phone = peekProfileTicket(ticket);
    let fromAuth = false;
    if (!phone) {
        // Allow logged-in users to add another business
        const header = req.headers.authorization ?? '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (bearer) {
            const auth = loadAuth();
            const session = auth.sessions.find((s) => s.token === bearer && s.expiresAt > Date.now());
            const account = session ? auth.accounts.find((a) => a.id === session.userId) : null;
            if (account) {
                phone = account.phone;
                if (!name) name = account.name;
                fromAuth = true;
            }
        }
    }
    if (!phone) {
        res.status(401).json({ error: 'Session expired. Please login again.' });
        return;
    }
    if (!shopName) {
        res.status(400).json({ error: 'Business name is required' });
        return;
    }
    if (shopName.length > 80) {
        res.status(400).json({ error: 'Business name is too long' });
        return;
    }
    if (!shopAddress) {
        res.status(400).json({ error: 'Business address is required' });
        return;
    }
    if (shopAddress.length > 240) {
        res.status(400).json({ error: 'Business address is too long' });
        return;
    }
    const auth = loadAuth();
    const siblings = auth.accounts.filter((a) => a.phone === phone);
    if (!name) {
        name = siblings[0]?.name || 'Owner';
    }
    if (name.length < 2) {
        res.status(400).json({ error: 'Enter a valid name (at least 2 characters)' });
        return;
    }
    const createdAt = new Date().toISOString();
    const account = {
        id: newId(),
        name,
        phone,
        email: siblings[0]?.email ?? null,
        role: 'shopkeeper',
        shopAppId: null,
        phoneVerified: true,
        createdAt,
    };
    auth.accounts.push(account);
    saveAuth(auth);
    const draft = ensureShopkeeperDraft(account, { shopName, shopAddress });
    account.shopAppId = draft.appId;
    const auth2 = loadAuth();
    const idx = auth2.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
        auth2.accounts[idx] = { ...auth2.accounts[idx], shopAppId: draft.appId };
        saveAuth(auth2);
    }
    saveShopByAppId(draft);
    if (ticket) consumeProfileTicket(ticket);
    const token = createSession(account.id);
    res.status(201).json({
        token,
        account: publicAccount({ ...account, shopAppId: draft.appId }),
        shop: shopPublic(draft),
        message: `Business “${shopName}” created`,
        fromAuth,
    });
});
app.get('/api/auth/profiles', requireAuth, (req, res) => {
    res.json({
        phone: req.account.phone,
        profiles: profilesForPhone(req.account.phone),
        activeAccountId: req.account.id,
    });
});
app.post('/api/auth/switch-profile', requireAuth, (req, res) => {
    const accountId = String(req.body?.accountId ?? '');
    const auth = loadAuth();
    const account = auth.accounts.find((a) => a.id === accountId && a.phone === req.account.phone);
    if (!account) {
        res.status(404).json({ error: 'Profile not found for this mobile' });
        return;
    }
    const token = createSession(account.id);
    const state = loadState(account);
    res.json({
        token,
        account: publicAccount(account),
        shop: shopPublic(state),
        message: account.role === 'shopkeeper' ? `Switched to ${state.shopName || 'business'}` : `Switched to customer · ${state.shopName || 'shop'}`,
    });
});
app.get('/api/auth/me', requireAuth, (req, res) => {
    const state = loadState(req.account);
    res.json({
        account: publicAccount(req.account),
        shop: shopPublic(state),
    });
});
app.put('/api/auth/profile', requireAuth, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const name = String(req.body?.name ?? '').trim();
    const emailRaw = req.body?.email;
    const email = emailRaw === undefined || emailRaw === null ? undefined : String(emailRaw).trim().toLowerCase();
    const shopNameRaw = req.body?.shopName;
    const shopName = shopNameRaw === undefined || shopNameRaw === null ? undefined : String(shopNameRaw).trim();
    const shopAddressRaw = req.body?.shopAddress;
    const shopAddress = shopAddressRaw === undefined || shopAddressRaw === null
        ? undefined
        : String(shopAddressRaw).trim();
    if (!name || name.length < 2) {
        res.status(400).json({ error: 'Enter a valid name (at least 2 characters)' });
        return;
    }
    if (name.length > 60) {
        res.status(400).json({ error: 'Name is too long' });
        return;
    }
    if (email !== undefined && email !== '') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            res.status(400).json({ error: 'Enter a valid email address' });
            return;
        }
        if (email.length > 120) {
            res.status(400).json({ error: 'Email is too long' });
            return;
        }
    }
    const account = req.account;
    if (shopName !== undefined) {
        if (account.role !== 'shopkeeper') {
            res.status(403).json({ error: 'Only the shopkeeper can edit the shop name' });
            return;
        }
        if (!shopName) {
            res.status(400).json({ error: 'Shop name is required' });
            return;
        }
        if (shopName.length > 80) {
            res.status(400).json({ error: 'Shop name is too long' });
            return;
        }
    }
    if (shopAddress !== undefined) {
        if (account.role !== 'shopkeeper') {
            res.status(403).json({ error: 'Only the shopkeeper can edit the business address' });
            return;
        }
        if (!shopAddress) {
            res.status(400).json({ error: 'Business address is required' });
            return;
        }
        if (shopAddress.length > 240) {
            res.status(400).json({ error: 'Business address is too long' });
            return;
        }
    }
    const auth = loadAuth();
    const idx = auth.accounts.findIndex((a) => a.id === account.id);
    if (idx < 0) {
        res.status(404).json({ error: 'Account not found' });
        return;
    }
    auth.accounts[idx] = {
        ...auth.accounts[idx],
        name,
        ...(email !== undefined ? { email: email || null } : {}),
    };
    saveAuth(auth);
    state.users = state.users.map((u) => {
        if (u.id === account.id || (account.phone && u.phone === account.phone)) {
            return { ...u, name };
        }
        return u;
    });
    if (shopName !== undefined) {
        state.shopName = shopName;
    }
    if (shopAddress !== undefined) {
        state.shopAddress = shopAddress;
    }
    saveState(state, req.account);
    const updated = auth.accounts[idx];
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({
        account: publicAccount(updated),
        shop: shopPublic(state),
        state,
        ...totals,
    });
});
app.post('/api/auth/logout', requireAuth, (req, res) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const auth = loadAuth();
    auth.sessions = auth.sessions.filter((s) => s.token !== token);
    saveAuth(auth);
    res.json({ ok: true });
});
app.get('/api/state', requireAuth, async (req, res) => {
    const account = req.account;
    const state = loadState(account);
    if (account.role === 'shopkeeper') {
        if (account.shopAppId && state.appId && account.shopAppId !== state.appId) {
            res.status(403).json({ error: 'Shop mismatch — sign in again' });
            return;
        }
        if (state.setupComplete) {
            const member = state.users.some((u) => u.id === account.id);
            if (!member) {
                res.status(403).json({ error: 'Not a member of this shop' });
                return;
            }
        }
    }
    const generated = materializeRecurringBillings(state);
    let loanGenerated = 0;
    try {
        loanGenerated = await materializeLoanEmis(state);
    }
    catch (err) {
        console.warn('[loans] materialize on state load failed:', err instanceof Error ? err.message : err);
    }
    if (generated > 0 || loanGenerated > 0)
        saveState(state, account);
    if (account.role === 'customer') {
        if (!account.shopAppId || account.shopAppId !== state.appId) {
            res.status(403).json({ error: 'Not linked to this shop' });
            return;
        }
        const myTx = state.transactions.filter((t) => t.customerId === account.id ||
            t.userId === account.id ||
            (account.phone && t.customerPhone === account.phone) ||
            (account.phone && t.remarks.includes(account.phone)));
        const totalReceipts = myTx
            .filter((t) => t.type === 'receipt')
            .reduce((sum, t) => sum + t.amount, 0);
        const totalPayments = myTx
            .filter((t) => t.type === 'payment')
            .reduce((sum, t) => sum + t.amount, 0);
        const liveBalance = totalReceipts - totalPayments;
        res.json({
            state: {
                ...state,
                openingBalance: 0,
                transactions: myTx,
                recurringBillings: state.recurringBillings.filter((billing) => billing.customerId === account.id),
                users: state.users.filter((u) => u.id === account.id),
                todos: [],
                services: [],
            },
            totalReceipts,
            totalPayments,
            // Customer perspective: opposite of shop receivable
            liveBalance,
            account: publicAccount(account),
        });
        return;
    }
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, ...totals, account: publicAccount(account) });
});
app.post('/api/setup', requireShopkeeper, (req, res) => {
    const { shopName, shopAddress, openingBalance } = req.body;
    const account = req.account;
    const existing = loadState(account);
    const resolvedName = (shopName?.trim() || existing.shopName || '').trim();
    const resolvedAddress = (shopAddress?.trim() || existing.shopAddress || '').trim();
    if (!resolvedName) {
        res.status(400).json({ error: 'Shop name is required' });
        return;
    }
    if (!resolvedAddress) {
        res.status(400).json({ error: 'Business address is required' });
        return;
    }
    const balance = Number(openingBalance);
    if (Number.isNaN(balance) || balance < 0) {
        res.status(400).json({ error: 'Invalid opening balance' });
        return;
    }
    const createdAt = existing.createdAt || new Date().toISOString();
    const appId = existing.appId || emptyState().appId;
    const cashAccount = defaultCashAccount(balance, createdAt, appId);
    const state = ensureCashAccounts({
        ...emptyState(),
        appId,
        shopName: resolvedName,
        shopAddress: resolvedAddress,
        // Shop opening balance = Cash account starting balance
        openingBalance: balance,
        cashAccounts: [cashAccount],
        users: [
            {
                id: account.id,
                name: account.name,
                phone: account.phone,
                role: 'shopkeeper',
                createdAt: account.createdAt,
            },
        ],
        activeUserId: account.id,
        setupComplete: true,
        createdAt,
    });
    // Keep Cash account opening balance locked to the setup value.
    const systemCash = state.cashAccounts.find((a) => a.isSystem || isSystemCashAccountId(a.id));
    if (systemCash)
        systemCash.openingBalance = balance;
    state.openingBalance = balance;
    const auth = loadAuth();
    const idx = auth.accounts.findIndex((a) => a.id === account.id);
    if (idx >= 0) {
        auth.accounts[idx] = { ...auth.accounts[idx], shopAppId: state.appId };
    }
    saveAuth(auth);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.status(201).json({
        state,
        ...totals,
        account: publicAccount(auth.accounts[idx] ?? account),
    });
});
app.post('/api/users', requireShopkeeper, async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    const email = String(req.body?.email ?? '')
        .trim()
        .toLowerCase();
    const role = String(req.body?.role ?? 'customer') || 'customer';
    /** Signed opening: +receivable (they owe you), −payable (you owe them). */
    const openingBalance = parseCustomerOpeningBalance(req.body);
    if (openingBalance === null) {
        res.status(400).json({ error: 'Invalid opening balance' });
        return;
    }
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }
    if (role !== 'shopkeeper' && role !== 'customer') {
        res.status(400).json({ error: 'Invalid role' });
        return;
    }
    if (role === 'customer' && !isValidPhone(phone)) {
        res.status(400).json({ error: 'Customer mobile number (10 digits) is required' });
        return;
    }
    if (phone && !isValidPhone(phone)) {
        res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
        return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Enter a valid email address' });
        return;
    }
    const state = loadState(req.account);
    if (!state.setupComplete) {
        res.status(400).json({ error: 'Complete setup first' });
        return;
    }
    if (phone && state.users.some((u) => u.role === 'customer' && normalizePhone(u.phone) === phone)) {
        res.status(409).json({ error: 'This mobile number is already added in this shop' });
        return;
    }
    const auth = loadAuth();
    if (phone && auth.accounts.some((a) => a.role === 'customer' && normalizePhone(a.phone) === phone && a.shopAppId === state.appId)) {
        res.status(409).json({
            error: 'This mobile number is already linked to this shop. Ask them to login with OTP.',
        });
        return;
    }
    try {
        if (phone && (await phoneExistsInShop(phone, state.appId))) {
            res.status(409).json({
                error: 'This mobile number is already linked to this shop',
            });
            return;
        }
    }
    catch (err) {
        console.error('[users] phone lookup failed', err);
        res.status(500).json({ error: 'Could not validate mobile number' });
        return;
    }
    const userId = newId();
    const createdAt = new Date().toISOString();
    const user = {
        id: userId,
        name,
        phone,
        email: email || null,
        role,
        openingBalance: role === 'customer' ? openingBalance : 0,
        createdAt,
    };
    state.users.push(user);
    if (!state.activeUserId && role === 'shopkeeper')
        state.activeUserId = user.id;
    try {
        saveState(state, req.account);
        if (phone) {
            auth.accounts.push({
                id: userId,
                name,
                phone,
                email: email || null,
                role,
                shopAppId: state.appId,
                phoneVerified: false,
                createdAt,
            });
            saveAuth(auth);
        }
        // Durable opening write only — do not await full shop flush (too slow on Hostinger).
        if (role === 'customer') {
            await writeCustomerOpeningBalance(userId, openingBalance);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Duplicate|ER_DUP_ENTRY/i.test(msg)) {
            res.status(409).json({ error: 'This mobile number is already linked to this shop' });
            return;
        }
        console.error('[users] create failed', err);
        res.status(500).json({ error: 'Could not add customer' });
        return;
    }
    res.status(201).json({
        state,
        user,
        loginReady: Boolean(phone),
        message: phone
            ? `${name} can login with OTP using ${phone}`
            : 'Customer added',
    });
});
app.put('/api/users/active', requireShopkeeper, (req, res) => {
    const id = String(req.body?.id ?? '');
    const state = loadState(req.account);
    const user = state.users.find((u) => u.id === id);
    if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    if (user.role !== 'shopkeeper') {
        res.status(400).json({ error: 'Only shopkeepers can record transactions' });
        return;
    }
    state.activeUserId = id;
    saveState(state, req.account);
    res.json({ state });
});
app.put('/api/users/:id', requireShopkeeper, async (req, res) => {
    const stateForCode = loadState(req.account);
    if (!requireActionConfirmCode(req, res, stateForCode))
        return;
    const id = String(req.params.id);
    const name = String(req.body?.name ?? '').trim();
    const phone = normalizePhone(String(req.body?.phone ?? ''));
    const email = String(req.body?.email ?? '')
        .trim()
        .toLowerCase();
    const openingBalance = parseCustomerOpeningBalance(req.body);
    if (openingBalance === null) {
        res.status(400).json({ error: 'Invalid opening balance' });
        return;
    }
    if (!name || name.length < 2) {
        res.status(400).json({ error: 'Enter a valid name' });
        return;
    }
    if (!isValidPhone(phone)) {
        res.status(400).json({ error: 'Customer mobile number (10 digits) is required' });
        return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Enter a valid email address' });
        return;
    }
    const state = loadState(req.account);
    const idx = state.users.findIndex((u) => u.id === id);
    if (idx < 0) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    const target = state.users[idx];
    if (target.role === 'shopkeeper') {
        res.status(400).json({ error: 'Edit shopkeeper details from Profile' });
        return;
    }
    const phoneUnchanged = normalizePhone(target.phone) === phone;
    if (!phoneUnchanged) {
        if (state.users.some((u) => u.id !== id && u.role === 'customer' && normalizePhone(u.phone) === phone)) {
            res.status(409).json({ error: 'This mobile number is already used by another customer in this shop' });
            return;
        }
        const auth = loadAuth();
        if (auth.accounts.some((a) => a.id !== id && a.role === 'customer' && normalizePhone(a.phone) === phone && a.shopAppId === state.appId)) {
            res.status(409).json({ error: 'This mobile number is already used in this shop' });
            return;
        }
        try {
            if (await phoneExistsInShop(phone, state.appId, id)) {
                res.status(409).json({ error: 'This mobile number is already used in this shop' });
                return;
            }
        }
        catch (err) {
            console.error('[users] phone lookup failed', err);
            res.status(500).json({ error: 'Could not validate mobile number' });
            return;
        }
    }
    const auth = loadAuth();
    const prevPhone = target.phone;
    const updated = {
        ...target,
        name,
        phone,
        email: email || null,
        openingBalance,
    };
    state.users[idx] = updated;
    state.transactions = state.transactions.map((t) => {
        if (t.customerId !== id && !(prevPhone && t.customerPhone === prevPhone))
            return t;
        return {
            ...t,
            customerId: id,
            customerName: name,
            customerPhone: phone,
        };
    });
    state.recurringBillings = state.recurringBillings.map((billing) => billing.customerId === id
        ? {
            ...billing,
            customerName: name,
            customerPhone: phone,
            updatedAt: new Date().toISOString(),
        }
        : billing);
    try {
        saveState(state, req.account);
        const authIdx = auth.accounts.findIndex((a) => a.id === id);
        if (authIdx >= 0) {
            const phoneChanged = normalizePhone(auth.accounts[authIdx].phone) !== phone;
            auth.accounts[authIdx] = {
                ...auth.accounts[authIdx],
                name,
                phone,
                email: email || null,
                ...(phoneChanged ? { phoneVerified: false } : {}),
            };
            saveAuth(auth);
        }
        else if (phone) {
            auth.accounts.push({
                id,
                name,
                phone,
                email: email || null,
                role: 'customer',
                shopAppId: state.appId,
                phoneVerified: false,
                createdAt: target.createdAt,
            });
            saveAuth(auth);
        }
        // Fast durable write — respond without waiting for full shop rewrite.
        await writeCustomerOpeningBalance(id, openingBalance);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Duplicate|ER_DUP_ENTRY/i.test(msg)) {
            res.status(409).json({ error: 'This mobile number is already used in this shop' });
            return;
        }
        console.error('[users] update failed', err);
        res.status(500).json({ error: 'Could not update customer' });
        return;
    }
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, user: updated, ...totals });
});
app.delete('/api/users/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const id = String(req.params.id);
    const target = state.users.find((u) => u.id === id);
    if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
    }
    if (target.role === 'shopkeeper' && state.users.filter((u) => u.role === 'shopkeeper').length <= 1) {
        res.status(400).json({ error: 'At least one shopkeeper is required' });
        return;
    }
    if (target.role === 'customer') {
        const hasTx = state.transactions.some((t) => t.customerId === id ||
            (target.phone && t.customerPhone === target.phone) ||
            (target.phone && t.remarks.includes(target.phone)));
        if (hasTx) {
            res.status(400).json({
                error: 'Cannot delete customer with transactions. Only customers with no entries can be removed.',
            });
            return;
        }
        if (state.recurringBillings.some((billing) => billing.customerId === id)) {
            res.status(400).json({
                error: 'Delete this customer’s recurring billing schedules first.',
            });
            return;
        }
    }
    state.users = state.users.filter((u) => u.id !== id);
    if (state.activeUserId === id) {
        state.activeUserId = state.users.find((u) => u.role === 'shopkeeper')?.id ?? state.users[0]?.id ?? null;
    }
    saveState(state, req.account);
    const auth = loadAuth();
    auth.accounts = auth.accounts.filter((a) => a.id !== id);
    auth.sessions = auth.sessions.filter((s) => s.userId !== id);
    saveAuth(auth);
    res.json({ state });
});
app.post('/api/recurring-billings', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const customerId = String(req.body?.customerId ?? '');
    const amount = Number(req.body?.amount);
    const remarks = String(req.body?.remarks ?? '').trim();
    const interval = String(req.body?.interval ?? '');
    const effectiveDate = String(req.body?.effectiveDate ?? '');
    const transactionCategory = String(req.body?.transactionCategory ?? 'sales') === 'purchase' ? 'purchase' : 'sales';
    const serviceLookup = resolveService(state, req.body?.serviceId);
    const customer = state.users.find((user) => user.id === customerId && user.role === 'customer') ?? null;
    if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
    }
    if (!serviceLookup.ok) {
        res.status(404).json({ error: serviceLookup.error });
        return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'Billing amount must be greater than 0' });
        return;
    }
    const note = remarks || (serviceLookup.service ? serviceRemarks(serviceLookup.service) : '');
    if (!note) {
        res.status(400).json({ error: 'Billing description is required' });
        return;
    }
    if (!RECURRING_INTERVALS.includes(interval)) {
        res.status(400).json({ error: 'Invalid recurring interval' });
        return;
    }
    if (!isDateOnly(effectiveDate)) {
        res.status(400).json({ error: 'Enter a valid billing period' });
        return;
    }
    const billingDate = String(req.body?.billingDate ?? billingDateForPeriod(effectiveDate, interval, 1));
    if (!isDateOnly(billingDate) || !isBillingDateAllowed(effectiveDate, billingDate)) {
        res.status(400).json({ error: 'Billing date must be on or after the period start' });
        return;
    }
    const today = localDateString();
    let autoBilling = req.body?.autoBilling !== false;
    if (billingDate < today) {
        autoBilling = false;
    }
    const billing = createRecurringBilling({
        account: req.account,
        customer,
        amount,
        remarks: note,
        interval,
        effectiveDate,
        billingDate,
        transactionCategory,
        autoBilling,
        serviceId: serviceLookup.service?.id ?? null,
        serviceName: serviceLookup.service?.name ?? null,
    });
    state.recurringBillings.unshift(billing);
    materializeRecurringBillings(state);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.status(201).json({ state, recurringBilling: billing, ...totals });
});
app.put('/api/recurring-billings/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const index = state.recurringBillings.findIndex((billing) => billing.id === req.params.id);
    if (index < 0) {
        res.status(404).json({ error: 'Recurring billing not found' });
        return;
    }
    const current = state.recurringBillings[index];
    const amount = req.body?.amount === undefined ? current.amount : Number(req.body.amount);
    const remarks = req.body?.remarks === undefined ? current.remarks : String(req.body.remarks).trim();
    const interval = (req.body?.interval === undefined ? current.interval : String(req.body.interval));
    const effectiveDate = req.body?.effectiveDate === undefined
        ? current.effectiveDate
        : String(req.body.effectiveDate);
    const transactionCategory = req.body?.transactionCategory === undefined
        ? current.transactionCategory
        : String(req.body.transactionCategory) === 'purchase'
            ? 'purchase'
            : 'sales';
    let autoBilling = req.body?.autoBilling === undefined ? current.autoBilling : Boolean(req.body.autoBilling);
    const serviceLookup = resolveService(state, req.body?.serviceId === undefined ? current.serviceId : req.body.serviceId);
    if (!serviceLookup.ok) {
        res.status(404).json({ error: serviceLookup.error });
        return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'Billing amount must be greater than 0' });
        return;
    }
    const note = remarks || (serviceLookup.service ? serviceRemarks(serviceLookup.service) : '');
    if (!note) {
        res.status(400).json({ error: 'Billing description is required' });
        return;
    }
    if (!RECURRING_INTERVALS.includes(interval)) {
        res.status(400).json({ error: 'Invalid recurring interval' });
        return;
    }
    if (!isDateOnly(effectiveDate)) {
        res.status(400).json({ error: 'Enter a valid billing period' });
        return;
    }
    // Prefer explicit bill/due date from the client. Fall back to delay-based date
    // for the period being edited (form sends next period start as effectiveDate).
    const hasBillingDate = req.body?.billingDate !== undefined && req.body?.billingDate !== null && req.body?.billingDate !== '';
    const billingDate = hasBillingDate
        ? String(req.body.billingDate)
        : billingDateForPeriod(effectiveDate, interval, Number(current.billingDelayDays) || 0);
    const billingDelayDays = daysAfterPeriodEnd(effectiveDate, interval, billingDate);
    if (!isDateOnly(billingDate) || !isBillingDateAllowed(effectiveDate, billingDate)) {
        res.status(400).json({ error: 'Billing date must be on or after the period start' });
        return;
    }
    if (billingDate < localDateString()) {
        autoBilling = false;
    }
    const currentDelay = Number(current.billingDelayDays) || 0;
    const scheduleChanged = interval !== current.interval ||
        effectiveDate !== current.nextPeriodStartDate ||
        billingDate !== current.nextRunDate ||
        billingDelayDays !== currentDelay;
    const updated = {
        ...current,
        amount,
        remarks: note,
        serviceId: serviceLookup.service?.id ?? null,
        serviceName: serviceLookup.service?.name ?? null,
        transactionCategory,
        interval,
        // Keep original start once any period has been posted; otherwise adopt form period.
        effectiveDate: current.lastRunDate ? current.effectiveDate : effectiveDate,
        nextPeriodStartDate: scheduleChanged ? effectiveDate : current.nextPeriodStartDate,
        billingDelayDays,
        // Always apply bill/due date when the schedule definition or due date changed.
        nextRunDate: scheduleChanged ? billingDate : current.nextRunDate,
        autoBilling,
        updatedAt: new Date().toISOString(),
    };
    state.recurringBillings[index] = updated;
    materializeRecurringBillings(state);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, recurringBilling: updated, ...totals });
});
app.post('/api/recurring-billings/:id/stop', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const billing = state.recurringBillings.find((item) => item.id === req.params.id);
    if (!billing) {
        res.status(404).json({ error: 'Recurring billing not found' });
        return;
    }
    if (!billing.active) {
        res.status(400).json({ error: 'This schedule is already stopped' });
        return;
    }
    const minStopDate = lastGeneratedBillDate(state, billing);
    const stopDate = String(req.body?.stopDate || localDateString()).trim();
    if (!isDateOnly(stopDate)) {
        res.status(400).json({ error: 'Enter a valid stop date' });
        return;
    }
    if (stopDate < minStopDate) {
        res.status(400).json({
            error: `Stop date cannot be earlier than the last generated bill (${minStopDate}). Past ledger entries stay unchanged.`,
        });
        return;
    }
    // Deactivate schedule only — never rewrite/delete generated transactions.
    billing.active = false;
    billing.stopDate = stopDate;
    billing.updatedAt = new Date().toISOString();
    saveState(state, req.account);
    res.json({ state, recurringBilling: billing });
});
app.post('/api/recurring-billings/:id/post', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    const billing = state.recurringBillings.find((item) => item.id === req.params.id);
    if (!billing) {
        res.status(404).json({ error: 'Recurring billing not found' });
        return;
    }
    if (!billing.active) {
        res.status(400).json({ error: 'Resume this recurring billing before posting' });
        return;
    }
    if (billing.stopDate && billing.nextRunDate > billing.stopDate) {
        res.status(400).json({
            error: `This schedule stops on ${billing.stopDate}. No further bills can be posted.`,
        });
        return;
    }
    if (billing.nextRunDate > localDateString()) {
        res.status(400).json({
            error: `This bill is not due until ${billing.nextRunDate}`,
        });
        return;
    }
    const transaction = postNextRecurringBill(state, billing);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.status(201).json({ state, recurringBilling: billing, transaction, ...totals });
});
app.post('/api/recurring-billings/:id/resume', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const billing = state.recurringBillings.find((item) => item.id === req.params.id);
    if (!billing) {
        res.status(404).json({ error: 'Recurring billing not found' });
        return;
    }
    if (billing.active) {
        res.status(400).json({ error: 'This schedule is already active' });
        return;
    }
    const minBill = minResumeBillingDate(state, billing);
    const resumeBillingDate = String(req.body?.resumeBillingDate || req.body?.resumeDate || '').trim();
    const resumePeriodStart = String(
        req.body?.resumePeriodStart || req.body?.effectiveDate || resumeBillingDate,
    ).trim();
    if (!isDateOnly(resumeBillingDate)) {
        res.status(400).json({ error: 'Enter a valid resume bill date' });
        return;
    }
    if (!isDateOnly(resumePeriodStart)) {
        res.status(400).json({ error: 'Enter a valid resume period start' });
        return;
    }
    if (resumeBillingDate < minBill) {
        res.status(400).json({
            error: `Resume bill date cannot be earlier than ${minBill}. That keeps the stopped gap out of calculations and reports.`,
        });
        return;
    }
    try {
        applyResumeSchedule(billing, { resumePeriodStart, resumeBillingDate });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not resume' });
        return;
    }
    // Only materialize from the new resume cursor forward (never rewrites past entries).
    materializeRecurringBillings(state);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, recurringBilling: billing, ...totals });
});
app.delete('/api/recurring-billings/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const exists = state.recurringBillings.some((billing) => billing.id === req.params.id);
    if (!exists) {
        res.status(404).json({ error: 'Recurring billing not found' });
        return;
    }
    // Remove schedule only. Generated transactions remain normal ledger entries.
    state.recurringBillings = state.recurringBillings.filter((billing) => billing.id !== req.params.id);
    saveState(state, req.account);
    res.json({ state });
});

app.post('/api/loans/preview', requireShopkeeper, (req, res) => {
    try {
        const principal = Number(req.body?.principal);
        const interestRate = Number(req.body?.interestRate);
        const tenureMonths = Math.round(Number(req.body?.tenureMonths));
        const interestType = req.body?.interestType;
        const emiFrequency = req.body?.emiFrequency;
        const emiStartDate = String(req.body?.emiStartDate || req.body?.startDate || localDateString());
        const emiAmount = calculateEmi(principal, interestRate, tenureMonths, interestType, emiFrequency);
        const schedule = buildAmortizationSchedule(principal, interestRate, tenureMonths, emiStartDate, interestType, emiFrequency);
        res.json({
            emiAmount,
            schedule,
            interestType: interestType === 'flat' ? 'flat' : 'reducing',
            emiFrequency: emiFrequency === 'weekly' ? 'weekly' : 'monthly',
        });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid loan input' });
    }
});

app.get('/api/loans', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const loanGenerated = await materializeLoanEmis(state);
        if (loanGenerated > 0)
            saveState(state, req.account);
        const overview = await getShopLoanOverview(state);
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.json({ ...overview, state, ...totals });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load loans' });
    }
});

app.get('/api/customers/:customerId/loans', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const loanGenerated = await materializeLoanEmis(state);
        if (loanGenerated > 0)
            saveState(state, req.account);
        const loans = await listLoansForCustomer(state.appId, req.params.customerId);
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.json({ loans, state, ...totals });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load loans' });
    }
});

app.post('/api/customers/:customerId/loans', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const detail = await createCustomerLoan(state, req.account, {
            customerId: req.params.customerId,
            principal: req.body?.principal,
            interestRate: req.body?.interestRate,
            interestType: req.body?.interestType,
            emiFrequency: req.body?.emiFrequency,
            tenureMonths: req.body?.tenureMonths,
            loanDate: req.body?.loanDate || req.body?.startDate,
            emiStartDate: req.body?.emiStartDate,
            cashAccountId: req.body?.cashAccountId,
            downPayment: req.body?.downPayment,
            remarks: req.body?.remarks,
        });
        await materializeLoanEmis(state);
        saveState(state, req.account);
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.status(201).json({ ...detail, state, ...totals });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create loan' });
    }
});

app.get('/api/loans/:id', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const loanGenerated = await materializeLoanEmis(state);
        if (loanGenerated > 0)
            saveState(state, req.account);
        const detail = await getLoanWithSchedule(state.appId, req.params.id);
        if (!detail) {
            res.status(404).json({ error: 'Loan not found' });
            return;
        }
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.json({ ...detail, state, ...totals });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load loan' });
    }
});

app.put('/api/loans/:id', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const detail = await updateCustomerLoan(state, req.params.id, {
            principal: req.body?.principal,
            interestRate: req.body?.interestRate,
            interestType: req.body?.interestType,
            emiFrequency: req.body?.emiFrequency,
            tenureMonths: req.body?.tenureMonths,
            loanDate: req.body?.loanDate || req.body?.startDate,
            emiStartDate: req.body?.emiStartDate,
            remarks: req.body?.remarks,
        });
        saveState(state, req.account);
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.json({ ...detail, state, ...totals });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not update loan' });
    }
});

app.post('/api/loans/:id/pay-emi', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const cashAccountId = String(req.body?.cashAccountId ?? '');
        const installmentId = String(req.body?.installmentId ?? '');
        if (!installmentId)
            throw new Error('Installment is required');
        if (!cashAccountId)
            throw new Error('Select a cash/bank account');
        const detail = await payLoanEmi(
            state,
            req.account,
            req.params.id,
            installmentId,
            cashAccountId,
            req.body?.amount,
        );
        saveState(state, req.account);
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.json({ ...detail, state, ...totals });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not pay EMI' });
    }
});

app.post('/api/loans/:id/preclose', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const cashAccountId = String(req.body?.cashAccountId ?? '');
        const preclosureCharge = Number(req.body?.preclosureCharge ?? 0);
        if (!cashAccountId)
            throw new Error('Select a cash/bank account');
        const detail = await precloseLoan(state, req.account, req.params.id, preclosureCharge, cashAccountId);
        saveState(state, req.account);
        const totals = calcTotals(state.openingBalance, state.transactions);
        res.json({ ...detail, state, ...totals });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not pre-close loan' });
    }
});

app.post('/api/services', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const name = String(req.body?.name ?? '').trim();
    const description = String(req.body?.description ?? '').trim();
    const amount = Number(req.body?.amount ?? 0);
    if (!name || name.length < 2) {
        res.status(400).json({ error: 'Service name is required' });
        return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
        res.status(400).json({ error: 'Enter a valid default amount' });
        return;
    }
    if (state.services.some((service) => service.name.toLowerCase() === name.toLowerCase())) {
        res.status(409).json({ error: 'A service with this name already exists' });
        return;
    }
    const now = new Date().toISOString();
    const service = {
        id: newId(),
        name,
        amount,
        description,
        createdAt: now,
        updatedAt: now,
    };
    state.services.unshift(service);
    state.services.sort((a, b) => a.name.localeCompare(b.name));
    saveState(state, req.account);
    res.status(201).json({ state, service });
});
app.put('/api/services/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const index = state.services.findIndex((service) => service.id === req.params.id);
    if (index < 0) {
        res.status(404).json({ error: 'Service not found' });
        return;
    }
    const current = state.services[index];
    const name = req.body?.name === undefined ? current.name : String(req.body.name).trim();
    const description = req.body?.description === undefined
        ? current.description
        : String(req.body.description).trim();
    const amount = req.body?.amount === undefined ? current.amount : Number(req.body.amount);
    if (!name || name.length < 2) {
        res.status(400).json({ error: 'Service name is required' });
        return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
        res.status(400).json({ error: 'Enter a valid default amount' });
        return;
    }
    if (state.services.some((service) => service.id !== current.id && service.name.toLowerCase() === name.toLowerCase())) {
        res.status(409).json({ error: 'A service with this name already exists' });
        return;
    }
    const updated = {
        ...current,
        name,
        description,
        amount,
        updatedAt: new Date().toISOString(),
    };
    state.services[index] = updated;
    state.services.sort((a, b) => a.name.localeCompare(b.name));
    state.recurringBillings = state.recurringBillings.map((billing) => billing.serviceId === updated.id
        ? { ...billing, serviceName: updated.name, updatedAt: new Date().toISOString() }
        : billing);
    state.transactions = state.transactions.map((tx) => tx.serviceId === updated.id ? { ...tx, serviceName: updated.name } : tx);
    saveState(state, req.account);
    res.json({ state, service: updated });
});
app.delete('/api/services/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const id = String(req.params.id);
    const exists = state.services.some((service) => service.id === id);
    if (!exists) {
        res.status(404).json({ error: 'Service not found' });
        return;
    }
    const usedInTx = state.transactions.some((tx) => tx.serviceId === id);
    const usedInRecurring = state.recurringBillings.some((billing) => billing.serviceId === id);
    if (usedInTx || usedInRecurring) {
        res.status(400).json({
            error: 'Cannot delete this service. Entries or recurring schedules still use it. Edit instead, or remove those entries first.',
        });
        return;
    }
    state.services = state.services.filter((service) => service.id !== id);
    saveState(state, req.account);
    res.json({ state });
});
app.post('/api/todos', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const title = String(req.body?.title ?? '').trim();
    const notes = String(req.body?.notes ?? '').trim();
    const activity = String(req.body?.activity ?? 'custom').trim() || 'custom';
    const dueDate = String(req.body?.dueDate ?? '').trim();
    const dueTimeRaw = String(req.body?.dueTime ?? '09:00').trim();
    const dueTime = /^\d{2}:\d{2}$/.test(dueTimeRaw) ? dueTimeRaw : '09:00';
    const whatsappReminder = Boolean(req.body?.whatsappReminder);
    const customerId = req.body?.customerId == null || req.body.customerId === ''
        ? null
        : String(req.body.customerId);
    const customerName = req.body?.customerName == null || req.body.customerName === ''
        ? null
        : String(req.body.customerName).trim();
    const customerPhone = req.body?.customerPhone == null || req.body.customerPhone === ''
        ? null
        : String(req.body.customerPhone).trim();
    if (!title || title.length < 2) {
        res.status(400).json({ error: 'Activity is required' });
        return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        res.status(400).json({ error: 'Choose a valid due date' });
        return;
    }
    const now = new Date().toISOString();
    const todo = {
        id: newId(),
        title,
        notes,
        activity,
        dueDate,
        dueTime,
        done: false,
        remind3DaysBefore: true,
        remind1DayBefore: true,
        remindOnDueMorning: true,
        whatsappReminder,
        customerId,
        customerName,
        customerPhone,
        reminded3DaysOn: null,
        reminded1DayOn: null,
        remindedDueOn: null,
        createdAt: now,
        updatedAt: now,
    };
    state.todos = [todo, ...(state.todos ?? [])].sort((a, b) => a.dueDate === b.dueDate
        ? `${a.dueTime}`.localeCompare(`${b.dueTime}`) || b.createdAt.localeCompare(a.createdAt)
        : a.dueDate.localeCompare(b.dueDate));
    saveState(state, req.account);
    res.status(201).json({ state, todo });
});
app.put('/api/todos/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const index = (state.todos ?? []).findIndex((todo) => todo.id === req.params.id);
    if (index < 0) {
        res.status(404).json({ error: 'Todo not found' });
        return;
    }
    const current = state.todos[index];
    const title = req.body?.title === undefined ? current.title : String(req.body.title).trim();
    const notes = req.body?.notes === undefined ? current.notes : String(req.body.notes).trim();
    const activity = req.body?.activity === undefined
        ? current.activity
        : String(req.body.activity).trim() || 'custom';
    const dueDate = req.body?.dueDate === undefined ? current.dueDate : String(req.body.dueDate).trim();
    const dueTimeRaw = req.body?.dueTime === undefined ? current.dueTime : String(req.body.dueTime).trim();
    const dueTime = /^\d{2}:\d{2}$/.test(dueTimeRaw) ? dueTimeRaw : current.dueTime || '09:00';
    const done = req.body?.done === undefined ? current.done : Boolean(req.body.done);
    const whatsappReminder = req.body?.whatsappReminder === undefined
        ? current.whatsappReminder
        : Boolean(req.body.whatsappReminder);
    const customerId = req.body?.customerId === undefined
        ? current.customerId
        : req.body.customerId == null || req.body.customerId === ''
            ? null
            : String(req.body.customerId);
    const customerName = req.body?.customerName === undefined
        ? current.customerName
        : req.body.customerName == null || req.body.customerName === ''
            ? null
            : String(req.body.customerName).trim();
    const customerPhone = req.body?.customerPhone === undefined
        ? current.customerPhone
        : req.body.customerPhone == null || req.body.customerPhone === ''
            ? null
            : String(req.body.customerPhone).trim();
    if (!title || title.length < 2) {
        res.status(400).json({ error: 'Activity is required' });
        return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        res.status(400).json({ error: 'Choose a valid due date' });
        return;
    }
    const dueChanged = dueDate !== current.dueDate || dueTime !== current.dueTime;
    const updated = {
        ...current,
        title,
        notes,
        activity,
        dueDate,
        dueTime,
        done,
        remind3DaysBefore: true,
        remind1DayBefore: true,
        remindOnDueMorning: true,
        whatsappReminder,
        customerId,
        customerName,
        customerPhone,
        reminded3DaysOn: dueChanged ? null : current.reminded3DaysOn,
        reminded1DayOn: dueChanged ? null : current.reminded1DayOn,
        remindedDueOn: dueChanged ? null : current.remindedDueOn,
        updatedAt: new Date().toISOString(),
    };
    state.todos[index] = updated;
    state.todos.sort((a, b) => a.dueDate === b.dueDate
        ? `${a.dueTime}`.localeCompare(`${b.dueTime}`) || b.createdAt.localeCompare(a.createdAt)
        : a.dueDate.localeCompare(b.dueDate));
    saveState(state, req.account);
    res.json({ state, todo: updated });
});
app.post('/api/payment-reminders/send', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    if (!state.appId) {
        res.status(400).json({ error: 'Complete shop setup first' });
        return;
    }
    const shopWa = await getWhatsAppConfig(state.appId);
    const shopMapped = shopWa.connected
        ? await resolveWhatsAppTemplateForActivity(state.appId, 'payment_reminder')
        : null;
    if (!shopMapped && !isPaymentReminderWhatsAppConfigured()) {
        res.status(503).json({
            error: 'Payment reminder WhatsApp is not configured. Connect WhatsApp API in Settings and map Payment Reminder, or set ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID on the server.',
        });
        return;
    }
    const shopName = String(req.body?.shopName ?? state.shopName ?? 'Shop').trim() || 'Shop';
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawItems.length === 0) {
        res.status(400).json({ error: 'No reminders to send' });
        return;
    }

    if (shopMapped) {
        const recipients = [];
        for (const raw of rawItems) {
            const customerId = raw.customerId ? String(raw.customerId) : null;
            const fromState = customerId
                ? state.users.find((u) => u.id === customerId && u.role === 'customer')
                : undefined;
            const phone = String(raw.phone ?? fromState?.phone ?? '')
                .replace(/\D/g, '')
                .slice(-10);
            const customerName = String(raw.customerName ?? fromState?.name ?? 'Customer').trim() || 'Customer';
            const balance = Number(raw.balance);
            recipients.push({ customerId, phone, customerName, balance });
        }
        try {
            const result = await broadcastWhatsAppMessages(state.appId, req.account, {
                activity: 'payment_reminder',
                shopName,
                recipients,
            });
            res.json(result);
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send reminders' });
        }
        return;
    }

    const results = [];
    for (const raw of rawItems) {
        const customerId = raw.customerId ? String(raw.customerId) : null;
        const fromState = customerId
            ? state.users.find((u) => u.id === customerId && u.role === 'customer')
            : undefined;
        const phone = String(raw.phone ?? fromState?.phone ?? '')
            .replace(/\D/g, '')
            .slice(-10);
        const customerName = String(raw.customerName ?? fromState?.name ?? 'Customer').trim() || 'Customer';
        const balance = Number(raw.balance);
        if (!phone || phone.length !== 10) {
            results.push({
                customerId,
                phone,
                customerName,
                ok: false,
                error: 'Missing or invalid mobile number',
            });
            continue;
        }
        if (!Number.isFinite(balance) || balance === 0) {
            results.push({
                customerId,
                phone,
                customerName,
                ok: false,
                error: 'No outstanding balance',
            });
            continue;
        }
        const sent = await sendPaymentReminderWhatsApp({
            phone,
            customerName,
            shopName,
            balance,
        });
        try {
            await insertWhatsAppMessageLog({
                shopAppId: state.appId,
                customerId,
                customerName,
                phone,
                kind: 'payment_reminder',
                templateName: sent.templateName || 'payment_reminder',
                messageBody: sent.messageBody || `Payment reminder · Rs. ${Math.abs(balance)}`,
                ok: sent.ok,
                error: sent.ok ? null : sent.error,
                providerMessageId: sent.messageId || sent.wamid || null,
                sentByUserId: req.account.id,
                sentByName: req.account.name,
            });
        }
        catch (err) {
            console.warn('[WhatsApp log] insert failed:', err instanceof Error ? err.message : err);
        }
        results.push({
            customerId,
            phone,
            customerName,
            ok: sent.ok,
            error: sent.ok ? undefined : sent.error,
            messageId: sent.ok ? (sent.messageId || sent.wamid) : undefined,
        });
    }
    const sent = results.filter((r) => r.ok).length;
    const failed = results.length - sent;
    res.json({ ok: failed === 0, sent, failed, results });
});
app.get('/api/payment-reminders/status', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    let shopMapped = false;
    try {
        if (state.appId) {
            const shopWa = await getWhatsAppConfig(state.appId);
            shopMapped = Boolean(
                shopWa.connected && (await resolveWhatsAppTemplateForActivity(state.appId, 'payment_reminder')),
            );
        }
    }
    catch {
        shopMapped = false;
    }
    res.json({
        configured: shopMapped || isPaymentReminderWhatsAppConfigured(),
        shopMapped,
        unitCostInr: whatsappMessageUnitCost(),
    });
});

/** —— WhatsApp API manager (AiSensy / Meta WABA) —— */
app.get('/api/whatsapp/config', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        res.json({ config: await getWhatsAppConfig(state.appId) });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load WhatsApp config' });
    }
});
app.put('/api/whatsapp/config', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const result = await saveWhatsAppConfig(state.appId, req.body || {});
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save WhatsApp config' });
    }
});
app.post('/api/whatsapp/config/refresh', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const result = await refreshWhatsAppConnectionStatus(state.appId);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not refresh OneChatting status' });
    }
});
app.post('/api/whatsapp/config/disconnect', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    try {
        const result = await disconnectWhatsAppConfig(state.appId);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not disconnect OneChatting' });
    }
});

function requirePlatformAdmin(req, res) {
    const expected = String(process.env.PLATFORM_ADMIN_API_KEY || '').trim();
    if (!expected) {
        res.status(503).json({ error: 'PLATFORM_ADMIN_API_KEY is not configured' });
        return false;
    }
    const provided = String(req.get('x-platform-admin-key') || req.body?.adminKey || '').trim();
    if (!provided || provided !== expected) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

/** OneSAAS-CRM platform tokens for admin portal (masked; never returns raw secrets). */
app.get('/api/admin/platform-whatsapp', async (req, res) => {
    if (!requirePlatformAdmin(req, res))
        return;
    try {
        const tokens = await getPlatformWhatsAppTokens({ force: true });
        res.json({
            ready: tokens.ready,
            developerTokenSet: tokens.developerTokenSet,
            userTokenSet: tokens.userTokenSet,
            developerTokenMasked: tokens.developerTokenMasked,
            userTokenMasked: tokens.userTokenMasked,
            updatedAt: tokens.updatedAt,
        });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load platform tokens' });
    }
});

app.put('/api/admin/platform-whatsapp', async (req, res) => {
    if (!requirePlatformAdmin(req, res))
        return;
    try {
        const body = req.body || {};
        const tokens = await savePlatformWhatsAppTokens({
            developerToken: body.developerToken,
            userToken: body.userToken,
            note: body.note,
        });
        res.json({
            ready: tokens.ready,
            developerTokenSet: tokens.developerTokenSet,
            userTokenSet: tokens.userTokenSet,
            developerTokenMasked: tokens.developerTokenMasked,
            userTokenMasked: tokens.userTokenMasked,
            updatedAt: tokens.updatedAt,
        });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save platform tokens' });
    }
});

app.get('/api/whatsapp/templates', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        res.json({ templates: await listWhatsAppTemplates(state.appId) });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load templates' });
    }
});
app.get('/api/whatsapp/remote-templates', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        res.json({ templates: await fetchRemoteWhatsAppTemplates(state.appId) });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not fetch OneChatting templates' });
    }
});
app.post('/api/whatsapp/templates/sync', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const result = await syncRemoteWhatsAppTemplates(state.appId);
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not sync templates' });
    }
});
app.post('/api/whatsapp/templates/:id/refresh', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const template = await refreshWhatsAppTemplate(state.appId, req.params.id);
        res.json({ template });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not refresh template' });
    }
});
app.get('/api/whatsapp/activities', requireShopkeeper, (_req, res) => {
    res.json({
        activities: listWhatsAppActivities(),
        variables: listWhatsAppTemplateVariables(),
    });
});
app.put('/api/whatsapp/activity-map', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const config = await saveWhatsAppActivityMap(state.appId, req.body?.activityMap || req.body || {});
        res.json({ config });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save activity mapping' });
    }
});
app.post('/api/whatsapp/activity-map/attachment', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    const activityId = String(req.body?.activityId || 'map').replace(/[^\w-]/g, '').slice(0, 40) || 'map';
    const fileName = String(req.body?.fileName || req.body?.name || 'attachment').trim();
    const data = String(req.body?.data || req.body?.attachmentData || '');
    if (!fileName || !data) {
        res.status(400).json({ error: 'Choose a file to attach' });
        return;
    }
    try {
        const saved = saveAttachmentData(`wa-${state.appId}-${activityId}`, fileName, data);
        const host = req.get('x-forwarded-host') || req.get('host') || 'localhost:4000';
        const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
        const publicBase = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || `${proto}://${host}`).replace(/\/$/, '');
        res.json({
            name: saved.attachmentName,
            path: saved.attachmentPath,
            url: `${publicBase}${saved.attachmentPath}`,
        });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not save attachment' });
    }
});
app.post('/api/whatsapp/broadcast', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const result = await broadcastWhatsAppMessages(state.appId, req.account, {
            templateId: req.body?.templateId,
            activity: req.body?.activity,
            recipients: req.body?.recipients,
            shopName: req.body?.shopName || state.shopName,
            shopAddress: req.body?.shopAddress || state.shopAddress,
            teamName: req.body?.teamName,
            paramMode: req.body?.paramMode,
            templateParams: req.body?.templateParams,
            note: req.body?.note,
            variables: req.body?.variables,
            headerMediaUrl: req.body?.headerMediaUrl || req.body?.attachmentUrl,
            headerMediaName: req.body?.headerMediaName || req.body?.attachmentName,
            attachmentUrl: req.body?.attachmentUrl,
            attachmentName: req.body?.attachmentName,
        });
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Broadcast failed' });
    }
});
app.post('/api/whatsapp/templates', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const template = await createWhatsAppTemplate(state.appId, req.body || {});
        res.status(201).json({ template });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create template' });
    }
});
app.put('/api/whatsapp/templates/:id', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const template = await updateWhatsAppTemplate(state.appId, req.params.id, req.body || {});
        res.json({ template });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not update template' });
    }
});
app.delete('/api/whatsapp/templates/:id', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        await deleteWhatsAppTemplate(state.appId, req.params.id);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not delete template' });
    }
});
app.get('/api/whatsapp/campaigns', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        res.json({ campaigns: await listWhatsAppCampaigns(state.appId) });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load campaigns' });
    }
});
app.post('/api/whatsapp/campaigns', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const campaign = await createWhatsAppCampaign(state.appId, req.body || {});
        res.status(201).json({ campaign });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create campaign' });
    }
});
app.put('/api/whatsapp/campaigns/:id', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const campaign = await updateWhatsAppCampaign(state.appId, req.params.id, req.body || {});
        res.json({ campaign });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not update campaign' });
    }
});
app.delete('/api/whatsapp/campaigns/:id', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        await deleteWhatsAppCampaign(state.appId, req.params.id);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not delete campaign' });
    }
});
app.post('/api/whatsapp/campaigns/:id/send', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const result = await sendWhatsAppCampaignMessage(state.appId, req.account, {
            campaignId: req.params.id,
            phone: req.body?.phone,
            userName: req.body?.userName || req.body?.customerName,
            customerId: req.body?.customerId,
            templateParams: req.body?.templateParams,
        });
        res.json({ ok: true, result });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send campaign' });
    }
});
app.get('/api/whatsapp/chats', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const autoSync = String(req.query.sync || '1') !== '0';
        let sync = null;
        if (autoSync) {
            // Light refresh only — full sync is via POST /chats/sync
            sync = await syncWhatsAppInbox(state.appId, {
                search: req.query.q ? String(req.query.q) : undefined,
                maxPages: 10,
                limit: 100,
                pruneUnseen: false,
            });
        }
        const result = await listWhatsAppChats(state.appId, {
            filter: String(req.query.filter || 'all'),
            q: String(req.query.q || ''),
            assignedTo: req.query.assignedTo ? String(req.query.assignedTo) : null,
        });
        res.json({ ...result, sync });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load chats' });
    }
});
app.post('/api/whatsapp/chats/sync', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const sync = await syncWhatsAppInbox(state.appId, {
            search: req.body?.search ? String(req.body.search) : undefined,
            maxPages: Number(req.body?.maxPages) || 20,
            limit: Number(req.body?.limit) || 100,
            pruneUnseen: !req.body?.search,
        });
        const result = await listWhatsAppChats(state.appId, {
            filter: String(req.body?.filter || req.query.filter || 'all'),
            q: String(req.body?.q || req.query.q || ''),
        });
        res.json({ ...result, sync });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not sync chats' });
    }
});
app.get('/api/whatsapp/live-session', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const session = await getWhatsAppLiveSession(state.appId);
        res.json(session);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Live session unavailable' });
    }
});
app.get('/api/whatsapp/chats/:phone', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const phone = String(req.params.phone || '');
        const creds = await getShopWhatsAppChatCredentials(state.appId);
        const packed = await listWhatsAppChatMessages(state.appId, phone, {
            apiKey: creds.apiKey || null,
            countryCode: creds.countryCode || '91',
        });
        const thread = await getWhatsAppChatThread(state.appId, phone);
        res.json({
            messages: packed.messages || packed,
            thread,
            source: packed.source || 'local',
            liveError: packed.liveError || null,
            assigning: packed.assigning || null,
            chatReady: creds.chatReady,
        });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Could not load chat' });
    }
});
app.post('/api/whatsapp/chats/:phone/read', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const creds = await getShopWhatsAppChatCredentials(state.appId);
        const result = await markWhatsAppChatRead(state.appId, req.params.phone, {
            apiKey: creds.apiKey || null,
            countryCode: creds.countryCode || '91',
        });
        res.json({ thread: result.thread || result, live: result.live || null });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not mark read' });
    }
});
app.post('/api/whatsapp/chats/:phone/unread', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const thread = await markWhatsAppChatUnread(state.appId, req.params.phone);
        res.json({ thread });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not mark unread' });
    }
});
app.put('/api/whatsapp/chats/:phone/assign', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const userId = req.body?.userId ? String(req.body.userId) : null;
        let userName = req.body?.userName ? String(req.body.userName) : null;
        if (userId && !userName) {
            const user = (state.users || []).find((u) => u.id === userId);
            userName = user?.name || 'Staff';
        }
        const thread = await assignWhatsAppChat(state.appId, req.params.phone, {
            userId,
            userName,
            customerId: req.body?.customerId || null,
            customerName: req.body?.customerName || null,
        });
        res.json({ thread });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not assign chat' });
    }
});
app.post('/api/whatsapp/chats/:phone/send', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const phone = String(req.params.phone || req.body?.phone || '');
        const result = await sendWhatsAppChatTemplate(state.appId, req.account, {
            phone,
            templateId: req.body?.templateId,
            customerId: req.body?.customerId,
            customerName: req.body?.customerName || req.body?.userName,
            variables: req.body?.variables,
            templateParams: req.body?.templateParams,
            note: req.body?.note,
            attachmentUrl: req.body?.attachmentUrl,
            attachmentName: req.body?.attachmentName,
            documentName: req.body?.documentName || req.body?.attachmentName,
            documentLink: req.body?.documentLink || req.body?.attachmentUrl,
            balance: req.body?.balance,
            invoiceNumber: req.body?.invoiceNumber,
            invoiceAmount: req.body?.invoiceAmount,
            invoiceDate: req.body?.invoiceDate,
            amount: req.body?.amount ?? req.body?.invoiceAmount,
            date: req.body?.date || req.body?.invoiceDate,
            shopName: state.shopName || req.body?.shopName,
            shopAddress: state.shopAddress || req.body?.shopAddress,
            teamName: req.account?.name || state.shopName,
            activity: req.body?.activity,
        });
        const thread = await getWhatsAppChatThread(state.appId, phone);
        res.json({ ...result, thread });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send message' });
    }
});
app.post('/api/whatsapp/chats/:phone/send-text', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const phone = String(req.params.phone || req.body?.phone || '');
        const result = await sendWhatsAppChatTextMessage(state.appId, req.account, {
            phone,
            message: req.body?.message,
            customerId: req.body?.customerId,
            customerName: req.body?.customerName || req.body?.userName,
        });
        const thread = await getWhatsAppChatThread(state.appId, phone);
        res.json({ ...result, thread });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send text' });
    }
});
app.post('/api/whatsapp/chats/:phone/send-media', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    try {
        const phone = String(req.params.phone || req.body?.phone || '');
        const result = await sendWhatsAppChatMediaMessage(state.appId, req.account, {
            phone,
            mediaUrl: req.body?.mediaUrl || req.body?.url,
            mediaType: req.body?.mediaType || req.body?.type,
            caption: req.body?.caption || req.body?.message,
            fileName: req.body?.fileName || req.body?.attachmentName,
            customerId: req.body?.customerId,
            customerName: req.body?.customerName || req.body?.userName,
        });
        const thread = await getWhatsAppChatThread(state.appId, phone);
        res.json({ ...result, thread });
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not send media' });
    }
});

/** Shop WhatsApp API send report (payment reminders, etc.). */
app.get('/api/whatsapp-messages', requireShopkeeper, async (req, res) => {
    const state = loadState(req.account);
    if (!state.appId) {
        res.status(400).json({ error: 'Complete shop setup first' });
        return;
    }
    const fromRaw = String(req.query.from ?? '').trim();
    const toRaw = String(req.query.to ?? '').trim();
    const from = fromRaw ? new Date(fromRaw) : undefined;
    const to = toRaw ? new Date(toRaw) : undefined;
    try {
        const messages = await listWhatsAppMessageLogs(state.appId, {
            from: from && !Number.isNaN(from.getTime()) ? from : undefined,
            to: to && !Number.isNaN(to.getTime()) ? to : undefined,
        });
        res.json({
            messages,
            summary: summarizeWhatsAppLogs(messages),
            unitCostInr: whatsappMessageUnitCost(),
        });
    }
    catch (err) {
        console.error('[WhatsApp report]', err);
        res.status(500).json({
            error: err instanceof Error ? err.message : 'Could not load WhatsApp message report',
        });
    }
});
app.post('/api/todos/reminders/ack', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
        res.json({ state });
        return;
    }
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    let changed = false;
    state.todos = (state.todos ?? []).map((todo) => {
        const match = items.find((item) => item.id === todo.id && item.kind);
        if (!match)
            return todo;
        changed = true;
        if (match.kind === '3d')
            return { ...todo, reminded3DaysOn: todayStr, updatedAt: new Date().toISOString() };
        if (match.kind === '1d')
            return { ...todo, reminded1DayOn: todayStr, updatedAt: new Date().toISOString() };
        return { ...todo, remindedDueOn: todayStr, updatedAt: new Date().toISOString() };
    });
    if (changed)
        saveState(state, req.account);
    res.json({ state });
});
app.post('/api/todos/bulk-delete', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map((id) => String(id)).filter(Boolean)
        : [];
    if (ids.length === 0) {
        res.status(400).json({ error: 'Select at least one to-do' });
        return;
    }
    const idSet = new Set(ids);
    const before = (state.todos ?? []).length;
    state.todos = (state.todos ?? []).filter((todo) => !idSet.has(todo.id));
    if (state.todos.length === before) {
        res.status(404).json({ error: 'No matching to-dos found' });
        return;
    }
    saveState(state, req.account);
    res.json({ state, deleted: before - state.todos.length });
});
app.delete('/api/todos/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    const id = String(req.params.id);
    const exists = (state.todos ?? []).some((todo) => todo.id === id);
    if (!exists) {
        res.status(404).json({ error: 'Todo not found' });
        return;
    }
    state.todos = state.todos.filter((todo) => todo.id !== id);
    saveState(state, req.account);
    res.json({ state });
});
app.post('/api/transactions', requireShopkeeper, (req, res) => {
    const { type, category, amount, remarks, customerId, createdAt, cashAccountId, attachmentName, attachmentData, serviceId, } = req.body;
    const state = loadState(req.account);
    const account = req.account;
    if (account.shopAppId && state.appId && account.shopAppId !== state.appId) {
        res.status(403).json({ error: 'Shop mismatch — sign in again' });
        return;
    }
    const user = state.users.find((u) => u.id === account.id);
    if (!user || user.role !== 'shopkeeper') {
        res.status(403).json({ error: 'Not allowed to record for this shop' });
        return;
    }
    const value = Number(amount);
    if (!type || (type !== 'receipt' && type !== 'payment')) {
        res.status(400).json({ error: 'Invalid transaction' });
        return;
    }
    if (Number.isNaN(value) || value <= 0) {
        res.status(400).json({ error: 'Amount must be greater than 0' });
        return;
    }
    const note = String(remarks ?? '').trim();
    let resolvedCategory = category ?? (type === 'receipt' ? 'receipt' : 'payment');
    const serviceLookup = resolveService(state, resolvedCategory === 'sales' || resolvedCategory === 'purchase' ? serviceId : null);
    if (!serviceLookup.ok) {
        res.status(404).json({ error: serviceLookup.error });
        return;
    }
    if (type === 'receipt') {
        if (resolvedCategory !== 'receipt' &&
            resolvedCategory !== 'adjustment' &&
            resolvedCategory !== 'purchase') {
            res.status(400).json({ error: 'In options: Receipt, Purchase, or Adjustment' });
            return;
        }
    }
    else if (resolvedCategory !== 'sales' && resolvedCategory !== 'payment' && resolvedCategory !== 'adjustment') {
        res.status(400).json({ error: 'Out options: Sales, Payment, or Adjustment' });
        return;
    }
    if (resolvedCategory === 'adjustment' && !note) {
        res.status(400).json({ error: 'Remarks are required for adjustment' });
        return;
    }
    const isAdjustment = resolvedCategory === 'adjustment';
    const isSales = resolvedCategory === 'sales';
    const isPurchase = resolvedCategory === 'purchase';
    const isXorParty = isSales || isPurchase;
    const hasCustomer = Boolean(customerId);
    const hasAccount = Boolean(cashAccountId);
    if (isXorParty) {
        if (hasCustomer === hasAccount) {
            const label = isPurchase ? 'Purchase' : 'Sales';
            res.status(400).json({
                error: hasCustomer
                    ? `${label}: choose either party or account, not both`
                    : `${label}: select a party or an account`,
            });
            return;
        }
    }
    else if (!customerId) {
        res.status(400).json({ error: 'Customer is required' });
        return;
    }
    let customer = null;
    if (customerId) {
        customer = state.users.find((u) => u.id === customerId && u.role === 'customer') ?? null;
        if (!customer) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
    }
    let resolvedCashId = null;
    let resolvedCashName = null;
    if (isAdjustment || (isXorParty && hasCustomer)) {
        resolvedCashId = null;
        resolvedCashName = null;
    }
    else {
        if (!cashAccountId) {
            res.status(400).json({ error: 'Account is required' });
            return;
        }
        const cashAccount = state.cashAccounts.find((a) => a.id === cashAccountId);
        if (!cashAccount) {
            res.status(404).json({ error: 'Account not found' });
            return;
        }
        resolvedCashId = cashAccount.id;
        resolvedCashName = cashAccount.name;
    }
    let txCreatedAt = uniqueTxCreatedAt(state.transactions, new Date());
    if (createdAt) {
        const parsed = new Date(createdAt);
        if (Number.isNaN(parsed.getTime())) {
            res.status(400).json({ error: 'Invalid date' });
            return;
        }
        txCreatedAt = uniqueTxCreatedAt(state.transactions, parsed);
    }
    let txId = newTxId(new Date(txCreatedAt));
    const existingIds = new Set(state.transactions.map((t) => t.id));
    while (existingIds.has(txId)) {
        txId = newTxId(new Date(txCreatedAt));
    }
    let savedAttachmentName = null;
    let savedAttachmentPath = null;
    if (attachmentData && attachmentName) {
        try {
            const saved = saveAttachmentData(txId, String(attachmentName), String(attachmentData));
            savedAttachmentName = saved.attachmentName;
            savedAttachmentPath = saved.attachmentPath;
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid attachment' });
            return;
        }
    }
    const tx = {
        id: txId,
        type,
        category: resolvedCategory,
        amount: value,
        remarks: note,
        userId: account.id,
        userName: account.name,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? null,
        cashAccountId: resolvedCashId,
        cashAccountName: resolvedCashName,
        attachmentName: savedAttachmentName,
        attachmentPath: savedAttachmentPath,
        recurringBillingId: null,
        recurringOccurrenceDate: null,
        serviceId: resolvedCategory === 'sales' || resolvedCategory === 'purchase' ? (serviceLookup.service?.id ?? null) : null,
        serviceName: resolvedCategory === 'sales' || resolvedCategory === 'purchase' ? (serviceLookup.service?.name ?? null) : null,
        createdAt: txCreatedAt,
    };
    state.transactions.unshift(tx);
    state.activeUserId = account.id;
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.status(201).json({ state, transaction: tx, ...totals });
});
app.put('/api/transactions/:id', requireShopkeeper, (req, res) => {
    const stateForCode = loadState(req.account);
    if (!requireActionConfirmCode(req, res, stateForCode))
        return;
    const { type, category, amount, remarks, customerId, createdAt, cashAccountId, attachmentName, attachmentData, clearAttachment, serviceId, } = req.body;
    const state = loadState(req.account);
    const account = req.account;
    if (account.shopAppId && state.appId && account.shopAppId !== state.appId) {
        res.status(403).json({ error: 'Shop mismatch — sign in again' });
        return;
    }
    if (!state.users.some((u) => u.id === account.id && u.role === 'shopkeeper')) {
        res.status(403).json({ error: 'Not allowed to edit this shop' });
        return;
    }
    const index = state.transactions.findIndex((t) => t.id === req.params.id);
    if (index < 0) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
    }
    const existing = state.transactions[index];
    const nextType = type ?? existing.type;
    if (nextType !== 'receipt' && nextType !== 'payment') {
        res.status(400).json({ error: 'Invalid transaction' });
        return;
    }
    const value = amount !== undefined ? Number(amount) : existing.amount;
    if (Number.isNaN(value) || value <= 0) {
        res.status(400).json({ error: 'Amount must be greater than 0' });
        return;
    }
    const note = remarks !== undefined ? String(remarks).trim() : existing.remarks;
    let resolvedCategory = category ?? existing.category ?? (nextType === 'receipt' ? 'receipt' : 'payment');
    const serviceLookup = resolveService(state, resolvedCategory === 'sales' || resolvedCategory === 'purchase'
        ? serviceId === undefined
            ? existing.serviceId
            : serviceId
        : null);
    if (!serviceLookup.ok) {
        res.status(404).json({ error: serviceLookup.error });
        return;
    }
    if (nextType === 'receipt') {
        if (resolvedCategory !== 'receipt' &&
            resolvedCategory !== 'adjustment' &&
            resolvedCategory !== 'purchase') {
            res.status(400).json({ error: 'In options: Receipt, Purchase, or Adjustment' });
            return;
        }
    }
    else if (resolvedCategory !== 'sales' &&
        resolvedCategory !== 'payment' &&
        resolvedCategory !== 'adjustment') {
        res.status(400).json({ error: 'Out options: Sales, Payment, or Adjustment' });
        return;
    }
    if (resolvedCategory === 'adjustment' && !note) {
        res.status(400).json({ error: 'Remarks are required for adjustment' });
        return;
    }
    const isAdjustment = resolvedCategory === 'adjustment';
    const isSales = resolvedCategory === 'sales';
    const isPurchase = resolvedCategory === 'purchase';
    const isXorParty = isSales || isPurchase;
    const requestedCustomerId = customerId !== undefined ? String(customerId || '') : (existing.customerId ?? '');
    const systemCashId =
        state.cashAccounts.find((a) => a.isSystem || isSystemCashAccountId(a.id))?.id ||
        (state.appId ? `${state.appId}:cash` : DEFAULT_CASH_ACCOUNT_ID);
    const requestedCashId = cashAccountId !== undefined
        ? String(cashAccountId || '')
        : isXorParty || isAdjustment
            ? (existing.cashAccountId ?? '')
            : (existing.cashAccountId ?? systemCashId);
    const hasCustomer = Boolean(requestedCustomerId);
    const hasAccount = Boolean(requestedCashId);
    if (isXorParty) {
        if (hasCustomer === hasAccount) {
            const label = isPurchase ? 'Purchase' : 'Sales';
            res.status(400).json({
                error: hasCustomer
                    ? `${label}: choose either party or account, not both`
                    : `${label}: select a party or an account`,
            });
            return;
        }
    }
    else if (!requestedCustomerId) {
        res.status(400).json({ error: 'Customer is required' });
        return;
    }
    let customer = null;
    if (requestedCustomerId) {
        customer =
            state.users.find((u) => u.id === requestedCustomerId && u.role === 'customer') ?? null;
        if (!customer) {
            res.status(404).json({ error: 'Customer not found' });
            return;
        }
    }
    let resolvedCashId = null;
    let resolvedCashName = null;
    if (isAdjustment || (isXorParty && hasCustomer)) {
        resolvedCashId = null;
        resolvedCashName = null;
    }
    else {
        if (!requestedCashId) {
            res.status(400).json({ error: 'Account is required' });
            return;
        }
        const cashAccount = state.cashAccounts.find((a) => a.id === requestedCashId);
        if (!cashAccount) {
            res.status(404).json({ error: 'Account not found' });
            return;
        }
        resolvedCashId = cashAccount.id;
        resolvedCashName = cashAccount.name;
    }
    let nextCreatedAt = existing.createdAt;
    if (createdAt) {
        const parsed = new Date(createdAt);
        if (Number.isNaN(parsed.getTime())) {
            res.status(400).json({ error: 'Invalid date' });
            return;
        }
        const others = state.transactions.filter((t) => t.id !== req.params.id);
        nextCreatedAt = uniqueTxCreatedAt(others, parsed);
    }
    let nextAttachmentName = existing.attachmentName ?? null;
    let nextAttachmentPath = existing.attachmentPath ?? null;
    if (clearAttachment) {
        deleteAttachmentFile(existing.attachmentPath);
        nextAttachmentName = null;
        nextAttachmentPath = null;
    }
    else if (attachmentData && attachmentName) {
        try {
            deleteAttachmentFile(existing.attachmentPath);
            const saved = saveAttachmentData(existing.id, String(attachmentName), String(attachmentData));
            nextAttachmentName = saved.attachmentName;
            nextAttachmentPath = saved.attachmentPath;
        }
        catch (err) {
            res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid attachment' });
            return;
        }
    }
    const updated = {
        ...existing,
        type: nextType,
        category: resolvedCategory,
        amount: value,
        remarks: note,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? null,
        cashAccountId: resolvedCashId,
        cashAccountName: resolvedCashName,
        attachmentName: nextAttachmentName,
        attachmentPath: nextAttachmentPath,
        serviceId: resolvedCategory === 'sales' || resolvedCategory === 'purchase' ? (serviceLookup.service?.id ?? null) : null,
        serviceName: resolvedCategory === 'sales' || resolvedCategory === 'purchase' ? (serviceLookup.service?.name ?? null) : null,
        createdAt: nextCreatedAt,
    };
    state.transactions[index] = updated;
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, transaction: updated, ...totals });
});
app.delete('/api/transactions/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const existing = state.transactions.find((t) => t.id === req.params.id);
    if (existing)
        deleteAttachmentFile(existing.attachmentPath);
    state.transactions = state.transactions.filter((t) => t.id !== req.params.id);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, ...totals });
});
app.put('/api/opening-balance', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const amount = Number(req.body?.amount);
    if (Number.isNaN(amount) || amount < 0) {
        res.status(400).json({ error: 'Invalid amount' });
        return;
    }
    state.openingBalance = amount;
    const cash = state.cashAccounts.find((a) => a.isSystem || isSystemCashAccountId(a.id));
    if (cash)
        cash.openingBalance = amount;
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, ...totals });
});
app.post('/api/cash-accounts', requireShopkeeper, (req, res) => {
    const bankName = String(req.body?.bankName ?? req.body?.name ?? '').trim();
    const accountName = String(req.body?.accountName ?? '').trim();
    const accountNumber = String(req.body?.accountNumber ?? '')
        .replace(/\s+/g, '')
        .trim();
    const ifscCode = String(req.body?.ifscCode ?? '')
        .replace(/\s+/g, '')
        .trim()
        .toUpperCase();
    const branch = String(req.body?.branch ?? '').trim();
    const opening = Number(req.body?.openingBalance ?? 0);
    if (!bankName) {
        res.status(400).json({ error: 'Bank name is required' });
        return;
    }
    if (!accountName) {
        res.status(400).json({ error: 'Account name is required' });
        return;
    }
    if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
        res.status(400).json({ error: 'Enter a valid IFSC (e.g. HDFC0001234)' });
        return;
    }
    if (Number.isNaN(opening) || opening < 0) {
        res.status(400).json({ error: 'Invalid opening balance' });
        return;
    }
    const displayName = `${bankName} · ${accountName}`;
    const state = loadState(req.account);
    if (state.cashAccounts.some((a) => a.kind === 'bank' &&
        (a.name.toLowerCase() === displayName.toLowerCase() ||
            (accountNumber &&
                a.accountNumber &&
                a.bankName?.toLowerCase() === bankName.toLowerCase() &&
                a.accountNumber === accountNumber)))) {
        res.status(400).json({ error: 'This bank account already exists' });
        return;
    }
    const account = {
        id: newId(),
        name: displayName,
        kind: 'bank',
        bankName,
        accountName,
        accountNumber: accountNumber || null,
        ifscCode: ifscCode || null,
        branch: branch || null,
        isSystem: false,
        openingBalance: opening,
        createdAt: new Date().toISOString(),
    };
    state.cashAccounts.push(account);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.status(201).json({ state, account, ...totals });
});
app.delete('/api/cash-accounts/:id', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!requireActionConfirmCode(req, res, state))
        return;
    const id = String(req.params.id);
    const target = state.cashAccounts.find((a) => a.id === id);
    if (!target) {
        res.status(404).json({ error: 'Account not found' });
        return;
    }
    if (target.isSystem || isSystemCashAccountId(target.id)) {
        res.status(400).json({ error: 'Cash account cannot be deleted' });
        return;
    }
    if (state.transactions.some((t) => t.cashAccountId === id)) {
        res.status(400).json({ error: 'Cannot delete account with transactions' });
        return;
    }
    state.cashAccounts = state.cashAccounts.filter((a) => a.id !== id);
    saveState(state, req.account);
    const totals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, ...totals });
});
app.post('/api/close-day', requireShopkeeper, (req, res) => {
    const state = loadState(req.account);
    if (!state.setupComplete) {
        res.status(400).json({ error: 'Complete setup first' });
        return;
    }
    const account = req.account;
    const totals = calcTotals(state.openingBalance, state.transactions);
    const closed = {
        id: newId(),
        date: new Date().toISOString().slice(0, 10),
        openingBalance: state.openingBalance,
        closingBalance: totals.liveBalance,
        totalReceipts: totals.totalReceipts,
        totalPayments: totals.totalPayments,
        transactionCount: state.transactions.length,
        closedAt: new Date().toISOString(),
        closedBy: account.name,
    };
    state.dayCloses.unshift(closed);
    state.openingBalance = totals.liveBalance;
    state.transactions = [];
    saveState(state, req.account);
    const nextTotals = calcTotals(state.openingBalance, state.transactions);
    res.json({ state, closed, ...nextTotals });
});
app.delete('/api/reset', requireShopkeeper, (req, res) => {
    const stateForCode = loadState(req.account);
    if (!requireActionConfirmCode(req, res, stateForCode))
        return;
    const account = req.account;
    const state = emptyState();
    // Keep same shop id if present so users stay linked
    if (account.shopAppId)
        state.appId = account.shopAppId;
    state.users = [
        {
            id: account.id,
            name: account.name,
            phone: account.phone,
            email: account.email ?? null,
            role: 'shopkeeper',
            createdAt: account.createdAt,
        },
    ];
    state.activeUserId = account.id;
    saveState(state, account);
    res.json({ state, totalReceipts: 0, totalPayments: 0, liveBalance: 0 });
});
async function main() {
    try {
        await initStore();
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('\n❌ MySQL connection failed:', message);
        console.error(`
Fix one of these:

1) Local development (from your Mac):
   Hostinger hPanel → Databases → Remote MySQL
   → Allow your current IP (or %) for remote access
   → Keep MYSQL_HOST=onebook.onesaas.in in server/.env

2) When the API runs on Hostinger itself:
   Set MYSQL_HOST=localhost in server/.env

Credentials are in server/.env (not committed to git).
`);
        process.exit(1);
    }
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`OneBook server running on http://0.0.0.0:${PORT}`);
    });
}
void main();
