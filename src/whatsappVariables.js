/**
 * Global OneBook → WhatsApp template variables.
 * Map each {{n}} placeholder to one of these ids in Activity mapping.
 */

export const WHATSAPP_TEMPLATE_VARIABLES = [
  { id: 'customer_name', label: 'Customer name', sample: 'Rahul', group: 'Customer' },
  { id: 'customer_phone', label: 'Customer mobile', sample: '9876543210', group: 'Customer' },
  { id: 'closing_balance', label: 'Closing balance', sample: '1,250', group: 'Balance' },
  { id: 'opening_balance', label: 'Opening balance', sample: '500', group: 'Balance' },
  { id: 'balance_amount', label: 'Balance (absolute)', sample: '1,250', group: 'Balance' },
  {
    id: 'balance_direction',
    label: 'Balance direction',
    sample: 'payable by you',
    group: 'Balance',
  },
  { id: 'shop_name', label: 'Shop name', sample: 'OneBook Shop', group: 'Shop' },
  { id: 'shop_address', label: 'Shop address', sample: 'Guwahati', group: 'Shop' },
  { id: 'team_name', label: 'Team / sender name', sample: 'OneBook Shop', group: 'Shop' },
  { id: 'document_name', label: 'Document name', sample: 'Ledger PDF', group: 'Document' },
  {
    id: 'document_link',
    label: 'Document link / URL',
    sample: 'https://onebook.app/doc',
    group: 'Document',
  },
  { id: 'invoice_number', label: 'Invoice / bill no.', sample: 'INV-102', group: 'Sales' },
  { id: 'invoice_amount', label: 'Invoice amount', sample: '2,500', group: 'Sales' },
  { id: 'invoice_date', label: 'Invoice date', sample: '20 Jul 2026', group: 'Sales' },
  { id: 'amount', label: 'Amount', sample: '1,000', group: 'General' },
  { id: 'date', label: 'Date', sample: '20 Jul 2026', group: 'General' },
  { id: 'note', label: 'Note / reminder text', sample: 'Please follow up', group: 'General' },
  {
    id: 'activity_title',
    label: 'Activity / task title',
    sample: 'Call customer',
    group: 'Reminder',
  },
  { id: 'due_date', label: 'Due date', sample: '23 Jul 2026', group: 'Reminder' },
]

const VARIABLE_IDS = new Set(WHATSAPP_TEMPLATE_VARIABLES.map((v) => v.id))

/** Sensible defaults when a template is first mapped to an activity */
export const ACTIVITY_VARIABLE_DEFAULTS = {
  payment_reminder: {
    1: 'customer_name',
    2: 'closing_balance',
    3: 'shop_name',
    4: 'team_name',
  },
  document_share: {
    1: 'customer_name',
    2: 'document_name',
    3: 'shop_name',
  },
  sales_invoice: {
    1: 'customer_name',
    2: 'invoice_amount',
    3: 'invoice_number',
    4: 'shop_name',
  },
  reminder_activity: {
    1: 'customer_name',
    2: 'note',
    3: 'due_date',
    4: 'shop_name',
  },
}

export function listWhatsAppTemplateVariables() {
  return WHATSAPP_TEMPLATE_VARIABLES
}

export function isWhatsAppVariableId(id) {
  return VARIABLE_IDS.has(String(id || ''))
}

/** Extract sorted placeholder indexes from template body/header text: {{1}}, {{2}}… */
export function listTemplatePlaceholders(...texts) {
  const found = new Set()
  for (const text of texts) {
    String(text || '').replace(/\{\{(\d+)\}\}/g, (_, raw) => {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) found.add(n)
      return ''
    })
  }
  return [...found].sort((a, b) => a - b)
}

export function normalizeVariableMap(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    const index = String(key).replace(/^\{\{|\}\}$/g, '').trim()
    if (!/^\d+$/.test(index)) continue
    const id = String(value || '').trim()
    if (!id || !VARIABLE_IDS.has(id)) continue
    out[index] = id
  }
  return out
}

function formatAmountPlain(amount) {
  return new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(Math.abs(Number(amount) || 0))
}

function formatSignedBalance(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n === 0) return '0'
  const plain = formatAmountPlain(n)
  return n < 0 ? `-${plain}` : plain
}

/**
 * Build a context bag of resolved string values for one send.
 * @param {Record<string, unknown>} input
 */
export function buildWhatsAppVariableContext(input = {}) {
  const customerName = String(input.customerName || input.userName || 'Customer').trim() || 'Customer'
  const customerPhone = String(input.customerPhone || input.phone || '')
    .replace(/\D/g, '')
    .slice(-10)
  const balance = Number(input.balance)
  const shopName = String(input.shopName || 'Shop').trim() || 'Shop'
  const shopAddress = String(input.shopAddress || '').trim()
  const teamName = String(input.teamName || shopName).trim() || shopName
  const documentName = String(input.documentName || input.docName || 'Document').trim() || 'Document'
  const documentLink = String(input.documentLink || input.docLink || '').trim()
  const invoiceNumber = String(input.invoiceNumber || input.billNo || '').trim()
  const invoiceAmount = Number.isFinite(Number(input.invoiceAmount))
    ? formatAmountPlain(input.invoiceAmount)
    : String(input.invoiceAmount || '').trim()
  const invoiceDate = String(input.invoiceDate || '').trim()
  const amount = Number.isFinite(Number(input.amount))
    ? formatAmountPlain(input.amount)
    : String(input.amount || '').trim()
  const date = String(input.date || '').trim()
  const note = String(input.note || input.reminderNote || 'Reminder').trim() || 'Reminder'
  const activityTitle = String(input.activityTitle || input.title || note).trim() || note
  const dueDate = String(input.dueDate || '').trim()

  const balanceFinite = Number.isFinite(balance) ? balance : 0
  const direction =
    balanceFinite > 0 ? 'payable by you' : balanceFinite < 0 ? 'payable to you' : 'settled'

  return {
    customer_name: customerName,
    customer_phone: customerPhone || '—',
    closing_balance: formatSignedBalance(balanceFinite),
    opening_balance: formatSignedBalance(
      Number.isFinite(Number(input.openingBalance)) ? Number(input.openingBalance) : 0,
    ),
    balance_amount: formatAmountPlain(balanceFinite),
    balance_direction: direction,
    shop_name: shopName,
    shop_address: shopAddress || '—',
    team_name: teamName,
    document_name: documentName,
    document_link: documentLink || documentName,
    invoice_number: invoiceNumber || '—',
    invoice_amount: invoiceAmount || formatAmountPlain(balanceFinite),
    invoice_date: invoiceDate || date || '—',
    amount: amount || formatAmountPlain(balanceFinite),
    date: date || invoiceDate || dueDate || '—',
    note,
    activity_title: activityTitle,
    due_date: dueDate || date || '—',
  }
}

/**
 * Ordered body parameter texts for OneChatting from a {{n}} → variable map.
 * @param {Record<string, string>} variableMap
 * @param {Record<string, string>} context
 * @param {number[]} [placeholderIndexes]
 */
export function buildBodyTextsFromVariableMap(variableMap, context, placeholderIndexes) {
  const map = normalizeVariableMap(variableMap)
  const indexes =
    Array.isArray(placeholderIndexes) && placeholderIndexes.length
      ? placeholderIndexes
      : Object.keys(map)
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0)
          .sort((a, b) => a - b)
  if (indexes.length === 0) return []
  const max = Math.max(...indexes)
  const out = []
  for (let i = 1; i <= max; i += 1) {
    const varId = map[String(i)]
    out.push(varId && context[varId] != null ? String(context[varId]) : '')
  }
  return out
}

/** Sample values for live preview (UI + hydrate). */
export function sampleValuesForVariables(variableMap, shopName = 'Shop') {
  const context = buildWhatsAppVariableContext({
    customerName: 'Rahul',
    phone: '9876543210',
    balance: 1250,
    openingBalance: 500,
    shopName,
    shopAddress: 'Guwahati',
    teamName: shopName,
    documentName: 'Ledger PDF',
    documentLink: 'https://onebook.app/doc',
    invoiceNumber: 'INV-102',
    invoiceAmount: 2500,
    invoiceDate: '20 Jul 2026',
    amount: 1000,
    date: '20 Jul 2026',
    note: 'Please follow up',
    activityTitle: 'Call customer',
    dueDate: '23 Jul 2026',
  })
  return buildBodyTextsFromVariableMap(variableMap, context)
}

export function defaultVariablesForActivity(activityId, placeholderIndexes) {
  const defaults = ACTIVITY_VARIABLE_DEFAULTS[activityId] || {}
  const out = {}
  const indexes = placeholderIndexes?.length
    ? placeholderIndexes
    : Object.keys(defaults).map(Number)
  for (const n of indexes) {
    const key = String(n)
    if (defaults[n] || defaults[key]) out[key] = defaults[n] || defaults[key]
  }
  return out
}
