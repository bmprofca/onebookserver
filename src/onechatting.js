/**
 * OneChatting WhatsApp (Meta Cloud API via BSP)
 * Docs: https://docs.onechatting.com/ (Send Template)
 */

const DEFAULT_BASE_URL = 'https://server.onechatting.com'
const DEFAULT_COUNTRY_CODE = '91'

export function isWhatsAppOtpConfigured() {
  return Boolean(
    process.env.ONECHATTING_TOKEN?.trim() && process.env.ONECHATTING_OTP_TEMPLATE_ID?.trim(),
  )
}

export function isPaymentReminderWhatsAppConfigured() {
  return Boolean(
    process.env.ONECHATTING_TOKEN?.trim() &&
      process.env.ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID?.trim(),
  )
}

/** E.164-style digits without +: country code + 10-digit Indian mobile */
export function toWhatsAppNumber(phone10, countryCode = DEFAULT_COUNTRY_CODE) {
  const local = phone10.replace(/\D/g, '').slice(-10)
  const cc = (process.env.ONECHATTING_COUNTRY_CODE || countryCode).replace(/\D/g, '')
  return `${cc}${local}`
}

async function listApprovedTemplates(baseUrl, token, category) {
  const query = new URLSearchParams({
    category,
    status: 'APPROVED',
    page_no: '1',
    limit: '100',
  })
  const res = await fetch(`${baseUrl}/developer/template/template-list?${query}`, {
    headers: { token },
  })
  const raw = await res.text()
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Could not read OneChatting template list (HTTP ${res.status})`)
  }
  if (!res.ok || data.error === true || typeof data.error === 'string') {
    throw new Error(
      data.message ||
        (typeof data.error === 'string' ? data.error : `OneChatting HTTP ${res.status}`),
    )
  }
  return data.data ?? []
}

async function resolveTemplate(baseUrl, token, templateRef, categories) {
  for (const category of categories) {
    const templates = await listApprovedTemplates(baseUrl, token, category)
    const match = templates.find(
      (template) =>
        template.template_id === templateRef ||
        (template.template_name === templateRef && template.status === 'APPROVED'),
    )
    if (match?.template_id) return match
  }
  throw new Error(
    `Approved WhatsApp template "${templateRef}" was not found in OneChatting (${categories.join(', ')})`,
  )
}

function headerImageFromTemplate(templateRow) {
  const components = templateRow?.template?.components
  if (!Array.isArray(components)) return null
  const header = components.find((c) => String(c.type || '').toUpperCase() === 'HEADER')
  if (!header || String(header.format || '').toUpperCase() !== 'IMAGE') return null
  const handle = header.example?.header_handle
  if (Array.isArray(handle) && handle[0]) return String(handle[0])
  if (typeof handle === 'string' && handle) return handle
  return null
}

/**
 * @param {string} phone10
 * @param {string} templateRef
 * @param {string[]} bodyTexts
 * @param {string[]} categories
 * @param {{ headerImageUrl?: string | null }} [options]
 */
async function sendTemplateMessage(phone10, templateRef, bodyTexts, categories, options = {}) {
  const token = process.env.ONECHATTING_TOKEN?.trim()
  const baseUrl = (process.env.ONECHATTING_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
  if (!token || !templateRef) {
    return {
      ok: false,
      error: 'WhatsApp template is not configured (ONECHATTING_TOKEN / template id)',
    }
  }

  const digits = phone10.replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) {
    return { ok: false, error: 'Customer mobile must be a 10-digit Indian number' }
  }

  const number = toWhatsAppNumber(digits)
  const url = `${baseUrl}/developer/message/send-template`

  try {
    const templateRow = await resolveTemplate(baseUrl, token, templateRef, categories)
    const templateId = templateRow.template_id
    const headerImageUrl =
      options.headerImageUrl ||
      process.env.ONECHATTING_PAYMENT_REMINDER_HEADER_IMAGE?.trim() ||
      headerImageFromTemplate(templateRow)

    const component = []
    if (headerImageUrl) {
      component.push({
        type: 'header',
        parameters: [
          {
            type: 'image',
            image: { link: headerImageUrl },
          },
        ],
      })
    }
    if (bodyTexts.length > 0) {
      component.push({
        type: 'body',
        parameters: bodyTexts.map((text) => ({ type: 'text', text: String(text) })),
      })
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        token,
      },
      body: JSON.stringify({
        number,
        template_id: templateId,
        component,
      }),
    })

    const raw = await res.text()
    let data = {}
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      data = { message: raw }
    }

    if (!res.ok || data.error === true) {
      const message =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'string'
            ? data.error
            : `OneChatting HTTP ${res.status}`
      console.error(`[OneChatting] template send failed → ${number}:`, message, raw.slice(0, 400))
      return { ok: false, error: message }
    }

    console.log(
      `[OneChatting] template sent → ${number}`,
      data.message_id ?? data.wamid ?? data.status ?? 'ok',
    )
    return {
      ok: true,
      messageId: typeof data.message_id === 'string' ? data.message_id : undefined,
      wamid: typeof data.wamid === 'string' ? data.wamid : undefined,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error calling OneChatting'
    console.error(`[OneChatting] template send exception → ${number}:`, message)
    return { ok: false, error: message }
  }
}

/**
 * Send an AUTHENTICATION OTP template via OneChatting.
 */
export async function sendWhatsAppOtp(phone10, otpCode) {
  const templateRef = process.env.ONECHATTING_OTP_TEMPLATE_ID?.trim()
  if (!templateRef) {
    return {
      ok: false,
      error: 'WhatsApp OTP is not configured (ONECHATTING_TOKEN / ONECHATTING_OTP_TEMPLATE_ID)',
    }
  }
  if (!/^\d{4,8}$/.test(otpCode)) {
    return { ok: false, error: 'OTP must be 4–8 digits for WhatsApp AUTHENTICATION templates' }
  }
  return sendTemplateMessage(phone10, templateRef, [otpCode], ['AUTHENTICATION'])
}

/** Amount for "Rs. {{2}}" — Indian grouping, no currency symbol. */
function formatAmountPlain(amount) {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(Math.abs(amount))
}

/**
 * Send UTILITY template `payment_reminder`:
 *
 * Dear *{{1}}*,
 * Kindly clear your due of *Rs. {{2}}* to *{{3}}* as soon as possible.
 * Thanks and Regards
 * Team *{{4}}* your Compliance Partner
 *
 * Params (ONECHATTING_PAYMENT_REMINDER_PARAMS): name,amount,shop,team
 */
export async function sendPaymentReminderWhatsApp(payload) {
  const templateRef =
    process.env.ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID?.trim() || 'payment_reminder'
  const shop = payload.shopName.trim() || 'Shop'
  const team =
    process.env.ONECHATTING_PAYMENT_REMINDER_TEAM?.trim() || shop
  const values = {
    name: payload.customerName.trim() || 'Customer',
    shop,
    team,
    amount: formatAmountPlain(payload.balance),
    direction:
      payload.balance > 0 ? 'payable by you' : payload.balance < 0 ? 'payable to you' : 'settled',
  }
  const order = (
    process.env.ONECHATTING_PAYMENT_REMINDER_PARAMS || 'name,amount,shop,team'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const bodyTexts = order.map((key) => values[key] ?? '')
  return sendTemplateMessage(payload.phone, templateRef, bodyTexts, ['UTILITY', 'MARKETING'], {
    headerImageUrl: process.env.ONECHATTING_PAYMENT_REMINDER_HEADER_IMAGE?.trim() || null,
  })
}
