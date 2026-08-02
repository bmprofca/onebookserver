/**
 * Platform admin panel API — OTP login for allowlisted phones + user ops.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'
import {
  calcTotals,
  ensureShopkeeperDraft,
  isValidPhone,
  loadAuth,
  loadState,
  markDeleted,
  newId,
  normalizePhone,
  saveAuth,
  saveState,
} from './store.js'

const ADMIN_SESSION_MS = 1000 * 60 * 60 * 12 // 12 hours
const OTP_TTL_MS = 1000 * 60 * 5

export function adminPhones() {
  return String(process.env.ADMIN_PHONES || '')
    .split(/[,\s]+/)
    .map((p) => normalizePhone(p))
    .filter((p) => /^\d{10}$/.test(p))
}

/** Fixed demo OTP for admin panel (no SMS/WhatsApp required). */
export function adminDemoOtp() {
  const raw = String(process.env.ADMIN_OTP || '123456').trim()
  return /^\d{4,8}$/.test(raw) ? raw : '123456'
}

export function isAdminPhone(phone) {
  const list = adminPhones()
  // If no allowlist is configured, any valid 10-digit phone can use the default admin OTP.
  if (list.length === 0) return /^\d{10}$/.test(normalizePhone(phone))
  return list.includes(normalizePhone(phone))
}

export async function ensureAdminSchema() {
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token VARCHAR(191) NOT NULL PRIMARY KEY,
      phone VARCHAR(15) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      expires_at BIGINT NOT NULL,
      KEY idx_admin_sessions_phone (phone),
      KEY idx_admin_sessions_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  await p.query(`
    CREATE TABLE IF NOT EXISTS login_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id CHAR(36) NULL,
      phone VARCHAR(15) NOT NULL,
      role VARCHAR(32) NULL,
      event VARCHAR(32) NOT NULL,
      ip VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_login_history_phone (phone),
      KEY idx_login_history_user (user_id),
      KEY idx_login_history_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  try {
    await p.query(
      `ALTER TABLE otps MODIFY purpose ENUM('login','register','admin') NOT NULL`,
    )
  } catch (err) {
    console.warn('[MySQL] otps purpose enum migrate skipped:', err instanceof Error ? err.message : err)
  }
}

export async function recordLoginEvent({
  userId = null,
  phone,
  role = null,
  event,
  ip = null,
  userAgent = null,
}) {
  try {
    await getPool().query(
      `INSERT INTO login_history (user_id, phone, role, event, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [
        userId,
        normalizePhone(phone),
        role,
        event,
        ip ? String(ip).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, 255) : null,
      ],
    )
  } catch (err) {
    console.warn('[login_history] insert skipped:', err instanceof Error ? err.message : err)
  }
}

async function createAdminSession(phone) {
  const token = `adm.${randomUUID().replace(/-/g, '')}${Date.now().toString(36)}`
  const expiresAt = Date.now() + ADMIN_SESSION_MS
  await getPool().query(
    `INSERT INTO admin_sessions (token, phone, created_at, expires_at) VALUES (?, ?, UTC_TIMESTAMP(3), ?)`,
    [token, normalizePhone(phone), expiresAt],
  )
  return { token, expiresAt }
}

async function findAdminSession(token) {
  if (!token) return null
  const [rows] = await getPool().query(
    `SELECT token, phone, created_at, expires_at FROM admin_sessions WHERE token = ? LIMIT 1`,
    [token],
  )
  const row = rows[0]
  if (!row) return null
  if (Number(row.expires_at) < Date.now()) {
    await getPool().query(`DELETE FROM admin_sessions WHERE token = ?`, [token])
    return null
  }
  return {
    token: String(row.token),
    phone: String(row.phone),
    createdAt: row.created_at,
    expiresAt: Number(row.expires_at),
  }
}

export function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  findAdminSession(token)
    .then((session) => {
      if (!session || !isAdminPhone(session.phone)) {
        res.status(401).json({ error: 'Admin login required' })
        return
      }
      req.admin = session
      next()
    })
    .catch((err) => {
      console.error('[admin] auth error', err)
      res.status(500).json({ error: 'Admin auth failed' })
    })
}

function clientMeta(req) {
  const fwd = req.headers['x-forwarded-for']
  const ip = req.ip || (typeof fwd === 'string' ? fwd.split(',')[0].trim() : null)
  return {
    ip,
    userAgent: req.get('user-agent') || null,
  }
}

function shopPublic(state) {
  if (!state) return null
  return {
    appId: state.appId,
    shopName: state.shopName,
    shopAddress: state.shopAddress || '',
    setupComplete: Boolean(state.setupComplete),
  }
}

function mapUserRow(r) {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    phone: String(r.phone ?? ''),
    email: r.email == null ? null : String(r.email),
    role: String(r.role ?? 'customer'),
    shopAppId: r.shop_app_id == null ? null : String(r.shop_app_id),
    phoneVerified: Boolean(r.phone_verified),
    openingBalance: Number(r.opening_balance) || 0,
    status: String(r.status || 'active'),
    deletedAt:
      r.deleted_at == null
        ? null
        : r.deleted_at instanceof Date
          ? r.deleted_at.toISOString()
          : new Date(r.deleted_at).toISOString(),
    createdAt:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at).toISOString(),
  }
}

async function walletForUser(user) {
  const openingBalance = Number(user.openingBalance) || 0
  if (!user.shopAppId) {
    return {
      openingBalance,
      liveBalance: openingBalance,
      totalReceipts: 0,
      totalPayments: 0,
      shop: null,
    }
  }
  try {
    const auth = loadAuth()
    const account = auth.accounts.find((a) => a.id === user.id) || {
      id: user.id,
      role: user.role,
      shopAppId: user.shopAppId,
    }
    const state = loadState(account)
    const shopTotals = calcTotals(state.openingBalance || 0, state.transactions || [])
    if (user.role === 'shopkeeper') {
      return {
        openingBalance: Number(state.openingBalance) || 0,
        liveBalance: shopTotals.liveBalance,
        totalReceipts: shopTotals.totalReceipts,
        totalPayments: shopTotals.totalPayments,
        shop: shopPublic(state),
      }
    }
    const customerTx = (state.transactions || []).filter(
      (t) => t.userId === user.id || t.customerId === user.id,
    )
    let receipts = 0
    let payments = 0
    for (const t of customerTx) {
      const amt = Math.abs(Number(t.amount) || 0)
      if (t.type === 'receipt') receipts += amt
      else payments += amt
    }
    return {
      openingBalance,
      liveBalance: openingBalance + payments - receipts,
      totalReceipts: receipts,
      totalPayments: payments,
      shop: shopPublic(state),
    }
  } catch {
    return {
      openingBalance,
      liveBalance: openingBalance,
      totalReceipts: 0,
      totalPayments: 0,
      shop: null,
    }
  }
}

/**
 * @param {import('express').Express} app
 * @param {{ issueOtp: Function, otpSentMessage: Function }} deps
 */
export function registerAdminPanelRoutes(app, deps) {
  const { issueOtp, otpSentMessage } = deps

  app.post('/api/admin/auth/request-otp', async (req, res) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''))
    if (!isValidPhone(phone)) {
      res.status(400).json({ error: 'Enter a valid 10-digit phone number' })
      return
    }
    if (!isAdminPhone(phone)) {
      res.status(403).json({ error: 'This number is not authorised for admin access' })
      return
    }
    // Admin panel uses a fixed default OTP — no WhatsApp/SMS send.
    const code = adminDemoOtp()
    const auth = loadAuth()
    auth.otps = auth.otps.filter((o) => !(o.phone === phone && o.purpose === 'admin'))
    auth.otps.push({
      phone,
      code,
      purpose: 'admin',
      expiresAt: Date.now() + OTP_TTL_MS,
    })
    saveAuth(auth)
    res.json({
      message: 'Use the default admin OTP to continue.',
      phone,
      channel: 'demo',
      devOtp: code,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    })
  })

  app.post('/api/admin/auth/verify-otp', async (req, res) => {
    const phone = normalizePhone(String(req.body?.phone ?? ''))
    const code = String(req.body?.otp ?? '').trim()
    if (!isValidPhone(phone) || !/^\d{4,8}$/.test(code)) {
      res.status(400).json({ error: 'Valid phone and OTP are required' })
      return
    }
    if (!isAdminPhone(phone)) {
      res.status(403).json({ error: 'This number is not authorised for admin access' })
      return
    }
    const auth = loadAuth()
    const otp = auth.otps.find((o) => o.phone === phone && o.purpose === 'admin')
    const expected = otp && otp.expiresAt > Date.now() ? otp.code : adminDemoOtp()
    // Accept stored OTP, or the default admin OTP even if request-otp was skipped.
    if (code !== expected && code !== adminDemoOtp()) {
      res.status(401).json({ error: 'Invalid or expired OTP' })
      return
    }
    auth.otps = auth.otps.filter((o) => !(o.phone === phone && o.purpose === 'admin'))
    saveAuth(auth)
    const session = await createAdminSession(phone)
    const meta = clientMeta(req)
    await recordLoginEvent({
      phone,
      role: 'platform_admin',
      event: 'admin_login',
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    res.json({
      token: session.token,
      phone,
      expiresAt: session.expiresAt,
      message: 'Admin login successful',
    })
  })

  app.get('/api/admin/auth/me', requireAdminAuth, (req, res) => {
    res.json({
      phone: req.admin.phone,
      role: 'platform_admin',
      expiresAt: req.admin.expiresAt,
    })
  })

  app.post('/api/admin/auth/logout', requireAdminAuth, async (req, res) => {
    await getPool().query(`DELETE FROM admin_sessions WHERE token = ?`, [req.admin.token])
    await recordLoginEvent({
      phone: req.admin.phone,
      role: 'platform_admin',
      event: 'admin_logout',
      ...clientMeta(req),
    })
    res.json({ ok: true })
  })

  app.get('/api/admin/stats', requireAdminAuth, async (_req, res) => {
    const p = getPool()
    const [[users]] = await p.query(
      `SELECT
         COUNT(*) AS total,
         SUM(IFNULL(status,'active') = 'active') AS active,
         SUM(IFNULL(status,'active') = 'suspended') AS suspended,
         SUM(IFNULL(status,'active') = 'deleted') AS deleted,
         SUM(role = 'shopkeeper' AND IFNULL(status,'active') <> 'deleted') AS shopkeepers,
         SUM(role = 'customer' AND IFNULL(status,'active') <> 'deleted') AS customers
       FROM users`,
    )
    const [[sessions]] = await p.query(
      `SELECT COUNT(*) AS activeSessions FROM sessions WHERE expires_at > ?`,
      [Date.now()],
    )
    const [[shops]] = await p.query(`SELECT COUNT(*) AS shops FROM shops`)
    const [[messages]] = await p.query(
      `SELECT COUNT(*) AS messages FROM whatsapp_message_logs WHERE created_at >= (UTC_TIMESTAMP(3) - INTERVAL 7 DAY)`,
    )
    res.json({
      users: {
        total: Number(users.total) || 0,
        active: Number(users.active) || 0,
        suspended: Number(users.suspended) || 0,
        deleted: Number(users.deleted) || 0,
        shopkeepers: Number(users.shopkeepers) || 0,
        customers: Number(users.customers) || 0,
      },
      activeSessions: Number(sessions.activeSessions) || 0,
      shops: Number(shops.shops) || 0,
      messagesLast7Days: Number(messages.messages) || 0,
    })
  })

  app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
    const q = String(req.query.q || '').trim()
    const status = String(req.query.status || '').trim().toLowerCase()
    const role = String(req.query.role || '').trim().toLowerCase()
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const params = []
    let where = '1=1'
    if (q) {
      where += ' AND (name LIKE ? OR phone LIKE ? OR id LIKE ? OR shop_app_id LIKE ?)'
      const like = `%${q}%`
      params.push(like, like, like, like)
    }
    if (status && ['active', 'suspended', 'deleted'].includes(status)) {
      where += " AND IFNULL(status, 'active') = ?"
      params.push(status)
    }
    if (role && ['shopkeeper', 'customer'].includes(role)) {
      where += ' AND role = ?'
      params.push(role)
    }
    params.push(limit)
    const [rows] = await getPool().query(
      `SELECT id, name, phone, email, role, phone_verified, shop_app_id, opening_balance, status, deleted_at, created_at
       FROM users
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params,
    )
    res.json({ users: rows.map(mapUserRow) })
  })

  app.get('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
    const id = String(req.params.id)
    const [rows] = await getPool().query(
      `SELECT id, name, phone, email, role, phone_verified, shop_app_id, opening_balance, status, deleted_at, created_at
       FROM users WHERE id = ? LIMIT 1`,
      [id],
    )
    if (!rows[0]) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    const user = mapUserRow(rows[0])
    const wallet = await walletForUser(user)
    const [loginRows] = await getPool().query(
      `SELECT id, user_id, phone, role, event, ip, user_agent, created_at
       FROM login_history
       WHERE user_id = ? OR phone = ?
       ORDER BY created_at DESC
       LIMIT 30`,
      [id, user.phone],
    )
    const [sessionRows] = await getPool().query(
      `SELECT token, user_id, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [id],
    )
    res.json({
      user,
      wallet,
      loginHistory: loginRows.map((r) => ({
        id: Number(r.id),
        userId: r.user_id == null ? null : String(r.user_id),
        phone: String(r.phone),
        role: r.role,
        event: String(r.event),
        ip: r.ip,
        userAgent: r.user_agent,
        createdAt:
          r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      })),
      sessions: sessionRows.map((r) => ({
        token: `${String(r.token).slice(0, 12)}…`,
        userId: String(r.user_id),
        createdAt:
          r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        expiresAt: Number(r.expires_at),
        active: Number(r.expires_at) > Date.now(),
      })),
    })
  })

  app.post('/api/admin/users', requireAdminAuth, async (req, res) => {
    const name = String(req.body?.name ?? '').trim()
    const phone = normalizePhone(String(req.body?.phone ?? ''))
    const role =
      String(req.body?.role ?? 'customer').toLowerCase() === 'shopkeeper' ? 'shopkeeper' : 'customer'
    const shopName = String(req.body?.shopName ?? '').trim() || 'New shop'
    const shopAddress = String(req.body?.shopAddress ?? '').trim()
    if (!name) {
      res.status(400).json({ error: 'Name is required' })
      return
    }
    if (!isValidPhone(phone)) {
      res.status(400).json({ error: 'Enter a valid 10-digit phone number' })
      return
    }
    const auth = loadAuth()
    if (role === 'shopkeeper' && auth.accounts.some((a) => a.phone === phone && a.role === 'shopkeeper')) {
      res.status(409).json({ error: 'This phone already has a shopkeeper profile' })
      return
    }
    const account = {
      id: newId(),
      name,
      phone,
      email: null,
      role,
      shopAppId: null,
      phoneVerified: true,
      createdAt: new Date().toISOString(),
      status: 'active',
    }
    if (role === 'shopkeeper') {
      const draft = ensureShopkeeperDraft(account, { shopName, shopAddress })
      account.shopAppId = draft.appId
      auth.accounts.push(account)
      saveAuth(auth)
      saveState(draft, account)
      await getPool().query(`UPDATE users SET status = 'active' WHERE id = ?`, [account.id])
    } else {
      auth.accounts.push(account)
      saveAuth(auth)
      await getPool().query(
        `INSERT INTO users (id, name, phone, email, role, phone_verified, shop_app_id, opening_balance, created_at, status, deleted_at)
         VALUES (?, ?, ?, NULL, 'customer', 1, NULL, 0, UTC_TIMESTAMP(3), 'active', NULL)
         ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active', deleted_at = NULL`,
        [account.id, name, phone],
      )
    }
    res.status(201).json({ user: account, message: 'User created' })
  })

  app.patch('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
    const id = String(req.params.id)
    const [rows] = await getPool().query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [id])
    if (!rows[0]) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    const nextName = req.body?.name != null ? String(req.body.name).trim() : null
    const nextStatus = req.body?.status != null ? String(req.body.status).trim().toLowerCase() : null
    const nextOpening =
      req.body?.openingBalance != null && req.body.openingBalance !== ''
        ? Number(req.body.openingBalance)
        : null

    if (nextStatus && !['active', 'suspended', 'deleted'].includes(nextStatus)) {
      res.status(400).json({ error: 'Status must be active, suspended, or deleted' })
      return
    }

    const auth = loadAuth()
    const idx = auth.accounts.findIndex((a) => a.id === id)
    if (idx >= 0 && nextName) {
      auth.accounts[idx] = { ...auth.accounts[idx], name: nextName }
    }
    if (idx >= 0 && nextStatus === 'deleted') {
      auth.accounts[idx] = markDeleted(auth.accounts[idx])
      auth.sessions = auth.sessions.filter((s) => s.userId !== id)
    }
    if (idx >= 0 && nextStatus && nextStatus !== 'deleted') {
      auth.accounts[idx] = {
        ...auth.accounts[idx],
        status: nextStatus,
        deletedAt: null,
      }
    }
    if (idx >= 0) saveAuth(auth)

    const sets = []
    const params = []
    if (nextName) {
      sets.push('name = ?')
      params.push(nextName)
    }
    if (nextStatus) {
      sets.push('status = ?')
      params.push(nextStatus)
      sets.push('deleted_at = ?')
      params.push(nextStatus === 'deleted' ? new Date() : null)
    }
    if (nextOpening != null && Number.isFinite(nextOpening)) {
      sets.push('opening_balance = ?')
      params.push(nextOpening)
    }
    if (sets.length === 0) {
      res.status(400).json({ error: 'No changes provided' })
      return
    }
    params.push(id)
    await getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params)

    if (nextStatus === 'suspended' || nextStatus === 'deleted') {
      await getPool().query(`DELETE FROM sessions WHERE user_id = ?`, [id])
    }

    const [updated] = await getPool().query(
      `SELECT id, name, phone, email, role, phone_verified, shop_app_id, opening_balance, status, deleted_at, created_at
       FROM users WHERE id = ? LIMIT 1`,
      [id],
    )
    res.json({ user: mapUserRow(updated[0]), message: 'User updated' })
  })

  app.delete('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
    const id = String(req.params.id)
    const auth = loadAuth()
    const idx = auth.accounts.findIndex((a) => a.id === id)
    if (idx >= 0) {
      auth.accounts[idx] = markDeleted(auth.accounts[idx])
      auth.sessions = auth.sessions.filter((s) => s.userId !== id)
      saveAuth(auth)
    }
    await getPool().query(
      `UPDATE users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [id],
    )
    await getPool().query(`DELETE FROM sessions WHERE user_id = ?`, [id])
    res.json({ ok: true, message: 'User removed (soft-deleted)' })
  })

  app.get('/api/admin/sessions', requireAdminAuth, async (_req, res) => {
    const now = Date.now()
    const [rows] = await getPool().query(
      `SELECT s.token, s.user_id, s.created_at, s.expires_at,
              u.name, u.phone, u.role, u.shop_app_id, u.status
       FROM sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > ?
       ORDER BY s.created_at DESC
       LIMIT 300`,
      [now],
    )
    const [adminRows] = await getPool().query(
      `SELECT token, phone, created_at, expires_at FROM admin_sessions WHERE expires_at > ? ORDER BY created_at DESC LIMIT 50`,
      [now],
    )
    res.json({
      activeUsers: rows.map((r) => ({
        userId: String(r.user_id),
        name: r.name == null ? 'Unknown' : String(r.name),
        phone: r.phone == null ? '' : String(r.phone),
        role: r.role,
        shopAppId: r.shop_app_id == null ? null : String(r.shop_app_id),
        status: r.status || 'active',
        sessionStarted:
          r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        expiresAt: Number(r.expires_at),
      })),
      activeAdmins: adminRows.map((r) => ({
        phone: String(r.phone),
        sessionStarted:
          r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        expiresAt: Number(r.expires_at),
      })),
    })
  })

  app.get('/api/admin/login-history', requireAdminAuth, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const phone = normalizePhone(String(req.query.phone || ''))
    const params = []
    let where = '1=1'
    if (/^\d{10}$/.test(phone)) {
      where += ' AND phone = ?'
      params.push(phone)
    }
    params.push(limit)
    const [rows] = await getPool().query(
      `SELECT id, user_id, phone, role, event, ip, user_agent, created_at
       FROM login_history
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params,
    )
    res.json({
      history: rows.map((r) => ({
        id: Number(r.id),
        userId: r.user_id == null ? null : String(r.user_id),
        phone: String(r.phone),
        role: r.role,
        event: String(r.event),
        ip: r.ip,
        userAgent: r.user_agent,
        createdAt:
          r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
      })),
    })
  })

  app.get('/api/admin/messages', requireAdminAuth, async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    const phone = normalizePhone(String(req.query.phone || ''))
    const shopAppId = String(req.query.shopAppId || '').trim()
    const params = []
    let where = '1=1'
    if (/^\d{10}$/.test(phone)) {
      where += ' AND phone = ?'
      params.push(phone)
    }
    if (shopAppId) {
      where += ' AND shop_app_id = ?'
      params.push(shopAppId)
    }
    params.push(limit)
    const [rows] = await getPool().query(
      `SELECT id, shop_app_id, customer_user_id, customer_name, phone,
              kind, template_name, message_body, status, error_message,
              provider_message_id, cost_inr, sent_by_user_id, sent_by_name, created_at
       FROM whatsapp_message_logs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params,
    )
    res.json({
      messages: rows.map((row) => ({
        id: String(row.id),
        shopAppId: String(row.shop_app_id),
        customerId: row.customer_user_id == null ? null : String(row.customer_user_id),
        customerName: String(row.customer_name ?? ''),
        phone: String(row.phone ?? ''),
        kind: String(row.kind ?? ''),
        templateName: String(row.template_name ?? ''),
        messageBody: String(row.message_body ?? ''),
        status: String(row.status ?? ''),
        error: row.error_message == null ? null : String(row.error_message),
        costInr: Number(row.cost_inr) || 0,
        sentByName: row.sent_by_name == null ? null : String(row.sent_by_name),
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : new Date(row.created_at).toISOString(),
      })),
    })
  })
}
