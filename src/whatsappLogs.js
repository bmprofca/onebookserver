import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'
import { touchWhatsAppChatThread } from './whatsappChats.js'

/** Estimated INR cost per successful utility template (override via env). */
export function whatsappMessageUnitCost() {
  const n = Number(process.env.WHATSAPP_MESSAGE_COST_INR ?? 0.75)
  return Number.isFinite(n) && n >= 0 ? n : 0.75
}

/**
 * @param {object} entry
 * @param {string} entry.shopAppId
 * @param {string|null} [entry.customerId]
 * @param {string} entry.customerName
 * @param {string} entry.phone
 * @param {string} entry.kind
 * @param {string} entry.templateName
 * @param {string} entry.messageBody
 * @param {boolean} entry.ok
 * @param {string|null} [entry.error]
 * @param {string|null} [entry.providerMessageId]
 * @param {string|null} [entry.sentByUserId]
 * @param {string|null} [entry.sentByName]
 */
export async function insertWhatsAppMessageLog(entry) {
  const id = randomUUID()
  const cost = entry.ok ? whatsappMessageUnitCost() : 0
  const createdAt = new Date()
  await getPool().query(
    `INSERT INTO whatsapp_message_logs
      (id, shop_app_id, customer_user_id, customer_name, phone,
       kind, template_name, message_body, status, error_message,
       provider_message_id, cost_inr, sent_by_user_id, sent_by_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      entry.shopAppId,
      entry.customerId ?? null,
      entry.customerName,
      entry.phone,
      entry.kind,
      entry.templateName,
      entry.messageBody,
      entry.ok ? 'sent' : 'failed',
      entry.error ?? null,
      entry.providerMessageId ?? null,
      cost,
      entry.sentByUserId ?? null,
      entry.sentByName ?? null,
      createdAt,
    ],
  )
  const logged = {
    id,
    shopAppId: entry.shopAppId,
    customerId: entry.customerId ?? null,
    customerName: entry.customerName,
    phone: entry.phone,
    kind: entry.kind,
    templateName: entry.templateName,
    messageBody: entry.messageBody,
    status: entry.ok ? 'sent' : 'failed',
    error: entry.error ?? null,
    providerMessageId: entry.providerMessageId ?? null,
    costInr: cost,
    sentByUserId: entry.sentByUserId ?? null,
    sentByName: entry.sentByName ?? null,
    createdAt: createdAt.toISOString(),
  }
  try {
    await touchWhatsAppChatThread(
      {
        shopAppId: logged.shopAppId,
        phone: logged.phone,
        customerId: logged.customerId,
        customerName: logged.customerName,
        messageBody: logged.messageBody,
        templateName: logged.templateName,
        status: logged.status,
        createdAt: logged.createdAt,
        ok: entry.ok,
      },
      {
        bumpUnread: entry.bumpUnread === true,
        direction: entry.direction === 'in' ? 'in' : 'out',
      },
    )
  } catch (err) {
    console.warn('[WhatsApp] chat thread touch skipped:', err instanceof Error ? err.message : err)
  }
  return logged
}

/**
 * @param {string} shopAppId
 * @param {{ from?: Date, to?: Date, limit?: number }} [opts]
 */
export async function listWhatsAppMessageLogs(shopAppId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000)
  const params = [shopAppId]
  let where = 'shop_app_id = ?'
  if (opts.from instanceof Date && !Number.isNaN(opts.from.getTime())) {
    where += ' AND created_at >= ?'
    params.push(opts.from)
  }
  if (opts.to instanceof Date && !Number.isNaN(opts.to.getTime())) {
    where += ' AND created_at <= ?'
    params.push(opts.to)
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
  return rows.map((row) => ({
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
    providerMessageId:
      row.provider_message_id == null ? null : String(row.provider_message_id),
    costInr: Number(row.cost_inr) || 0,
    sentByUserId: row.sent_by_user_id == null ? null : String(row.sent_by_user_id),
    sentByName: row.sent_by_name == null ? null : String(row.sent_by_name),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
  }))
}

export function summarizeWhatsAppLogs(logs) {
  const sent = logs.filter((l) => l.status === 'sent')
  const failed = logs.filter((l) => l.status === 'failed')
  const costInr = sent.reduce((sum, l) => sum + (Number(l.costInr) || 0), 0)
  const recipients = new Set(sent.map((l) => l.phone).filter(Boolean))
  return {
    total: logs.length,
    sent: sent.length,
    failed: failed.length,
    recipients: recipients.size,
    costInr: Math.round(costInr * 100) / 100,
    unitCostInr: whatsappMessageUnitCost(),
  }
}
