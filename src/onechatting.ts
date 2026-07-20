/**
 * OneChatting WhatsApp (Meta Cloud API via BSP)
 * Docs: https://docs.onechatting.com/ (Send Template)
 */

const DEFAULT_BASE_URL = 'https://server.onechatting.com'
const DEFAULT_COUNTRY_CODE = '91'

type TemplateListItem = {
  template_id?: string
  template_name?: string
  category?: string
  status?: string
}

export type WhatsAppSendResult =
  | { ok: true; messageId?: string; wamid?: string }
  | { ok: false; error: string }

/** @deprecated alias */
export type WhatsAppOtpResult = WhatsAppSendResult

export function isWhatsAppOtpConfigured(): boolean {
  return Boolean(
    process.env.ONECHATTING_TOKEN?.trim() &&
      process.env.ONECHATTING_OTP_TEMPLATE_ID?.trim(),
  )
}

export function isPaymentReminderWhatsAppConfigured(): boolean {
  return Boolean(
    process.env.ONECHATTING_TOKEN?.trim() &&
      process.env.ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID?.trim(),
  )
}

/** E.164-style digits without +: country code + 10-digit Indian mobile */
export function toWhatsAppNumber(phone10: string, countryCode = DEFAULT_COUNTRY_CODE): string {
  const local = phone10.replace(/\D/g, '').slice(-10)
  const cc = (process.env.ONECHATTING_COUNTRY_CODE || countryCode).replace(/\D/g, '')
  return `${cc}${local}`
}

async function resolveTemplateId(
  baseUrl: string,
  token: string,
  templateRef: string,
  categories: string[],
): Promise<string> {
  for (const category of categories) {
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
    let data: { data?: TemplateListItem[]; error?: boolean | string; message?: string }
    try {
      data = JSON.parse(raw) as typeof data
    } catch {
      throw new Error(`Could not read OneChatting template list (HTTP ${res.status})`)
    }

    if (!res.ok || data.error === true || typeof data.error === 'string') {
      throw new Error(
        data.message ||
          (typeof data.error === 'string' ? data.error : `OneChatting HTTP ${res.status}`),
      )
    }

    const templates = data.data ?? []
    const match = templates.find(
      (template) =>
        template.template_id === templateRef ||
        (template.template_name === templateRef && template.status === 'APPROVED'),
    )
    if (match?.template_id) return match.template_id
  }

  throw new Error(
    `Approved WhatsApp template "${templateRef}" was not found in OneChatting (${categories.join(', ')})`,
  )
}

async function sendTemplateMessage(
  phone10: string,
  templateRef: string,
  bodyTexts: string[],
  categories: string[],
): Promise<WhatsAppSendResult> {
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
    const templateId = await resolveTemplateId(baseUrl, token, templateRef, categories)
    const component =
      bodyTexts.length > 0
        ? [
            {
              type: 'body',
              parameters: bodyTexts.map((text) => ({ type: 'text', text })),
            },
          ]
        : []

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
    let data: Record<string, unknown> = {}
    try {
      data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
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
 * POST /developer/message/send-template
 */
export async function sendWhatsAppOtp(
  phone10: string,
  otpCode: string,
): Promise<WhatsAppSendResult> {
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

function formatInr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Math.abs(amount))
}

export type PaymentReminderPayload = {
  phone: string
  customerName: string
  shopName: string
  balance: number
}

/**
 * Send a UTILITY payment-reminder template via Meta WhatsApp (OneChatting).
 *
 * Template body variables (order configurable via ONECHATTING_PAYMENT_REMINDER_PARAMS):
 * - name → customer name
 * - shop → shop name
 * - amount → absolute balance as INR
 * - direction → "payable by you" | "payable to you"
 *
 * Default order: name,shop,amount
 */
export async function sendPaymentReminderWhatsApp(
  payload: PaymentReminderPayload,
): Promise<WhatsAppSendResult> {
  const templateRef = process.env.ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID?.trim()
  if (!templateRef) {
    return {
      ok: false,
      error:
        'Payment reminder WhatsApp template is not configured (ONECHATTING_PAYMENT_REMINDER_TEMPLATE_ID)',
    }
  }

  const amount = formatInr(payload.balance)
  const direction =
    payload.balance > 0 ? 'payable by you' : payload.balance < 0 ? 'payable to you' : 'settled'
  const values: Record<string, string> = {
    name: payload.customerName.trim() || 'Customer',
    shop: payload.shopName.trim() || 'Shop',
    amount,
    direction,
  }

  const order = (
    process.env.ONECHATTING_PAYMENT_REMINDER_PARAMS || 'name,shop,amount'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  const bodyTexts = order.map((key) => values[key] ?? '')
  return sendTemplateMessage(payload.phone, templateRef, bodyTexts, [
    'UTILITY',
    'MARKETING',
    'AUTHENTICATION',
  ])
}
