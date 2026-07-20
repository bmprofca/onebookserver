/**
 * Fast2SMS client
 * Docs:
 * - Authorization: https://docs.fast2sms.com/reference/authorization
 * - DLT template SMS: https://docs.fast2sms.com/reference/dlt-sms
 * - Send OTP: https://docs.fast2sms.com/reference/send-otp
 *
 * Structured so DLT template sends can be reused for transactional SMS later.
 */

const DEFAULT_BASE_URL = 'https://www.fast2sms.com'

export type Fast2SmsResult =
  | { ok: true; requestId?: string; message?: string }
  | { ok: false; error: string }

export type DltTemplateSmsInput = {
  /** 10-digit numbers, or comma-separated list */
  numbers: string | string[]
  /** DLT Message / Content Template ID from Fast2SMS DLT Manager */
  messageId: string
  /** Values for {#var#} placeholders, joined with "|" */
  variables?: string | string[]
  /** 3–6 letter DLT-approved sender ID */
  senderId?: string
  scheduleTime?: string
  smsDetails?: boolean
  udf1?: string
  udf2?: string
  udf3?: string
}

function apiKey(): string | undefined {
  return process.env.FAST2SMS_API_KEY?.trim()
}

function baseUrl(): string {
  return (process.env.FAST2SMS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
}

function defaultSenderId(): string | undefined {
  return (
    process.env.FAST2SMS_SENDER_ID?.trim() ||
    process.env.FAST2SMS_DEFAULT_SENDER_ID?.trim()
  )
}

export function isFast2SmsConfigured(): boolean {
  return Boolean(apiKey())
}

/** True when SMS OTP can be sent (API key + OTP template/otp_id). */
export function isSmsOtpConfigured(): boolean {
  return Boolean(
    apiKey() &&
      (process.env.FAST2SMS_OTP_ID?.trim() ||
        (defaultSenderId() && process.env.FAST2SMS_OTP_MESSAGE_ID?.trim())),
  )
}

function normalizeNumbers(numbers: string | string[]): string {
  const list = Array.isArray(numbers) ? numbers : numbers.split(',')
  return list
    .map((n) => n.replace(/\D/g, '').slice(-10))
    .filter((n) => /^\d{10}$/.test(n))
    .join(',')
}

function joinVariables(variables?: string | string[]): string | undefined {
  if (variables == null) return undefined
  if (Array.isArray(variables)) return variables.map(String).join('|')
  return variables
}

function parseFast2SmsResponse(
  res: Response,
  raw: string,
): Fast2SmsResult {
  let data: Record<string, unknown> = {}
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    data = { message: raw }
  }

  const messageValue = data.message
  const messageText = Array.isArray(messageValue)
    ? messageValue.map(String).join(', ')
    : typeof messageValue === 'string'
      ? messageValue
      : undefined

  const okFlag = data.return === true || data.return === 'true'
  if (!res.ok || data.return === false || data.return === 'false') {
    return {
      ok: false,
      error: messageText || `Fast2SMS HTTP ${res.status}`,
    }
  }

  // Some successful payloads omit `return`; treat 2xx + request_id as success.
  if (!okFlag && !data.request_id && res.status >= 400) {
    return { ok: false, error: messageText || `Fast2SMS HTTP ${res.status}` }
  }

  return {
    ok: true,
    requestId: typeof data.request_id === 'string' ? data.request_id : undefined,
    message: messageText,
  }
}

/**
 * Send a DLT-approved template SMS (route=dlt).
 * Use this for OTP and any future transactional/template messages.
 * POST https://www.fast2sms.com/dev/bulkV2
 * Header: Authorization: YOUR_API_KEY
 */
export async function sendDltTemplateSms(
  input: DltTemplateSmsInput,
): Promise<Fast2SmsResult> {
  const key = apiKey()
  if (!key) {
    return { ok: false, error: 'Fast2SMS is not configured (FAST2SMS_API_KEY)' }
  }

  const senderId = input.senderId?.trim() || defaultSenderId()
  if (!senderId) {
    return {
      ok: false,
      error: 'Fast2SMS sender ID missing (FAST2SMS_SENDER_ID)',
    }
  }

  const numbers = normalizeNumbers(input.numbers)
  if (!numbers) {
    return { ok: false, error: 'No valid 10-digit mobile numbers for SMS' }
  }

  const variables_values = joinVariables(input.variables)
  if (!variables_values) {
    return {
      ok: false,
      error: 'DLT template variables_values are required',
    }
  }

  const body: Record<string, string> = {
    route: 'dlt',
    sender_id: senderId,
    message: String(input.messageId),
    variables_values,
    numbers,
  }
  if (input.scheduleTime) body.schedule_time = input.scheduleTime
  if (input.smsDetails) body.sms_details = '1'
  if (input.udf1) body.udf1 = input.udf1
  if (input.udf2) body.udf2 = input.udf2
  if (input.udf3) body.udf3 = input.udf3

  try {
    const res = await fetch(`${baseUrl()}/dev/bulkV2`, {
      method: 'POST',
      headers: {
        Authorization: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const raw = await res.text()
    const result = parseFast2SmsResponse(res, raw)
    if (!result.ok) {
      console.error(`[Fast2SMS] DLT template failed → ${numbers}:`, result.error, raw.slice(0, 400))
      return result
    }
    console.log(`[Fast2SMS] DLT template sent → ${numbers}`, result.requestId ?? 'ok')
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error calling Fast2SMS'
    console.error(`[Fast2SMS] DLT template exception → ${numbers}:`, message)
    return { ok: false, error: message }
  }
}

/**
 * Send OTP SMS.
 * Prefers dedicated OTP API (/dev/otp/send) when FAST2SMS_OTP_ID is set.
 * Otherwise uses DLT template SMS with FAST2SMS_OTP_MESSAGE_ID.
 */
export async function sendSmsOtp(
  phone10: string,
  otpCode: string,
  options?: { purpose?: 'login' | 'register'; variables?: string[] },
): Promise<Fast2SmsResult> {
  const key = apiKey()
  if (!key) {
    return { ok: false, error: 'Fast2SMS is not configured (FAST2SMS_API_KEY)' }
  }

  const mobile = phone10.replace(/\D/g, '').slice(-10)
  if (!/^\d{10}$/.test(mobile)) {
    return { ok: false, error: 'Invalid 10-digit mobile for SMS OTP' }
  }
  if (!/^\d{4,10}$/.test(otpCode)) {
    return { ok: false, error: 'OTP must be 4–10 digits for SMS' }
  }

  const otpId = process.env.FAST2SMS_OTP_ID?.trim()
  if (otpId) {
    const expiryMinutes = Math.max(
      1,
      Math.min(10080, Number(process.env.FAST2SMS_OTP_EXPIRY_MINUTES || 5)),
    )
    try {
      const body: Record<string, unknown> = {
        mobile,
        otp_id: otpId,
        otp: otpCode,
        otp_length: otpCode.length,
        otp_expiry: expiryMinutes,
      }
      const variables = joinVariables(options?.variables)
      if (variables) body.variables_values = variables
      if (options?.purpose) body.udf1 = options.purpose

      const res = await fetch(`${baseUrl()}/dev/otp/send`, {
        method: 'POST',
        headers: {
          Authorization: key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const raw = await res.text()
      const result = parseFast2SmsResponse(res, raw)
      if (!result.ok) {
        console.error(`[Fast2SMS] OTP API failed → ${mobile}:`, result.error, raw.slice(0, 400))
        return result
      }
      console.log(`[Fast2SMS] OTP sent → ${mobile}`, result.requestId ?? 'ok')
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error calling Fast2SMS OTP'
      console.error(`[Fast2SMS] OTP API exception → ${mobile}:`, message)
      return { ok: false, error: message }
    }
  }

  const messageId = process.env.FAST2SMS_OTP_MESSAGE_ID?.trim()
  if (!messageId) {
    return {
      ok: false,
      error: 'Set FAST2SMS_OTP_ID or FAST2SMS_OTP_MESSAGE_ID for SMS OTP',
    }
  }

  // DLT OTP templates commonly use {#var#} for the code (and optionally more vars).
  const variables = options?.variables?.length ? options.variables : [otpCode]
  return sendDltTemplateSms({
    numbers: mobile,
    messageId,
    variables,
    udf1: options?.purpose,
  })
}
