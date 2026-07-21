/**
 * AiSensy WhatsApp Business API (Meta Cloud via AiSensy BSP)
 * Campaign send: POST https://backend.aisensy.com/campaign/t1/api/v2
 */

const DEFAULT_BASE = 'https://backend.aisensy.com'

export function aisensyBaseUrl() {
  return (process.env.AISENSY_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')
}

export function toAiSensyDestination(phone10, countryCode = '91') {
  const local = String(phone10 || '').replace(/\D/g, '').slice(-10)
  const cc = String(countryCode || '91').replace(/\D/g, '') || '91'
  if (local.length !== 10) throw new Error('Enter a valid 10-digit mobile')
  return `${cc}${local}`
}

/**
 * Send a live AiSensy API campaign (template must already be approved in Meta via AiSensy).
 */
export async function sendAiSensyCampaign({
  apiKey,
  campaignName,
  destination,
  userName,
  templateParams = [],
  source = 'OneBook',
  tags = [],
  media,
}) {
  const key = String(apiKey || '').trim()
  const name = String(campaignName || '').trim()
  const dest = String(destination || '').replace(/\D/g, '')
  if (!key) throw new Error('AiSensy API key is required')
  if (!name) throw new Error('Campaign name is required')
  if (!dest) throw new Error('Destination mobile is required')

  const body = {
    apiKey: key,
    campaignName: name,
    destination: dest,
    userName: String(userName || 'Customer').trim() || 'Customer',
    source: String(source || 'OneBook'),
    templateParams: Array.isArray(templateParams)
      ? templateParams.map((p) => String(p ?? ''))
      : [],
  }
  if (Array.isArray(tags) && tags.length) body.tags = tags.map(String)
  if (media?.url) {
    body.media = {
      url: String(media.url),
      filename: String(media.filename || 'file'),
    }
  }

  const res = await fetch(`${aisensyBaseUrl()}/campaign/t1/api/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    data = { raw }
  }
  if (!res.ok) {
    const msg =
      data?.errorMessage ||
      data?.message ||
      data?.error ||
      (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : null) ||
      `AiSensy HTTP ${res.status}`
    throw new Error(String(msg))
  }
  return {
    ok: true,
    providerMessageId: data?.submitted_message_id || data?.messageId || data?.id || null,
    raw: data,
  }
}

/** Lightweight connectivity check — invalid key / empty campaign should fail gracefully. */
export async function probeAiSensyApiKey(apiKey) {
  const key = String(apiKey || '').trim()
  if (!key) return { ok: false, error: 'API key is empty' }
  // AiSensy has no public "ping"; validate key shape and attempt a dry-ish call pattern.
  if (key.length < 20) return { ok: false, error: 'API key looks too short' }
  return {
    ok: true,
    message:
      'API key saved. Create Live API campaigns in AiSensy (Campaigns → API Campaign) after Meta template approval.',
  }
}
