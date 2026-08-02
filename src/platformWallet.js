/**
 * Platform wallet / pricing — messaging + subscription costs for admin.
 * Shop wallet balances are ready for future auto-billing.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'

const DEFAULTS = {
  messagingCostInr: 0.75,
  subscriptionMonthlyInr: 299,
  subscriptionYearlyInr: 2999,
  notes: '',
}

/** @type {number|null} */
let cachedMessagingCost = null

export async function ensurePlatformWalletSchema() {
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS platform_pricing (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
      messaging_cost_inr DECIMAL(10,4) NOT NULL DEFAULT 0.75,
      subscription_monthly_inr DECIMAL(12,2) NOT NULL DEFAULT 299,
      subscription_yearly_inr DECIMAL(12,2) NOT NULL DEFAULT 2999,
      notes TEXT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS shop_wallets (
      shop_app_id VARCHAR(32) NOT NULL PRIMARY KEY,
      balance_inr DECIMAL(14,2) NOT NULL DEFAULT 0,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS shop_wallet_ledger (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      amount_inr DECIMAL(14,2) NOT NULL,
      balance_after DECIMAL(14,2) NOT NULL,
      note VARCHAR(255) NULL,
      created_by_phone VARCHAR(15) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_wallet_ledger_shop (shop_app_id),
      KEY idx_wallet_ledger_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  const [rows] = await p.query(`SELECT id FROM platform_pricing WHERE id = 1 LIMIT 1`)
  if (!rows[0]) {
    await p.query(
      `INSERT INTO platform_pricing
        (id, messaging_cost_inr, subscription_monthly_inr, subscription_yearly_inr, notes, updated_at)
       VALUES (1, ?, ?, ?, '', UTC_TIMESTAMP(3))`,
      [DEFAULTS.messagingCostInr, DEFAULTS.subscriptionMonthlyInr, DEFAULTS.subscriptionYearlyInr],
    )
  }
  await refreshMessagingCostCache()
}

function envMessagingCost() {
  const n = Number(process.env.WHATSAPP_MESSAGE_COST_INR ?? DEFAULTS.messagingCostInr)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULTS.messagingCostInr
}

export async function refreshMessagingCostCache() {
  try {
    const [rows] = await getPool().query(
      `SELECT messaging_cost_inr FROM platform_pricing WHERE id = 1 LIMIT 1`,
    )
    if (rows[0]) {
      const n = Number(rows[0].messaging_cost_inr)
      cachedMessagingCost = Number.isFinite(n) && n >= 0 ? n : envMessagingCost()
      return cachedMessagingCost
    }
  } catch {
    // schema may not exist yet during early boot
  }
  cachedMessagingCost = envMessagingCost()
  return cachedMessagingCost
}

/** Sync unit cost for WhatsApp logs (uses DB cache, then env). */
export function whatsappMessageUnitCost() {
  if (cachedMessagingCost != null) return cachedMessagingCost
  return envMessagingCost()
}

export async function getPlatformPricing() {
  const [rows] = await getPool().query(
    `SELECT messaging_cost_inr, subscription_monthly_inr, subscription_yearly_inr, notes, updated_at
     FROM platform_pricing WHERE id = 1 LIMIT 1`,
  )
  const r = rows[0]
  if (!r) {
    return {
      ...DEFAULTS,
      updatedAt: null,
      billingLive: false,
    }
  }
  return {
    messagingCostInr: Number(r.messaging_cost_inr) || 0,
    subscriptionMonthlyInr: Number(r.subscription_monthly_inr) || 0,
    subscriptionYearlyInr: Number(r.subscription_yearly_inr) || 0,
    notes: r.notes == null ? '' : String(r.notes),
    updatedAt:
      r.updated_at instanceof Date
        ? r.updated_at.toISOString()
        : new Date(r.updated_at).toISOString(),
    billingLive: false,
  }
}

export async function updatePlatformPricing(input) {
  const messagingCostInr = Number(input.messagingCostInr)
  const subscriptionMonthlyInr = Number(input.subscriptionMonthlyInr)
  const subscriptionYearlyInr = Number(input.subscriptionYearlyInr)
  const notes = input.notes != null ? String(input.notes).slice(0, 2000) : ''
  if (![messagingCostInr, subscriptionMonthlyInr, subscriptionYearlyInr].every((n) => Number.isFinite(n) && n >= 0)) {
    throw new Error('Costs must be non-negative numbers')
  }
  await getPool().query(
    `INSERT INTO platform_pricing
      (id, messaging_cost_inr, subscription_monthly_inr, subscription_yearly_inr, notes, updated_at)
     VALUES (1, ?, ?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       messaging_cost_inr = VALUES(messaging_cost_inr),
       subscription_monthly_inr = VALUES(subscription_monthly_inr),
       subscription_yearly_inr = VALUES(subscription_yearly_inr),
       notes = VALUES(notes),
       updated_at = UTC_TIMESTAMP(3)`,
    [messagingCostInr, subscriptionMonthlyInr, subscriptionYearlyInr, notes],
  )
  await refreshMessagingCostCache()
  return getPlatformPricing()
}

export async function listShopWallets(q = '') {
  const params = []
  let where = '1=1'
  if (q) {
    where += ' AND (s.app_id LIKE ? OR s.shop_name LIKE ? OR u.phone LIKE ? OR u.name LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like, like)
  }
  const [rows] = await getPool().query(
    `SELECT
       s.app_id, s.shop_name, s.shop_address,
       u.id AS owner_id, u.name AS owner_name, u.phone AS owner_phone,
       COALESCE(w.balance_inr, 0) AS balance_inr,
       w.updated_at AS wallet_updated_at
     FROM shops s
     LEFT JOIN shop_wallets w ON w.shop_app_id = s.app_id
     LEFT JOIN users u ON u.id = COALESCE(
       s.owner_user_id,
       (SELECT id FROM users sk
         WHERE sk.shop_app_id = s.app_id AND sk.role = 'shopkeeper'
         ORDER BY sk.created_at ASC LIMIT 1)
     )
     WHERE ${where}
     ORDER BY s.shop_name ASC, s.created_at DESC
     LIMIT 300`,
    params,
  )
  return rows.map((r) => ({
    appId: String(r.app_id),
    shopName: String(r.shop_name ?? ''),
    shopAddress: String(r.shop_address ?? ''),
    balanceInr: Number(r.balance_inr) || 0,
    owner: r.owner_id
      ? {
          id: String(r.owner_id),
          name: String(r.owner_name ?? ''),
          phone: String(r.owner_phone ?? ''),
        }
      : null,
    updatedAt:
      r.wallet_updated_at == null
        ? null
        : r.wallet_updated_at instanceof Date
          ? r.wallet_updated_at.toISOString()
          : new Date(r.wallet_updated_at).toISOString(),
  }))
}

export async function adjustShopWallet({ shopAppId, amountInr, kind, note, createdByPhone }) {
  const appId = String(shopAppId || '').trim()
  const amount = Number(amountInr)
  const entryKind = String(kind || 'credit').toLowerCase() === 'debit' ? 'debit' : 'credit'
  if (!appId) throw new Error('Shop app id is required')
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Amount must be a positive number')

  const [shops] = await getPool().query(`SELECT app_id FROM shops WHERE app_id = ? LIMIT 1`, [appId])
  if (!shops[0]) throw new Error('Business not found')

  const conn = await getPool().getConnection()
  try {
    await conn.beginTransaction()
    const [walletRows] = await conn.query(
      `SELECT balance_inr FROM shop_wallets WHERE shop_app_id = ? LIMIT 1 FOR UPDATE`,
      [appId],
    )
    let balance = walletRows[0] ? Number(walletRows[0].balance_inr) || 0 : 0
    const delta = entryKind === 'debit' ? -amount : amount
    balance = Math.round((balance + delta) * 100) / 100
    if (balance < 0) {
      throw new Error('Insufficient wallet balance')
    }
    await conn.query(
      `INSERT INTO shop_wallets (shop_app_id, balance_inr, updated_at)
       VALUES (?, ?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE balance_inr = VALUES(balance_inr), updated_at = UTC_TIMESTAMP(3)`,
      [appId, balance],
    )
    const id = randomUUID()
    await conn.query(
      `INSERT INTO shop_wallet_ledger
        (id, shop_app_id, kind, amount_inr, balance_after, note, created_by_phone, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [
        id,
        appId,
        entryKind,
        amount,
        balance,
        note ? String(note).slice(0, 255) : null,
        createdByPhone ? String(createdByPhone).slice(0, 15) : null,
      ],
    )
    await conn.commit()
    return { appId, balanceInr: balance, kind: entryKind, amountInr: amount, ledgerId: id }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function shopWalletLedger(shopAppId, limit = 50) {
  const appId = String(shopAppId || '').trim()
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200)
  const [rows] = await getPool().query(
    `SELECT id, shop_app_id, kind, amount_inr, balance_after, note, created_by_phone, created_at
     FROM shop_wallet_ledger
     WHERE shop_app_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [appId, lim],
  )
  return rows.map((r) => ({
    id: String(r.id),
    shopAppId: String(r.shop_app_id),
    kind: String(r.kind),
    amountInr: Number(r.amount_inr) || 0,
    balanceAfter: Number(r.balance_after) || 0,
    note: r.note == null ? null : String(r.note),
    createdByPhone: r.created_by_phone == null ? null : String(r.created_by_phone),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at).toISOString(),
  }))
}
