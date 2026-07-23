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
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_wa_chat_phone (shop_app_id, phone_key),
      KEY idx_wa_chat_shop_updated (shop_app_id, last_message_at),
      KEY idx_wa_chat_shop_unread (shop_app_id, unread_count),
      KEY idx_wa_chat_assigned (shop_app_id, assigned_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  schemaReady = true
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

  const [existing] = await getPool().query(
    `SELECT id, unread_count FROM whatsapp_chat_threads WHERE shop_app_id = ? AND phone_key = ? LIMIT 1`,
    [entry.shopAppId, key],
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
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
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
    messageCount: Number(counts.message_count ?? 0),
    sentCount: Number(counts.sent_count ?? 0),
    failedCount: Number(counts.failed_count ?? 0),
    live: Boolean(row.live),
  }
}

export async function listWhatsAppChats(shopAppId, opts = {}) {
  await ensureWhatsAppChatSchema()
  await seedThreadsFromLogs(shopAppId)

  const filter = String(opts.filter || 'all')
  const q = String(opts.q || '')
    .trim()
    .toLowerCase()
  const assignedTo = opts.assignedTo ? String(opts.assignedTo) : null

  let where = 'shop_app_id = ?'
  const params = [shopAppId]
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
  return { chats, unreadTotal, total: chats.length }
}

export async function getWhatsAppChatThread(shopAppId, phone) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  const [rows] = await getPool().query(
    `SELECT * FROM whatsapp_chat_threads WHERE shop_app_id = ? AND phone_key = ? LIMIT 1`,
    [shopAppId, key],
  )
  if (!rows[0]) return null
  return mapThreadRow(rows[0])
}

export async function listWhatsAppChatMessages(shopAppId, phone, options = {}) {
  const digits = phoneKey(phone)
  const localRows = await listLocalChatMessages(shopAppId, digits)

  if (!options.apiKey) {
    return { messages: localRows, source: 'local', liveError: null }
  }

  try {
    const history = await getOneChattingChatHistory(options.apiKey, phone, {
      countryCode: options.countryCode || '91',
      lastId: 0,
      limit: 100,
    })
    const liveMessages = history.messages.map((m) => ({
      id: `oc:${m.id}`,
      customerName: null,
      phone: digits,
      kind: m.isTemplate ? 'template' : m.mediaType || m.messageType || 'text',
      templateName: m.templateName || (m.isTemplate ? 'Template' : m.messageType || 'Message'),
      body: m.body,
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

    await enrichMessagesWithTemplateMedia(shopAppId, liveMessages)

    // Prefer live history; append any local-only failed/outbound not present yet
    const liveBodies = new Set(liveMessages.map((m) => `${m.direction}|${m.body}|${m.createdAt.slice(0, 16)}`))
    const extras = localRows.filter((m) => {
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
      messages: localRows,
      source: 'local',
      liveError: err instanceof Error ? err.message : 'Could not load live history',
    }
  }
}

async function enrichMessagesWithTemplateMedia(shopAppId, messages) {
  const names = [
    ...new Set(
      messages
        .filter((m) => !m.mediaUrl && m.templateName)
        .map((m) => String(m.templateName || '').trim())
        .filter(Boolean),
    ),
  ]
  if (names.length === 0) return
  const [rows] = await getPool().query(
    `SELECT name, campaign_name, external_id, header_media_url, header_format
     FROM shop_whatsapp_templates
     WHERE shop_app_id = ?
       AND header_media_url IS NOT NULL
       AND header_media_url <> ''
       AND (
         name IN (${names.map(() => '?').join(',')})
         OR campaign_name IN (${names.map(() => '?').join(',')})
         OR external_id IN (${names.map(() => '?').join(',')})
       )`,
    [shopAppId, ...names, ...names, ...names],
  )
  const byKey = new Map()
  for (const row of rows) {
    const payload = {
      mediaUrl: row.header_media_url,
      mediaType:
        String(row.header_format || '').toUpperCase() === 'VIDEO'
          ? 'video'
          : String(row.header_format || '').toUpperCase() === 'DOCUMENT'
            ? 'document'
            : 'image',
    }
    for (const key of [row.name, row.campaign_name, row.external_id]) {
      if (key) byKey.set(String(key), payload)
    }
  }
  for (const message of messages) {
    if (message.mediaUrl || !message.templateName) continue
    const hit = byKey.get(String(message.templateName))
    if (!hit) continue
    message.mediaUrl = hit.mediaUrl
    message.mediaType = message.mediaType || hit.mediaType
    if (!String(message.kind || '').includes('template')) {
      message.kind = message.kind || 'template'
    }
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
  const now = new Date()
  const [result] = await getPool().query(
    `UPDATE whatsapp_chat_threads
     SET unread_count = 0, last_read_at = ?, updated_at = ?
     WHERE shop_app_id = ? AND phone_key = ?`,
    [now, now, shopAppId, key],
  )
  if (!result.affectedRows) {
    await touchWhatsAppChatThread(
      { shopAppId, phone: key, customerName: key, messageBody: '', status: 'sent', ok: true },
      { bumpUnread: false, unreadCount: 0 },
    )
    await getPool().query(
      `UPDATE whatsapp_chat_threads
       SET unread_count = 0, last_read_at = ?, updated_at = ?
       WHERE shop_app_id = ? AND phone_key = ?`,
      [now, now, shopAppId, key],
    )
  }

  let live = null
  if (options.apiKey) {
    try {
      live = await markOneChattingChatRead(options.apiKey, phone, options.countryCode || '91')
    } catch (err) {
      live = { ok: false, error: err instanceof Error ? err.message : 'mark-as-read failed' }
    }
  }
  return { thread: await getWhatsAppChatThread(shopAppId, key), live }
}

export async function markWhatsAppChatUnread(shopAppId, phone) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  const now = new Date()
  const [rows] = await getPool().query(
    `SELECT id FROM whatsapp_chat_threads WHERE shop_app_id = ? AND phone_key = ? LIMIT 1`,
    [shopAppId, key],
  )
  if (!rows[0]) {
    await touchWhatsAppChatThread(
      { shopAppId, phone: key, customerName: key, messageBody: '', status: 'sent', ok: true },
      { bumpUnread: false },
    )
  }
  await getPool().query(
    `UPDATE whatsapp_chat_threads
     SET unread_count = GREATEST(unread_count, 1), updated_at = ?
     WHERE shop_app_id = ? AND phone_key = ?`,
    [now, shopAppId, key],
  )
  return getWhatsAppChatThread(shopAppId, key)
}

export async function assignWhatsAppChat(shopAppId, phone, assignee) {
  await ensureWhatsAppChatSchema()
  const key = phoneKey(phone)
  const now = new Date()
  const userId = assignee?.userId ? String(assignee.userId) : null
  const userName = userId ? String(assignee.userName || '').trim().slice(0, 120) || 'Staff' : null

  const [rows] = await getPool().query(
    `SELECT id FROM whatsapp_chat_threads WHERE shop_app_id = ? AND phone_key = ? LIMIT 1`,
    [shopAppId, key],
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
      },
      { bumpUnread: false },
    )
  }

  await getPool().query(
    `UPDATE whatsapp_chat_threads
     SET assigned_user_id = ?, assigned_user_name = ?, updated_at = ?
     WHERE shop_app_id = ? AND phone_key = ?`,
    [userId, userName, now, shopAppId, key],
  )
  return getWhatsAppChatThread(shopAppId, key)
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

  let synced = 0
  let page = 1
  const limit = Math.min(100, Math.max(20, Number(options.limit) || 50))
  const maxPages = Math.min(10, Math.max(1, Number(options.maxPages) || 2))
  let lastError = null
  const seen = new Set()

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
    if (rows.length === 0) break

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

    // Upsert in parallel batches so sync does not crawl one-by-one
    const batchSize = 25
    for (let i = 0; i < jobs.length; i += batchSize) {
      await Promise.all(jobs.slice(i, i + batchSize))
    }

    const hasMore = listed.pagination?.has_more === true
    if (!hasMore && rows.length < limit) break
    page += 1
  }

  return {
    ok: true,
    synced,
    error: lastError,
    pages: page,
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
