/**
 * OneChatting WhatsApp (Meta Cloud API via BSP)
 * Docs: https://docs.onechatting.com/ (Send Template)
 */

const DEFAULT_BASE_URL = 'https://server.onechatting.com'
const DEFAULT_COUNTRY_CODE = '91'

function networkErrorMessage(err) {
  const code = err?.cause?.code || err?.code || ''
  const msg = String(err?.cause?.message || err?.message || '')
  if (code === 'ECONNRESET' || /ECONNRESET/i.test(msg)) {
    return 'Connection to OneChatting was reset. Please try again.'
  }
  if (code === 'ETIMEDOUT' || /timeout|aborted/i.test(msg)) {
    return 'OneChatting timed out. Please try again.'
  }
  if (code === 'ECONNREFUSED' || /ENOTFOUND|getaddrinfo/i.test(msg)) {
    return 'Could not reach OneChatting. Check your internet connection.'
  }
  if (/fetch failed/i.test(msg)) {
    return 'Could not reach OneChatting. Please try again.'
  }
  return msg || 'Network error calling OneChatting'
}

async function fetchWithRetry(url, init = {}, { retries = 2, timeoutMs = 25000 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timer)
      return res
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      const detail = String(err?.cause?.code || err?.code || err?.message || '')
      const retryable = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR|aborted|network|fetch failed/i.test(
        detail,
      )
      if (!retryable || attempt === retries) {
        throw new Error(networkErrorMessage(err))
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  throw new Error(networkErrorMessage(lastErr))
}

export function oneChattingBaseUrl() {
  return (process.env.ONECHATTING_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
}

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

async function listApprovedTemplates(baseUrl, token, category, status = 'APPROVED') {
  const query = new URLSearchParams({
    category,
    status,
    page_no: '1',
    limit: '100',
  })
  const res = await fetchWithRetry(
    `${baseUrl}/developer/template/template-list?${query}`,
    {
      headers: { token },
    },
    { retries: 1, timeoutMs: 10000 },
  )
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

/** Soft template list — never throws (User Tokens often cannot list templates). */
async function tryListApprovedTemplates(baseUrl, token, category) {
  try {
    return await listApprovedTemplates(baseUrl, token, category)
  } catch {
    return null
  }
}

function extractTemplateComponents(row) {
  let template = row?.template
  if (typeof template === 'string') {
    try {
      template = JSON.parse(template)
    } catch {
      template = null
    }
  }
  const candidates = [
    template?.components,
    row?.components,
    row?.template_components,
    Array.isArray(template) ? template : null,
    row?.data?.template?.components,
  ]
  for (const value of candidates) {
    if (Array.isArray(value) && value.length) return value
  }
  return []
}

function extractTemplateBody(row) {
  const components = extractTemplateComponents(row)
  const body = components.find((c) => String(c.type || '').toUpperCase() === 'BODY')
  if (body?.text) return String(body.text)
  if (typeof body?.body === 'string') return body.body
  if (typeof row?.body === 'string' && row.body.trim()) return row.body
  if (typeof row?.body_text === 'string' && row.body_text.trim()) return row.body_text
  if (typeof row?.template?.body === 'string') return row.template.body
  return ''
}

function extractTemplateLanguage(row) {
  return (
    row?.language ||
    row?.template?.language ||
    row?.language_code ||
    row?.template_language ||
    'en'
  )
}

function extractTemplateMedia(row) {
  const components = extractTemplateComponents(row)
  const header = components.find((c) => String(c.type || '').toUpperCase() === 'HEADER')
  const footer = components.find((c) => String(c.type || '').toUpperCase() === 'FOOTER')
  const footerText = footer?.text ? String(footer.text) : null
  if (!header) {
    return { headerFormat: null, headerMediaUrl: null, headerText: null, footerText }
  }
  const headerFormat = String(
    header.format || header.header_format || (header.text ? 'TEXT' : '') || '',
  ).toUpperCase()
  let headerMediaUrl = null
  const handle =
    header.example?.header_handle ||
    header.example?.header_url ||
    header.header_handle ||
    header.media_url ||
    header.link
  if (Array.isArray(handle) && handle[0]) headerMediaUrl = String(handle[0])
  else if (typeof handle === 'string' && handle) headerMediaUrl = handle
  const headerText = header.text ? String(header.text) : null
  return {
    headerFormat: headerFormat || null,
    headerMediaUrl,
    headerText,
    footerText,
  }
}

function mapRemoteTemplate(row, categoryFallback = 'UTILITY') {
  const templateId = row.template_id || row.id
  const media = extractTemplateMedia(row)
  return {
    templateId: String(templateId),
    templateName: String(row.template_name || row.name || templateId),
    category: String(row.category || categoryFallback).toUpperCase(),
    language: String(extractTemplateLanguage(row)).slice(0, 20) || 'en',
    status: String(row.status || 'APPROVED').toUpperCase(),
    body: extractTemplateBody(row),
    headerFormat: media.headerFormat,
    headerMediaUrl: media.headerMediaUrl,
    headerText: media.headerText,
    footerText: media.footerText,
  }
}

async function fetchOneChattingTemplateDetails(baseUrl, token, templateId) {
  if (!templateId) return null
  const query = new URLSearchParams({ template_id: String(templateId) })
  const { res, data } = await fetchJson(
    `${baseUrl}/developer/template/template-details?${query}`,
    token,
  )
  if (!res.ok || data.error === true || typeof data.error === 'string') return null
  // Docs put metadata in data and expanded components (with signed B2 URLs) in template.
  return {
    ...(data.data && typeof data.data === 'object' ? data.data : {}),
    template: data.template || data.data?.template || data.data,
    components: data.components || data.template?.components || data.data?.components,
  }
}

/**
 * List OneChatting templates for a token (Meta-backed via BSP).
 * Always hydrates each row via template-details so body + media headers are complete.
 * Docs: https://docs.onechatting.com/ — Templates API / template-list + template-details
 */
export async function listOneChattingTemplates(token, options = {}) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  const baseUrl = oneChattingBaseUrl()
  const categories = options.categories || ['UTILITY', 'MARKETING', 'AUTHENTICATION']
  const status = options.status || 'APPROVED'
  const byId = new Map()
  for (const category of categories) {
    const rows = await listApprovedTemplates(baseUrl, key, category, status)
    for (const row of rows) {
      const templateId = row.template_id || row.id
      if (!templateId) continue
      const id = String(templateId)
      if (byId.has(id)) continue
      byId.set(id, mapRemoteTemplate(row, category))
    }
  }

  for (const item of byId.values()) {
    try {
      const detail = await fetchOneChattingTemplateDetails(baseUrl, key, item.templateId)
      if (!detail) continue
      const hydrated = mapRemoteTemplate(
        {
          ...detail,
          template_id: item.templateId,
          template_name: detail.template_name || item.templateName,
          category: detail.category || item.category,
          status: detail.status || item.status,
          language_code: detail.language_code || item.language,
        },
        item.category,
      )
      if (hydrated.body) item.body = hydrated.body
      if (hydrated.headerFormat) item.headerFormat = hydrated.headerFormat
      if (hydrated.headerMediaUrl) item.headerMediaUrl = hydrated.headerMediaUrl
      if (hydrated.headerText) item.headerText = hydrated.headerText
      if (hydrated.footerText) item.footerText = hydrated.footerText
      if (hydrated.language) item.language = hydrated.language
      if (hydrated.category) item.category = hydrated.category
    } catch {
      /* keep list data */
    }
  }

  return [...byId.values()].sort((a, b) => a.templateName.localeCompare(b.templateName))
}

/** Fetch one template’s full details (body + signed media) from OneChatting. */
export async function getOneChattingTemplateDetails(token, templateId) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  if (!templateId) throw new Error('Template id is required')
  const detail = await fetchOneChattingTemplateDetails(oneChattingBaseUrl(), key, templateId)
  if (!detail) throw new Error('Could not load template details from OneChatting')
  return mapRemoteTemplate({
    ...detail,
    template_id: templateId,
    template_name: detail.template_name || templateId,
  })
}

function pickFirstString(...values) {
  for (const value of values) {
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return null
}

function extractWabaHint(row) {
  return pickFirstString(
    row?.waba_id,
    row?.wabaId,
    row?.whatsapp_business_account_id,
    row?.waba_account_id,
    typeof row?.waba_template_id === 'string' && row.waba_template_id.includes('_')
      ? row.waba_template_id.split('_')[0]
      : null,
  )
}

export async function fetchJson(url, token) {
  const res = await fetchWithRetry(url, { headers: { token } })
  const raw = await res.text()
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { message: raw }
  }
  return { res, data }
}

async function enrichFromTemplateDetails(baseUrl, token, templateId) {
  if (!templateId) return {}
  try {
    const query = new URLSearchParams({ template_id: String(templateId) })
    const { res, data } = await fetchJson(
      `${baseUrl}/developer/template/template-details?${query}`,
      token,
    )
    if (!res.ok || data.error === true || typeof data.error === 'string') return {}
    const row = data.data || data
    return {
      projectId: pickFirstString(row.project_id, row.projectId),
      wabaId: extractWabaHint(row),
      displayPhone: pickFirstString(
        row.display_phone_number,
        row.phone_number,
        row.business_phone,
        row.sender_number,
      ),
    }
  } catch {
    return {}
  }
}

/** Soft-probe undocumented project / phone endpoints when present. */
async function enrichFromProjectEndpoints(baseUrl, token) {
  const paths = [
    '/developer/project/details',
    '/developer/project/info',
    '/developer/waba/details',
    '/developer/message/account-info',
  ]
  for (const path of paths) {
    try {
      const { res, data } = await fetchJson(`${baseUrl}${path}`, token)
      if (!res.ok || data.error === true || typeof data.error === 'string') continue
      const row = data.data || data.project || data.account || data
      if (!row || typeof row !== 'object') continue
      return {
        projectId: pickFirstString(row.project_id, row.projectId, row.id),
        wabaId: pickFirstString(row.waba_id, row.wabaId, row.whatsapp_business_account_id),
        displayPhone: pickFirstString(
          row.display_phone_number,
          row.phone_number,
          row.business_phone,
          row.mobile,
          row.number,
          row.connected_number,
        ),
        messagingLimit: pickFirstString(
          row.messaging_limit,
          row.messaging_limit_tier,
          row.whatsapp_business_manager_messaging_limit,
          row.daily_limit,
          row.limit,
        ),
        qualityRating: pickFirstString(row.quality_rating, row.quality_score, row.quality),
        displayName: pickFirstString(row.display_name, row.verified_name, row.business_name, row.name),
      }
    } catch {
      /* try next */
    }
  }
  return {}
}

/** Verify a shop OneChatting developer token and collect connection stats. */
export async function probeOneChattingToken(token) {
  const key = String(token || '').trim()
  if (!key) return { ok: false, error: 'OneChatting token is required' }
  if (key.length < 12) return { ok: false, error: 'Token looks too short' }

  const baseUrl = oneChattingBaseUrl()
  const appUrl = (process.env.ONECHATTING_APP_URL || 'https://onechatting.com').replace(/\/$/, '')

  try {
    const categories = ['UTILITY', 'MARKETING', 'AUTHENTICATION']
    const counts = { UTILITY: 0, MARKETING: 0, AUTHENTICATION: 0 }
    let projectId = null
    let displayPhone = null
    let messagingLimit = null
    let qualityRating = null
    let wabaId = null
    let displayName = null
    let sampleTemplateId = null
    let templateApiOk = false

    for (const category of categories) {
      const templates = await tryListApprovedTemplates(baseUrl, key, category)
      if (templates == null) continue
      templateApiOk = true
      counts[category] = Array.isArray(templates) ? templates.length : 0
      for (const row of templates || []) {
        if (!sampleTemplateId && (row.template_id || row.id)) {
          sampleTemplateId = String(row.template_id || row.id)
        }
        if (!projectId) projectId = pickFirstString(row.project_id, row.projectId)
        if (!wabaId) wabaId = extractWabaHint(row)
        if (!displayPhone) {
          displayPhone = pickFirstString(
            row.display_phone_number,
            row.phone_number,
            row.business_phone,
            row.sender_number,
            row.number,
          )
        }
        if (!messagingLimit) {
          messagingLimit = pickFirstString(
            row.messaging_limit,
            row.messaging_limit_tier,
            row.whatsapp_business_manager_messaging_limit,
            row.daily_limit,
          )
        }
        if (!qualityRating) {
          qualityRating = pickFirstString(row.quality_rating, row.quality_score, row.quality)
        }
        if (!displayName) {
          displayName = pickFirstString(row.display_name, row.verified_name, row.business_name)
        }
      }
    }

    const fromDetails = await enrichFromTemplateDetails(baseUrl, key, sampleTemplateId)
    projectId = projectId || fromDetails.projectId || null
    wabaId = wabaId || fromDetails.wabaId || null
    displayPhone = displayPhone || fromDetails.displayPhone || null

    const fromProject = await enrichFromProjectEndpoints(baseUrl, key)
    projectId = projectId || fromProject.projectId || null
    wabaId = wabaId || fromProject.wabaId || null
    displayPhone = displayPhone || fromProject.displayPhone || null
    messagingLimit = messagingLimit || fromProject.messagingLimit || null
    qualityRating = qualityRating || fromProject.qualityRating || null
    displayName = displayName || fromProject.displayName || null

    let chatApiOk = false
    let chatCount = null
    let chatError = null
    try {
      const { res, data: chatData } = await fetchJson(
        `${baseUrl}/developer/message/chat-list?${new URLSearchParams({ page_no: '1', limit: '1' })}`,
        key,
      )
      chatApiOk = res.ok && chatData.error !== true && typeof chatData.error !== 'string'
      if (!chatApiOk) {
        chatError =
          (typeof chatData.error === 'string' && chatData.error) ||
          chatData.message ||
          `Chat API HTTP ${res.status}`
      }
      if (chatApiOk && typeof chatData.count === 'number') chatCount = chatData.count
      const first = Array.isArray(chatData.data) ? chatData.data[0] : null
      if (!displayPhone) {
        displayPhone = pickFirstString(
          first?.contact?.number,
          first?.project_phone,
          first?.business_number,
          first?.sender,
          first?.from_number,
          first?.send_by?.mobile,
        )
      }
      if (!displayName) {
        displayName = pickFirstString(first?.contact?.name)
      }
    } catch (err) {
      chatApiOk = false
      chatError = err instanceof Error ? err.message : 'Chat API unreachable'
    }

    // Valid if either templates or chats work
    if (!templateApiOk && !chatApiOk) {
      return {
        ok: false,
        error: chatError || 'Invalid OneChatting token',
      }
    }

    const totalApproved =
      counts.UTILITY + counts.MARKETING + counts.AUTHENTICATION
    const tokenKind = chatApiOk ? 'user' : 'project'

    const status = {
      connected: true,
      checkedAt: new Date().toISOString(),
      displayPhone: displayPhone || null,
      displayName: displayName || null,
      messagingLimit: messagingLimit || null,
      qualityRating: qualityRating || null,
      wabaId: wabaId || null,
      projectId: projectId || null,
      utilityTemplates: counts.UTILITY,
      marketingTemplates: counts.MARKETING,
      authenticationTemplates: counts.AUTHENTICATION,
      totalApprovedTemplates: totalApproved,
      chatApiOk,
      chatCount,
      tokenKind,
      templateApiOk,
      openAppUrl: appUrl,
      note: chatApiOk
        ? null
        : 'Token works for templates. Connect a User Token under Chats for the live inbox.',
    }

    return {
      ok: true,
      message: chatApiOk
        ? totalApproved > 0
          ? `Connected · live chats + ${totalApproved} templates`
          : 'Connected · live chats ready'
        : totalApproved > 0
          ? `Connected · ${totalApproved} approved template${totalApproved === 1 ? '' : 's'}`
          : 'Connected to OneChatting',
      status,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not verify OneChatting token',
    }
  }
}

/**
 * Verify a User Token for live chats (chat-list first — does not require template access).
 */
export async function probeOneChattingUserToken(token) {
  const key = String(token || '').trim()
  if (!key) return { ok: false, error: 'Paste your OneChatting User Token' }
  if (key.length < 12) return { ok: false, error: 'Token looks too short' }
  if (key.startsWith('••••')) {
    return { ok: false, error: 'Paste the full User Token (not the masked dots)' }
  }

  const baseUrl = oneChattingBaseUrl()
  const appUrl = (process.env.ONECHATTING_APP_URL || 'https://onechatting.com').replace(/\/$/, '')

  try {
    const { res, data } = await fetchJson(
      `${baseUrl}/developer/message/chat-list?${new URLSearchParams({ page_no: '1', limit: '5' })}`,
      key,
    )
    const chatApiOk = res.ok && data.error !== true && typeof data.error !== 'string'
    if (!chatApiOk) {
      const detail =
        (typeof data.error === 'string' && data.error) ||
        data.message ||
        `HTTP ${res.status}`
      return {
        ok: false,
        error:
          /invalid/i.test(String(detail))
            ? 'Invalid User Token. Copy a fresh User Token from OneChatting → Developer Access (not the Project Token).'
            : String(detail),
      }
    }

    const rows = Array.isArray(data.data) ? data.data : []
    const first = rows[0] || null
    const chatCount = typeof data.count === 'number' ? data.count : rows.length
    const status = {
      connected: true,
      checkedAt: new Date().toISOString(),
      displayPhone: pickFirstString(first?.contact?.number) || null,
      displayName: pickFirstString(first?.contact?.name) || null,
      messagingLimit: null,
      qualityRating: null,
      wabaId: null,
      projectId: null,
      utilityTemplates: 0,
      marketingTemplates: 0,
      authenticationTemplates: 0,
      totalApprovedTemplates: 0,
      chatApiOk: true,
      chatCount,
      tokenKind: 'user',
      templateApiOk: false,
      openAppUrl: appUrl,
      note: null,
    }

    return {
      ok: true,
      message:
        chatCount > 0
          ? `User Token connected · ${chatCount} chat${chatCount === 1 ? '' : 's'}`
          : 'User Token connected · live inbox ready',
      status,
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Could not verify User Token',
    }
  }
}

/**
 * Send a template using an explicit OneChatting token (shop connection).
 */
export async function sendOneChattingTemplate({
  token,
  phone10,
  templateRef,
  bodyTexts = [],
  categories = ['UTILITY', 'MARKETING', 'AUTHENTICATION'],
  countryCode = DEFAULT_COUNTRY_CODE,
  headerImageUrl = null,
  headerMediaUrl = null,
  headerMediaType = null,
  headerMediaName = null,
}) {
  const result = await sendTemplateMessage(
    phone10,
    templateRef,
    bodyTexts,
    categories,
    {
      token,
      countryCode,
      headerImageUrl: headerMediaUrl || headerImageUrl,
      headerMediaType,
      headerMediaName,
    },
  )
  if (!result.ok) throw new Error(result.error || 'OneChatting send failed')
  return {
    ok: true,
    providerMessageId: result.messageId || result.wamid || null,
    raw: result,
  }
}

async function resolveTemplate(baseUrl, token, templateRef, categories, options = {}) {
  const ref = String(templateRef || '').trim()
  if (!ref) throw new Error('WhatsApp template id is required')

  // OTP / known ids: skip slow template-list (User Tokens often cannot list; listing can exceed client timeouts).
  if (options.assumeId) {
    return { template_id: ref, template_name: ref, status: 'APPROVED' }
  }

  try {
    for (const category of categories) {
      const templates = await listApprovedTemplates(baseUrl, token, category)
      const match = templates.find(
        (template) =>
          template.template_id === ref ||
          (template.template_name === ref && template.status === 'APPROVED'),
      )
      if (match?.template_id) return match
    }
  } catch (err) {
    console.warn(
      `[OneChatting] template list failed for "${ref}"; sending with configured id:`,
      err instanceof Error ? err.message : err,
    )
    return { template_id: ref, template_name: ref, status: 'APPROVED' }
  }

  // Not found in list — still attempt send; Meta may accept the configured template_id.
  console.warn(`[OneChatting] template "${ref}" not in approved list; sending with configured id`)
  return { template_id: ref, template_name: ref, status: 'APPROVED' }
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
 * @param {{ headerImageUrl?: string | null, headerMediaType?: string | null, headerMediaName?: string | null }} [options]
 */
async function sendTemplateMessage(phone10, templateRef, bodyTexts, categories, options = {}) {
  const token = String(options.token || process.env.ONECHATTING_TOKEN || '').trim()
  const baseUrl = oneChattingBaseUrl()
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

  const number = toWhatsAppNumber(digits, options.countryCode || DEFAULT_COUNTRY_CODE)
  const url = `${baseUrl}/developer/message/send-template`

  try {
    const templateRow = await resolveTemplate(baseUrl, token, templateRef, categories, {
      assumeId: Boolean(options.assumeId),
    })
    const templateId = templateRow.template_id
    const headerMediaUrl =
      options.headerImageUrl ||
      process.env.ONECHATTING_PAYMENT_REMINDER_HEADER_IMAGE?.trim() ||
      headerImageFromTemplate(templateRow)
    const headerMediaType = String(
      options.headerMediaType || (headerMediaUrl ? 'IMAGE' : '') || '',
    ).toUpperCase()

    const component = []
    if (headerMediaUrl) {
      if (headerMediaType === 'VIDEO') {
        component.push({
          type: 'header',
          parameters: [{ type: 'video', video: { link: headerMediaUrl } }],
        })
      } else if (headerMediaType === 'DOCUMENT') {
        component.push({
          type: 'header',
          parameters: [
            {
              type: 'document',
              document: {
                link: headerMediaUrl,
                filename: String(options.headerMediaName || 'document.pdf'),
              },
            },
          ],
        })
      } else {
        component.push({
          type: 'header',
          parameters: [{ type: 'image', image: { link: headerMediaUrl } }],
        })
      }
    }
    if (bodyTexts.length > 0) {
      component.push({
        type: 'body',
        parameters: bodyTexts.map((text) => ({ type: 'text', text: String(text) })),
      })
    }

    const res = await fetchWithRetry(
      url,
      {
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
      },
      {
        retries: options.retries ?? 2,
        timeoutMs: options.timeoutMs ?? 25000,
      },
    )

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
    const message = err instanceof Error ? err.message : networkErrorMessage(err)
    console.error(`[OneChatting] template send exception → ${number}:`, message)
    return { ok: false, error: message }
  }
}

/**
 * Send an AUTHENTICATION OTP template via OneChatting.
 */
const otpTemplateIdCache = new Map()

function looksLikeOneChattingTemplateId(ref) {
  // Real template ids are long opaque strings; names are short like "login_otp".
  return /^[a-z0-9]{24,}$/i.test(String(ref || '').trim())
}

async function resolveOtpTemplateId(templateRef) {
  const ref = String(templateRef || '').trim()
  if (!ref) return null
  if (looksLikeOneChattingTemplateId(ref)) return ref
  const cached = otpTemplateIdCache.get(ref)
  if (cached) return cached

  const token = process.env.ONECHATTING_TOKEN?.trim()
  const baseUrl = oneChattingBaseUrl()
  if (!token) return ref

  try {
    // Short, single-attempt lookup by name — avoids the old multi-minute hang.
    const templates = await listApprovedTemplates(baseUrl, token, 'AUTHENTICATION')
    const match = templates.find(
      (template) =>
        template.template_id === ref ||
        (String(template.template_name || '') === ref &&
          String(template.status || '').toUpperCase() === 'APPROVED'),
    )
    const id = match?.template_id ? String(match.template_id) : null
    if (id) {
      otpTemplateIdCache.set(ref, id)
      console.log(`[OneChatting] OTP template "${ref}" → ${id}`)
      return id
    }
  } catch (err) {
    console.warn(
      `[OneChatting] OTP template name lookup failed for "${ref}":`,
      err instanceof Error ? err.message : err,
    )
  }
  return ref
}

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
  const templateId = await resolveOtpTemplateId(templateRef)
  return sendTemplateMessage(phone10, templateId, [otpCode], ['AUTHENTICATION'], {
    retries: 1,
    timeoutMs: 10000,
    // ID already resolved (or is a raw id) — do not list templates again.
    assumeId: true,
  })
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
  const messageBody = [
    `Dear ${values.name},`,
    `Kindly clear your due of Rs. ${values.amount} to ${values.shop} as soon as possible.`,
    `Thanks and Regards`,
    `Team ${values.team}`,
  ].join('\n')
  const result = await sendTemplateMessage(payload.phone, templateRef, bodyTexts, ['UTILITY', 'MARKETING'], {
    headerImageUrl: process.env.ONECHATTING_PAYMENT_REMINDER_HEADER_IMAGE?.trim() || null,
  })
  return {
    ...result,
    templateName: templateRef,
    messageBody,
  }
}

function assertOneChattingOk(res, data, fallback) {
  if (!res.ok || data.error === true || typeof data.error === 'string') {
    const msg =
      (typeof data.error === 'string' && data.error) ||
      data.message ||
      data.msg ||
      fallback ||
      'OneChatting request failed'
    throw new Error(String(msg))
  }
}

export async function fetchJsonPost(url, token, body) {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      token,
    },
    body: JSON.stringify(body || {}),
  })
  const raw = await res.text()
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { message: raw }
  }
  return { res, data }
}

/** Normalize to OneChatting WhatsApp number (country + local). */
export function toOneChattingNumber(phone, countryCode = DEFAULT_COUNTRY_CODE) {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length >= 11 && digits.length <= 15) return digits
  return toWhatsAppNumber(digits.slice(-10), countryCode)
}

/**
 * Live inbox from OneChatting.
 * @see https://docs.onechatting.com/messages/chat-list
 */
export async function listOneChattingChats(token, options = {}) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  const baseUrl = oneChattingBaseUrl()
  const page = Math.max(1, Number(options.pageNo) || 1)
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50))
  const params = new URLSearchParams({
    page_no: String(page),
    limit: String(limit),
  })
  if (options.search) params.set('search', String(options.search).trim())

  const { res, data } = await fetchJson(
    `${baseUrl}/developer/message/chat-list?${params}`,
    key,
  )
  assertOneChattingOk(res, data, 'Could not load OneChatting chat list')

  const rows = Array.isArray(data.data) ? data.data : []
  const chats = rows
    .map((row) => {
      const contact = row.contact && typeof row.contact === 'object' ? row.contact : {}
      const last =
        row.last_message && typeof row.last_message === 'object'
          ? row.last_message
          : typeof row.last_message === 'string'
            ? { message: row.last_message }
            : {}
      const number = String(
        contact.number ||
          contact.mobile ||
          contact.phone ||
          row.number ||
          row.mobile ||
          row.phone ||
          row.wa_id ||
          '',
      ).replace(/\D/g, '')
      const phone10 = number.slice(-10)
      if (phone10.length < 8) return null
      return {
        number,
        phone10,
        name: String(contact.name || row.name || phone10).trim() || phone10,
        unreadCount: Number(row.unread_count || row.unread || 0) || 0,
        caseOpenCount: Number(row.case_open_count || 0) || 0,
        lastMessage: String(last.message || last.text || row.message || '').trim(),
        lastType: String(last.type || row.type || '').toLowerCase() === 'out' ? 'out' : 'in',
        lastStatus: last.status || row.status || null,
        lastAt: last.create_date || last.created_at || row.updated_at || row.create_date || null,
        lastMessageId: last.message_id || last.unique_id || last.id || null,
        lastWamid: last.wamid || null,
        raw: row,
      }
    })
    .filter(Boolean)

  return {
    chats,
    count: Number(data.count || chats.length) || chats.length,
    pagination: data.pagination || null,
  }
}

/**
 * Message history for one contact.
 * @see https://docs.onechatting.com/messages/chat-history
 */
export async function getOneChattingChatHistory(token, number, options = {}) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  const waNumber = toOneChattingNumber(number, options.countryCode)
  if (waNumber.length < 10) throw new Error('Invalid WhatsApp number')

  const baseUrl = oneChattingBaseUrl()
  const pageLimit = Math.min(100, Math.max(1, Number(options.limit) || 100))
  const maxPages = Math.min(20, Math.max(1, Number(options.maxPages) || 1))
  let lastId = Number(options.lastId ?? 0) || 0
  const messages = []
  let assigning = null
  let lastError = null

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      number: waNumber,
      last_id: String(lastId),
      limit: String(pageLimit),
    })

    const { res, data } = await fetchJson(
      `${baseUrl}/developer/message/chat-history?${params}`,
      key,
    )
    try {
      assertOneChattingOk(
        res,
        data,
        'Could not load chat history. Use a User Token (not Project Token) for live chats.',
      )
    } catch (err) {
      lastError = err
      if (page === 0) throw err
      break
    }

    if (data.assigning) assigning = data.assigning

    const rows = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.messages)
        ? data.messages
        : Array.isArray(data.chats)
          ? data.chats
          : []

    if (rows.length === 0) break

    const beforeCount = messages.length
    for (const row of rows) {
      try {
        const direction = String(row.type || '').toLowerCase() === 'out' ? 'out' : 'in'
        const messageType = String(row.message_type || 'text').toLowerCase()
        const isTemplate = Boolean(row.is_template) || messageType === 'template'
        const media = extractChatHistoryMedia(row, messageType)
        const textParts = extractChatHistoryText(row, { isTemplate, mediaUrl: media.mediaUrl })
        const body = textParts.body
        const id = String(
          row.message_id || row.unique_id || row.id || `${waNumber}-${row.create_date}-${messages.length}`,
        )
        if (messages.some((m) => m.id === id)) continue
        messages.push({
          id,
          providerId: row.id != null ? Number(row.id) : null,
          wamid: row.wamid || null,
          direction,
          messageType: media.mediaType || messageType,
          body:
            body ||
            (media.mediaType === 'image'
              ? '[Image]'
              : media.mediaType === 'video'
                ? '[Video]'
                : media.mediaType === 'document'
                  ? '[Document]'
                  : media.mediaType === 'audio'
                    ? '[Audio]'
                    : isTemplate
                      ? '[Template]'
                      : '[Message]'),
          headerText: textParts.headerText,
          footerText: textParts.footerText,
          status: row.status || 'sent',
          isTemplate,
          templateName:
            row.template?.name ||
            row.template_name ||
            row.template?.template_name ||
            row.campaign_name ||
            null,
          createdAt: row.create_date || null,
          sentByName: row.send_by?.name || row.send_by?.username || null,
          isRead: row.is_read !== false,
          mediaUrl: media.mediaUrl,
          mediaName: media.mediaName,
          mediaMime: media.mediaMime,
          mediaType: media.mediaType,
          raw: row,
        })
      } catch (err) {
        console.warn('[OneChatting] skip bad history row', err)
      }
    }

    if (messages.length === beforeCount) break

    const nextLast =
      data.last_id != null
        ? Number(data.last_id)
        : messages.reduce((max, m) => {
            const n = Number(m.providerId)
            return Number.isFinite(n) && n > max ? n : max
          }, lastId)
    if (!Number.isFinite(nextLast) || nextLast <= lastId) break
    lastId = nextLast
    if (rows.length < pageLimit) break
  }

  // OneChatting often returns newest-first; keep chronological for the UI
  messages.sort((a, b) => {
    const ta = parseProviderDate(a.createdAt)?.getTime() || 0
    const tb = parseProviderDate(b.createdAt)?.getTime() || 0
    return ta - tb
  })

  return {
    number: waNumber,
    messages,
    count: messages.length,
    lastId,
    assigning,
    error: lastError ? (lastError instanceof Error ? lastError.message : String(lastError)) : null,
  }
}

function parseProviderDate(value) {
  if (!value) return null
  const raw = String(value).trim()
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const d = new Date(normalized)
  if (!Number.isNaN(d.getTime())) return d
  const d2 = new Date(raw)
  return Number.isNaN(d2.getTime()) ? null : d2
}

/** Pull caption / body / template text from a chat-history row. */
function extractChatHistoryText(row, opts = {}) {
  const components = extractTemplateComponents(row)
  let headerText = null
  let footerText = null
  let bodyFromComponents = ''

  for (const component of components) {
    const ctype = String(component?.type || '').toUpperCase()
    if (ctype === 'HEADER' || ctype === 'header') {
      if (component?.text) headerText = String(component.text).trim() || headerText
      const params = Array.isArray(component?.parameters) ? component.parameters : []
      for (const param of params) {
        if (param?.text) headerText = String(param.text).trim() || headerText
      }
    } else if (ctype === 'BODY' || ctype === 'body') {
      let text = String(component?.text || component?.body || '').trim()
      const params = Array.isArray(component?.parameters) ? component.parameters : []
      if (params.length && text.includes('{{')) {
        text = text.replace(/\{\{(\d+)\}\}/g, (_, n) => {
          const idx = Number(n) - 1
          const p = params[idx]
          return String(p?.text ?? p?.value ?? p ?? '').trim()
        })
      } else if (!text && params.length) {
        text = params.map((p) => String(p?.text ?? p?.value ?? p ?? '').trim()).filter(Boolean).join('\n')
      }
      if (text) bodyFromComponents = text
    } else if (ctype === 'FOOTER' || ctype === 'footer') {
      if (component?.text) footerText = String(component.text).trim() || footerText
    }
  }

  const captionCandidates = [
    row.message,
    row.caption,
    row.text,
    row.body,
    row.body_text,
    row.media?.caption,
    row.image?.caption,
    row.video?.caption,
    row.document?.caption,
    row.media_caption,
    row.message_text,
    row.content,
    row.template?.body,
    row.template_body,
    bodyFromComponents,
  ]

  let body = ''
  for (const value of captionCandidates) {
    const text = String(value || '').trim()
    if (!text) continue
    // Skip bare media URLs — those belong in mediaUrl, not as bubble text.
    if (opts.mediaUrl && text === opts.mediaUrl) continue
    if (/^https?:\/\/\S+$/i.test(text) && opts.mediaUrl) continue
    body = text
    break
  }

  if (!headerText) headerText = String(row.header_text || row.template?.header_text || '').trim() || null
  if (!footerText) footerText = String(row.footer_text || row.template?.footer_text || '').trim() || null

  return { body, headerText, footerText }
}

/**
 * Pull image/video/document/audio links from OneChatting chat-history rows
 * (including template header media nested under components).
 */
function extractChatHistoryMedia(row, messageType = '') {
  const typeHint = String(messageType || row.message_type || '').toLowerCase()
  const candidates = [
    row.media_url,
    row.image_link,
    row.video_link,
    row.document_link,
    row.audio_link,
    row.media?.link,
    row.media?.url,
    row.media?.media_url,
    row.file_url,
    row.file_link,
    row.url,
    row.link,
    row.header_media_url,
    row.header_link,
    row.image?.link,
    row.video?.link,
    row.document?.link,
    row.audio?.link,
  ]

  const components = extractTemplateComponents(row)

  for (const component of components) {
    const ctype = String(component?.type || '').toUpperCase()
    if (ctype && ctype !== 'HEADER' && ctype !== 'header') continue
    const format = String(component?.format || component?.header_format || '').toUpperCase()
    const params = Array.isArray(component?.parameters) ? component.parameters : []
    for (const param of params) {
      const ptype = String(param?.type || '').toLowerCase()
      const bucket = param?.image || param?.video || param?.document || param?.audio || param
      const link = bucket?.link || bucket?.url || bucket?.media_url || null
      if (link) candidates.push(link)
      if (format === 'IMAGE' || ptype === 'image') candidates.push(link)
      if (format === 'VIDEO' || ptype === 'video') candidates.push(link)
      if (format === 'DOCUMENT' || ptype === 'document') candidates.push(link)
      if ((format === 'DOCUMENT' || ptype === 'document') && bucket?.filename) {
        // keep filename for later
        row._oc_doc_name = bucket.filename
      }
    }
    const handle =
      component?.example?.header_handle ||
      component?.example?.header_url ||
      component?.media_url ||
      component?.link
    if (Array.isArray(handle) && handle[0]) candidates.push(handle[0])
    else if (typeof handle === 'string' && handle) candidates.push(handle)

    if (format === 'DOCUMENT') row._oc_header_format = 'DOCUMENT'
    else if (format === 'IMAGE') row._oc_header_format = row._oc_header_format || 'IMAGE'
    else if (format === 'VIDEO') row._oc_header_format = row._oc_header_format || 'VIDEO'
  }

  let mediaUrl = null
  for (const value of candidates) {
    const link = String(value || '').trim()
    if (/^https?:\/\//i.test(link)) {
      mediaUrl = link
      break
    }
  }

  const mediaName = String(
    row._oc_doc_name ||
      row.document_name ||
      row.file_name ||
      row.filename ||
      row.media?.filename ||
      row.document?.filename ||
      row.media_name ||
      '',
  ).trim() || null

  const mediaMime = String(
    row.mime_type || row.mimetype || row.media?.mime_type || row.document?.mime_type || '',
  )
    .trim()
    .toLowerCase() || null

  const headerFormat = String(row._oc_header_format || '').toUpperCase()
  let mediaType = null
  if (headerFormat === 'DOCUMENT' || typeHint === 'document') mediaType = 'document'
  else if (headerFormat === 'VIDEO' || typeHint === 'video') mediaType = 'video'
  else if (headerFormat === 'IMAGE' || typeHint === 'image') mediaType = 'image'
  else if (typeHint === 'audio') mediaType = 'audio'
  else if (mediaMime.startsWith('image/')) mediaType = 'image'
  else if (mediaMime.startsWith('video/')) mediaType = 'video'
  else if (mediaMime.startsWith('audio/')) mediaType = 'audio'
  else if (mediaMime.includes('pdf') || mediaMime.includes('document') || mediaMime.includes('msword')) {
    mediaType = 'document'
  } else if (mediaUrl) {
    const u = mediaUrl.toLowerCase()
    if (/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(u) || /\/image\//i.test(u)) mediaType = 'image'
    else if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) || /\/video\//i.test(u)) mediaType = 'video'
    else if (/\.(mp3|ogg|wav|m4a|aac)(\?|$)/i.test(u) || /\/audio\//i.test(u)) mediaType = 'audio'
    else if (/\.(pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(u) || mediaName) mediaType = 'document'
    else if (typeHint === 'template') mediaType = 'document' // invoice/share templates are usually docs
    else mediaType = 'document'
  } else if (typeHint === 'template') {
    // keep null — text-only template
  }

  return { mediaUrl, mediaName, mediaMime, mediaType }
}

/**
 * Mark inbound messages as read on OneChatting.
 * @see https://docs.onechatting.com/messages/mark-as-read
 */
export async function markOneChattingChatRead(token, number, countryCode = DEFAULT_COUNTRY_CODE) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  const waNumber = toOneChattingNumber(number, countryCode)
  const baseUrl = oneChattingBaseUrl()
  const { res, data } = await fetchJsonPost(`${baseUrl}/developer/message/mark-as-read`, key, {
    number: waNumber,
  })
  assertOneChattingOk(res, data, 'Could not mark chat as read on OneChatting')
  return { ok: true, number: waNumber }
}

/**
 * Session text message (within customer care window).
 * @see https://docs.onechatting.com/messages/send-text
 */
export async function sendOneChattingTextMessage({
  token,
  phone,
  message,
  countryCode = DEFAULT_COUNTRY_CODE,
  isReply = false,
  replyWamid = null,
}) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  const text = String(message || '').trim()
  if (!text) throw new Error('Message text is required')
  const waNumber = toOneChattingNumber(phone, countryCode)
  const baseUrl = oneChattingBaseUrl()
  const body = {
    number: waNumber,
    message: text,
  }
  if (isReply && replyWamid) {
    body.is_reply = true
    body.reply_wamid = replyWamid
  }
  const { res, data } = await fetchJsonPost(
    `${baseUrl}/developer/message/send-text-message`,
    key,
    body,
  )
  assertOneChattingOk(res, data, 'Could not send text message')
  return {
    ok: true,
    number: waNumber,
    wamid: data.wamid || null,
    messageId: data.message_id || null,
    providerId: data.id ?? null,
    status: data.status || 'pending',
    createDate: data.create_date || null,
    message: data.message || text,
    raw: data,
  }
}

/**
 * Session media message (image / video / document / audio) within the care window.
 * Tries OneChatting media endpoints used alongside send-text-message.
 */
export async function sendOneChattingMediaMessage({
  token,
  phone,
  mediaUrl,
  mediaType = 'image',
  caption = '',
  fileName = null,
  countryCode = DEFAULT_COUNTRY_CODE,
}) {
  const key = String(token || '').trim()
  if (!key) throw new Error('OneChatting token is required')
  const link = String(mediaUrl || '').trim()
  if (!link || !/^https?:\/\//i.test(link)) {
    throw new Error('A public media URL is required')
  }
  const type = String(mediaType || 'image').toLowerCase()
  const allowed = new Set(['image', 'video', 'document', 'audio'])
  if (!allowed.has(type)) {
    throw new Error('Media type must be image, video, document, or audio')
  }
  const waNumber = toOneChattingNumber(phone, countryCode)
  const baseUrl = oneChattingBaseUrl()
  const captionText = String(caption || '').trim()
  const name = String(fileName || '').trim() || undefined

  const attempts = [
    {
      url: `${baseUrl}/developer/message/send-${type}-message`,
      body:
        type === 'image'
          ? { number: waNumber, image: { link }, caption: captionText || undefined }
          : type === 'video'
            ? { number: waNumber, video: { link }, caption: captionText || undefined }
            : type === 'audio'
              ? { number: waNumber, audio: { link } }
              : {
                  number: waNumber,
                  document: { link, filename: name || 'document' },
                  caption: captionText || undefined,
                },
    },
    {
      url: `${baseUrl}/developer/message/send-media-message`,
      body: {
        number: waNumber,
        type,
        media_url: link,
        link,
        caption: captionText || undefined,
        filename: name,
      },
    },
  ]

  let lastError = 'Could not send media message'
  for (const attempt of attempts) {
    try {
      const { res, data } = await fetchJsonPost(attempt.url, key, attempt.body)
      if (data?.error) {
        lastError = String(data.message || data.error || lastError)
        continue
      }
      if (!res.ok) {
        lastError = String(data?.message || data?.error || `HTTP ${res.status}`)
        continue
      }
      return {
        ok: true,
        number: waNumber,
        mediaType: type,
        mediaUrl: link,
        wamid: data.wamid || null,
        messageId: data.message_id || null,
        providerId: data.id ?? null,
        status: data.status || 'pending',
        createDate: data.create_date || null,
        message: captionText || `[${type}]`,
        raw: data,
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : lastError
    }
  }
  throw new Error(lastError)
}

export function oneChattingSocketUrl() {
  return oneChattingBaseUrl()
}
