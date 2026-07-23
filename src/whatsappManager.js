import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'
import {
  getOneChattingTemplateDetails,
  listOneChattingTemplates,
  probeOneChattingToken,
  probeOneChattingUserToken,
  sendOneChattingTemplate,
  toWhatsAppNumber,
} from './onechatting.js'
import { insertWhatsAppMessageLog } from './whatsappLogs.js'
import {
  syncWhatsAppChatsFromProvider,
  chatTokenFingerprintFromConfig,
  listWhatsAppChats as listWhatsAppChatsRaw,
  clearWhatsAppChatThreadsForShop,
  listWhatsAppChatMessages,
  getWhatsAppChatThread,
  markWhatsAppChatRead,
  markWhatsAppChatUnread,
  assignWhatsAppChat,
} from './whatsappChats.js'
import {
  buildBodyTextsFromVariableMap,
  buildWhatsAppVariableContext,
  defaultVariablesForActivity,
  listTemplatePlaceholders,
  listWhatsAppTemplateVariables,
  normalizeVariableMap,
} from './whatsappVariables.js'
import {
  ensurePlatformWhatsAppSchema,
  getPlatformWhatsAppTokens,
  peekPlatformWhatsAppTokens,
} from './platformWhatsApp.js'

const DEFAULT_PROVIDER = 'onechatting'

/** OneBook activity → WhatsApp template mapping keys */
export const WHATSAPP_ACTIVITIES = [
  {
    id: 'payment_reminder',
    label: 'Payment Reminder',
    hint: 'Outstanding balance nudges',
  },
  {
    id: 'document_share',
    label: 'Document Share',
    hint: 'Ledger / PDF share alerts',
  },
  {
    id: 'sales_invoice',
    label: 'Sales Invoice',
    hint: 'Sale / bill notifications',
  },
  {
    id: 'reminder_activity',
    label: 'Reminder Activity',
    hint: 'To-do / follow-up reminders',
  },
]

function emptyBinding() {
  return { templateId: null, variables: {}, attachmentUrl: null, attachmentName: null }
}

const EMPTY_ACTIVITY_MAP = Object.fromEntries(
  WHATSAPP_ACTIVITIES.map((a) => [a.id, emptyBinding()]),
)

let schemaReady = false

const TOKEN_SOURCE_ONESAAS = 'onesaas'
const TOKEN_SOURCE_CUSTOMER = 'customer'

function normalizeTokenSource(value) {
  const raw = String(value || '').trim().toLowerCase()
  return raw === TOKEN_SOURCE_ONESAAS ? TOKEN_SOURCE_ONESAAS : TOKEN_SOURCE_CUSTOMER
}

async function resolvePlatformTokens() {
  return getPlatformWhatsAppTokens()
}

function platformTokensReadySync() {
  const peek = peekPlatformWhatsAppTokens()
  if (peek.loaded) return peek.ready
  return Boolean(
    (process.env.ONEBOOK_PLATFORM_DEVELOPER_TOKEN || process.env.ONECHATTING_TOKEN) &&
      process.env.ONEBOOK_PLATFORM_USER_TOKEN,
  )
}

async function ensureWhatsAppSchema() {
  if (schemaReady) return
  const p = getPool()
  for (const sql of [
    `ALTER TABLE shop_whatsapp_config ADD COLUMN activity_map TEXT NULL`,
    `ALTER TABLE shop_whatsapp_config ADD COLUMN connection_status TEXT NULL`,
    `ALTER TABLE shop_whatsapp_config ADD COLUMN user_api_key VARCHAR(500) NULL`,
    `ALTER TABLE shop_whatsapp_config ADD COLUMN user_connection_status TEXT NULL`,
    `ALTER TABLE shop_whatsapp_config ADD COLUMN token_source VARCHAR(20) NOT NULL DEFAULT 'customer'`,
    `ALTER TABLE shop_whatsapp_templates ADD COLUMN external_id VARCHAR(120) NULL AFTER campaign_name`,
    `ALTER TABLE shop_whatsapp_templates ADD COLUMN activity VARCHAR(40) NOT NULL DEFAULT 'custom' AFTER external_id`,
    `ALTER TABLE shop_whatsapp_templates ADD COLUMN header_format VARCHAR(20) NULL AFTER activity`,
    `ALTER TABLE shop_whatsapp_templates ADD COLUMN header_media_url TEXT NULL AFTER header_format`,
    `ALTER TABLE shop_whatsapp_templates ADD COLUMN header_text VARCHAR(500) NULL AFTER header_media_url`,
    `ALTER TABLE shop_whatsapp_templates ADD COLUMN footer_text VARCHAR(500) NULL AFTER header_text`,
  ]) {
    try {
      await p.query(sql)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Duplicate column/i.test(msg)) {
        console.warn('[MySQL] whatsapp schema migrate skipped:', msg)
      }
    }
  }
  await ensurePlatformWhatsAppSchema()
  await getPlatformWhatsAppTokens({ force: true }).catch(() => {})
  schemaReady = true
}

function parseActivityBinding(value) {
  if (!value) return emptyBinding()
  if (typeof value === 'string') {
    return { templateId: value || null, variables: {}, attachmentUrl: null, attachmentName: null }
  }
  if (typeof value === 'object') {
    const templateId = value.templateId || value.template_id || null
    const attachmentUrl = value.attachmentUrl || value.attachment_url || null
    const attachmentName = value.attachmentName || value.attachment_name || null
    return {
      templateId: templateId ? String(templateId) : null,
      variables: normalizeVariableMap(value.variables || value.variableMap || {}),
      attachmentUrl: attachmentUrl ? String(attachmentUrl).trim() : null,
      attachmentName: attachmentName ? String(attachmentName).trim().slice(0, 180) : null,
    }
  }
  return emptyBinding()
}

function parseActivityMap(raw) {
  const base = Object.fromEntries(WHATSAPP_ACTIVITIES.map((a) => [a.id, emptyBinding()]))
  if (!raw) return base
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return base
    for (const key of Object.keys(base)) {
      base[key] = parseActivityBinding(parsed[key])
    }
  } catch {
    /* ignore */
  }
  return base
}

export function getActivityBinding(activityMap, activity) {
  return parseActivityBinding(activityMap?.[activity])
}

function nowIso() {
  return new Date().toISOString()
}

function toMysqlDate(iso) {
  return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

function parseConnectionStatus(raw) {
  if (!raw) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function mapConfig(row, platform = null) {
  const onesaasReady = Boolean(
    platform?.ready ?? platformTokensReadySync(),
  )
  const onesaasDeveloperMasked = platform?.developerTokenMasked || ''
  const onesaasUserMasked = platform?.userTokenMasked || ''
  if (!row) {
    return {
      provider: DEFAULT_PROVIDER,
      tokenSource: TOKEN_SOURCE_CUSTOMER,
      onesaasReady,
      onesaasDeveloperMasked,
      onesaasUserMasked,
      apiKey: '',
      apiKeySet: false,
      userApiKey: '',
      userApiKeySet: false,
      templatesReady: false,
      chatsReady: false,
      userChatReady: false,
      projectName: '',
      projectId: '',
      wabaId: '',
      phoneNumberId: '',
      countryCode: '91',
      connected: false,
      activityMap: Object.fromEntries(WHATSAPP_ACTIVITIES.map((a) => [a.id, emptyBinding()])),
      connectionStatus: null,
      userConnectionStatus: null,
      updatedAt: null,
    }
  }
  const connectionStatus = parseConnectionStatus(row.connection_status)
  const userConnectionStatus = parseConnectionStatus(row.user_connection_status)
  const tokenSource = normalizeTokenSource(row.token_source)
  const apiKeySet = Boolean(row.api_key)
  const userApiKeySet = Boolean(row.user_api_key)
  const templatesReady = Boolean(apiKeySet && row.connected && connectionStatus)
  const chatsReady =
    Boolean(userApiKeySet && (userConnectionStatus?.chatApiOk || userConnectionStatus?.tokenKind === 'user')) ||
    Boolean(!userApiKeySet && connectionStatus?.chatApiOk)
  return {
    provider: row.provider || DEFAULT_PROVIDER,
    tokenSource,
    onesaasReady,
    onesaasDeveloperMasked,
    onesaasUserMasked,
    apiKey: row.api_key ? '••••' + String(row.api_key).slice(-4) : '',
    apiKeySet,
    userApiKey: row.user_api_key ? '••••' + String(row.user_api_key).slice(-4) : '',
    userApiKeySet,
    templatesReady,
    chatsReady,
    userChatReady: chatsReady,
    projectName: row.project_name || '',
    projectId: row.project_id || '',
    wabaId: row.waba_id || '',
    phoneNumberId: row.phone_number_id || '',
    countryCode: row.country_code || '91',
    connected: Boolean(row.connected),
    activityMap: parseActivityMap(row.activity_map),
    connectionStatus,
    userConnectionStatus,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

/** Token used for live chat APIs (prefer dedicated user token). */
export function resolveChatApiKey(rawConfig) {
  if (!rawConfig) return null
  if (rawConfig.user_api_key) return rawConfig.user_api_key
  const st = parseConnectionStatus(rawConfig.connection_status)
  if (st?.chatApiOk) return rawConfig.api_key || null
  return rawConfig.api_key || null
}

export async function getShopWhatsAppChatCredentials(shopAppId) {
  const config = await getRawConfig(shopAppId)
  const platform = await getPlatformWhatsAppTokens()
  const mapped = mapConfig(config, platform)
  return {
    apiKey: resolveChatApiKey(config),
    countryCode: config?.country_code || '91',
    userApiKeySet: Boolean(config?.user_api_key),
    chatReady: mapped.userChatReady,
  }
}

function mapTemplate(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    language: row.language,
    body: row.body_text,
    campaignName: row.campaign_name,
    externalId: row.external_id || null,
    activity: row.activity || 'custom',
    headerFormat: row.header_format || null,
    headerMediaUrl: row.header_media_url || null,
    headerText: row.header_text || null,
    footerText: row.footer_text || null,
    paramLabels: row.param_labels ? JSON.parse(row.param_labels) : [],
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function mapCampaign(row) {
  return {
    id: row.id,
    name: row.name,
    templateId: row.template_id,
    templateName: row.template_name,
    campaignName: row.campaign_name,
    status: row.status,
    lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

async function getRawConfig(shopAppId) {
  await ensureWhatsAppSchema()
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_config WHERE shop_app_id = ? LIMIT 1`,
    [shopAppId],
  )
  return rows[0] || null
}

export async function getWhatsAppConfig(shopAppId) {
  const [row, platform] = await Promise.all([getRawConfig(shopAppId), getPlatformWhatsAppTokens()])
  return mapConfig(row, platform)
}

export function listWhatsAppActivities() {
  return WHATSAPP_ACTIVITIES
}

export { listWhatsAppTemplateVariables, listTemplatePlaceholders }

export async function saveWhatsAppActivityMap(shopAppId, inputMap) {
  await ensureWhatsAppSchema()
  const existing = await getRawConfig(shopAppId)
  if (!existing) throw new Error('Connect WhatsApp first (Settings → WhatsApp API)')
  const next = parseActivityMap(existing.activity_map)
  const incoming = inputMap && typeof inputMap === 'object' ? inputMap : {}
  for (const key of Object.keys(EMPTY_ACTIVITY_MAP)) {
    if (incoming[key] === undefined) continue
    next[key] = parseActivityBinding(incoming[key])
  }
  const now = nowIso()
  await getPool().query(
    `UPDATE shop_whatsapp_config SET activity_map = ?, updated_at = ? WHERE shop_app_id = ?`,
    [JSON.stringify(next), toMysqlDate(now), shopAppId],
  )
  // Keep template.activity in sync for mapped rows
  for (const [activity, binding] of Object.entries(next)) {
    const templateId = binding?.templateId
    if (!templateId) continue
    await getPool().query(
      `UPDATE shop_whatsapp_templates SET activity = ? WHERE id = ? AND shop_app_id = ?`,
      [activity, templateId, shopAppId],
    )
  }
  return getWhatsAppConfig(shopAppId)
}

export async function fetchRemoteWhatsAppTemplates(shopAppId) {
  const config = await getRawConfig(shopAppId)
  if (!config?.api_key) throw new Error('Connect WhatsApp first (Settings → WhatsApp API)')
  return listOneChattingTemplates(config.api_key)
}

export async function syncRemoteWhatsAppTemplates(shopAppId) {
  const remote = await fetchRemoteWhatsAppTemplates(shopAppId)
  const existing = await listWhatsAppTemplates(shopAppId)
  const byExternal = new Map(
    existing.filter((t) => t.externalId).map((t) => [t.externalId, t]),
  )
  const byCampaign = new Map(existing.map((t) => [t.campaignName, t]))
  const remoteIds = new Set(remote.map((row) => row.templateId).filter(Boolean))
  const remoteNames = new Set(remote.map((row) => row.templateName).filter(Boolean))
  let created = 0
  let updated = 0
  let removed = 0
  for (const row of remote) {
    const payload = {
      name: row.templateName,
      category: row.category,
      language: row.language,
      body: row.body,
      campaignName: row.templateName,
      externalId: row.templateId,
      headerFormat: row.headerFormat || null,
      headerMediaUrl: row.headerMediaUrl || null,
      headerText: row.headerText || null,
      footerText: row.footerText || null,
      status: row.status === 'APPROVED' ? 'approved' : String(row.status || 'draft').toLowerCase(),
    }
    const match = byExternal.get(row.templateId) || byCampaign.get(row.templateName)
    if (match) {
      await updateWhatsAppTemplate(shopAppId, match.id, {
        ...payload,
        name: match.name || row.templateName,
        // Prefer freshly hydrated body/media from OneChatting details
        body: row.body || match.body || '',
      })
      updated += 1
    } else {
      await createWhatsAppTemplate(shopAppId, payload)
      created += 1
    }
  }
  // Drop templates that are not on the currently connected developer token account.
  for (const local of existing) {
    const keep =
      (local.externalId && remoteIds.has(local.externalId)) ||
      remoteNames.has(local.campaignName) ||
      remoteNames.has(local.name)
    if (!keep) {
      await deleteWhatsAppTemplate(shopAppId, local.id)
      removed += 1
    }
  }
  return {
    remoteCount: remote.length,
    created,
    updated,
    removed,
    templates: await listWhatsAppTemplates(shopAppId),
  }
}

/** Re-fetch one template’s body + media from OneChatting and persist. */
export async function refreshWhatsAppTemplate(shopAppId, templateId) {
  await ensureWhatsAppSchema()
  const config = await getRawConfig(shopAppId)
  if (!config?.api_key) throw new Error('Connect WhatsApp first (Settings → WhatsApp API)')
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
    [templateId, shopAppId],
  )
  if (!rows[0]) throw new Error('Template not found')
  const cur = mapTemplate(rows[0])
  const remoteId = cur.externalId || cur.campaignName
  if (!remoteId) throw new Error('Template has no OneChatting id — sync templates first')
  const remote = await getOneChattingTemplateDetails(config.api_key, remoteId)
  return updateWhatsAppTemplate(shopAppId, templateId, {
    name: cur.name || remote.templateName,
    category: remote.category || cur.category,
    language: remote.language || cur.language,
    body: remote.body || cur.body || '',
    campaignName: remote.templateName || cur.campaignName,
    externalId: remote.templateId || cur.externalId,
    headerFormat: remote.headerFormat || null,
    headerMediaUrl: remote.headerMediaUrl || null,
    headerText: remote.headerText || null,
    footerText: remote.footerText || null,
    status: remote.status === 'APPROVED' ? 'approved' : cur.status,
  })
}

export async function saveWhatsAppConfig(shopAppId, input) {
  const existing = await getRawConfig(shopAppId)
  const now = nowIso()
  const tokenSource = normalizeTokenSource(
    input.tokenSource ?? existing?.token_source ?? TOKEN_SOURCE_CUSTOMER,
  )

  let apiKeyIncoming = input.apiKey === undefined ? undefined : String(input.apiKey ?? '').trim()
  let userKeyIncoming =
    input.userApiKey === undefined ? undefined : String(input.userApiKey ?? '').trim()

  if (tokenSource === TOKEN_SOURCE_ONESAAS) {
    const platform = await resolvePlatformTokens()
    if (!platform.ready) {
      throw new Error(
        'OneSAAS-CRM tokens are not ready yet. They will be managed from the OneBook admin portal. Use “My OneChatting tokens” for now.',
      )
    }
    apiKeyIncoming = platform.developerToken
    userKeyIncoming = platform.userToken
  }

  const keepKey =
    tokenSource !== TOKEN_SOURCE_ONESAAS &&
    (apiKeyIncoming === undefined || apiKeyIncoming === '' || apiKeyIncoming.startsWith('••••'))
  const apiKey = keepKey ? existing?.api_key || '' : apiKeyIncoming || ''

  const clearUserKey = input.clearUserApiKey === true
  const keepUserKey =
    tokenSource !== TOKEN_SOURCE_ONESAAS &&
    !clearUserKey &&
    (userKeyIncoming === undefined || userKeyIncoming === '' || userKeyIncoming.startsWith('••••'))
  let userApiKey = keepUserKey ? existing?.user_api_key || null : userKeyIncoming || null
  if (clearUserKey) userApiKey = null

  if (tokenSource === TOKEN_SOURCE_CUSTOMER && !apiKey) {
    throw new Error('Paste your OneChatting developer token')
  }

  const provider = 'onechatting'
  const projectName = String(input.projectName ?? existing?.project_name ?? '').trim().slice(0, 160)
  let projectId = String(input.projectId ?? existing?.project_id ?? '').trim().slice(0, 120)
  let wabaId = String(input.wabaId ?? existing?.waba_id ?? '').trim().slice(0, 120)
  const phoneNumberId = String(input.phoneNumberId ?? existing?.phone_number_id ?? '').trim().slice(0, 120)
  const countryCode =
    String(input.countryCode ?? existing?.country_code ?? '91').replace(/\D/g, '').slice(0, 4) || '91'

  let probe = { ok: false, message: 'Add credentials to connect' }
  let connectionStatus = parseConnectionStatus(existing?.connection_status)
  if (!apiKey) {
    probe = { ok: false, error: 'Paste your OneChatting developer token' }
    connectionStatus = null
  } else if (!keepKey || !connectionStatus || tokenSource === TOKEN_SOURCE_ONESAAS) {
    probe = await probeOneChattingToken(apiKey)
    if (probe.ok && probe.status) {
      connectionStatus = probe.status
      if (probe.status.projectId) projectId = String(probe.status.projectId).slice(0, 120)
      if (probe.status.wabaId) wabaId = String(probe.status.wabaId).slice(0, 120)
    } else if (!keepKey || tokenSource === TOKEN_SOURCE_ONESAAS) {
      connectionStatus = null
    }
  } else {
    probe = { ok: true, message: 'Connected', status: connectionStatus }
  }

  let userProbe = null
  let userConnectionStatus = parseConnectionStatus(existing?.user_connection_status)
  if (clearUserKey) {
    userConnectionStatus = null
  } else if (userApiKey && (!keepUserKey || !userConnectionStatus || tokenSource === TOKEN_SOURCE_ONESAAS)) {
    userProbe = await probeOneChattingUserToken(userApiKey)
    if (userProbe.ok && userProbe.status) {
      userConnectionStatus = userProbe.status
    } else if (!keepUserKey || tokenSource === TOKEN_SOURCE_ONESAAS) {
      throw new Error(userProbe?.error || 'Could not verify User Token')
    }
  }

  const connected = Boolean(apiKey) && Boolean(probe.ok)
  const nextProjectName =
    projectName ||
    (connectionStatus?.displayName ? String(connectionStatus.displayName).slice(0, 160) : '')
  const displayPhone = connectionStatus?.displayPhone
    ? String(connectionStatus.displayPhone).slice(0, 120)
    : phoneNumberId || null

  if (existing) {
    await getPool().query(
      `UPDATE shop_whatsapp_config
       SET provider = ?, api_key = ?, user_api_key = ?, project_name = ?, project_id = ?, waba_id = ?,
           phone_number_id = ?, country_code = ?, connected = ?, connection_status = ?,
           user_connection_status = ?, token_source = ?, updated_at = ?
       WHERE shop_app_id = ?`,
      [
        provider,
        apiKey || null,
        userApiKey || null,
        nextProjectName,
        projectId || null,
        wabaId || null,
        displayPhone,
        countryCode,
        connected ? 1 : 0,
        connectionStatus ? JSON.stringify(connectionStatus) : null,
        userConnectionStatus ? JSON.stringify(userConnectionStatus) : null,
        tokenSource,
        toMysqlDate(now),
        shopAppId,
      ],
    )
  } else {
    await getPool().query(
      `INSERT INTO shop_whatsapp_config
        (shop_app_id, provider, api_key, user_api_key, project_name, project_id, waba_id, phone_number_id,
         country_code, connected, connection_status, user_connection_status, token_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopAppId,
        provider,
        apiKey || null,
        userApiKey || null,
        nextProjectName,
        projectId || null,
        wabaId || null,
        displayPhone,
        countryCode,
        connected ? 1 : 0,
        connectionStatus ? JSON.stringify(connectionStatus) : null,
        userConnectionStatus ? JSON.stringify(userConnectionStatus) : null,
        tokenSource,
        toMysqlDate(now),
        toMysqlDate(now),
      ],
    )
  }

  const prevFp = chatTokenFingerprintFromConfig(existing)
  const nextFp = chatTokenFingerprintFromConfig({
    token_source: tokenSource,
    user_api_key: userApiKey,
    api_key: apiKey,
  })
  if (prevFp !== nextFp) {
    await clearWhatsAppChatThreadsForShop(shopAppId)
  }

  return {
    config: await getWhatsAppConfig(shopAppId),
    probe,
    userProbe: userProbe || (userApiKey ? { ok: true, message: 'User token ready for live chats' } : null),
  }
}

export async function refreshWhatsAppConnectionStatus(shopAppId) {
  const existing = await getRawConfig(shopAppId)
  if (!existing?.api_key) throw new Error('Connect with a OneChatting developer token first')
  const probe = await probeOneChattingToken(existing.api_key)
  if (!probe.ok) {
    await getPool().query(
      `UPDATE shop_whatsapp_config SET connected = 0, connection_status = NULL, updated_at = ? WHERE shop_app_id = ?`,
      [toMysqlDate(nowIso()), shopAppId],
    )
    throw new Error(probe.error || 'Could not refresh OneChatting status')
  }
  const status = probe.status || null
  const projectId = status?.projectId || existing.project_id || null
  const wabaId = status?.wabaId || existing.waba_id || null
  const displayPhone = status?.displayPhone || existing.phone_number_id || null
  let userConnectionStatus = parseConnectionStatus(existing.user_connection_status)
  let userProbe = null
  if (existing.user_api_key) {
    userProbe = await probeOneChattingUserToken(existing.user_api_key)
    if (userProbe.ok && userProbe.status) userConnectionStatus = userProbe.status
  }
  await getPool().query(
    `UPDATE shop_whatsapp_config
     SET connected = 1, connection_status = ?, user_connection_status = ?, project_id = ?, waba_id = ?,
         phone_number_id = ?, updated_at = ?
     WHERE shop_app_id = ?`,
    [
      status ? JSON.stringify(status) : null,
      userConnectionStatus ? JSON.stringify(userConnectionStatus) : null,
      projectId,
      wabaId,
      displayPhone,
      toMysqlDate(nowIso()),
      shopAppId,
    ],
  )
  return { config: await getWhatsAppConfig(shopAppId), probe, userProbe }
}

export async function disconnectWhatsAppConfig(shopAppId) {
  await ensureWhatsAppSchema()
  const existing = await getRawConfig(shopAppId)
  if (!existing) {
    return { config: await getWhatsAppConfig(shopAppId) }
  }
  await getPool().query(
    `UPDATE shop_whatsapp_config
     SET api_key = NULL, user_api_key = NULL, project_id = NULL, waba_id = NULL, phone_number_id = NULL,
         connected = 0, connection_status = NULL, user_connection_status = NULL,
         token_source = ?, updated_at = ?
     WHERE shop_app_id = ?`,
    [TOKEN_SOURCE_CUSTOMER, toMysqlDate(nowIso()), shopAppId],
  )
  return { config: await getWhatsAppConfig(shopAppId) }
}

export async function listWhatsAppTemplates(shopAppId) {
  await ensureWhatsAppSchema()
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_templates WHERE shop_app_id = ? ORDER BY updated_at DESC`,
    [shopAppId],
  )
  return rows.map(mapTemplate)
}

export async function createWhatsAppTemplate(shopAppId, input) {
  await ensureWhatsAppSchema()
  const id = randomUUID()
  const now = nowIso()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('Template name is required')
  const campaignName = String(input.campaignName || name).trim()
  if (!campaignName) throw new Error('Template / campaign name is required')
  const externalId = input.externalId ? String(input.externalId).trim().slice(0, 120) : null
  const activity = String(input.activity || 'custom').trim().slice(0, 40) || 'custom'
  const headerFormat = input.headerFormat ? String(input.headerFormat).trim().slice(0, 20) : null
  const headerMediaUrl = input.headerMediaUrl ? String(input.headerMediaUrl).trim().slice(0, 2000) : null
  const headerText = input.headerText ? String(input.headerText).trim().slice(0, 500) : null
  const footerText = input.footerText ? String(input.footerText).trim().slice(0, 500) : null
  await getPool().query(
    `INSERT INTO shop_whatsapp_templates
      (id, shop_app_id, name, category, language, body_text, campaign_name, external_id, activity,
       header_format, header_media_url, header_text, footer_text, param_labels, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopAppId,
      name.slice(0, 120),
      String(input.category || 'UTILITY').slice(0, 40),
      String(input.language || 'en').slice(0, 20),
      String(input.body || '').slice(0, 2000),
      campaignName.slice(0, 160),
      externalId,
      activity,
      headerFormat,
      headerMediaUrl,
      headerText,
      footerText,
      JSON.stringify(Array.isArray(input.paramLabels) ? input.paramLabels : []),
      String(input.status || 'draft').slice(0, 20),
      toMysqlDate(now),
      toMysqlDate(now),
    ],
  )
  const [rows] = await getPool().query(`SELECT * FROM shop_whatsapp_templates WHERE id = ?`, [id])
  return mapTemplate(rows[0])
}

export async function updateWhatsAppTemplate(shopAppId, id, input) {
  await ensureWhatsAppSchema()
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
    [id, shopAppId],
  )
  if (!rows[0]) throw new Error('Template not found')
  const cur = rows[0]
  const now = nowIso()
  const externalId =
    input.externalId === undefined
      ? cur.external_id
      : input.externalId
        ? String(input.externalId).trim().slice(0, 120)
        : null
  const headerFormat =
    input.headerFormat === undefined
      ? cur.header_format
      : input.headerFormat
        ? String(input.headerFormat).trim().slice(0, 20)
        : null
  const headerMediaUrl =
    input.headerMediaUrl === undefined
      ? cur.header_media_url
      : input.headerMediaUrl
        ? String(input.headerMediaUrl).trim().slice(0, 2000)
        : null
  const headerText =
    input.headerText === undefined
      ? cur.header_text
      : input.headerText
        ? String(input.headerText).trim().slice(0, 500)
        : null
  const footerText =
    input.footerText === undefined
      ? cur.footer_text
      : input.footerText
        ? String(input.footerText).trim().slice(0, 500)
        : null
  await getPool().query(
    `UPDATE shop_whatsapp_templates
     SET name = ?, category = ?, language = ?, body_text = ?, campaign_name = ?,
         external_id = ?, activity = ?, header_format = ?, header_media_url = ?,
         header_text = ?, footer_text = ?, param_labels = ?, status = ?, updated_at = ?
     WHERE id = ? AND shop_app_id = ?`,
    [
      String(input.name ?? cur.name).trim().slice(0, 120),
      String(input.category ?? cur.category).slice(0, 40),
      String(input.language ?? cur.language).slice(0, 20),
      String(input.body ?? cur.body_text).slice(0, 2000),
      String(input.campaignName ?? cur.campaign_name).trim().slice(0, 160),
      externalId,
      String(input.activity ?? cur.activity ?? 'custom').trim().slice(0, 40) || 'custom',
      headerFormat,
      headerMediaUrl,
      headerText,
      footerText,
      JSON.stringify(
        Array.isArray(input.paramLabels)
          ? input.paramLabels
          : cur.param_labels
            ? JSON.parse(cur.param_labels)
            : [],
      ),
      String(input.status ?? cur.status).slice(0, 20),
      toMysqlDate(now),
      id,
      shopAppId,
    ],
  )
  const [next] = await getPool().query(`SELECT * FROM shop_whatsapp_templates WHERE id = ?`, [id])
  return mapTemplate(next[0])
}

export async function deleteWhatsAppTemplate(shopAppId, id) {
  const [result] = await getPool().query(
    `DELETE FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
    [id, shopAppId],
  )
  if (!result.affectedRows) throw new Error('Template not found')
  await getPool().query(
    `UPDATE shop_whatsapp_campaigns SET template_id = NULL WHERE shop_app_id = ? AND template_id = ?`,
    [shopAppId, id],
  )
  return true
}

export async function listWhatsAppCampaigns(shopAppId) {
  const [rows] = await getPool().query(
    `SELECT c.*, t.name AS template_name
     FROM shop_whatsapp_campaigns c
     LEFT JOIN shop_whatsapp_templates t ON t.id = c.template_id
     WHERE c.shop_app_id = ?
     ORDER BY c.updated_at DESC`,
    [shopAppId],
  )
  return rows.map(mapCampaign)
}

export async function createWhatsAppCampaign(shopAppId, input) {
  const id = randomUUID()
  const now = nowIso()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('Campaign name is required')
  let campaignName = String(input.campaignName || '').trim()
  let templateName = null
  if (input.templateId) {
    const [trows] = await getPool().query(
      `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
      [input.templateId, shopAppId],
    )
    if (!trows[0]) throw new Error('Template not found')
    templateName = trows[0].name
    if (!campaignName) campaignName = trows[0].campaign_name
  }
  if (!campaignName) campaignName = name
  await getPool().query(
    `INSERT INTO shop_whatsapp_campaigns
      (id, shop_app_id, name, template_id, campaign_name, status, last_sent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      shopAppId,
      name.slice(0, 160),
      input.templateId || null,
      campaignName.slice(0, 160),
      String(input.status || 'draft').slice(0, 20),
      toMysqlDate(now),
      toMysqlDate(now),
    ],
  )
  return {
    id,
    name,
    templateId: input.templateId || null,
    templateName,
    campaignName,
    status: input.status || 'draft',
    lastSentAt: null,
    createdAt: now,
    updatedAt: now,
  }
}

export async function updateWhatsAppCampaign(shopAppId, id, input) {
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_campaigns WHERE id = ? AND shop_app_id = ?`,
    [id, shopAppId],
  )
  if (!rows[0]) throw new Error('Campaign not found')
  const cur = rows[0]
  const now = nowIso()
  let templateId = input.templateId === undefined ? cur.template_id : input.templateId || null
  let campaignName = String(input.campaignName ?? cur.campaign_name).trim()
  if (input.templateId) {
    const [trows] = await getPool().query(
      `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
      [input.templateId, shopAppId],
    )
    if (!trows[0]) throw new Error('Template not found')
    if (!input.campaignName) campaignName = trows[0].campaign_name
  }
  await getPool().query(
    `UPDATE shop_whatsapp_campaigns
     SET name = ?, template_id = ?, campaign_name = ?, status = ?, updated_at = ?
     WHERE id = ? AND shop_app_id = ?`,
    [
      String(input.name ?? cur.name).trim().slice(0, 160),
      templateId,
      campaignName.slice(0, 160),
      String(input.status ?? cur.status).slice(0, 20),
      toMysqlDate(now),
      id,
      shopAppId,
    ],
  )
  const list = await listWhatsAppCampaigns(shopAppId)
  return list.find((c) => c.id === id)
}

export async function deleteWhatsAppCampaign(shopAppId, id) {
  const [result] = await getPool().query(
    `DELETE FROM shop_whatsapp_campaigns WHERE id = ? AND shop_app_id = ?`,
    [id, shopAppId],
  )
  if (!result.affectedRows) throw new Error('Campaign not found')
  return true
}

export async function sendWhatsAppCampaignMessage(shopAppId, account, input) {
  const config = await getRawConfig(shopAppId)
  if (!config?.api_key) throw new Error('Connect WhatsApp first (Settings → WhatsApp API)')
  const [camps] = await getPool().query(
    `SELECT * FROM shop_whatsapp_campaigns WHERE id = ? AND shop_app_id = ?`,
    [input.campaignId, shopAppId],
  )
  if (!camps[0]) throw new Error('Campaign not found')
  const camp = camps[0]
  const phone = String(input.phone || '').replace(/\D/g, '').slice(-10)
  const userName = String(input.userName || input.customerName || 'Customer').trim()
  const params = Array.isArray(input.templateParams) ? input.templateParams : []
  const countryCode = config.country_code || '91'
  const destination = toWhatsAppNumber(phone, countryCode)

  let category = 'UTILITY'
  if (camp.template_id) {
    const [trows] = await getPool().query(
      `SELECT category FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
      [camp.template_id, shopAppId],
    )
    if (trows[0]?.category) category = String(trows[0].category).toUpperCase()
  }

  const result = await sendOneChattingTemplate({
    token: config.api_key,
    phone10: phone,
    templateRef: camp.campaign_name,
    bodyTexts: params,
    categories: [category, 'UTILITY', 'MARKETING', 'AUTHENTICATION'],
    countryCode,
  })

  const now = nowIso()
  await getPool().query(
    `UPDATE shop_whatsapp_campaigns SET last_sent_at = ?, status = 'live', updated_at = ? WHERE id = ?`,
    [toMysqlDate(now), toMysqlDate(now), camp.id],
  )

  await insertWhatsAppMessageLog({
    shopAppId,
    customerId: input.customerId || null,
    customerName: userName,
    phone,
    kind: 'campaign',
    templateName: camp.campaign_name,
    messageBody: `Campaign “${camp.name}” → ${destination}`,
    ok: true,
    error: null,
    providerMessageId: result.providerMessageId,
    sentByUserId: account?.id || null,
    sentByName: account?.name || null,
  })

  return result
}

function formatAmountPlain(amount) {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(Math.abs(Number(amount) || 0))
}

export async function resolveWhatsAppActivityBinding(shopAppId, activity) {
  await ensureWhatsAppSchema()
  const config = await getWhatsAppConfig(shopAppId)
  const binding = getActivityBinding(config.activityMap, activity)
  if (!binding.templateId) return null
  const templates = await listWhatsAppTemplates(shopAppId)
  const template = templates.find((t) => t.id === binding.templateId) || null
  if (!template) return null
  return {
    template,
    variables: binding.variables || {},
    attachmentUrl: binding.attachmentUrl || null,
    attachmentName: binding.attachmentName || null,
  }
}

export async function resolveWhatsAppTemplateForActivity(shopAppId, activity) {
  const resolved = await resolveWhatsAppActivityBinding(shopAppId, activity)
  return resolved?.template || null
}

function resolveBodyTextsForSend({
  activity,
  template,
  variables,
  recipient,
  shopName,
  teamName,
  shopAddress,
  customParams,
  paramMode,
  note,
}) {
  const customerName =
    String(recipient.customerName || recipient.userName || 'Customer').trim() || 'Customer'
  const balance = Number(recipient.balance)
  const placeholders = listTemplatePlaceholders(template.body, template.headerText)
  const mappedVars =
    variables && Object.keys(variables).length
      ? variables
      : defaultVariablesForActivity(activity || template.activity, placeholders)

  if (paramMode === 'custom' && customParams.length) {
    return customParams
  }
  if (Array.isArray(recipient.templateParams) && recipient.templateParams.length) {
    return recipient.templateParams.map((p) => String(p))
  }
  if (mappedVars && Object.keys(mappedVars).length) {
    const context = buildWhatsAppVariableContext({
      customerName,
      phone: recipient.phone,
      customerPhone: recipient.phone,
      balance,
      openingBalance: recipient.openingBalance,
      shopName,
      shopAddress,
      teamName,
      note: recipient.note || note,
      documentName: recipient.documentName,
      documentLink: recipient.documentLink,
      invoiceNumber: recipient.invoiceNumber,
      invoiceAmount: recipient.invoiceAmount,
      invoiceDate: recipient.invoiceDate,
      amount: recipient.amount,
      date: recipient.date,
      activityTitle: recipient.activityTitle,
      dueDate: recipient.dueDate,
    })
    const texts = buildBodyTextsFromVariableMap(mappedVars, context, placeholders)
    if (texts.some((t) => t)) return texts
  }

  if (template.activity === 'payment_reminder' || activity === 'payment_reminder') {
    return [
      customerName,
      formatAmountPlain(Number.isFinite(balance) ? balance : 0),
      shopName,
      teamName,
    ]
  }
  if (
    template.activity === 'document_share' ||
    activity === 'document_share' ||
    template.activity === 'sales_invoice' ||
    activity === 'sales_invoice'
  ) {
    if (activity === 'sales_invoice' || template.activity === 'sales_invoice') {
      return [
        customerName,
        formatAmountPlain(
          Number.isFinite(Number(recipient.invoiceAmount))
            ? Number(recipient.invoiceAmount)
            : Number.isFinite(balance)
              ? balance
              : 0,
        ),
        String(recipient.invoiceNumber || '').trim() || 'Invoice',
        shopName,
      ]
    }
    return [
      customerName,
      String(recipient.documentName || 'Document').trim() || 'Document',
      shopName,
    ]
  }
  if (template.activity === 'reminder_activity' || activity === 'reminder_activity') {
    return [customerName, String(recipient.note || note || 'Reminder'), shopName]
  }
  return customParams.length ? customParams : [customerName]
}

/**
 * Broadcast a mapped / selected template to many customers (device-initiated).
 */
export async function broadcastWhatsAppMessages(shopAppId, account, input) {
  const config = await getRawConfig(shopAppId)
  if (!config?.api_key) throw new Error('Connect WhatsApp first (Settings → WhatsApp API)')

  let template = null
  let activityVariables = {}
  let activityAttachmentUrl = null
  let activityAttachmentName = null
  if (input.templateId) {
    const [rows] = await getPool().query(
      `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
      [input.templateId, shopAppId],
    )
    if (!rows[0]) throw new Error('Template not found')
    template = mapTemplate(rows[0])
    if (input.activity) {
      const binding = await resolveWhatsAppActivityBinding(shopAppId, input.activity)
      if (binding?.template?.id === template.id) {
        activityVariables = binding.variables || {}
        activityAttachmentUrl = binding.attachmentUrl || null
        activityAttachmentName = binding.attachmentName || null
      }
    }
  } else if (input.activity) {
    const resolved = await resolveWhatsAppActivityBinding(shopAppId, input.activity)
    if (!resolved?.template) {
      throw new Error(
        `No template mapped for “${input.activity}”. Open Mapping and assign a OneChatting template.`,
      )
    }
    template = resolved.template
    activityVariables = resolved.variables || {}
    activityAttachmentUrl = resolved.attachmentUrl || null
    activityAttachmentName = resolved.attachmentName || null
  }
  if (!template) throw new Error('Select a template or activity to broadcast')

  // Client overrides (Broadcast UI template pick + variable map + attachment)
  if (input.variables && typeof input.variables === 'object') {
    const next = {}
    for (const [k, v] of Object.entries(input.variables)) {
      if (/^\d+$/.test(k) && v) next[k] = String(v)
    }
    if (Object.keys(next).length) activityVariables = next
  }
  if (input.headerMediaUrl != null && String(input.headerMediaUrl).trim()) {
    activityAttachmentUrl = String(input.headerMediaUrl).trim()
  }
  if (input.headerMediaName != null && String(input.headerMediaName).trim()) {
    activityAttachmentName = String(input.headerMediaName).trim()
  } else if (input.attachmentName != null && String(input.attachmentName).trim()) {
    activityAttachmentName = String(input.attachmentName).trim()
  }
  if (input.attachmentUrl != null && String(input.attachmentUrl).trim()) {
    activityAttachmentUrl = String(input.attachmentUrl).trim()
  }

  const recipients = Array.isArray(input.recipients) ? input.recipients : []
  if (recipients.length === 0) throw new Error('Select at least one customer')

  const shopName = String(input.shopName || '').trim() || 'Shop'
  const shopAddress = String(input.shopAddress || '').trim()
  const team = String(input.teamName || shopName).trim() || shopName
  const customParams = Array.isArray(input.templateParams)
    ? input.templateParams.map((p) => String(p))
    : []
  const paramMode = String(input.paramMode || 'auto')
  const countryCode = config.country_code || '91'
  const category = String(template.category || 'UTILITY').toUpperCase()
  const results = []

  for (const raw of recipients) {
    const phone = String(raw.phone || '')
      .replace(/\D/g, '')
      .slice(-10)
    const customerName = String(raw.customerName || raw.userName || 'Customer').trim() || 'Customer'
    const customerId = raw.customerId ? String(raw.customerId) : null
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

    const bodyTexts = resolveBodyTextsForSend({
      activity: input.activity,
      template,
      variables: activityVariables,
      recipient: raw,
      shopName,
      teamName: team,
      shopAddress,
      customParams,
      paramMode,
      note: input.note,
    })

    try {
      const headerMediaUrl =
        activityAttachmentUrl ||
        input.headerMediaUrl ||
        template.headerMediaUrl ||
        null
      const headerMediaType = String(
        template.headerFormat || input.headerMediaType || (headerMediaUrl ? 'IMAGE' : ''),
      ).toUpperCase()
      const sent = await sendOneChattingTemplate({
        token: config.api_key,
        phone10: phone,
        templateRef: template.externalId || template.campaignName,
        bodyTexts,
        categories: [category, 'UTILITY', 'MARKETING', 'AUTHENTICATION'],
        countryCode,
        headerMediaUrl,
        headerMediaType: headerMediaType || null,
        headerMediaName: activityAttachmentName || input.headerMediaName || null,
      })
      await insertWhatsAppMessageLog({
        shopAppId,
        customerId,
        customerName,
        phone,
        kind: input.activity || template.activity || 'broadcast',
        templateName: template.campaignName,
        messageBody: `Broadcast “${template.name}” → ${toWhatsAppNumber(phone, countryCode)}`,
        ok: true,
        error: null,
        providerMessageId: sent.providerMessageId,
        sentByUserId: account?.id || null,
        sentByName: account?.name || null,
      })
      results.push({
        customerId,
        phone,
        customerName,
        ok: true,
        messageId: sent.providerMessageId,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Send failed'
      try {
        await insertWhatsAppMessageLog({
          shopAppId,
          customerId,
          customerName,
          phone,
          kind: input.activity || template.activity || 'broadcast',
          templateName: template.campaignName,
          messageBody: `Broadcast “${template.name}” failed`,
          ok: false,
          error,
          providerMessageId: null,
          sentByUserId: account?.id || null,
          sentByName: account?.name || null,
        })
      } catch {
        /* ignore log failure */
      }
      results.push({ customerId, phone, customerName, ok: false, error })
    }
  }

  const sent = results.filter((r) => r.ok).length
  const failed = results.length - sent
  return { ok: failed === 0, sent, failed, template, results }
}

/**
 * Send one template message into an existing / new chat thread.
 */
export async function sendWhatsAppChatTemplate(shopAppId, account, input) {
  const config = await getRawConfig(shopAppId)
  if (!config?.api_key) throw new Error('Connect WhatsApp first (Settings → WhatsApp API)')

  const phone = String(input.phone || '')
    .replace(/\D/g, '')
    .slice(-10)
  if (phone.length !== 10) throw new Error('Enter a valid 10-digit mobile number')

  const activity = input.activity ? String(input.activity) : null
  let template = null
  let activityVariables = {}
  let activityAttachmentUrl = null
  let activityAttachmentName = null

  if (input.templateId) {
    const [trows] = await getPool().query(
      `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
      [input.templateId, shopAppId],
    )
    if (!trows[0]) throw new Error('Template not found')
    template = mapTemplate(trows[0])
    if (activity) {
      const binding = await resolveWhatsAppActivityBinding(shopAppId, activity)
      if (binding?.template?.id === template.id) {
        activityVariables = binding.variables || {}
        activityAttachmentUrl = binding.attachmentUrl || null
        activityAttachmentName = binding.attachmentName || null
      }
    }
  } else if (activity) {
    const resolved = await resolveWhatsAppActivityBinding(shopAppId, activity)
    if (!resolved?.template) {
      throw new Error(
        `No template mapped for “${activity}”. Open WhatsApp → Mapping and assign a template.`,
      )
    }
    template = resolved.template
    activityVariables = resolved.variables || {}
    activityAttachmentUrl = resolved.attachmentUrl || null
    activityAttachmentName = resolved.attachmentName || null
  } else {
    throw new Error('Select a WhatsApp template')
  }

  const customerName =
    String(input.customerName || input.userName || 'Customer').trim() || 'Customer'
  const countryCode = config.country_code || '91'
  const destination = toWhatsAppNumber(phone, countryCode)
  const customParams = Array.isArray(input.templateParams)
    ? input.templateParams.map((p) => String(p))
    : []
  const variables = {
    ...activityVariables,
    ...(input.variables && typeof input.variables === 'object' ? input.variables : {}),
  }

  const bodyTexts = resolveBodyTextsForSend({
    activity: activity || template.activity || 'custom',
    template,
    variables,
    recipient: {
      customerName,
      phone,
      balance: input.balance,
      openingBalance: input.openingBalance,
      note: input.note,
      documentName: input.documentName || input.attachmentName || activityAttachmentName,
      documentLink: input.documentLink || input.attachmentUrl || activityAttachmentUrl,
      invoiceNumber: input.invoiceNumber,
      invoiceAmount: input.invoiceAmount,
      invoiceDate: input.invoiceDate,
      amount: input.amount ?? input.invoiceAmount,
      date: input.date || input.invoiceDate,
      activityTitle: input.activityTitle,
      dueDate: input.dueDate,
      templateParams: customParams,
    },
    shopName: String(input.shopName || '').trim() || 'Shop',
    teamName: String(input.teamName || input.shopName || 'Shop').trim() || 'Shop',
    shopAddress: String(input.shopAddress || '').trim(),
    customParams,
    paramMode: customParams.length ? 'custom' : 'mapped',
    note: input.note || '',
  })

  const headerMediaUrl =
    input.attachmentUrl || activityAttachmentUrl || template.headerMediaUrl || null
  const attachmentName =
    input.attachmentName || activityAttachmentName || input.documentName || null
  let headerMediaType = String(template.headerFormat || '').toUpperCase() || null
  if (headerMediaUrl && (!headerMediaType || headerMediaType === 'TEXT')) {
    const hint = `${attachmentName || ''} ${headerMediaUrl}`
    headerMediaType = /\.pdf(\?|$)/i.test(hint) ? 'DOCUMENT' : 'IMAGE'
  }
  if (headerMediaUrl && /\.pdf(\?|$)/i.test(`${attachmentName || ''} ${headerMediaUrl}`)) {
    headerMediaType = 'DOCUMENT'
  }

  let result
  try {
    result = await sendOneChattingTemplate({
      token: config.api_key,
      phone10: phone,
      templateRef: template.externalId || template.campaignName || template.name,
      bodyTexts,
      categories: [String(template.category || 'UTILITY').toUpperCase(), 'UTILITY', 'MARKETING', 'AUTHENTICATION'],
      countryCode,
      headerMediaUrl,
      headerMediaType,
      headerMediaName: attachmentName || null,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Send failed'
    await insertWhatsAppMessageLog({
      shopAppId,
      customerId: input.customerId || null,
      customerName,
      phone,
      kind: activity || template.activity || 'chat',
      templateName: template.name,
      messageBody: bodyTexts.filter(Boolean).join(' · ') || `Template “${template.name}” → ${destination}`,
      ok: false,
      error,
      providerMessageId: null,
      sentByUserId: account?.id || null,
      sentByName: account?.name || null,
    })
    throw err
  }

  const logged = await insertWhatsAppMessageLog({
    shopAppId,
    customerId: input.customerId || null,
    customerName,
    phone,
    kind: activity || template.activity || 'template',
    templateName: template.name,
    messageBody:
      [
        bodyTexts.filter(Boolean).join('\n') || `Template “${template.name}” → ${destination}`,
        headerMediaUrl || '',
      ]
        .filter(Boolean)
        .join('\n'),
    ok: true,
    error: null,
    providerMessageId: result.providerMessageId,
    sentByUserId: account?.id || null,
    sentByName: account?.name || null,
  })

  return { ok: true, result, message: logged, template }
}

export async function syncWhatsAppInbox(shopAppId, options = {}) {
  const config = await getRawConfig(shopAppId)
  const token = resolveChatApiKey(config)
  if (!token) {
    return {
      ok: false,
      synced: 0,
      error: 'Connect a OneChatting User Token under Chats to sync the live inbox.',
    }
  }
  const userStatus = parseConnectionStatus(config?.user_connection_status)
  const mainStatus = parseConnectionStatus(config?.connection_status)
  const chatReady = Boolean(
    (config?.user_api_key && userStatus?.chatApiOk) ||
      (!config?.user_api_key && mainStatus?.chatApiOk),
  )
  if (config?.user_api_key && userStatus && !userStatus.chatApiOk) {
    return {
      ok: false,
      synced: 0,
      error:
        'Saved token cannot read chats. Connect a User Token from OneChatting → Developer Access.',
    }
  }
  if (!config?.user_api_key && mainStatus && !mainStatus.chatApiOk) {
    return {
      ok: false,
      synced: 0,
      error:
        'Project Token is connected for templates. Open Chats and connect a User Token for the live inbox.',
      needsUserToken: true,
    }
  }
  const tokenFingerprint = chatTokenFingerprintFromConfig(config)
  const sync = await syncWhatsAppChatsFromProvider(shopAppId, token, {
    ...options,
    tokenFingerprint,
    prune: options.prune !== false,
  })
  return { ...sync, chatReady, tokenFingerprint }
}

export async function sendWhatsAppChatTextMessage(shopAppId, account, input) {
  const { sendWhatsAppChatText } = await import('./whatsappChats.js')
  return sendWhatsAppChatText(shopAppId, account, input)
}

export async function sendWhatsAppChatMediaMessage(shopAppId, account, input) {
  const { sendWhatsAppChatMedia } = await import('./whatsappChats.js')
  return sendWhatsAppChatMedia(shopAppId, account, input)
}

export async function getWhatsAppLiveSession(shopAppId) {
  const config = await getRawConfig(shopAppId)
  const token = resolveChatApiKey(config)
  if (!token) {
    throw new Error('Connect a OneChatting User Token under Chats for live messaging')
  }
  const userStatus = parseConnectionStatus(config?.user_connection_status)
  const mainStatus = parseConnectionStatus(config?.connection_status)
  const chatApiOk = Boolean(
    (config?.user_api_key && (userStatus?.chatApiOk || userStatus?.tokenKind === 'user')) ||
      (!config?.user_api_key && mainStatus?.chatApiOk),
  )
  if (!chatApiOk && config?.user_api_key) {
    // still return token; socket will fail auth with clear message
  }
  if (!config?.user_api_key && !mainStatus?.chatApiOk) {
    throw new Error(
      'Live chats need a User Token. Open Chats → Connect User Token (Project Token cannot open the inbox).',
    )
  }
  const { oneChattingSocketUrl } = await import('./onechatting.js')
  return {
    socketUrl: oneChattingSocketUrl(),
    token,
    countryCode: config.country_code || '91',
    chatApiOk,
    userTokenSet: Boolean(config.user_api_key),
  }
}

// Re-export chat helpers used by server routes
export {
  listWhatsAppChatMessages,
  getWhatsAppChatThread,
  markWhatsAppChatRead,
  markWhatsAppChatUnread,
  assignWhatsAppChat,
  syncWhatsAppChatsFromProvider,
  clearWhatsAppChatThreadsForShop,
  chatTokenFingerprintFromConfig,
}

/** Inbox list scoped to the currently connected token fingerprint. */
export async function listWhatsAppChats(shopAppId, opts = {}) {
  const config = await getRawConfig(shopAppId)
  const tokenFingerprint = chatTokenFingerprintFromConfig(config)
  return listWhatsAppChatsRaw(shopAppId, { ...opts, tokenFingerprint })
}
