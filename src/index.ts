import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import {
  createSession,
  publicAccount,
  requireAuth,
  requireShopkeeper,
  type AuthedRequest,
} from './auth.js'
import {
  deleteAttachmentFile,
  ensureUploadsDir,
  saveAttachmentData,
  UPLOADS_DIR,
} from './attachments.js'
import {
  calcTotals,
  DEFAULT_CASH_ACCOUNT_ID,
  defaultCashAccount,
  emptyAuth,
  emptyState,
  ensureCashAccounts,
  generateDemoOtp,
  generateOtp,
  ensureShopkeeperDraft,
  getActionConfirmCode,
  initStore,
  isValidPhone,
  loadAuth,
  loadState,
  newId,
  newTxId,
  normalizePhone,
  phoneExistsInDatabase,
  uniqueTxCreatedAt,
  saveAuth,
  saveState,
} from './store.js'
import { isWhatsAppOtpConfigured, sendWhatsAppOtp, sendPaymentReminderWhatsApp, isPaymentReminderWhatsAppConfigured } from './onechatting.js'
import { isSmsOtpConfigured, sendSmsOtp } from './fast2sms.js'
import {
  billingDateForPeriod,
  createRecurringBilling,
  daysAfterPeriodEnd,
  isDateOnly,
  localDateString,
  materializeRecurringBillings,
  postNextRecurringBill,
  RECURRING_INTERVALS,
} from './recurring.js'
import type { Response } from 'express'
import type {
  RecurringInterval,
  ShopService,
  ShopState,
  ShopTodo,
  TransactionCategory,
  TransactionType,
  UserRole,
} from './types.js'

const app = express()
const PORT = Number(process.env.PORT || 4000)
const OTP_TTL_MS = 1000 * 60 * 5

function resolveService(
  state: ShopState,
  serviceId: string | null | undefined,
): { ok: true; service: ShopService | null } | { ok: false; error: string } {
  const id = String(serviceId ?? '').trim()
  if (!id) return { ok: true, service: null }
  const service = state.services.find((item) => item.id === id) ?? null
  if (!service) return { ok: false, error: 'Service not found' }
  return { ok: true, service }
}

function serviceRemarks(service: ShopService, fallback = ''): string {
  const desc = service.description.trim()
  if (desc) return `${service.name} — ${desc}`
  return service.name || fallback
}

type OtpChannel = 'whatsapp' | 'sms' | 'whatsapp+sms' | 'demo'

type OtpIssueResult =
  | { ok: true; code: string; channel: OtpChannel; expiresInSeconds: number }
  | { ok: false; error: string; status: number }

function configuredOtpChannels(): Array<'whatsapp' | 'sms'> {
  const raw = (process.env.OTP_CHANNELS || '').trim().toLowerCase()
  const requested = raw
    ? raw
        .split(',')
        .map((c) => c.trim())
        .filter((c): c is 'whatsapp' | 'sms' => c === 'whatsapp' || c === 'sms')
    : (['whatsapp', 'sms'] as const)

  const channels: Array<'whatsapp' | 'sms'> = []
  for (const channel of requested) {
    if (channel === 'whatsapp' && isWhatsAppOtpConfigured()) channels.push('whatsapp')
    if (channel === 'sms' && isSmsOtpConfigured()) channels.push('sms')
  }
  return [...new Set(channels)]
}

function toDeliveryChannel(sent: Array<'whatsapp' | 'sms'>): OtpChannel {
  if (sent.includes('whatsapp') && sent.includes('sms')) return 'whatsapp+sms'
  if (sent.includes('sms')) return 'sms'
  if (sent.includes('whatsapp')) return 'whatsapp'
  return 'demo'
}

function otpSentMessage(channel: OtpChannel, purpose: 'login' | 'register'): string {
  if (purpose === 'register') {
    if (channel === 'whatsapp+sms') {
      return 'OTP sent on WhatsApp and SMS. Confirm your mobile number to complete registration.'
    }
    if (channel === 'sms') {
      return 'OTP sent by SMS. Confirm your mobile number to complete registration.'
    }
    if (channel === 'whatsapp') {
      return 'OTP sent on WhatsApp. Confirm your mobile number to complete registration.'
    }
    return 'OTP sent. Confirm your mobile number to complete registration.'
  }

  if (channel === 'whatsapp+sms') return 'OTP sent on WhatsApp and SMS'
  if (channel === 'sms') return 'OTP sent by SMS'
  if (channel === 'whatsapp') return 'OTP sent on WhatsApp'
  return 'OTP sent'
}

/** Generate OTP and deliver via WhatsApp and/or SMS when configured. */
async function issueOtp(phone: string, purpose: 'login' | 'register'): Promise<OtpIssueResult> {
  const channels = configuredOtpChannels()
  const requireBoth =
    process.env.OTP_REQUIRE_BOTH === '1' ||
    (channels.includes('whatsapp') && channels.includes('sms'))
  const demoFallback =
    process.env.OTP_DEMO_FALLBACK === '1' || channels.length === 0
  const code = channels.length > 0 ? generateOtp() : generateDemoOtp()

  if (channels.length > 0) {
    const sent: Array<'whatsapp' | 'sms'> = []
    const errors: string[] = []

    // Send in parallel so WhatsApp + SMS arrive together.
    const jobs: Array<Promise<void>> = []
    if (channels.includes('whatsapp')) {
      jobs.push(
        sendWhatsAppOtp(phone, code).then((result) => {
          if (result.ok) sent.push('whatsapp')
          else errors.push(`WhatsApp: ${result.error}`)
        }),
      )
    }
    if (channels.includes('sms')) {
      jobs.push(
        sendSmsOtp(phone, code, { purpose }).then((result) => {
          if (result.ok) sent.push('sms')
          else errors.push(`SMS: ${result.error}`)
        }),
      )
    }
    await Promise.all(jobs)

    const missing = channels.filter((c) => !sent.includes(c))
    if (sent.length === 0 || (requireBoth && missing.length > 0)) {
      return {
        ok: false,
        status: 502,
        error: `Could not send OTP on ${missing.join(' and ') || 'any channel'} (${errors.join('; ') || 'no channel succeeded'})`,
      }
    }

    const channel = toDeliveryChannel(sent)
    console.log(`[OTP ${purpose}] ${phone} → ${channel}`)
    return {
      ok: true,
      code,
      channel,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    }
  }

  if (!demoFallback) {
    return {
      ok: false,
      status: 503,
      error:
        'OTP delivery is not configured. Set OneChatting and/or Fast2SMS credentials.',
    }
  }

  console.log(`[OTP ${purpose}] ${phone} → ${code} (demo fallback)`)
  return {
    ok: true,
    code,
    channel: 'demo',
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
  }
}

ensureUploadsDir()
app.use(cors())
app.use(express.json({ limit: '8mb' }))
app.use('/uploads', express.static(UPLOADS_DIR))

/** Require shops.action_confirm_code for edit/delete (dev default 123456). */
function requireActionConfirmCode(
  req: AuthedRequest,
  res: Response,
  state: ShopState,
): boolean {
  const code = String(req.body?.confirmCode ?? '').replace(/\D/g, '').slice(0, 6)
  const expected = getActionConfirmCode(state.appId)
  if (!code || code !== expected) {
    res.status(403).json({ error: 'Invalid confirmation code' })
    return false
  }
  return true
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

function shopPublic(state: { appId: string; shopName: string; shopAddress?: string; setupComplete: boolean }) {
  return {
    appId: state.appId,
    shopName: state.shopName,
    shopAddress: state.shopAddress ?? '',
    setupComplete: state.setupComplete,
  }
}

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  const phone = normalizePhone(String(req.body?.phone ?? ''))
  const shopName = String(req.body?.shopName ?? '').trim()
  const shopAddress = String(req.body?.shopAddress ?? '').trim()

  if (!name) {
    res.status(400).json({ error: 'Name is required' })
    return
  }
  if (!shopName) {
    res.status(400).json({ error: 'Business name is required' })
    return
  }
  if (shopName.length > 80) {
    res.status(400).json({ error: 'Business name is too long' })
    return
  }
  if (!shopAddress) {
    res.status(400).json({ error: 'Business address is required' })
    return
  }
  if (shopAddress.length > 240) {
    res.status(400).json({ error: 'Business address is too long' })
    return
  }
  if (!isValidPhone(phone)) {
    res.status(400).json({ error: 'Enter a valid 10-digit phone number' })
    return
  }

  const auth = loadAuth()
  const existing = auth.accounts.find((a) => a.phone === phone)
  if (existing?.phoneVerified) {
    res.status(409).json({ error: 'Phone already registered. Please login.' })
    return
  }

  const issued = await issueOtp(phone, 'register')
  if (!issued.ok) {
    res.status(issued.status).json({ error: issued.error })
    return
  }

  // Replace any previous pending registration / OTP for this phone
  auth.pendingRegistrations = auth.pendingRegistrations.filter((p) => p.phone !== phone)
  auth.otps = auth.otps.filter((o) => o.phone !== phone)

  auth.pendingRegistrations.push({
    name,
    phone,
    shopName,
    shopAddress,
    role: 'shopkeeper',
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + OTP_TTL_MS,
  })
  auth.otps.push({
    phone,
    code: issued.code,
    purpose: 'register',
    expiresAt: Date.now() + OTP_TTL_MS,
  })
  saveAuth(auth)

  res.status(201).json({
    message: otpSentMessage(issued.channel, 'register'),
    phone,
    channel: issued.channel,
    ...(issued.channel === 'demo' ? { devOtp: issued.code } : {}),
    expiresInSeconds: issued.expiresInSeconds,
  })
})

app.post('/api/auth/verify-register', (req, res) => {
  const phone = normalizePhone(String(req.body?.phone ?? ''))
  const code = String(req.body?.otp ?? '').trim()

  if (!isValidPhone(phone) || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: 'Valid phone and 6-digit OTP are required' })
    return
  }

  const auth = loadAuth()
  const pending = auth.pendingRegistrations.find((p) => p.phone === phone)
  if (!pending || pending.expiresAt < Date.now()) {
    res.status(400).json({ error: 'Registration expired. Please register again.' })
    return
  }

  const otp = auth.otps.find((o) => o.phone === phone && o.purpose === 'register')
  if (!otp || otp.expiresAt < Date.now() || otp.code !== code) {
    res.status(401).json({ error: 'Invalid or expired OTP' })
    return
  }

  // Remove unfinished / duplicate accounts for this phone
  auth.accounts = auth.accounts.filter((a) => a.phone !== phone)

  const account = {
    id: newId(),
    name: pending.name,
    phone: pending.phone,
    email: null as string | null,
    role: pending.role,
    shopAppId: null as string | null,
    phoneVerified: true,
    createdAt: new Date().toISOString(),
  }

  // Create this shopkeeper's shop draft (multi-tenant: each admin gets their own shop)
  const draft = ensureShopkeeperDraft(account, {
    shopName: pending.shopName,
    shopAddress: pending.shopAddress,
  })
  account.shopAppId = draft.appId

  auth.accounts.push(account)
  auth.pendingRegistrations = auth.pendingRegistrations.filter((p) => p.phone !== phone)
  auth.otps = auth.otps.filter((o) => o.phone !== phone)
  saveAuth(auth)

  const token = createSession(account.id)
  saveState(draft, account)

  res.status(201).json({
    message: 'Registration confirmed',
    token,
    account: publicAccount(account),
    shop: shopPublic(draft),
  })
})

app.post('/api/auth/request-otp', async (req, res) => {
  const phone = normalizePhone(String(req.body?.phone ?? ''))
  if (!isValidPhone(phone)) {
    res.status(400).json({ error: 'Enter a valid 10-digit phone number' })
    return
  }

  const auth = loadAuth()
  const account = auth.accounts.find((a) => a.phone === phone)
  if (!account) {
    res.status(404).json({ error: 'Phone not registered. Please register first.' })
    return
  }

  const issued = await issueOtp(phone, 'login')
  if (!issued.ok) {
    res.status(issued.status).json({ error: issued.error })
    return
  }

  auth.otps = auth.otps.filter((o) => !(o.phone === phone && o.purpose === 'login'))
  auth.otps.push({
    phone,
    code: issued.code,
    purpose: 'login',
    expiresAt: Date.now() + OTP_TTL_MS,
  })
  saveAuth(auth)

  res.json({
    message: otpSentMessage(issued.channel, 'login'),
    phone,
    channel: issued.channel,
    ...(issued.channel === 'demo' ? { devOtp: issued.code } : {}),
    expiresInSeconds: issued.expiresInSeconds,
  })
})

app.post('/api/auth/verify-otp', (req, res) => {
  const phone = normalizePhone(String(req.body?.phone ?? ''))
  const code = String(req.body?.otp ?? '').trim()

  if (!isValidPhone(phone) || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: 'Valid phone and 6-digit OTP are required' })
    return
  }

  const auth = loadAuth()
  const otp = auth.otps.find((o) => o.phone === phone && o.purpose === 'login')
  if (!otp || otp.expiresAt < Date.now() || otp.code !== code) {
    res.status(401).json({ error: 'Invalid or expired OTP' })
    return
  }

  const idx = auth.accounts.findIndex((a) => a.phone === phone)
  if (idx < 0) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  auth.accounts[idx] = { ...auth.accounts[idx], phoneVerified: true }
  auth.otps = auth.otps.filter((o) => !(o.phone === phone && o.purpose === 'login'))
  saveAuth(auth)

  const account = auth.accounts[idx]
  const token = createSession(account.id)
  const state = loadState(account)

  res.json({
    token,
    account: publicAccount(account),
    shop: shopPublic(state),
  })
})

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  res.json({
    account: publicAccount(req.account!),
    shop: shopPublic(state),
  })
})

app.put('/api/auth/profile', requireAuth, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const name = String(req.body?.name ?? '').trim()
  const emailRaw = req.body?.email
  const email =
    emailRaw === undefined || emailRaw === null ? undefined : String(emailRaw).trim().toLowerCase()
  const shopNameRaw = req.body?.shopName
  const shopName =
    shopNameRaw === undefined || shopNameRaw === null ? undefined : String(shopNameRaw).trim()
  const shopAddressRaw = req.body?.shopAddress
  const shopAddress =
    shopAddressRaw === undefined || shopAddressRaw === null
      ? undefined
      : String(shopAddressRaw).trim()

  if (!name || name.length < 2) {
    res.status(400).json({ error: 'Enter a valid name (at least 2 characters)' })
    return
  }
  if (name.length > 60) {
    res.status(400).json({ error: 'Name is too long' })
    return
  }
  if (email !== undefined && email !== '') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Enter a valid email address' })
      return
    }
    if (email.length > 120) {
      res.status(400).json({ error: 'Email is too long' })
      return
    }
  }

  const account = req.account!
  if (shopName !== undefined) {
    if (account.role !== 'shopkeeper') {
      res.status(403).json({ error: 'Only the shopkeeper can edit the shop name' })
      return
    }
    if (!shopName) {
      res.status(400).json({ error: 'Shop name is required' })
      return
    }
    if (shopName.length > 80) {
      res.status(400).json({ error: 'Shop name is too long' })
      return
    }
  }
  if (shopAddress !== undefined) {
    if (account.role !== 'shopkeeper') {
      res.status(403).json({ error: 'Only the shopkeeper can edit the business address' })
      return
    }
    if (!shopAddress) {
      res.status(400).json({ error: 'Business address is required' })
      return
    }
    if (shopAddress.length > 240) {
      res.status(400).json({ error: 'Business address is too long' })
      return
    }
  }

  const auth = loadAuth()
  const idx = auth.accounts.findIndex((a) => a.id === account.id)
  if (idx < 0) {
    res.status(404).json({ error: 'Account not found' })
    return
  }

  auth.accounts[idx] = {
    ...auth.accounts[idx],
    name,
    ...(email !== undefined ? { email: email || null } : {}),
  }
  saveAuth(auth)

  state.users = state.users.map((u) => {
    if (u.id === account.id || (account.phone && u.phone === account.phone)) {
      return { ...u, name }
    }
    return u
  })
  if (shopName !== undefined) {
    state.shopName = shopName
  }
  if (shopAddress !== undefined) {
    state.shopAddress = shopAddress
  }
  saveState(state, req.account)

  const updated = auth.accounts[idx]
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({
    account: publicAccount(updated),
    shop: shopPublic(state),
    state,
    ...totals,
  })
})

app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const auth = loadAuth()
  auth.sessions = auth.sessions.filter((s) => s.token !== token)
  saveAuth(auth)
  res.json({ ok: true })
})

app.get('/api/state', requireAuth, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const account = req.account!
  const generated = materializeRecurringBillings(state)
  if (generated > 0) saveState(state, req.account)

  if (account.role === 'customer') {
    if (account.shopAppId !== state.appId) {
      res.status(403).json({ error: 'Not linked to this shop' })
      return
    }
    const myTx = state.transactions.filter(
      (t) =>
        t.customerId === account.id ||
        t.userId === account.id ||
        (account.phone && t.customerPhone === account.phone) ||
        (account.phone && t.remarks.includes(account.phone)),
    )
    const totalReceipts = myTx
      .filter((t) => t.type === 'receipt')
      .reduce((sum, t) => sum + t.amount, 0)
    const totalPayments = myTx
      .filter((t) => t.type === 'payment')
      .reduce((sum, t) => sum + t.amount, 0)
    const liveBalance = totalReceipts - totalPayments

    res.json({
      state: {
        ...state,
        openingBalance: 0,
        transactions: myTx,
        recurringBillings: state.recurringBillings.filter(
          (billing) => billing.customerId === account.id,
        ),
        users: state.users.filter((u) => u.id === account.id),
        todos: [],
        services: [],
      },
      totalReceipts,
      totalPayments,
      // Customer perspective: opposite of shop receivable
      liveBalance,
      account: publicAccount(account),
    })
    return
  }

  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, ...totals, account: publicAccount(account) })
})

app.post('/api/setup', requireShopkeeper, (req: AuthedRequest, res) => {
  const { shopName, shopAddress, openingBalance } = req.body as {
    shopName?: string
    shopAddress?: string
    openingBalance?: number
  }
  const account = req.account!
  const existing = loadState(account)
  const resolvedName = (shopName?.trim() || existing.shopName || '').trim()
  const resolvedAddress = (shopAddress?.trim() || existing.shopAddress || '').trim()

  if (!resolvedName) {
    res.status(400).json({ error: 'Shop name is required' })
    return
  }
  if (!resolvedAddress) {
    res.status(400).json({ error: 'Business address is required' })
    return
  }

  const balance = Number(openingBalance)
  if (Number.isNaN(balance) || balance < 0) {
    res.status(400).json({ error: 'Invalid opening balance' })
    return
  }

  const createdAt = existing.createdAt || new Date().toISOString()
  const cashAccount = defaultCashAccount(balance, createdAt)
  const state = ensureCashAccounts({
    ...emptyState(),
    appId: existing.appId || emptyState().appId,
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
        role: 'shopkeeper' as const,
        createdAt: account.createdAt,
      },
    ],
    activeUserId: account.id,
    setupComplete: true,
    createdAt,
  })

  // Keep Cash account opening balance locked to the setup value.
  const systemCash = state.cashAccounts.find(
    (a) => a.isSystem || a.id === DEFAULT_CASH_ACCOUNT_ID,
  )
  if (systemCash) systemCash.openingBalance = balance
  state.openingBalance = balance

  const auth = loadAuth()
  const idx = auth.accounts.findIndex((a) => a.id === account.id)
  if (idx >= 0) {
    auth.accounts[idx] = { ...auth.accounts[idx], shopAppId: state.appId }
  }
  saveAuth(auth)
  saveState(state, req.account)

  const totals = calcTotals(state.openingBalance, state.transactions)
  res.status(201).json({
    state,
    ...totals,
    account: publicAccount(auth.accounts[idx] ?? account),
  })
})

app.post('/api/users', requireShopkeeper, async (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim()
  const phone = normalizePhone(String(req.body?.phone ?? ''))
  const email = String(req.body?.email ?? '')
    .trim()
    .toLowerCase()
  const role = (String(req.body?.role ?? 'customer') as UserRole) || 'customer'

  if (!name) {
    res.status(400).json({ error: 'Name is required' })
    return
  }
  if (role !== 'shopkeeper' && role !== 'customer') {
    res.status(400).json({ error: 'Invalid role' })
    return
  }
  if (role === 'customer' && !isValidPhone(phone)) {
    res.status(400).json({ error: 'Customer mobile number (10 digits) is required' })
    return
  }
  if (phone && !isValidPhone(phone)) {
    res.status(400).json({ error: 'Enter a valid 10-digit phone number' })
    return
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Enter a valid email address' })
    return
  }

  const state = loadState(req.account)
  if (!state.setupComplete) {
    res.status(400).json({ error: 'Complete setup first' })
    return
  }

  if (phone && state.users.some((u) => normalizePhone(u.phone) === phone)) {
    res.status(409).json({ error: 'This mobile number is already added in this shop' })
    return
  }

  const auth = loadAuth()
  if (phone && auth.accounts.some((a) => normalizePhone(a.phone) === phone)) {
    res.status(409).json({
      error: 'This mobile number is already registered. Ask them to login with OTP.',
    })
    return
  }

  try {
    if (phone && (await phoneExistsInDatabase(phone))) {
      res.status(409).json({
        error: 'This mobile number already exists in the database',
      })
      return
    }
  } catch (err) {
    console.error('[users] phone lookup failed', err)
    res.status(500).json({ error: 'Could not validate mobile number' })
    return
  }

  const userId = newId()
  const createdAt = new Date().toISOString()
  const user = {
    id: userId,
    name,
    phone,
    email: email || null,
    role,
    createdAt,
  }
  state.users.push(user)
  if (!state.activeUserId && role === 'shopkeeper') state.activeUserId = user.id

  try {
    saveState(state, req.account)

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
      })
      saveAuth(auth)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Duplicate|ER_DUP_ENTRY/i.test(msg)) {
      res.status(409).json({ error: 'This mobile number already exists in the database' })
      return
    }
    console.error('[users] create failed', err)
    res.status(500).json({ error: 'Could not add customer' })
    return
  }

  res.status(201).json({
    state,
    user,
    loginReady: Boolean(phone),
    message: phone
      ? `${name} can login with OTP using ${phone}`
      : 'Customer added',
  })
})

app.put('/api/users/active', requireShopkeeper, (req: AuthedRequest, res) => {
  const id = String(req.body?.id ?? '')
  const state = loadState(req.account)
  const user = state.users.find((u) => u.id === id)
  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (user.role !== 'shopkeeper') {
    res.status(400).json({ error: 'Only shopkeepers can record transactions' })
    return
  }
  state.activeUserId = id
  saveState(state, req.account)
  res.json({ state })
})

app.put('/api/users/:id', requireShopkeeper, async (req: AuthedRequest, res) => {
  const stateForCode = loadState(req.account)
  if (!requireActionConfirmCode(req, res, stateForCode)) return
  const id = String(req.params.id)
  const name = String(req.body?.name ?? '').trim()
  const phone = normalizePhone(String(req.body?.phone ?? ''))
  const email = String(req.body?.email ?? '')
    .trim()
    .toLowerCase()

  if (!name || name.length < 2) {
    res.status(400).json({ error: 'Enter a valid name' })
    return
  }
  if (!isValidPhone(phone)) {
    res.status(400).json({ error: 'Customer mobile number (10 digits) is required' })
    return
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Enter a valid email address' })
    return
  }

  const state = loadState(req.account)
  const idx = state.users.findIndex((u) => u.id === id)
  if (idx < 0) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const target = state.users[idx]
  if (target.role === 'shopkeeper') {
    res.status(400).json({ error: 'Edit shopkeeper details from Profile' })
    return
  }

  if (state.users.some((u) => u.id !== id && normalizePhone(u.phone) === phone)) {
    res.status(409).json({ error: 'This mobile number is already used by another customer' })
    return
  }

  const auth = loadAuth()
  if (auth.accounts.some((a) => a.id !== id && normalizePhone(a.phone) === phone)) {
    res.status(409).json({ error: 'This mobile number already has an account' })
    return
  }

  try {
    if (await phoneExistsInDatabase(phone, id)) {
      res.status(409).json({ error: 'This mobile number already exists in the database' })
      return
    }
  } catch (err) {
    console.error('[users] phone lookup failed', err)
    res.status(500).json({ error: 'Could not validate mobile number' })
    return
  }

  const prevPhone = target.phone
  const updated = {
    ...target,
    name,
    phone,
    email: email || null,
  }
  state.users[idx] = updated

  state.transactions = state.transactions.map((t) => {
    if (t.customerId !== id && !(prevPhone && t.customerPhone === prevPhone)) return t
    return {
      ...t,
      customerId: id,
      customerName: name,
      customerPhone: phone,
    }
  })
  state.recurringBillings = state.recurringBillings.map((billing) =>
    billing.customerId === id
      ? {
          ...billing,
          customerName: name,
          customerPhone: phone,
          updatedAt: new Date().toISOString(),
        }
      : billing,
  )

  try {
    saveState(state, req.account)

    const authIdx = auth.accounts.findIndex((a) => a.id === id)
    if (authIdx >= 0) {
      const phoneChanged = normalizePhone(auth.accounts[authIdx].phone) !== phone
      auth.accounts[authIdx] = {
        ...auth.accounts[authIdx],
        name,
        phone,
        email: email || null,
        ...(phoneChanged ? { phoneVerified: false } : {}),
      }
      saveAuth(auth)
    } else if (phone) {
      auth.accounts.push({
        id,
        name,
        phone,
        email: email || null,
        role: 'customer',
        shopAppId: state.appId,
        phoneVerified: false,
        createdAt: target.createdAt,
      })
      saveAuth(auth)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/Duplicate|ER_DUP_ENTRY/i.test(msg)) {
      res.status(409).json({ error: 'This mobile number already exists in the database' })
      return
    }
    console.error('[users] update failed', err)
    res.status(500).json({ error: 'Could not update customer' })
    return
  }

  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, user: updated, ...totals })
})

app.delete('/api/users/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const id = String(req.params.id)
  const target = state.users.find((u) => u.id === id)
  if (!target) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (target.role === 'shopkeeper' && state.users.filter((u) => u.role === 'shopkeeper').length <= 1) {
    res.status(400).json({ error: 'At least one shopkeeper is required' })
    return
  }

  if (target.role === 'customer') {
    const hasTx = state.transactions.some(
      (t) =>
        t.customerId === id ||
        (target.phone && t.customerPhone === target.phone) ||
        (target.phone && t.remarks.includes(target.phone)),
    )
    if (hasTx) {
      res.status(400).json({
        error: 'Cannot delete customer with transactions. Only customers with no entries can be removed.',
      })
      return
    }
    if (state.recurringBillings.some((billing) => billing.customerId === id)) {
      res.status(400).json({
        error: 'Delete this customer’s recurring billing schedules first.',
      })
      return
    }
  }

  state.users = state.users.filter((u) => u.id !== id)
  if (state.activeUserId === id) {
    state.activeUserId = state.users.find((u) => u.role === 'shopkeeper')?.id ?? state.users[0]?.id ?? null
  }
  saveState(state, req.account)

  const auth = loadAuth()
  auth.accounts = auth.accounts.filter((a) => a.id !== id)
  auth.sessions = auth.sessions.filter((s) => s.userId !== id)
  saveAuth(auth)

  res.json({ state })
})

app.post('/api/recurring-billings', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const customerId = String(req.body?.customerId ?? '')
  const amount = Number(req.body?.amount)
  const remarks = String(req.body?.remarks ?? '').trim()
  const interval = String(req.body?.interval ?? '') as RecurringInterval
  const effectiveDate = String(req.body?.effectiveDate ?? '')
  const transactionCategory =
    String(req.body?.transactionCategory ?? 'sales') === 'purchase' ? 'purchase' : 'sales'
  const autoBilling = req.body?.autoBilling !== false
  const serviceLookup = resolveService(state, req.body?.serviceId)

  const customer =
    state.users.find((user) => user.id === customerId && user.role === 'customer') ?? null
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' })
    return
  }
  if (!serviceLookup.ok) {
    res.status(404).json({ error: serviceLookup.error })
    return
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Billing amount must be greater than 0' })
    return
  }
  const note = remarks || (serviceLookup.service ? serviceRemarks(serviceLookup.service) : '')
  if (!note) {
    res.status(400).json({ error: 'Billing description is required' })
    return
  }
  if (!RECURRING_INTERVALS.includes(interval)) {
    res.status(400).json({ error: 'Invalid recurring interval' })
    return
  }
  if (!isDateOnly(effectiveDate)) {
    res.status(400).json({ error: 'Enter a valid billing period' })
    return
  }
  const billingDate = String(
    req.body?.billingDate ?? billingDateForPeriod(effectiveDate, interval, 1),
  )
  if (
    !isDateOnly(billingDate) ||
    daysAfterPeriodEnd(effectiveDate, interval, billingDate) < 1
  ) {
    res.status(400).json({ error: 'Billing date must be after the billing period ends' })
    return
  }

  const billing = createRecurringBilling({
    account: req.account!,
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
  })
  state.recurringBillings.unshift(billing)
  materializeRecurringBillings(state)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.status(201).json({ state, recurringBilling: billing, ...totals })
})

app.put('/api/recurring-billings/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const index = state.recurringBillings.findIndex((billing) => billing.id === req.params.id)
  if (index < 0) {
    res.status(404).json({ error: 'Recurring billing not found' })
    return
  }

  const current = state.recurringBillings[index]
  const amount = req.body?.amount === undefined ? current.amount : Number(req.body.amount)
  const remarks =
    req.body?.remarks === undefined ? current.remarks : String(req.body.remarks).trim()
  const interval = (
    req.body?.interval === undefined ? current.interval : String(req.body.interval)
  ) as RecurringInterval
  const effectiveDate =
    req.body?.effectiveDate === undefined
      ? current.effectiveDate
      : String(req.body.effectiveDate)
  const transactionCategory =
    req.body?.transactionCategory === undefined
      ? current.transactionCategory
      : String(req.body.transactionCategory) === 'purchase'
        ? 'purchase'
        : 'sales'
  const autoBilling =
    req.body?.autoBilling === undefined ? current.autoBilling : Boolean(req.body.autoBilling)
  const serviceLookup = resolveService(
    state,
    req.body?.serviceId === undefined ? current.serviceId : req.body.serviceId,
  )

  if (!serviceLookup.ok) {
    res.status(404).json({ error: serviceLookup.error })
    return
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'Billing amount must be greater than 0' })
    return
  }
  const note = remarks || (serviceLookup.service ? serviceRemarks(serviceLookup.service) : '')
  if (!note) {
    res.status(400).json({ error: 'Billing description is required' })
    return
  }
  if (!RECURRING_INTERVALS.includes(interval)) {
    res.status(400).json({ error: 'Invalid recurring interval' })
    return
  }
  if (!isDateOnly(effectiveDate)) {
    res.status(400).json({ error: 'Enter a valid billing period' })
    return
  }
  const currentInitialBillingDate = billingDateForPeriod(
    effectiveDate,
    interval,
    current.billingDelayDays,
  )
  const billingDate = String(req.body?.billingDate ?? currentInitialBillingDate)
  const billingDelayDays = daysAfterPeriodEnd(effectiveDate, interval, billingDate)
  if (!isDateOnly(billingDate) || billingDelayDays < 1) {
    res.status(400).json({ error: 'Billing date must be after the billing period ends' })
    return
  }

  const scheduleChanged =
    interval !== current.interval ||
    effectiveDate !== current.effectiveDate ||
    billingDelayDays !== current.billingDelayDays
  const updated = {
    ...current,
    amount,
    remarks: note,
    serviceId: serviceLookup.service?.id ?? null,
    serviceName: serviceLookup.service?.name ?? null,
    transactionCategory,
    interval,
    effectiveDate,
    nextPeriodStartDate: scheduleChanged
      ? effectiveDate
      : current.nextPeriodStartDate,
    billingDelayDays,
    nextRunDate: scheduleChanged
      ? billingDate
      : current.nextRunDate,
    autoBilling,
    updatedAt: new Date().toISOString(),
  }
  state.recurringBillings[index] = updated
  materializeRecurringBillings(state)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, recurringBilling: updated, ...totals })
})

app.post('/api/recurring-billings/:id/stop', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const billing = state.recurringBillings.find((item) => item.id === req.params.id)
  if (!billing) {
    res.status(404).json({ error: 'Recurring billing not found' })
    return
  }
  billing.active = false
  billing.updatedAt = new Date().toISOString()
  saveState(state, req.account)
  res.json({ state, recurringBilling: billing })
})

app.post('/api/recurring-billings/:id/post', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const billing = state.recurringBillings.find((item) => item.id === req.params.id)
  if (!billing) {
    res.status(404).json({ error: 'Recurring billing not found' })
    return
  }
  if (!billing.active) {
    res.status(400).json({ error: 'Resume this recurring billing before posting' })
    return
  }
  if (billing.nextRunDate > localDateString()) {
    res.status(400).json({
      error: `This bill is not due until ${billing.nextRunDate}`,
    })
    return
  }
  const transaction = postNextRecurringBill(state, billing)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.status(201).json({ state, recurringBilling: billing, transaction, ...totals })
})

app.post('/api/recurring-billings/:id/resume', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const billing = state.recurringBillings.find((item) => item.id === req.params.id)
  if (!billing) {
    res.status(404).json({ error: 'Recurring billing not found' })
    return
  }
  billing.active = true
  billing.updatedAt = new Date().toISOString()
  materializeRecurringBillings(state)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, recurringBilling: billing, ...totals })
})

app.delete('/api/recurring-billings/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const exists = state.recurringBillings.some((billing) => billing.id === req.params.id)
  if (!exists) {
    res.status(404).json({ error: 'Recurring billing not found' })
    return
  }
  state.recurringBillings = state.recurringBillings.filter(
    (billing) => billing.id !== req.params.id,
  )
  // Generated transactions remain normal ledger entries and can be deleted individually.
  saveState(state, req.account)
  res.json({ state })
})

app.post('/api/services', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const name = String(req.body?.name ?? '').trim()
  const description = String(req.body?.description ?? '').trim()
  const amount = Number(req.body?.amount ?? 0)

  if (!name || name.length < 2) {
    res.status(400).json({ error: 'Service name is required' })
    return
  }
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: 'Enter a valid default amount' })
    return
  }
  if (
    state.services.some((service) => service.name.toLowerCase() === name.toLowerCase())
  ) {
    res.status(409).json({ error: 'A service with this name already exists' })
    return
  }

  const now = new Date().toISOString()
  const service: ShopService = {
    id: newId(),
    name,
    amount,
    description,
    createdAt: now,
    updatedAt: now,
  }
  state.services.unshift(service)
  state.services.sort((a, b) => a.name.localeCompare(b.name))
  saveState(state, req.account)
  res.status(201).json({ state, service })
})

app.put('/api/services/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const index = state.services.findIndex((service) => service.id === req.params.id)
  if (index < 0) {
    res.status(404).json({ error: 'Service not found' })
    return
  }

  const current = state.services[index]
  const name =
    req.body?.name === undefined ? current.name : String(req.body.name).trim()
  const description =
    req.body?.description === undefined
      ? current.description
      : String(req.body.description).trim()
  const amount =
    req.body?.amount === undefined ? current.amount : Number(req.body.amount)

  if (!name || name.length < 2) {
    res.status(400).json({ error: 'Service name is required' })
    return
  }
  if (!Number.isFinite(amount) || amount < 0) {
    res.status(400).json({ error: 'Enter a valid default amount' })
    return
  }
  if (
    state.services.some(
      (service) =>
        service.id !== current.id && service.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    res.status(409).json({ error: 'A service with this name already exists' })
    return
  }

  const updated: ShopService = {
    ...current,
    name,
    description,
    amount,
    updatedAt: new Date().toISOString(),
  }
  state.services[index] = updated
  state.services.sort((a, b) => a.name.localeCompare(b.name))

  state.recurringBillings = state.recurringBillings.map((billing) =>
    billing.serviceId === updated.id
      ? { ...billing, serviceName: updated.name, updatedAt: new Date().toISOString() }
      : billing,
  )
  state.transactions = state.transactions.map((tx) =>
    tx.serviceId === updated.id ? { ...tx, serviceName: updated.name } : tx,
  )

  saveState(state, req.account)
  res.json({ state, service: updated })
})

app.delete('/api/services/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const id = String(req.params.id)
  const exists = state.services.some((service) => service.id === id)
  if (!exists) {
    res.status(404).json({ error: 'Service not found' })
    return
  }
  const usedInTx = state.transactions.some((tx) => tx.serviceId === id)
  const usedInRecurring = state.recurringBillings.some((billing) => billing.serviceId === id)
  if (usedInTx || usedInRecurring) {
    res.status(400).json({
      error:
        'Cannot delete this service. Entries or recurring schedules still use it. Edit instead, or remove those entries first.',
    })
    return
  }
  state.services = state.services.filter((service) => service.id !== id)
  saveState(state, req.account)
  res.json({ state })
})

app.post('/api/todos', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const title = String(req.body?.title ?? '').trim()
  const notes = String(req.body?.notes ?? '').trim()
  const activity = String(req.body?.activity ?? 'custom').trim() || 'custom'
  const dueDate = String(req.body?.dueDate ?? '').trim()
  const dueTimeRaw = String(req.body?.dueTime ?? '09:00').trim()
  const dueTime = /^\d{2}:\d{2}$/.test(dueTimeRaw) ? dueTimeRaw : '09:00'
  const whatsappReminder = Boolean(req.body?.whatsappReminder)
  const customerId =
    req.body?.customerId == null || req.body.customerId === ''
      ? null
      : String(req.body.customerId)
  const customerName =
    req.body?.customerName == null || req.body.customerName === ''
      ? null
      : String(req.body.customerName).trim()
  const customerPhone =
    req.body?.customerPhone == null || req.body.customerPhone === ''
      ? null
      : String(req.body.customerPhone).trim()

  if (!title || title.length < 2) {
    res.status(400).json({ error: 'Activity is required' })
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    res.status(400).json({ error: 'Choose a valid due date' })
    return
  }

  const now = new Date().toISOString()
  const todo: ShopTodo = {
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
  }
  state.todos = [todo, ...(state.todos ?? [])].sort((a, b) =>
    a.dueDate === b.dueDate
      ? `${a.dueTime}`.localeCompare(`${b.dueTime}`) || b.createdAt.localeCompare(a.createdAt)
      : a.dueDate.localeCompare(b.dueDate),
  )
  saveState(state, req.account)
  res.status(201).json({ state, todo })
})

app.put('/api/todos/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const index = (state.todos ?? []).findIndex((todo) => todo.id === req.params.id)
  if (index < 0) {
    res.status(404).json({ error: 'Todo not found' })
    return
  }

  const current = state.todos[index]
  const title =
    req.body?.title === undefined ? current.title : String(req.body.title).trim()
  const notes =
    req.body?.notes === undefined ? current.notes : String(req.body.notes).trim()
  const activity =
    req.body?.activity === undefined
      ? current.activity
      : String(req.body.activity).trim() || 'custom'
  const dueDate =
    req.body?.dueDate === undefined ? current.dueDate : String(req.body.dueDate).trim()
  const dueTimeRaw =
    req.body?.dueTime === undefined ? current.dueTime : String(req.body.dueTime).trim()
  const dueTime = /^\d{2}:\d{2}$/.test(dueTimeRaw) ? dueTimeRaw : current.dueTime || '09:00'
  const done = req.body?.done === undefined ? current.done : Boolean(req.body.done)
  const whatsappReminder =
    req.body?.whatsappReminder === undefined
      ? current.whatsappReminder
      : Boolean(req.body.whatsappReminder)
  const customerId =
    req.body?.customerId === undefined
      ? current.customerId
      : req.body.customerId == null || req.body.customerId === ''
        ? null
        : String(req.body.customerId)
  const customerName =
    req.body?.customerName === undefined
      ? current.customerName
      : req.body.customerName == null || req.body.customerName === ''
        ? null
        : String(req.body.customerName).trim()
  const customerPhone =
    req.body?.customerPhone === undefined
      ? current.customerPhone
      : req.body.customerPhone == null || req.body.customerPhone === ''
        ? null
        : String(req.body.customerPhone).trim()

  if (!title || title.length < 2) {
    res.status(400).json({ error: 'Activity is required' })
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    res.status(400).json({ error: 'Choose a valid due date' })
    return
  }

  const dueChanged = dueDate !== current.dueDate || dueTime !== current.dueTime
  const updated: ShopTodo = {
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
  }
  state.todos[index] = updated
  state.todos.sort((a, b) =>
    a.dueDate === b.dueDate
      ? `${a.dueTime}`.localeCompare(`${b.dueTime}`) || b.createdAt.localeCompare(a.createdAt)
      : a.dueDate.localeCompare(b.dueDate),
  )
  saveState(state, req.account)
  res.json({ state, todo: updated })
})

app.post('/api/payment-reminders/send', requireShopkeeper, async (req: AuthedRequest, res) => {
  if (!isPaymentReminderWhatsAppConfigured()) {
    res.status(503).json({
      error:
        'Payment reminder WhatsApp is not configured. Set ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID (approved Meta UTILITY template) and ONECHATTING_TOKEN.',
    })
    return
  }

  const state = loadState(req.account)
  const shopName = String(req.body?.shopName ?? state.shopName ?? 'Shop').trim() || 'Shop'
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : []
  if (rawItems.length === 0) {
    res.status(400).json({ error: 'No reminders to send' })
    return
  }

  type ReminderItem = {
    customerId?: string
    phone?: string
    customerName?: string
    balance?: number
  }

  const results: Array<{
    customerId: string | null
    phone: string
    customerName: string
    ok: boolean
    error?: string
  }> = []

  for (const raw of rawItems as ReminderItem[]) {
    const customerId = raw.customerId ? String(raw.customerId) : null
    const fromState = customerId
      ? state.users.find((u) => u.id === customerId && u.role === 'customer')
      : undefined
    const phone = String(raw.phone ?? fromState?.phone ?? '')
      .replace(/\D/g, '')
      .slice(-10)
    const customerName = String(raw.customerName ?? fromState?.name ?? 'Customer').trim() || 'Customer'
    const balance = Number(raw.balance)
    if (!phone || phone.length !== 10) {
      results.push({
        customerId,
        phone,
        customerName,
        ok: false,
        error: 'Missing or invalid mobile number',
      })
      continue
    }
    if (!Number.isFinite(balance) || balance === 0) {
      results.push({
        customerId,
        phone,
        customerName,
        ok: false,
        error: 'No outstanding balance',
      })
      continue
    }

    const sent = await sendPaymentReminderWhatsApp({
      phone,
      customerName,
      shopName,
      balance,
    })
    results.push({
      customerId,
      phone,
      customerName,
      ok: sent.ok,
      error: sent.ok ? undefined : sent.error,
    })
  }

  const sent = results.filter((r) => r.ok).length
  const failed = results.length - sent
  res.json({ ok: failed === 0, sent, failed, results })
})

app.get('/api/payment-reminders/status', requireShopkeeper, (_req: AuthedRequest, res) => {
  res.json({
    configured: isPaymentReminderWhatsAppConfigured(),
  })
})

app.post('/api/todos/reminders/ack', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (items.length === 0) {
    res.json({ state })
    return
  }

  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

  let changed = false
  state.todos = (state.todos ?? []).map((todo) => {
    const match = items.find(
      (item: { id?: string; kind?: string }) => item.id === todo.id && item.kind,
    ) as { id: string; kind: '3d' | '1d' | 'due' } | undefined
    if (!match) return todo
    changed = true
    if (match.kind === '3d') return { ...todo, reminded3DaysOn: todayStr, updatedAt: new Date().toISOString() }
    if (match.kind === '1d') return { ...todo, reminded1DayOn: todayStr, updatedAt: new Date().toISOString() }
    return { ...todo, remindedDueOn: todayStr, updatedAt: new Date().toISOString() }
  })

  if (changed) saveState(state, req.account)
  res.json({ state })
})

app.post('/api/todos/bulk-delete', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((id: unknown) => String(id)).filter(Boolean)
    : []
  if (ids.length === 0) {
    res.status(400).json({ error: 'Select at least one to-do' })
    return
  }
  const idSet = new Set(ids)
  const before = (state.todos ?? []).length
  state.todos = (state.todos ?? []).filter((todo) => !idSet.has(todo.id))
  if (state.todos.length === before) {
    res.status(404).json({ error: 'No matching to-dos found' })
    return
  }
  saveState(state, req.account)
  res.json({ state, deleted: before - state.todos.length })
})

app.delete('/api/todos/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  const id = String(req.params.id)
  const exists = (state.todos ?? []).some((todo) => todo.id === id)
  if (!exists) {
    res.status(404).json({ error: 'Todo not found' })
    return
  }
  state.todos = state.todos.filter((todo) => todo.id !== id)
  saveState(state, req.account)
  res.json({ state })
})

app.post('/api/transactions', requireShopkeeper, (req: AuthedRequest, res) => {
  const {
    type,
    category,
    amount,
    remarks,
    customerId,
    createdAt,
    cashAccountId,
    attachmentName,
    attachmentData,
    serviceId,
  } = req.body as {
    type?: TransactionType
    category?: TransactionCategory
    amount?: number
    remarks?: string
    customerId?: string
    createdAt?: string
    cashAccountId?: string
    attachmentName?: string
    attachmentData?: string
    serviceId?: string
  }

  const state = loadState(req.account)
  const account = req.account!
  const user =
    state.users.find((u) => u.id === account.id) ??
    state.users.find((u) => u.id === state.activeUserId)

  const value = Number(amount)
  if (!user || !type || (type !== 'receipt' && type !== 'payment')) {
    res.status(400).json({ error: 'Invalid transaction' })
    return
  }
  if (Number.isNaN(value) || value <= 0) {
    res.status(400).json({ error: 'Amount must be greater than 0' })
    return
  }

  const note = String(remarks ?? '').trim()
  let resolvedCategory: TransactionCategory =
    category ?? (type === 'receipt' ? 'receipt' : 'payment')
  const serviceLookup = resolveService(
    state,
    resolvedCategory === 'sales' ? serviceId : null,
  )
  if (!serviceLookup.ok) {
    res.status(404).json({ error: serviceLookup.error })
    return
  }

  if (type === 'receipt') {
    if (
      resolvedCategory !== 'receipt' &&
      resolvedCategory !== 'adjustment' &&
      resolvedCategory !== 'purchase'
    ) {
      res.status(400).json({ error: 'In options: Receipt, Purchase, or Adjustment' })
      return
    }
  } else if (resolvedCategory !== 'sales' && resolvedCategory !== 'payment' && resolvedCategory !== 'adjustment') {
    res.status(400).json({ error: 'Out options: Sales, Payment, or Adjustment' })
    return
  }

  if (resolvedCategory === 'adjustment' && !note) {
    res.status(400).json({ error: 'Remarks are required for adjustment' })
    return
  }

  const isAdjustment = resolvedCategory === 'adjustment'
  const isSales = resolvedCategory === 'sales'
  const isPurchase = resolvedCategory === 'purchase'
  const isXorParty = isSales || isPurchase
  const hasCustomer = Boolean(customerId)
  const hasAccount = Boolean(cashAccountId)

  if (isXorParty) {
    if (hasCustomer === hasAccount) {
      const label = isPurchase ? 'Purchase' : 'Sales'
      res.status(400).json({
        error: hasCustomer
          ? `${label}: choose either party or account, not both`
          : `${label}: select a party or an account`,
      })
      return
    }
  } else if (!customerId) {
    res.status(400).json({ error: 'Customer is required' })
    return
  }

  let customer: (typeof state.users)[number] | null = null
  if (customerId) {
    customer = state.users.find((u) => u.id === customerId && u.role === 'customer') ?? null
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' })
      return
    }
  }

  let resolvedCashId: string | null = null
  let resolvedCashName: string | null = null

  if (isAdjustment || (isXorParty && hasCustomer)) {
    resolvedCashId = null
    resolvedCashName = null
  } else {
    if (!cashAccountId) {
      res.status(400).json({ error: 'Account is required' })
      return
    }
    const cashAccount = state.cashAccounts.find((a) => a.id === cashAccountId)
    if (!cashAccount) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    resolvedCashId = cashAccount.id
    resolvedCashName = cashAccount.name
  }

  let txCreatedAt = uniqueTxCreatedAt(state.transactions, new Date())
  if (createdAt) {
    const parsed = new Date(createdAt)
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'Invalid date' })
      return
    }
    txCreatedAt = uniqueTxCreatedAt(state.transactions, parsed)
  }

  let txId = newTxId(new Date(txCreatedAt))
  const existingIds = new Set(state.transactions.map((t) => t.id))
  while (existingIds.has(txId)) {
    txId = newTxId(new Date(txCreatedAt))
  }
  let savedAttachmentName: string | null = null
  let savedAttachmentPath: string | null = null
  if (attachmentData && attachmentName) {
    try {
      const saved = saveAttachmentData(txId, String(attachmentName), String(attachmentData))
      savedAttachmentName = saved.attachmentName
      savedAttachmentPath = saved.attachmentPath
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid attachment' })
      return
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
    serviceId: resolvedCategory === 'sales' ? (serviceLookup.service?.id ?? null) : null,
    serviceName: resolvedCategory === 'sales' ? (serviceLookup.service?.name ?? null) : null,
    createdAt: txCreatedAt,
  }
  state.transactions.unshift(tx)
  state.activeUserId = account.id
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.status(201).json({ state, transaction: tx, ...totals })
})

app.put('/api/transactions/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const stateForCode = loadState(req.account)
  if (!requireActionConfirmCode(req, res, stateForCode)) return
  const {
    type,
    category,
    amount,
    remarks,
    customerId,
    createdAt,
    cashAccountId,
    attachmentName,
    attachmentData,
    clearAttachment,
    serviceId,
  } = req.body as {
    type?: TransactionType
    category?: TransactionCategory
    amount?: number
    remarks?: string
    customerId?: string
    createdAt?: string
    cashAccountId?: string
    attachmentName?: string
    attachmentData?: string
    clearAttachment?: boolean
    serviceId?: string
  }

  const state = loadState(req.account)
  const index = state.transactions.findIndex((t) => t.id === req.params.id)
  if (index < 0) {
    res.status(404).json({ error: 'Transaction not found' })
    return
  }

  const existing = state.transactions[index]!
  const nextType = type ?? existing.type
  if (nextType !== 'receipt' && nextType !== 'payment') {
    res.status(400).json({ error: 'Invalid transaction' })
    return
  }

  const value = amount !== undefined ? Number(amount) : existing.amount
  if (Number.isNaN(value) || value <= 0) {
    res.status(400).json({ error: 'Amount must be greater than 0' })
    return
  }

  const note = remarks !== undefined ? String(remarks).trim() : existing.remarks
  let resolvedCategory: TransactionCategory =
    category ?? existing.category ?? (nextType === 'receipt' ? 'receipt' : 'payment')
  const serviceLookup = resolveService(
    state,
    resolvedCategory === 'sales'
      ? serviceId === undefined
        ? existing.serviceId
        : serviceId
      : null,
  )
  if (!serviceLookup.ok) {
    res.status(404).json({ error: serviceLookup.error })
    return
  }

  if (nextType === 'receipt') {
    if (
      resolvedCategory !== 'receipt' &&
      resolvedCategory !== 'adjustment' &&
      resolvedCategory !== 'purchase'
    ) {
      res.status(400).json({ error: 'In options: Receipt, Purchase, or Adjustment' })
      return
    }
  } else if (
    resolvedCategory !== 'sales' &&
    resolvedCategory !== 'payment' &&
    resolvedCategory !== 'adjustment'
  ) {
    res.status(400).json({ error: 'Out options: Sales, Payment, or Adjustment' })
    return
  }

  if (resolvedCategory === 'adjustment' && !note) {
    res.status(400).json({ error: 'Remarks are required for adjustment' })
    return
  }

  const isAdjustment = resolvedCategory === 'adjustment'
  const isSales = resolvedCategory === 'sales'
  const isPurchase = resolvedCategory === 'purchase'
  const isXorParty = isSales || isPurchase

  const requestedCustomerId =
    customerId !== undefined ? String(customerId || '') : (existing.customerId ?? '')
  const requestedCashId =
    cashAccountId !== undefined
      ? String(cashAccountId || '')
      : isXorParty || isAdjustment
        ? (existing.cashAccountId ?? '')
        : (existing.cashAccountId ?? DEFAULT_CASH_ACCOUNT_ID)

  const hasCustomer = Boolean(requestedCustomerId)
  const hasAccount = Boolean(requestedCashId)

  if (isXorParty) {
    if (hasCustomer === hasAccount) {
      const label = isPurchase ? 'Purchase' : 'Sales'
      res.status(400).json({
        error: hasCustomer
          ? `${label}: choose either party or account, not both`
          : `${label}: select a party or an account`,
      })
      return
    }
  } else if (!requestedCustomerId) {
    res.status(400).json({ error: 'Customer is required' })
    return
  }

  let customer: (typeof state.users)[number] | null = null
  if (requestedCustomerId) {
    customer =
      state.users.find((u) => u.id === requestedCustomerId && u.role === 'customer') ?? null
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' })
      return
    }
  }

  let resolvedCashId: string | null = null
  let resolvedCashName: string | null = null

  if (isAdjustment || (isXorParty && hasCustomer)) {
    resolvedCashId = null
    resolvedCashName = null
  } else {
    if (!requestedCashId) {
      res.status(400).json({ error: 'Account is required' })
      return
    }
    const cashAccount = state.cashAccounts.find((a) => a.id === requestedCashId)
    if (!cashAccount) {
      res.status(404).json({ error: 'Account not found' })
      return
    }
    resolvedCashId = cashAccount.id
    resolvedCashName = cashAccount.name
  }

  let nextCreatedAt = existing.createdAt
  if (createdAt) {
    const parsed = new Date(createdAt)
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'Invalid date' })
      return
    }
    const others = state.transactions.filter((t) => t.id !== req.params.id)
    nextCreatedAt = uniqueTxCreatedAt(others, parsed)
  }

  let nextAttachmentName = existing.attachmentName ?? null
  let nextAttachmentPath = existing.attachmentPath ?? null
  if (clearAttachment) {
    deleteAttachmentFile(existing.attachmentPath)
    nextAttachmentName = null
    nextAttachmentPath = null
  } else if (attachmentData && attachmentName) {
    try {
      deleteAttachmentFile(existing.attachmentPath)
      const saved = saveAttachmentData(existing.id, String(attachmentName), String(attachmentData))
      nextAttachmentName = saved.attachmentName
      nextAttachmentPath = saved.attachmentPath
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid attachment' })
      return
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
    serviceId: resolvedCategory === 'sales' ? (serviceLookup.service?.id ?? null) : null,
    serviceName: resolvedCategory === 'sales' ? (serviceLookup.service?.name ?? null) : null,
    createdAt: nextCreatedAt,
  }
  state.transactions[index] = updated
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, transaction: updated, ...totals })
})

app.delete('/api/transactions/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const existing = state.transactions.find((t) => t.id === req.params.id)
  if (existing) deleteAttachmentFile(existing.attachmentPath)
  state.transactions = state.transactions.filter((t) => t.id !== req.params.id)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, ...totals })
})

app.put('/api/opening-balance', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const amount = Number(req.body?.amount)
  if (Number.isNaN(amount) || amount < 0) {
    res.status(400).json({ error: 'Invalid amount' })
    return
  }
  state.openingBalance = amount
  const cash = state.cashAccounts.find((a) => a.isSystem || a.id === DEFAULT_CASH_ACCOUNT_ID)
  if (cash) cash.openingBalance = amount
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, ...totals })
})

app.post('/api/cash-accounts', requireShopkeeper, (req: AuthedRequest, res) => {
  const bankName = String(req.body?.bankName ?? req.body?.name ?? '').trim()
  const accountName = String(req.body?.accountName ?? '').trim()
  const accountNumber = String(req.body?.accountNumber ?? '')
    .replace(/\s+/g, '')
    .trim()
  const ifscCode = String(req.body?.ifscCode ?? '')
    .replace(/\s+/g, '')
    .trim()
    .toUpperCase()
  const branch = String(req.body?.branch ?? '').trim()
  const opening = Number(req.body?.openingBalance ?? 0)

  if (!bankName) {
    res.status(400).json({ error: 'Bank name is required' })
    return
  }
  if (!accountName) {
    res.status(400).json({ error: 'Account name is required' })
    return
  }
  if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
    res.status(400).json({ error: 'Enter a valid IFSC (e.g. HDFC0001234)' })
    return
  }
  if (Number.isNaN(opening) || opening < 0) {
    res.status(400).json({ error: 'Invalid opening balance' })
    return
  }

  const displayName = `${bankName} · ${accountName}`
  const state = loadState(req.account)

  if (
    state.cashAccounts.some(
      (a) =>
        a.kind === 'bank' &&
        (a.name.toLowerCase() === displayName.toLowerCase() ||
          (accountNumber &&
            a.accountNumber &&
            a.bankName?.toLowerCase() === bankName.toLowerCase() &&
            a.accountNumber === accountNumber)),
    )
  ) {
    res.status(400).json({ error: 'This bank account already exists' })
    return
  }

  const account = {
    id: newId(),
    name: displayName,
    kind: 'bank' as const,
    bankName,
    accountName,
    accountNumber: accountNumber || null,
    ifscCode: ifscCode || null,
    branch: branch || null,
    isSystem: false,
    openingBalance: opening,
    createdAt: new Date().toISOString(),
  }
  state.cashAccounts.push(account)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.status(201).json({ state, account, ...totals })
})

app.delete('/api/cash-accounts/:id', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!requireActionConfirmCode(req, res, state)) return
  const id = String(req.params.id)
  const target = state.cashAccounts.find((a) => a.id === id)
  if (!target) {
    res.status(404).json({ error: 'Account not found' })
    return
  }
  if (target.isSystem || target.id === DEFAULT_CASH_ACCOUNT_ID) {
    res.status(400).json({ error: 'Cash account cannot be deleted' })
    return
  }
  if (state.transactions.some((t) => t.cashAccountId === id)) {
    res.status(400).json({ error: 'Cannot delete account with transactions' })
    return
  }
  state.cashAccounts = state.cashAccounts.filter((a) => a.id !== id)
  saveState(state, req.account)
  const totals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, ...totals })
})

app.post('/api/close-day', requireShopkeeper, (req: AuthedRequest, res) => {
  const state = loadState(req.account)
  if (!state.setupComplete) {
    res.status(400).json({ error: 'Complete setup first' })
    return
  }

  const account = req.account!
  const totals = calcTotals(state.openingBalance, state.transactions)
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
  }

  state.dayCloses.unshift(closed)
  state.openingBalance = totals.liveBalance
  state.transactions = []
  saveState(state, req.account)

  const nextTotals = calcTotals(state.openingBalance, state.transactions)
  res.json({ state, closed, ...nextTotals })
})

app.delete('/api/reset', requireShopkeeper, (req: AuthedRequest, res) => {
  const stateForCode = loadState(req.account)
  if (!requireActionConfirmCode(req, res, stateForCode)) return
  const account = req.account!
  const state = emptyState()
  // Keep same shop id if present so users stay linked
  if (account.shopAppId) state.appId = account.shopAppId
  state.users = [
    {
      id: account.id,
      name: account.name,
      phone: account.phone,
      email: account.email ?? null,
      role: 'shopkeeper',
      createdAt: account.createdAt,
    },
  ]
  state.activeUserId = account.id
  saveState(state, account)
  res.json({ state, totalReceipts: 0, totalPayments: 0, liveBalance: 0 })
})

async function main() {
  try {
    await initStore()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('\n❌ MySQL connection failed:', message)
    console.error(`
Fix one of these:

1) Local development (from your Mac):
   Hostinger hPanel → Databases → Remote MySQL
   → Allow your current IP (or %) for remote access
   → Keep MYSQL_HOST=onebook.onesaas.in in server/.env

2) When the API runs on Hostinger itself:
   Set MYSQL_HOST=localhost in server/.env

Credentials are in server/.env (not committed to git).
`)
    process.exit(1)
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OneBook server running on http://0.0.0.0:${PORT}`)
  })
}

void main()
