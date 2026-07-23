import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'
import {
  fetchJson,
  getOneChattingChatHistory,
  listOneChattingChats,
  markOneChattingChatRead,
  oneChattingBaseUrl,
  sendOneChattingTextMessage,
  toOneChattingNumber,
} from './onechatting.js'

let schemaReady = false

function phoneKey(phone) {
  return String(phone || '')
    .replace(/\D/g, '')
    .slice(-10)
}

function toMysqlDate(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate || Date.now())
  if (Number.isNaN(d.getTime())) return new Date()
  return d
}

function previewText(body, templateName) {
  const raw = String(body || templateName || '').replace(/\s+/g, ' ').trim()
  return raw.slice(0, 280)
}

function parseProviderDate(value) {
  if (!value) return null
  const raw = String(value).trim()
  // OneChatting often returns "2026-06-20 14:30:00"
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const d = new Date(normalized)
  if (!Number.isNaN(d.getTime())) return d
  const d2 = new Date(raw)
  return Number.isNaN(d2.getTime()) ? null : d2
}

export async function ensureWhatsAppChatSchema() {
  if (schemaReady) return
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_threads (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      phone_key VARCHAR(10) NOT NULL,
      customer_user_id CHAR(36) NULL,
      customer_name VARCHAR(180) NOT NULL DEFAULT '',
      assigned_user_id CHAR(36) NULL,
      assigned_user_name VARCHAR(120) NULL,
      unread_count INT NOT NULL DEFAULT 0,
      last_read_at DATETIME(3) NULL,
      last_message_at DATETIME(3) NULL,
      last_message_preview VARCHAR(500) NULL,
      last_message_status VARCHAR(20) NULL,
      last_direction VARCHAR(10) NOT NULL DEFAULT 'out',
      token_fingerprint VARCHAR(80) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_wa_chat_phone_token (shop_app_id, phone_key, token_fingerprint),
      KEY idx_wa_chat_shop_updated (shop_app_id, last_message_at),
      KEY idx_wa_chat_shop_unread (shop_app_id, unread_count),
      KEY idx_wa_chat_assigned (shop_app_id, assigned_user_id),
      KEY idx_wa_chat_token (shop_app_id, token_fingerprint)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  try {
    await p.query(
      `ALTER TABLE whatsapp_chat_threads ADD COLUMN token_fingerprint VARCHAR(80) NULL AFTER last_direction`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/Duplicate column/i.test(msg)) {
      console.warn('[MySQL] whatsapp chat fingerprint migrate skipped:', msg)
    }
  }
  // Scope threads per connected token (shop + phone alone re-tagged old inbox history).
  try {
    await p.query(`ALTER TABLE whatsapp_chat_threads DROP INDEX uq_wa_chat_phone`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/check that it exists|Can't DROP|Unknown key/i.test(msg)) {
      console.warn('[MySQL] drop uq_wa_chat_phone skipped:', msg)
    }
  }
  try {
    await p.query(
      `DELETE FROM whatsapp_chat_threads WHERE token_fingerprint IS NULL OR token_fingerprint = ''`,
    )
  } catch (err) {
    console.warn(
      '[MySQL] clear unscoped chat threads skipped:',
      err instanceof Error ? err.message : err,
    )
  }
  try {
    await p.query(
      `ALTER TABLE whatsapp_chat_threads
       MODIFY COLUMN token_fingerprint VARCHAR(80) NOT NULL DEFAULT ''`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/Unknown column/i.test(msg)) {
      console.warn('[MySQL] token_fingerprint NOT NULL migrate skipped:', msg)
    }
  }
  try {
    await p.query(
      `ALTER TABLE whatsapp_chat_threads
       ADD UNIQUE KEY uq_wa_chat_phone_token (shop_app_id, phone_key, token_fingerprint)`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/Duplicate/i.test(msg)) {
      console.warn('[MySQL] uq_wa_chat_phone_token migrate skipped:', msg)
    }
  }
  try {
    await p.query(
      `ALTER TABLE whatsapp_chat_threads ADD KEY idx_wa_chat_token (shop_app_id, token_fingerprint)`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/Duplicate/i.test(msg)) {
      console.warn('[MySQL] whatsapp chat token index migrate skipped:', msg)
    }
  }
  schemaReady = true
}

/** Stable id for the connected WhatsApp token pair (scopes inbox threads). */
export function chatTokenFingerprintFromConfig(row) {
  if (!row) return ''
  const source = String(row.token_source || 'customer').trim().toLowerCase() || 'customer'
  const user = row.user_api_key ? String(row.user_api_key).slice(-8) : ''
  const dev = row.api_key ? String(row.api_key).slice(-8) : ''
  if (!user && !dev) return ''
  return `${source}:${user}:${dev}`
}

export async function clearWhatsAppChatThreadsForShop(shopAppId, opts = {}) {
  await ensureWhatsAppChatSchema()
  if (opts.exceptFingerprint) {
    const keep = String(opts.exceptFingerprint)
    const [result] = await getPool().query(
      `DELETE FROM whatsapp_chat_threads
       WHERE shop_app_id = ?
         AND (token_fingerprint IS NULL OR token_fingerprint = '' OR token_fingerprint <> ?)`,
      [shopAppId, keep],
    )
    return Number(result?.affectedRows || 0)
  }
  const [result] = await getPool().query(
    `DELETE FROM whatsapp_chat_threads WHERE shop_app_id = ?`,
    [shopAppId],
  )
  return Number(result?.affectedRows || 0)
}

async function resolveShopTokenFingerprint(shopAppId) {
  const [rows] = await getPool().query(
    `SELECT token_source, api_key, user_api_key FROM shop_whatsapp_config WHERE shop_app_id = ? LIMIT 1`,
    [shopAppId],
  )
  return chatTokenFingerprintFromConfig(rows[0] || null)
}

/**
 * Upsert thread metadata after a message is logged.
 * @param {object} entry
 * @param {{ bumpUnread?: boolean, direction?: 'in'|'out', unreadCount?: number|null }} [opts]
 */
export async function touchWhatsAppChatThread(entry, opts = {}) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(entry.phone)
  if (key.length < 8) return null

  const now = toMysqlDate(entry.createdAt || new Date())
  const direction = opts.direction === 'in' ? 'in' : 'out'
  const bumpUnread = Boolean(opts.bumpUnread) || direction === 'in'
  const preview = previewText(entry.messageBody || entry.body, entry.templateName)
  const status = entry.status || (entry.ok === false ? 'failed' : 'sent')
  const phone = String(entry.phone || key).replace(/\D/g, '').slice(-15) || key
  const customerName = String(entry.customerName || '').trim().slice(0, 180)
  const customerId = entry.customerId || entry.customerUserId || null

  let fingerprint = entry.tokenFingerprint != null ? String(entry.tokenFingerprint).slice(0, 80) : ''
  if (!fingerprint) {
    fingerprint = (await resolveShopTokenFingerprint(entry.shopAppId)) || ''
  }
  // Never upsert unscoped rows — they bleed across token switches.
  if (!fingerprint) return null

  const [existing] = await getPool().query(
    `SELECT id, unread_count FROM whatsapp_chat_threads
     WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?
     LIMIT 1`,
    [entry.shopAppId, key, fingerprint],
  )

  if (existing[0]) {
    const nextUnread =
      opts.unreadCount != null
        ? Number(opts.unreadCount) || 0
        : bumpUnread
          ? Number(existing[0].unread_count || 0) + 1
          : Number(existing[0].unread_count || 0)
    await getPool().query(
      `UPDATE whatsapp_chat_threads SET
         phone = ?,
         customer_user_id = COALESCE(?, customer_user_id),
         customer_name = CASE WHEN ? <> '' THEN ? ELSE customer_name END,
         unread_count = ?,
         last_message_at = ?,
         last_message_preview = ?,
         last_message_status = ?,
         last_direction = ?,
         token_fingerprint = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        phone,
        customerId,
        customerName,
        customerName,
        nextUnread,
        now,
        preview,
        status,
        direction,
        fingerprint,
        now,
        existing[0].id,
      ],
    )
    return existing[0].id
  }

  const id = randomUUID()
  const initialUnread =
    opts.unreadCount != null ? Number(opts.unreadCount) || 0 : bumpUnread ? 1 : 0
  await getPool().query(
    `INSERT INTO whatsapp_chat_threads
      (id, shop_app_id, phone, phone_key, customer_user_id, customer_name,
       assigned_user_id, assigned_user_name, unread_count, last_read_at,
       last_message_at, last_message_preview, last_message_status, last_direction,
       token_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      entry.shopAppId,
      phone,
      key,
      customerId,
      customerName || key,
      initialUnread,
      now,
      preview,
      status,
      direction,
      fingerprint,
      now,
      now,
    ],
  )
  return id
}

async function seedThreadsFromLogs(shopAppId) {
  await ensureWhatsAppChatSchema()
  const [rows] = await getPool().query(
    `SELECT phone, MAX(customer_name) AS customer_name, MAX(customer_user_id) AS customer_user_id,
            COUNT(*) AS message_count, MAX(created_at) AS last_at,
            SUBSTRING_INDEX(GROUP_CONCAT(message_body ORDER BY created_at DESC SEPARATOR '\\n'), '\\n', 1) AS last_body,
            SUBSTRING_INDEX(GROUP_CONCAT(template_name ORDER BY created_at DESC SEPARATOR '\\n'), '\\n', 1) AS last_template,
            SUBSTRING_INDEX(GROUP_CONCAT(status ORDER BY created_at DESC SEPARATOR '\\n'), '\\n', 1) AS last_status
     FROM whatsapp_message_logs
     WHERE shop_app_id = ?
     GROUP BY phone
     ORDER BY last_at DESC
     LIMIT 200`,
    [shopAppId],
  )

  for (const row of rows) {
    const key = phoneKey(row.phone)
    if (!key) continue
    const [existing] = await getPool().query(
      `SELECT id FROM whatsapp_chat_threads WHERE shop_app_id = ? AND phone_key = ? LIMIT 1`,
      [shopAppId, key],
    )
    if (existing[0]) continue
    await touchWhatsAppChatThread(
      {
        shopAppId,
        phone: row.phone,
        customerId: row.customer_user_id,
        customerName: row.customer_name,
        messageBody: row.last_body,
        templateName: row.last_template,
        status: row.last_status,
        createdAt: row.last_at,
        ok: row.last_status !== 'failed',
      },
      { bumpUnread: false, direction: 'out' },
    )
  }
}

function mapThreadRow(row, counts = {}) {
  return {
    id: row.id,
    phone: row.phone,
    phoneKey: row.phone_key,
    customerName: row.customer_name || row.phone,
    customerId: row.customer_user_id || null,
    assignedUserId: row.assigned_user_id || null,
    assignedUserName: row.assigned_user_name || null,
    unreadCount: Number(row.unread_count || 0),
    lastReadAt: row.last_read_at ? new Date(row.last_read_at).toISOString() : null,
    lastAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
    lastPreview: row.last_message_preview || '',
    lastStatus: row.last_message_status || null,
    lastDirection: row.last_direction || 'out',
    tokenFingerprint: row.token_fingerprint || null,
    messageCount: Number(counts.message_count ?? 0),
    sentCount: Number(counts.sent_count ?? 0),
    failedCount: Number(counts.failed_count ?? 0),
    live: Boolean(row.live),
  }
}

export async function listWhatsAppChats(shopAppId, opts = {}) {
  await ensureWhatsAppChatSchema()
  // Do not seed from historical message logs — inbox must match the connected token only.

  const filter = String(opts.filter || 'all')
  const q = String(opts.q || '')
    .trim()
    .toLowerCase()
  const assignedTo = opts.assignedTo ? String(opts.assignedTo) : null
  const fingerprint = opts.tokenFingerprint ? String(opts.tokenFingerprint) : null

  let where = 'shop_app_id = ?'
  const params = [shopAppId]
  if (fingerprint) {
    where += ' AND token_fingerprint = ?'
    params.push(fingerprint)
  } else {
    // Without a connected token fingerprint, never surface leftover inbox rows.
    where += ` AND 1 = 0`
  }
  if (filter === 'unread') {
    where += ' AND unread_count > 0'
  } else if (filter === 'unassigned') {
    where += ' AND assigned_user_id IS NULL'
  } else if (filter === 'assigned' && assignedTo) {
    where += ' AND assigned_user_id = ?'
    params.push(assignedTo)
  } else if (filter === 'assigned') {
    where += ' AND assigned_user_id IS NOT NULL'
  }

  const [threads] = await getPool().query(
    `SELECT * FROM whatsapp_chat_threads
     WHERE ${where}
     ORDER BY COALESCE(last_message_at, updated_at) DESC
     LIMIT 200`,
    params,
  )

  const [logRows] = await getPool().query(
    `SELECT phone, status FROM whatsapp_message_logs WHERE shop_app_id = ?`,
    [shopAppId],
  )
  const countMap = new Map()
  for (const r of logRows) {
    const key = phoneKey(r.phone)
    if (!key) continue
    const cur = countMap.get(key) || { message_count: 0, sent_count: 0, failed_count: 0 }
    cur.message_count += 1
    if (r.status === 'sent') cur.sent_count += 1
    if (r.status === 'failed') cur.failed_count += 1
    countMap.set(key, cur)
  }

  let chats = threads.map((row) => mapThreadRow(row, countMap.get(row.phone_key) || {}))
  if (q) {
    chats = chats.filter((c) => {
      const hay = [c.customerName, c.phone, c.lastPreview, c.assignedUserName || '']
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }

  const unreadTotal = chats.reduce((n, c) => n + (c.unreadCount > 0 ? 1 : 0), 0)
  return { chats, unreadTotal, total: chats.length, tokenFingerprint: fingerprint }
}

export async function getWhatsAppChatThread(shopAppId, phone, opts = {}) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  let fingerprint =
    opts.tokenFingerprint != null ? String(opts.tokenFingerprint) : await resolveShopTokenFingerprint(shopAppId)
  if (!fingerprint) return null
  const [rows] = await getPool().query(
    `SELECT * FROM whatsapp_chat_threads
     WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?
     LIMIT 1`,
    [shopAppId, key, fingerprint],
  )
  if (!rows[0]) return null
  return mapThreadRow(rows[0])
}

export async function listWhatsAppChatMessages(shopAppId, phone, options = {}) {
  const digits = phoneKey(phone)

  if (!options.apiKey) {
    return {
      messages: [],
      source: 'none',
      liveError: 'Connect a OneChatting User Token under Chats to load history for this token.',
    }
  }

  try {
    // Pull history directly from OneChatting (paginated) — do not invent messages from local logs.
    const history = await getOneChattingChatHistory(options.apiKey, phone, {
      countryCode: options.countryCode || '91',
      lastId: 0,
      limit: 100,
      maxPages: Number(options.maxPages) || 8,
    })
    const liveMessages = history.messages.map((m) => ({
      id: `oc:${m.id}`,
      customerName: null,
      phone: digits,
      kind: m.isTemplate ? 'template' : m.mediaType || m.messageType || 'text',
      templateName: m.templateName || (m.isTemplate ? 'Template' : m.messageType || 'Message'),
      body: m.body,
      headerText: m.headerText || null,
      footerText: m.footerText || null,
      status: m.status || 'sent',
      error: null,
      direction: m.direction,
      sentByName: m.sentByName,
      createdAt: parseProviderDate(m.createdAt)?.toISOString() || new Date().toISOString(),
      mediaUrl: m.mediaUrl,
      mediaName: m.mediaName || null,
      mediaMime: m.mediaMime || null,
      mediaType: m.mediaType || null,
      provider: 'onechatting',
    }))

    // Only fill missing header media/body for rows OneChatting already marked as templates.
    await enrichMessagesWithTemplateContent(shopAppId, liveMessages.filter((m) => String(m.kind || '').includes('template')))

    // Recent failed local sends only (optimistic UX) — never historical OneBook logs.
    const recentCutoff = Date.now() - 15 * 60 * 1000
    const localRows = await listLocalChatMessages(shopAppId, digits)
    const liveBodies = new Set(
      liveMessages.map((m) => `${m.direction}|${m.body}|${m.createdAt.slice(0, 16)}`),
    )
    const extras = localRows.filter((m) => {
      if (String(m.status || '') !== 'failed') return false
      const at = new Date(m.createdAt).getTime()
      if (!Number.isFinite(at) || at < recentCutoff) return false
      const key = `${m.direction || 'out'}|${m.body}|${String(m.createdAt).slice(0, 16)}`
      return !liveBodies.has(key)
    })
    const merged = [...liveMessages, ...extras].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    return {
      messages: merged,
      source: 'onechatting',
      liveError: null,
      assigning: history.assigning || null,
    }
  } catch (err) {
    return {
      messages: [],
      source: 'none',
      liveError: err instanceof Error ? err.message : 'Could not load live history',
    }
  }
}

function isMediaPlaceholderBody(text) {
  return /^(?:\[)?(Image|Video|Audio|Document|Template|Message)(?:\])?$/i.test(
    String(text || '').trim(),
  )
}

function isGenericTemplateLabel(name) {
  return /^(Text|Image|Video|Audio|Document|Message|Template)$/i.test(String(name || '').trim())
}

function cleanChatBodyText(text) {
  return String(text || '')
    .replace(/\n?https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * OneChatting often returns document/invoice templates as bare image rows.
 * Reattach OneBook send logs (template name, body, header media) by time.
 */
async function enrichMessagesFromLocalLogs(shopAppId, digits, messages) {
  if (!messages.length) return
  const localRows = await listLocalChatMessages(shopAppId, digits)
  const locals = localRows.filter((row) => {
    if (String(row.status || '') === 'failed') return false
    if (isGenericTemplateLabel(row.templateName)) return false
    const kind = String(row.kind || '').toLowerCase()
    if (kind === 'chat_text') return false
    if (/^chat_(image|video|audio|document)$/i.test(kind)) return false
    return Boolean(row.templateName)
  })
  if (!locals.length) return

  const usedLocal = new Set()
  for (const message of messages) {
    if (message.direction && message.direction !== 'out') continue
    const body = String(message.body || '').trim()
    const name = String(message.templateName || '').trim()
    const needs =
      isMediaPlaceholderBody(body) ||
      isGenericTemplateLabel(name) ||
      !name ||
      (!message.mediaUrl && (message.mediaType === 'image' || message.mediaType === 'document'))
    if (!needs && message.mediaUrl && !isMediaPlaceholderBody(body) && !isGenericTemplateLabel(name)) {
      continue
    }

    const t = new Date(message.createdAt).getTime()
    if (!Number.isFinite(t)) continue

    let best = null
    let bestDelta = Infinity
    for (const local of locals) {
      if (usedLocal.has(local.id)) continue
      const lt = new Date(local.createdAt).getTime()
      if (!Number.isFinite(lt)) continue
      const delta = Math.abs(lt - t)
      if (delta > 2 * 60 * 60 * 1000) continue
      // Prefer same media URL when both have one
      let score = delta
      if (
        message.mediaUrl &&
        local.mediaUrl &&
        String(message.mediaUrl) === String(local.mediaUrl)
      ) {
        score = Math.min(score, 1000)
      }
      if (score < bestDelta) {
        best = local
        bestDelta = score
      }
    }
    if (!best) continue
    usedLocal.add(best.id)

    message.templateName = best.templateName
    message.kind = 'template'
    if (isMediaPlaceholderBody(body) && best.body && !isMediaPlaceholderBody(best.body)) {
      message.body = cleanChatBodyText(best.body) || best.body
    } else if (!body && best.body) {
      message.body = cleanChatBodyText(best.body) || best.body
    }
    if (!message.mediaUrl && best.mediaUrl) {
      message.mediaUrl = best.mediaUrl
    }
    if (best.mediaType) {
      // Document templates must stay documents even if OneChatting labeled them image
      if (best.mediaType === 'document' || message.mediaType == null) {
        message.mediaType = best.mediaType
      }
    }
    if (best.mediaName) message.mediaName = best.mediaName
  }
}

/**
 * Last resort for outbound bare Image rows (no real photo URL): use mapped
 * Document Share / Sales Invoice templates from WhatsApp → Mapping.
 */
async function enrichBareOutboundFromMappedDocuments(shopAppId, messages) {
  const bare = messages.filter((m) => {
    if (m.direction && m.direction !== 'out') return false
    if (m.templateName && !isGenericTemplateLabel(m.templateName) && String(m.kind || '').includes('template')) {
      return false
    }
    const body = String(m.body || '').trim()
    if (!isMediaPlaceholderBody(body) && !isGenericTemplateLabel(m.templateName)) return false
    // Real photo URLs stay as images
    if (m.mediaUrl && /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(String(m.mediaUrl))) return false
    return true
  })
  if (!bare.length) return

  let activityMap = {}
  try {
    const [rows] = await getPool().query(
      `SELECT activity_map FROM shop_whatsapp_config WHERE shop_app_id = ? LIMIT 1`,
      [shopAppId],
    )
    const raw = rows[0]?.activity_map
    activityMap = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw && typeof raw === 'object' ? raw : {}
  } catch {
    activityMap = {}
  }

  const bindingIds = []
  const attachmentByTemplateId = new Map()
  for (const key of ['sales_invoice', 'document_share']) {
    const binding = activityMap?.[key]
    const templateId =
      binding && typeof binding === 'object'
        ? binding.templateId || binding.template_id
        : binding
    if (templateId) {
      bindingIds.push(String(templateId))
      const url =
        binding && typeof binding === 'object'
          ? binding.attachmentUrl || binding.attachment_url || null
          : null
      const name =
        binding && typeof binding === 'object'
          ? binding.attachmentName || binding.attachment_name || null
          : null
      if (url) attachmentByTemplateId.set(String(templateId), { url, name })
    }
  }
  if (!bindingIds.length) return

  const [templates] = await getPool().query(
    `SELECT id, name, campaign_name, external_id, body_text, header_media_url, header_format,
            header_text, footer_text, activity
     FROM shop_whatsapp_templates
     WHERE shop_app_id = ? AND id IN (${bindingIds.map(() => '?').join(',')})`,
    [shopAppId, ...bindingIds],
  )
  if (!templates.length) return

  // Prefer sales_invoice over document_share when both exist
  const ordered = [...templates].sort((a, b) => {
    const rank = (row) =>
      String(row.activity || '').toLowerCase() === 'sales_invoice'
        ? 0
        : String(row.activity || '').toLowerCase() === 'document_share'
          ? 1
          : 2
    return rank(a) - rank(b)
  })

  for (const message of bare) {
    const hit = ordered[0]
    const fmt = String(hit.header_format || '').toUpperCase()
    const mappedAttach = attachmentByTemplateId.get(String(hit.id))
    message.kind = 'template'
    message.templateName = hit.name || hit.campaign_name || message.templateName
    if (isMediaPlaceholderBody(message.body) || !message.body) {
      message.body = cleanChatBodyText(hit.body_text) || String(hit.body_text || '').trim() || message.body
    }
    if (!message.headerText && hit.header_text) message.headerText = hit.header_text
    if (!message.footerText && hit.footer_text) message.footerText = hit.footer_text
    const mediaUrl = mappedAttach?.url || hit.header_media_url || message.mediaUrl
    if (mediaUrl) message.mediaUrl = mediaUrl
    if (mappedAttach?.name) message.mediaName = mappedAttach.name
    else if (!message.mediaName && (fmt === 'DOCUMENT' || /\.pdf(\?|$)/i.test(String(mediaUrl || '')))) {
      message.mediaName = 'Invoice.pdf'
    }
    message.mediaType =
      fmt === 'DOCUMENT' || /\.pdf(\?|$)/i.test(String(mediaUrl || ''))
        ? 'document'
        : fmt === 'VIDEO'
          ? 'video'
          : message.mediaType || 'document'
  }
}

async function enrichMessagesWithTemplateContent(shopAppId, messages) {
  const names = [
    ...new Set(
      messages
        .filter((m) => {
          const kind = String(m.kind || '').toLowerCase()
          const body = String(m.body || '').trim()
          const placeholder = isMediaPlaceholderBody(body)
          return (
            Boolean(m.templateName) &&
            !isGenericTemplateLabel(m.templateName) &&
            (kind.includes('template') || !m.mediaUrl || placeholder || !body || m.mediaType === 'image')
          )
        })
        .map((m) => String(m.templateName || '').trim())
        .filter(Boolean),
    ),
  ]
  if (names.length === 0) return
  const [rows] = await getPool().query(
    `SELECT name, campaign_name, external_id, body_text, header_media_url, header_format,
            header_text, footer_text
     FROM shop_whatsapp_templates
     WHERE shop_app_id = ?
       AND (
         name IN (${names.map(() => '?').join(',')})
         OR campaign_name IN (${names.map(() => '?').join(',')})
         OR external_id IN (${names.map(() => '?').join(',')})
       )`,
    [shopAppId, ...names, ...names, ...names],
  )
  const byKey = new Map()
  for (const row of rows) {
    const fmt = String(row.header_format || '').toUpperCase()
    const payload = {
      mediaUrl: row.header_media_url || null,
      mediaType:
        fmt === 'VIDEO' ? 'video' : fmt === 'DOCUMENT' ? 'document' : row.header_media_url ? 'image' : null,
      headerFormat: fmt || null,
      body: String(row.body_text || '').trim() || null,
      headerText: String(row.header_text || '').trim() || null,
      footerText: String(row.footer_text || '').trim() || null,
    }
    for (const key of [row.name, row.campaign_name, row.external_id]) {
      if (key) byKey.set(String(key), payload)
    }
  }
  for (const message of messages) {
    if (!message.templateName || isGenericTemplateLabel(message.templateName)) continue
    const hit = byKey.get(String(message.templateName))
    if (!hit) continue
    if (hit.mediaUrl && (!message.mediaUrl || hit.headerFormat === 'DOCUMENT')) {
      // Prefer mapped document header over a wrong bare image label
      if (!message.mediaUrl || hit.headerFormat === 'DOCUMENT') {
        message.mediaUrl = message.mediaUrl || hit.mediaUrl
      }
    }
    if (hit.mediaType === 'document') {
      message.mediaType = 'document'
      if (!message.mediaName) message.mediaName = 'Document.pdf'
    } else if (!message.mediaType && hit.mediaType) {
      message.mediaType = hit.mediaType
    }
    const body = String(message.body || '').trim()
    if ((!body || isMediaPlaceholderBody(body)) && hit.body) message.body = hit.body
    if (!message.headerText && hit.headerText) message.headerText = hit.headerText
    if (!message.footerText && hit.footerText) message.footerText = hit.footerText
    message.kind = 'template'
  }
}

async function listLocalChatMessages(shopAppId, digits) {
  const [rows] = await getPool().query(
    `SELECT m.*,
       (
         SELECT t.header_media_url
         FROM shop_whatsapp_templates t
         WHERE t.shop_app_id = m.shop_app_id
           AND (
             t.external_id = m.template_name
             OR t.name = m.template_name
             OR t.campaign_name = m.template_name
           )
           AND t.header_media_url IS NOT NULL
           AND t.header_media_url <> ''
         ORDER BY t.updated_at DESC
         LIMIT 1
       ) AS template_header_media_url,
       (
         SELECT t.header_format
         FROM shop_whatsapp_templates t
         WHERE t.shop_app_id = m.shop_app_id
           AND (
             t.external_id = m.template_name
             OR t.name = m.template_name
             OR t.campaign_name = m.template_name
           )
         ORDER BY t.updated_at DESC
         LIMIT 1
       ) AS template_header_format
     FROM whatsapp_message_logs m
     WHERE m.shop_app_id = ? AND m.phone LIKE ?
     ORDER BY m.created_at ASC
     LIMIT 200`,
    [shopAppId, `%${digits}`],
  )
  return rows.map((row) => {
    const kind = String(row.kind || '').toLowerCase()
    const body = String(row.message_body || '')
    const urlFromBody = (body.match(/https?:\/\/[^\s]+/i) || [])[0] || null
    const headerUrl = row.template_header_media_url || null
    const mediaUrl = urlFromBody || headerUrl || null
    let mediaType = null
    if (kind.includes('image')) mediaType = 'image'
    else if (kind.includes('video')) mediaType = 'video'
    else if (kind.includes('audio')) mediaType = 'audio'
    else if (kind.includes('document') || kind.includes('file')) mediaType = 'document'
    else if (headerUrl) {
      const fmt = String(row.template_header_format || '').toUpperCase()
      mediaType =
        fmt === 'VIDEO' ? 'video' : fmt === 'DOCUMENT' ? 'document' : fmt === 'IMAGE' ? 'image' : 'image'
    } else if (mediaUrl) {
      mediaType = /\.(pdf|docx?|xlsx?)(\?|$)/i.test(mediaUrl) ? 'document' : 'image'
    }
    return {
      id: row.id,
      customerName: row.customer_name,
      phone: row.phone,
      kind: row.kind,
      templateName: row.template_name,
      body: row.message_body,
      status: row.status,
      error: row.error_message,
      direction: 'out',
      sentByName: row.sent_by_name || null,
      createdAt: new Date(row.created_at).toISOString(),
      mediaUrl,
      mediaName: null,
      mediaMime: null,
      mediaType,
      provider: 'onebook',
    }
  })
}

export async function markWhatsAppChatRead(shopAppId, phone, options = {}) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  const fingerprint =
    options.tokenFingerprint != null
      ? String(options.tokenFingerprint)
      : await resolveShopTokenFingerprint(shopAppId)
  const now = new Date()
  if (fingerprint) {
    const [result] = await getPool().query(
      `UPDATE whatsapp_chat_threads
       SET unread_count = 0, last_read_at = ?, updated_at = ?
       WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?`,
      [now, now, shopAppId, key, fingerprint],
    )
    if (!result.affectedRows) {
      await touchWhatsAppChatThread(
        {
          shopAppId,
          phone: key,
          customerName: key,
          messageBody: '',
          status: 'sent',
          ok: true,
          tokenFingerprint: fingerprint,
        },
        { bumpUnread: false, unreadCount: 0 },
      )
      await getPool().query(
        `UPDATE whatsapp_chat_threads
         SET unread_count = 0, last_read_at = ?, updated_at = ?
         WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?`,
        [now, now, shopAppId, key, fingerprint],
      )
    }
  }

  let live = null
  if (options.apiKey) {
    try {
      live = await markOneChattingChatRead(options.apiKey, phone, options.countryCode || '91')
    } catch (err) {
      live = { ok: false, error: err instanceof Error ? err.message : 'mark-as-read failed' }
    }
  }
  return { thread: await getWhatsAppChatThread(shopAppId, key, { tokenFingerprint: fingerprint }), live }
}

export async function markWhatsAppChatUnread(shopAppId, phone, options = {}) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  const fingerprint =
    options.tokenFingerprint != null
      ? String(options.tokenFingerprint)
      : await resolveShopTokenFingerprint(shopAppId)
  const now = new Date()
  if (!fingerprint) return null
  const [rows] = await getPool().query(
    `SELECT id FROM whatsapp_chat_threads
     WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?
     LIMIT 1`,
    [shopAppId, key, fingerprint],
  )
  if (!rows[0]) {
    await touchWhatsAppChatThread(
      {
        shopAppId,
        phone: key,
        customerName: key,
        messageBody: '',
        status: 'sent',
        ok: true,
        tokenFingerprint: fingerprint,
      },
      { bumpUnread: false },
    )
  }
  await getPool().query(
    `UPDATE whatsapp_chat_threads
     SET unread_count = GREATEST(unread_count, 1), updated_at = ?
     WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?`,
    [now, shopAppId, key, fingerprint],
  )
  return getWhatsAppChatThread(shopAppId, key, { tokenFingerprint: fingerprint })
}

export async function assignWhatsAppChat(shopAppId, phone, assignee, options = {}) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  const fingerprint =
    options.tokenFingerprint != null
      ? String(options.tokenFingerprint)
      : await resolveShopTokenFingerprint(shopAppId)
  const now = new Date()
  const userId = assignee?.userId ? String(assignee.userId) : null
  const userName = userId ? String(assignee.userName || '').trim().slice(0, 120) || 'Staff' : null
  if (!fingerprint) return null

  const [rows] = await getPool().query(
    `SELECT id FROM whatsapp_chat_threads
     WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?
     LIMIT 1`,
    [shopAppId, key, fingerprint],
  )
  if (!rows[0]) {
    await touchWhatsAppChatThread(
      {
        shopAppId,
        phone: key,
        customerName: String(assignee?.customerName || key),
        customerId: assignee?.customerId || null,
        messageBody: '',
        status: 'sent',
        ok: true,
        tokenFingerprint: fingerprint,
      },
      { bumpUnread: false },
    )
  }

  await getPool().query(
    `UPDATE whatsapp_chat_threads
     SET assigned_user_id = ?, assigned_user_name = ?, updated_at = ?
     WHERE shop_app_id = ? AND phone_key = ? AND token_fingerprint = ?`,
    [userId, userName, now, shopAppId, key, fingerprint],
  )
  return getWhatsAppChatThread(shopAppId, key, { tokenFingerprint: fingerprint })
}

/**
 * Pull OneChatting chat-list into local threads (live inbox sync).
 */
export async function syncWhatsAppChatsFromProvider(shopAppId, apiKey, options = {}) {
  await ensureWhatsAppChatSchema()
  if (!apiKey) {
    return {
      ok: false,
      synced: 0,
      error:
        'Connect WhatsApp with a OneChatting User Token to sync live chats (Project Token cannot read inbox).',
    }
  }

  const fingerprint = options.tokenFingerprint ? String(options.tokenFingerprint).slice(0, 80) : ''
  if (!fingerprint) {
    return {
      ok: false,
      synced: 0,
      error: 'Missing token fingerprint — reconnect WhatsApp User Token under Chats.',
    }
  }
  let synced = 0
  let removed = 0
  let page = 1
  const limit = Math.min(100, Math.max(20, Number(options.limit) || 50))
  const maxPages = Math.min(20, Math.max(1, Number(options.maxPages) || 2))
  let lastError = null
  const seen = new Set()
  let exhausted = false

  while (page <= maxPages) {
    let listed
    try {
      listed = await listOneChattingChats(apiKey, {
        pageNo: page,
        limit,
        search: options.search || undefined,
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Chat sync failed'
      if (page === 1) {
        return {
          ok: false,
          synced: 0,
          error:
            String(lastError) +
            ' — Confirm the User Token from OneChatting → Developer Access.',
        }
      }
      break
    }

    const rows = listed.chats || []
    if (rows.length === 0) {
      exhausted = true
      break
    }

    const jobs = []
    for (const row of rows) {
      const key = phoneKey(row.phone10 || row.number)
      if (key.length < 8 || seen.has(key)) continue
      seen.add(key)
      const lastAt = parseProviderDate(row.lastAt) || new Date()
      jobs.push(
        touchWhatsAppChatThread(
          {
            shopAppId,
            phone: key,
            customerName: row.name || key,
            messageBody: row.lastMessage || '',
            templateName: '',
            status: row.lastStatus || 'sent',
            createdAt: lastAt,
            ok: true,
            tokenFingerprint: fingerprint || null,
          },
          {
            bumpUnread: false,
            direction: row.lastType === 'out' ? 'out' : 'in',
            unreadCount: row.unreadCount,
          },
        ).then(() => {
          synced += 1
        }),
      )
    }

    const batchSize = 25
    for (let i = 0; i < jobs.length; i += batchSize) {
      await Promise.all(jobs.slice(i, i + batchSize))
    }

    const hasMore = listed.pagination?.has_more === true
    if (!hasMore) {
      exhausted = true
      break
    }
    if (rows.length < limit) {
      exhausted = true
      break
    }
    page += 1
  }

  // Drop inbox rows that belong to a previous token (or were never tagged).
  if (fingerprint && options.prune !== false) {
    removed = await clearWhatsAppChatThreadsForShop(shopAppId, {
      exceptFingerprint: fingerprint,
    })
    // Only drop phones missing from a complete (non-search) sync — light/partial syncs
    // must not wipe chats that simply were not on the first pages.
    const canPruneUnseen =
      exhausted &&
      !options.search &&
      options.pruneUnseen !== false &&
      !lastError
    if (canPruneUnseen) {
      if (seen.size > 0) {
        const phones = [...seen]
        const [extra] = await getPool().query(
          `DELETE FROM whatsapp_chat_threads
           WHERE shop_app_id = ?
             AND token_fingerprint = ?
             AND phone_key NOT IN (${phones.map(() => '?').join(',')})`,
          [shopAppId, fingerprint, ...phones],
        )
        removed += Number(extra?.affectedRows || 0)
      } else {
        const [extra] = await getPool().query(
          `DELETE FROM whatsapp_chat_threads
           WHERE shop_app_id = ? AND token_fingerprint = ?`,
          [shopAppId, fingerprint],
        )
        removed += Number(extra?.affectedRows || 0)
      }
    }
  }

  return {
    ok: true,
    synced,
    removed,
    error: lastError,
    pages: page,
    exhausted,
    tokenFingerprint: fingerprint || null,
  }
}

export async function sendWhatsAppChatText(shopAppId, account, input) {
  const [rows] = await getPool().query(
    `SELECT api_key, user_api_key, country_code, connection_status, user_connection_status
     FROM shop_whatsapp_config WHERE shop_app_id = ? LIMIT 1`,
    [shopAppId],
  )
  const row = rows[0]
  const apiKey = row?.user_api_key || row?.api_key
  if (!apiKey) throw new Error('Connect WhatsApp first (Settings → WhatsApp API → Chats)')
  const countryCode = row?.country_code || '91'
  const phone = phoneKey(input.phone)
  if (phone.length !== 10) throw new Error('Enter a valid 10-digit mobile number')
  const text = String(input.message || '').trim()
  if (!text) throw new Error('Type a message')

  const customerName =
    String(input.customerName || input.userName || 'Customer').trim() || 'Customer'

  const result = await sendOneChattingTextMessage({
    token: apiKey,
    phone,
    message: text,
    countryCode,
  })

  const { insertWhatsAppMessageLog } = await import('./whatsappLogs.js')
  const logged = await insertWhatsAppMessageLog({
    shopAppId,
    customerId: input.customerId || null,
    customerName,
    phone,
    kind: 'chat_text',
    templateName: 'Text',
    messageBody: text,
    ok: true,
    error: null,
    providerMessageId: result.wamid || result.messageId,
    sentByUserId: account?.id || null,
    sentByName: account?.name || null,
  })

  return { ok: true, result, message: logged }
}

export async function sendWhatsAppChatMedia(shopAppId, account, input) {
  const [rows] = await getPool().query(
    `SELECT api_key, user_api_key, country_code
     FROM shop_whatsapp_config WHERE shop_app_id = ? LIMIT 1`,
    [shopAppId],
  )
  const row = rows[0]
  const apiKey = row?.user_api_key || row?.api_key
  if (!apiKey) throw new Error('Connect WhatsApp first (Settings → WhatsApp API → Chats)')
  const countryCode = row?.country_code || '91'
  const phone = phoneKey(input.phone)
  if (phone.length !== 10) throw new Error('Enter a valid 10-digit mobile number')
  const mediaUrl = String(input.mediaUrl || input.url || '').trim()
  if (!mediaUrl) throw new Error('Choose a media file')
  const mediaType = String(input.mediaType || input.type || 'image').toLowerCase()
  const caption = String(input.caption || input.message || '').trim()
  const fileName = String(input.fileName || input.attachmentName || '').trim() || null
  const customerName =
    String(input.customerName || input.userName || 'Customer').trim() || 'Customer'

  const { sendOneChattingMediaMessage } = await import('./onechatting.js')
  const result = await sendOneChattingMediaMessage({
    token: apiKey,
    phone,
    mediaUrl,
    mediaType,
    caption,
    fileName,
    countryCode,
  })

  const { insertWhatsAppMessageLog } = await import('./whatsappLogs.js')
  const logged = await insertWhatsAppMessageLog({
    shopAppId,
    customerId: input.customerId || null,
    customerName,
    phone,
    kind: `chat_${mediaType}`,
    templateName: mediaType,
    messageBody: caption || `[${mediaType}] ${fileName || mediaUrl}`,
    ok: true,
    error: null,
    providerMessageId: result.wamid || result.messageId,
    sentByUserId: account?.id || null,
    sentByName: account?.name || null,
  })

  await touchWhatsAppChatThread(
    {
      shopAppId,
      phone,
      customerId: input.customerId || null,
      customerName,
      messageBody: caption || `[${mediaType}]`,
      templateName: mediaType,
      status: result.status || 'sent',
      createdAt: new Date(),
      ok: true,
    },
    { bumpUnread: false, direction: 'out' },
  )

  return { ok: true, result, message: { ...logged, mediaUrl, kind: mediaType } }
}

export { toOneChattingNumber, oneChattingBaseUrl }
