/**
 * Soft-delete helpers — records stay in DB with status='deleted' for future recovery.
 * Client-facing state never includes deleted rows.
 */

export const RECORD_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DELETED: 'deleted',
}

export function normalizeRecordStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (status === RECORD_STATUS.DELETED) return RECORD_STATUS.DELETED
  if (status === RECORD_STATUS.SUSPENDED) return RECORD_STATUS.SUSPENDED
  return RECORD_STATUS.ACTIVE
}

export function isLive(record) {
  if (!record || typeof record !== 'object') return false
  return normalizeRecordStatus(record.status) !== RECORD_STATUS.DELETED
}

export function liveOnly(list) {
  if (!Array.isArray(list)) return []
  return list.filter(isLive)
}

/** Mark an in-memory record deleted (keeps all data for recovery). */
export function markDeleted(record) {
  return {
    ...record,
    status: RECORD_STATUS.DELETED,
    deletedAt: new Date().toISOString(),
  }
}

/**
 * Strip soft-deleted entities before sending shop state to clients.
 * Server caches keep full history including deleted rows.
 */
export function toClientState(state) {
  if (!state || typeof state !== 'object') return state
  return {
    ...state,
    users: liveOnly(state.users),
    transactions: liveOnly(state.transactions),
    cashAccounts: liveOnly(state.cashAccounts),
    recurringBillings: liveOnly(state.recurringBillings),
    services: liveOnly(state.services),
    todos: liveOnly(state.todos),
  }
}
