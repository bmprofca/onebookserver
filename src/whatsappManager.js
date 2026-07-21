import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'
import {
  probeOneChattingToken,
  sendOneChattingTemplate,
  toWhatsAppNumber,
} from './onechatting.js'
import { insertWhatsAppMessageLog } from './whatsappLogs.js'

const DEFAULT_PROVIDER = 'onechatting'

function nowIso() {
  return new Date().toISOString()
}

function toMysqlDate(iso) {
  return new Date(iso).toISOString().slice(0, 23).replace('T', ' ')
}

function mapConfig(row) {
  if (!row) {
    return {
      provider: DEFAULT_PROVIDER,
      apiKey: '',
      apiKeySet: false,
      projectName: '',
      projectId: '',
      wabaId: '',
      phoneNumberId: '',
      countryCode: '91',
      connected: false,
      updatedAt: null,
    }
  }
  return {
    provider: row.provider || DEFAULT_PROVIDER,
    apiKey: row.api_key ? '••••' + String(row.api_key).slice(-4) : '',
    apiKeySet: Boolean(row.api_key),
    projectName: row.project_name || '',
    projectId: row.project_id || '',
    wabaId: row.waba_id || '',
    phoneNumberId: row.phone_number_id || '',
    countryCode: row.country_code || '91',
    connected: Boolean(row.connected),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
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
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_config WHERE shop_app_id = ? LIMIT 1`,
    [shopAppId],
  )
  return rows[0] || null
}

export async function getWhatsAppConfig(shopAppId) {
  return mapConfig(await getRawConfig(shopAppId))
}

export async function saveWhatsAppConfig(shopAppId, input) {
  const existing = await getRawConfig(shopAppId)
  const now = nowIso()
  const apiKeyIncoming = input.apiKey === undefined ? undefined : String(input.apiKey ?? '').trim()
  const keepKey = apiKeyIncoming === undefined || apiKeyIncoming === '' || apiKeyIncoming.startsWith('••••')
  const apiKey = keepKey ? existing?.api_key || '' : apiKeyIncoming
  const provider = 'onechatting'
  const projectName = String(input.projectName ?? existing?.project_name ?? '').trim().slice(0, 160)
  const projectId = String(input.projectId ?? existing?.project_id ?? '').trim().slice(0, 120)
  const wabaId = String(input.wabaId ?? existing?.waba_id ?? '').trim().slice(0, 120)
  const phoneNumberId = String(input.phoneNumberId ?? existing?.phone_number_id ?? '').trim().slice(0, 120)
  const countryCode = String(input.countryCode ?? existing?.country_code ?? '91').replace(/\D/g, '').slice(0, 4) || '91'

  let probe = { ok: false, message: 'Add credentials to connect' }
  if (!apiKey) {
    probe = { ok: false, error: 'Paste your OneChatting token or continue with Facebook' }
  } else if (!keepKey) {
    probe = await probeOneChattingToken(apiKey)
  } else if (existing?.connected) {
    probe = { ok: true, message: 'OneChatting connection saved' }
  } else {
    probe = await probeOneChattingToken(apiKey)
  }
  const connected = Boolean(apiKey) && Boolean(probe.ok)

  if (existing) {
    await getPool().query(
      `UPDATE shop_whatsapp_config
       SET provider = ?, api_key = ?, project_name = ?, project_id = ?, waba_id = ?,
           phone_number_id = ?, country_code = ?, connected = ?, updated_at = ?
       WHERE shop_app_id = ?`,
      [
        provider,
        apiKey || null,
        projectName,
        projectId || null,
        wabaId || null,
        phoneNumberId || null,
        countryCode,
        connected ? 1 : 0,
        toMysqlDate(now),
        shopAppId,
      ],
    )
  } else {
    await getPool().query(
      `INSERT INTO shop_whatsapp_config
        (shop_app_id, provider, api_key, project_name, project_id, waba_id, phone_number_id,
         country_code, connected, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopAppId,
        provider,
        apiKey || null,
        projectName,
        projectId || null,
        wabaId || null,
        phoneNumberId || null,
        countryCode,
        connected ? 1 : 0,
        toMysqlDate(now),
        toMysqlDate(now),
      ],
    )
  }
  return { config: await getWhatsAppConfig(shopAppId), probe }
}

export async function listWhatsAppTemplates(shopAppId) {
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_templates WHERE shop_app_id = ? ORDER BY updated_at DESC`,
    [shopAppId],
  )
  return rows.map(mapTemplate)
}

export async function createWhatsAppTemplate(shopAppId, input) {
  const id = randomUUID()
  const now = nowIso()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('Template name is required')
  const campaignName = String(input.campaignName || name).trim()
  if (!campaignName) throw new Error('Template / campaign name is required')
  await getPool().query(
    `INSERT INTO shop_whatsapp_templates
      (id, shop_app_id, name, category, language, body_text, campaign_name, param_labels, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      shopAppId,
      name.slice(0, 120),
      String(input.category || 'UTILITY').slice(0, 40),
      String(input.language || 'en').slice(0, 20),
      String(input.body || '').slice(0, 2000),
      campaignName.slice(0, 160),
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
  const [rows] = await getPool().query(
    `SELECT * FROM shop_whatsapp_templates WHERE id = ? AND shop_app_id = ?`,
    [id, shopAppId],
  )
  if (!rows[0]) throw new Error('Template not found')
  const cur = rows[0]
  const now = nowIso()
  await getPool().query(
    `UPDATE shop_whatsapp_templates
     SET name = ?, category = ?, language = ?, body_text = ?, campaign_name = ?,
         param_labels = ?, status = ?, updated_at = ?
     WHERE id = ? AND shop_app_id = ?`,
    [
      String(input.name ?? cur.name).trim().slice(0, 120),
      String(input.category ?? cur.category).slice(0, 40),
      String(input.language ?? cur.language).slice(0, 20),
      String(input.body ?? cur.body_text).slice(0, 2000),
      String(input.campaignName ?? cur.campaign_name).trim().slice(0, 160),
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

export async function listWhatsAppChats(shopAppId) {
  const [rows] = await getPool().query(
    `SELECT phone, MAX(customer_name) AS customer_name, MAX(customer_user_id) AS customer_user_id,
            COUNT(*) AS message_count, MAX(created_at) AS last_at,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
     FROM whatsapp_message_logs
     WHERE shop_app_id = ?
     GROUP BY phone
     ORDER BY last_at DESC
     LIMIT 100`,
    [shopAppId],
  )
  return rows.map((row) => ({
    phone: row.phone,
    customerName: row.customer_name,
    customerId: row.customer_user_id,
    messageCount: Number(row.message_count),
    sentCount: Number(row.sent_count),
    failedCount: Number(row.failed_count),
    lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
  }))
}

export async function listWhatsAppChatMessages(shopAppId, phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10)
  const [rows] = await getPool().query(
    `SELECT * FROM whatsapp_message_logs
     WHERE shop_app_id = ? AND phone LIKE ?
     ORDER BY created_at DESC
     LIMIT 100`,
    [shopAppId, `%${digits}`],
  )
  return rows.map((row) => ({
    id: row.id,
    customerName: row.customer_name,
    phone: row.phone,
    kind: row.kind,
    templateName: row.template_name,
    body: row.message_body,
    status: row.status,
    error: row.error_message,
    createdAt: new Date(row.created_at).toISOString(),
  }))
}
