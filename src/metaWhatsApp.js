/**
 * In-house Meta WhatsApp Cloud API SDK
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const DEFAULT_GRAPH = 'https://graph.facebook.com'
const DEFAULT_VERSION = 'v21.0'

export function metaGraphBase() {
  const version = (process.env.META_WA_API_VERSION || DEFAULT_VERSION).replace(/^\/+|\/+$/g, '')
  const host = (process.env.META_WA_GRAPH_URL || DEFAULT_GRAPH).replace(/\/$/, '')
  return `${host}/${version}`
}

export function toMetaDestination(phone10, countryCode = '91') {
  const local = String(phone10 || '').replace(/\D/g, '').slice(-10)
  const cc = String(countryCode || '91').replace(/\D/g, '') || '91'
  if (local.length !== 10) throw new Error('Enter a valid 10-digit mobile')
  return `${cc}${local}`
}

async function parseMetaResponse(res) {
  const raw = await res.text()
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    data = { raw }
  }
  if (!res.ok) {
    const err = data?.error
    const msg =
      (err && (err.message || err.error_user_msg)) ||
      data?.message ||
      (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : null) ||
      `Meta WhatsApp HTTP ${res.status}`
    const error = new Error(String(msg))
    error.code = err?.code
    error.type = err?.type
    throw error
  }
  return data
}

/**
 * Verify token + phone number ID against Graph API.
 */
export async function probeMetaWhatsApp({ accessToken, phoneNumberId }) {
  const token = String(accessToken || '').trim()
  const phoneId = String(phoneNumberId || '').trim()
  if (!token) return { ok: false, error: 'Access token is required' }
  if (!phoneId) return { ok: false, error: 'Phone number ID is required' }
  if (token.length < 20) return { ok: false, error: 'Access token looks too short' }

  try {
    const url = `${metaGraphBase()}/${encodeURIComponent(phoneId)}?fields=id,display_phone_number,verified_name,quality_rating`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await parseMetaResponse(res)
    return {
      ok: true,
      message: data.verified_name
        ? `Connected · ${data.verified_name}${data.display_phone_number ? ` (${data.display_phone_number})` : ''}`
        : 'Connected to Meta WhatsApp Cloud API',
      displayPhone: data.display_phone_number || null,
      verifiedName: data.verified_name || null,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not verify Meta credentials',
    }
  }
}

/**
 * Send an approved WhatsApp template via Meta Cloud API.
 */
export async function sendMetaTemplate({
  accessToken,
  phoneNumberId,
  to,
  templateName,
  languageCode = 'en',
  bodyParams = [],
}) {
  const token = String(accessToken || '').trim()
  const phoneId = String(phoneNumberId || '').trim()
  const dest = String(to || '').replace(/\D/g, '')
  const name = String(templateName || '').trim()
  if (!token) throw new Error('Meta access token is required')
  if (!phoneId) throw new Error('Phone number ID is required')
  if (!dest) throw new Error('Destination mobile is required')
  if (!name) throw new Error('Template name is required')

  const components = []
  if (Array.isArray(bodyParams) && bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({
        type: 'text',
        text: String(text ?? ''),
      })),
    })
  }

  const body = {
    messaging_product: 'whatsapp',
    to: dest,
    type: 'template',
    template: {
      name,
      language: { code: String(languageCode || 'en') },
      ...(components.length ? { components } : {}),
    },
  }

  const res = await fetch(`${metaGraphBase()}/${encodeURIComponent(phoneId)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await parseMetaResponse(res)
  const messageId = data?.messages?.[0]?.id || null
  return {
    ok: true,
    providerMessageId: messageId,
    raw: data,
  }
}
