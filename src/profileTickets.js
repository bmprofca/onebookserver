/** Short-lived tickets after OTP so the user can pick a profile or create a shop. */

const TICKET_TTL_MS = 1000 * 60 * 15
/** @type {Map<string, { phone: string, expiresAt: number }>} */
const tickets = new Map()

function prune() {
  const now = Date.now()
  for (const [token, row] of tickets) {
    if (row.expiresAt < now) tickets.delete(token)
  }
}

export function issueProfileTicket(phone) {
  prune()
  const token = `pt.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  tickets.set(token, { phone, expiresAt: Date.now() + TICKET_TTL_MS })
  return token
}

/** @returns {string | null} phone */
export function peekProfileTicket(token) {
  prune()
  const row = tickets.get(String(token ?? ''))
  if (!row || row.expiresAt < Date.now()) {
    if (row) tickets.delete(String(token ?? ''))
    return null
  }
  return row.phone
}

/** @returns {string | null} phone */
export function consumeProfileTicket(token) {
  const phone = peekProfileTicket(token)
  if (phone) tickets.delete(String(token ?? ''))
  return phone
}
