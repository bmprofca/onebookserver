import { getPool } from './db.js'

/** Singleton row id for OneSAAS-CRM / OneBook platform WhatsApp tokens. */
const PLATFORM_ROW_ID = 1

let schemaReady = false
let cache = {
  loaded: false,
  developerToken: '',
  userToken: '',
  updatedAt: null,
}

function nowMysql() {
  return new Date().toISOString().slice(0, 23).replace('T', ' ')
}

function maskToken(value) {
  const raw = String(value || '')
  if (!raw) return ''
  return '••••' + raw.slice(-4)
}

export async function ensurePlatformWhatsAppSchema() {
  if (schemaReady) return
  const p = getPool()
  await p.query(`
    CREATE TABLE IF NOT EXISTS platform_whatsapp_tokens (
      id TINYINT NOT NULL PRIMARY KEY,
      developer_token VARCHAR(500) NULL,
      user_token VARCHAR(500) NULL,
      updated_at DATETIME(3) NOT NULL,
      note VARCHAR(255) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  schemaReady = true
}

async function refreshCache() {
  await ensurePlatformWhatsAppSchema()
  const [rows] = await getPool().query(
    `SELECT developer_token, user_token, updated_at FROM platform_whatsapp_tokens WHERE id = ? LIMIT 1`,
    [PLATFORM_ROW_ID],
  )
  const row = rows[0]
  const dbDev = String(row?.developer_token || '').trim()
  const dbUser = String(row?.user_token || '').trim()
  cache = {
    loaded: true,
    developerToken:
      dbDev ||
      String(process.env.ONEBOOK_PLATFORM_DEVELOPER_TOKEN || '').trim() ||
      String(process.env.ONECHATTING_TOKEN || '').trim() ||
      '',
    userToken:
      dbUser ||
      String(process.env.ONEBOOK_PLATFORM_USER_TOKEN || '').trim() ||
      '',
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
  return cache
}

export async function getPlatformWhatsAppTokens({ force = false } = {}) {
  if (!cache.loaded || force) await refreshCache()
  return {
    developerToken: cache.developerToken,
    userToken: cache.userToken,
    developerTokenSet: Boolean(cache.developerToken),
    userTokenSet: Boolean(cache.userToken),
    developerTokenMasked: maskToken(cache.developerToken),
    userTokenMasked: maskToken(cache.userToken),
    ready: Boolean(cache.developerToken && cache.userToken),
    updatedAt: cache.updatedAt,
    source: 'database',
  }
}

/** Sync helpers for mapConfig after cache is warm. */
export function peekPlatformWhatsAppTokens() {
  return {
    developerToken: cache.developerToken,
    userToken: cache.userToken,
    ready: Boolean(cache.developerToken && cache.userToken),
    loaded: cache.loaded,
  }
}

/**
 * Upsert OneSAAS-CRM platform tokens (admin portal will call this later).
 * Pass undefined to keep an existing value; pass '' / null to clear.
 */
export async function savePlatformWhatsAppTokens(input = {}) {
  await ensurePlatformWhatsAppSchema()
  const existing = await getPlatformWhatsAppTokens({ force: true })
  const nextDev =
    input.developerToken === undefined
      ? existing.developerToken
      : String(input.developerToken ?? '').trim()
  const nextUser =
    input.userToken === undefined ? existing.userToken : String(input.userToken ?? '').trim()
  const note =
    input.note === undefined
      ? 'OneSAAS-CRM platform tokens'
      : String(input.note || '').trim().slice(0, 255) || null
  const now = nowMysql()

  await getPool().query(
    `INSERT INTO platform_whatsapp_tokens (id, developer_token, user_token, updated_at, note)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       developer_token = VALUES(developer_token),
       user_token = VALUES(user_token),
       updated_at = VALUES(updated_at),
       note = VALUES(note)`,
    [PLATFORM_ROW_ID, nextDev || null, nextUser || null, now, note],
  )

  await refreshCache()
  return getPlatformWhatsAppTokens()
}

export async function platformTokensReady() {
  const tokens = await getPlatformWhatsAppTokens()
  return tokens.ready
}
