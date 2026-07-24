/**
 * App timezone — Indian Standard Time (Asia/Kolkata), 12-hour am/pm for display.
 * Prefer these helpers over Date#getFullYear / getHours so hosts in any TZ stay correct.
 */

export const APP_TIME_ZONE = 'Asia/Kolkata'
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** Ensure Node local time defaults to IST when callers still use Date local getters. */
if (!process.env.TZ) {
  process.env.TZ = APP_TIME_ZONE
}

/**
 * @param {string | Date} iso
 * @returns {{ year: string, month: string, day: string, hour: string, minute: string, second: string }}
 */
export function indiaDateParts(iso) {
  const d = iso instanceof Date ? iso : new Date(iso)
  const source = Number.isNaN(d.getTime()) ? new Date() : d
  const map = {}
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(source)) {
    if (part.type !== 'literal') map[part.type] = part.value
  }
  return {
    year: map.year || '1970',
    month: map.month || '01',
    day: map.day || '01',
    hour: map.hour || '00',
    minute: map.minute || '00',
    second: map.second || '00',
  }
}

/** Wall-clock time in Kolkata → UTC ISO (IST is always UTC+5:30). */
export function kolkataWallTimeToIso(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms) - IST_OFFSET_MS
  return new Date(utcMs).toISOString()
}

/** YYYY-MM-DD in Asia/Kolkata. */
export function toIndiaDateInput(iso = new Date()) {
  const p = indiaDateParts(iso)
  return `${p.year}-${p.month}-${p.day}`
}

export function indiaTodayDateInput() {
  return toIndiaDateInput(new Date())
}

/**
 * @param {string | Date} iso
 * @param {Intl.DateTimeFormatOptions} options
 */
function formatInIndia(iso, options) {
  const d = iso instanceof Date ? iso : new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: APP_TIME_ZONE,
    hour12: true,
    ...options,
  }).format(d)
}

/** e.g. 24 Jul 2026, 1:10 pm */
export function formatDateTime(iso) {
  return formatInIndia(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** e.g. 1:10 pm */
export function formatTime(iso) {
  return formatInIndia(iso, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** e.g. 24 Jul 2026 */
export function formatDate(iso) {
  return formatInIndia(iso, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** Compact stamp for ids: YYYYMMDDHHmmssSSS in Asia/Kolkata. */
export function indiaTimestampStamp(at = new Date()) {
  const p = indiaDateParts(at)
  const d = at instanceof Date ? at : new Date(at)
  const ms = String(Number.isNaN(d.getTime()) ? Date.now() : d.getMilliseconds()).padStart(3, '0')
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}${ms}`
}

/** Default auto-post clock on the billing date (IST). */
export const DEFAULT_AUTO_BILL_TIME = '09:00'

/** Normalize to HH:mm (24h). Invalid → default. */
export function normalizeAutoBillTime(value) {
  const raw = String(value ?? '').trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (!match) return DEFAULT_AUTO_BILL_TIME
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) {
    return DEFAULT_AUTO_BILL_TIME
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/**
 * Instant for a billing calendar day + auto time in Asia/Kolkata.
 * @param {string} dateOnly YYYY-MM-DD
 * @param {string} [timeHHMM]
 */
export function indiaBillingDateTime(dateOnly, timeHHMM = DEFAULT_AUTO_BILL_TIME) {
  const time = normalizeAutoBillTime(timeHHMM)
  const [y, m, d] = String(dateOnly).split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  return new Date(
    kolkataWallTimeToIso(y || 1970, m || 1, d || 1, hour || 0, minute || 0, 0, 0),
  )
}

/**
 * True when auto schedule may post for nextRunDate given "now" in IST.
 * Past billing dates always due; same-day waits until autoBillTime.
 */
export function isAutoBillTimeReached(nextRunDate, autoBillTime, now = new Date()) {
  const today = toIndiaDateInput(now)
  if (nextRunDate < today) return true
  if (nextRunDate > today) return false
  const time = normalizeAutoBillTime(autoBillTime)
  const [hour, minute] = time.split(':').map(Number)
  const p = indiaDateParts(now)
  const minsNow = Number(p.hour) * 60 + Number(p.minute)
  return minsNow >= hour * 60 + minute
}

/** Format HH:mm as Indian 12-hour, e.g. 9:00 am */
export function formatAutoBillTimeLabel(timeHHMM) {
  const time = normalizeAutoBillTime(timeHHMM)
  const [hour, minute] = time.split(':').map(Number)
  const iso = kolkataWallTimeToIso(2020, 1, 1, hour, minute, 0, 0)
  return formatTime(iso)
}
