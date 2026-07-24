/**
 * Customer loan / sale-on-EMI helpers.
 * Interest: flat | reducing
 * Frequency: monthly | weekly
 *
 * Monthly: EMI due 1st of month · interest ledger last day of prior month.
 * Weekly: EMI every Monday (skip first Monday after sale) · interest on due day.
 */

import { toIndiaDateInput } from './time.js'

function pad(n) {
  return String(n).padStart(2, '0')
}

function parseDate(dateStr) {
  return new Date(`${String(dateStr).slice(0, 10)}T12:00:00`)
}

export function dateOnly(date = new Date()) {
  return toIndiaDateInput(date)
}

export function lastDayOfMonth(year, monthIndex) {
  return dateOnly(new Date(year, monthIndex + 1, 0, 12))
}

/** Safe YYYY-MM-DD from MySQL DATE / Date / string (avoids timezone day-shift). */
export function asDateOnly(value) {
  if (value == null || value === '') return null
  if (typeof value === 'string') return value.slice(0, 10)
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  }
  return String(value).slice(0, 10)
}

export function addDays(dateStr, days) {
  const d = parseDate(dateStr)
  d.setDate(d.getDate() + days)
  return dateOnly(d)
}

function daysBetween(from, to) {
  const a = parseDate(from).getTime()
  const b = parseDate(to).getTime()
  return Math.round((b - a) / 86_400_000)
}

function firstOfMonth(year, monthIndex) {
  return dateOnly(new Date(year, monthIndex, 1, 12))
}

function nextMonthFirst(year, monthIndex) {
  return firstOfMonth(year, monthIndex + 1)
}

/** Monday on or after date (includes date when already Monday). */
function firstMondayOnOrAfter(dateStr) {
  const d = parseDate(dateStr)
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1)
  return dateOnly(d)
}

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}

/** @returns {'flat' | 'reducing'} */
export function normalizeInterestType(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  return v === 'flat' ? 'flat' : 'reducing'
}

/** @returns {'monthly' | 'weekly'} */
export function normalizeEmiFrequency(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
  return v === 'weekly' ? 'weekly' : 'monthly'
}

/**
 * Interest post date on customer ledger.
 * Monthly → last day of month before EMI due (EMI is on 1st).
 * Weekly → EMI due (Monday).
 */
export function emiLedgerDate(dueDate, frequency = 'monthly') {
  const due = String(dueDate).slice(0, 10)
  if (normalizeEmiFrequency(frequency) === 'weekly') return due
  const d = parseDate(due)
  return lastDayOfMonth(d.getFullYear(), d.getMonth() - 1)
}

/**
 * Default first EMI due date from sale date.
 * Monthly → 1st of next month; if sale→that date < 15 days, 1st of month after.
 * Weekly → second Monday after sale (skip first Monday on/after sale).
 */
export function defaultEmiStartDate(loanDate, frequency = 'monthly') {
  const from = String(loanDate).slice(0, 10)
  const freq = normalizeEmiFrequency(frequency)
  if (freq === 'weekly') {
    const firstMon = firstMondayOnOrAfter(from)
    return addDays(firstMon, 7)
  }
  const d = parseDate(from)
  let candidate = nextMonthFirst(d.getFullYear(), d.getMonth())
  if (daysBetween(from, candidate) < 15) {
    candidate = nextMonthFirst(d.getFullYear(), d.getMonth() + 1)
  }
  return candidate
}

/** EMI due date for a period start (already normalized). */
export function periodEndDate(periodStart, frequency = 'monthly') {
  return String(periodStart).slice(0, 10)
}

/**
 * Next EMI due after previous due.
 * Monthly → 1st of next month · Weekly → +7 days (Monday chain).
 */
export function nextPeriodStartAfter(periodEnd, frequency = 'monthly') {
  const end = String(periodEnd).slice(0, 10)
  const freq = normalizeEmiFrequency(frequency)
  if (freq === 'weekly') return addDays(end, 7)
  const d = parseDate(end)
  return nextMonthFirst(d.getFullYear(), d.getMonth())
}

/** Snap due date to 1st (monthly) or Monday (weekly). */
export function normalizePeriodStart(emiStartDate, frequency = 'monthly') {
  const date = String(emiStartDate).slice(0, 10)
  const freq = normalizeEmiFrequency(frequency)
  if (freq === 'weekly') return firstMondayOnOrAfter(date)
  const d = parseDate(date)
  if (d.getDate() === 1) return firstOfMonth(d.getFullYear(), d.getMonth())
  return nextMonthFirst(d.getFullYear(), d.getMonth())
}

/** Periods per year for rate math. */
function periodsPerYear(frequency) {
  return normalizeEmiFrequency(frequency) === 'weekly' ? 52 : 12
}

/**
 * Flat-rate total interest for the full tenure.
 * Monthly: P × rate% × (n/12) · Weekly: P × rate% × (n/52)
 */
export function flatTotalInterest(
  principal,
  annualRatePercent,
  tenurePeriods,
  frequency = 'monthly',
) {
  const P = Number(principal)
  const n = Math.round(Number(tenurePeriods))
  const annual = Number(annualRatePercent)
  if (!(P > 0) || !(n > 0) || !(annual >= 0)) return 0
  return roundMoney(P * (annual / 100) * (n / periodsPerYear(frequency)))
}

/**
 * @param {number} principal financed amount
 * @param {number} annualRatePercent e.g. 12 for 12% p.a.
 * @param {number} tenurePeriods months or weeks
 * @param {'flat' | 'reducing'} [interestType='reducing']
 * @param {'monthly' | 'weekly'} [frequency='monthly']
 */
export function calculateEmi(
  principal,
  annualRatePercent,
  tenurePeriods,
  interestType = 'reducing',
  frequency = 'monthly',
) {
  const P = Number(principal)
  const n = Math.round(Number(tenurePeriods))
  const annual = Number(annualRatePercent)
  if (!(P > 0) || !(n > 0)) {
    throw new Error('Financed amount and tenure must be greater than 0')
  }
  if (!(annual >= 0)) {
    throw new Error('Interest rate cannot be negative')
  }
  const type = normalizeInterestType(interestType)
  const freq = normalizeEmiFrequency(frequency)

  if (type === 'flat') {
    const totalInterest = flatTotalInterest(P, annual, n, freq)
    return roundMoney((P + totalInterest) / n)
  }

  const r = annual / periodsPerYear(freq) / 100
  if (r === 0) return roundMoney(P / n)
  const factor = Math.pow(1 + r, n)
  return roundMoney((P * r * factor) / (factor - 1))
}

/**
 * @returns {Array<{ installmentNo: number, periodStart: string, dueDate: string, ledgerDate: string, principalComponent: number, interestComponent: number, emiAmount: number }>}
 */
export function buildAmortizationSchedule(
  principal,
  annualRatePercent,
  tenurePeriods,
  emiStartDate,
  interestType = 'reducing',
  frequency = 'monthly',
) {
  const P0 = Number(principal)
  const n = Math.round(Number(tenurePeriods))
  const annual = Number(annualRatePercent)
  const type = normalizeInterestType(interestType)
  const freq = normalizeEmiFrequency(frequency)
  const emi = calculateEmi(P0, annual, n, type, freq)

  let periodStart = normalizePeriodStart(
    emiStartDate || defaultEmiStartDate(dateOnly(), freq),
    freq,
  )
  const rows = []

  if (type === 'flat') {
    const totalInterest = flatTotalInterest(P0, annual, n, freq)
    let remainingP = roundMoney(P0)
    let remainingI = totalInterest
    for (let i = 1; i <= n; i += 1) {
      const due = periodEndDate(periodStart, freq)
      const interest = i === n ? remainingI : roundMoney(totalInterest / n)
      let principalPart = i === n ? remainingP : roundMoney(P0 / n)
      if (principalPart > remainingP) principalPart = remainingP
      if (principalPart < 0) principalPart = 0
      rows.push({
        installmentNo: i,
        periodStart,
        dueDate: due,
        ledgerDate: emiLedgerDate(due, freq),
        principalComponent: principalPart,
        interestComponent: interest,
        emiAmount: roundMoney(principalPart + interest),
      })
      remainingP = roundMoney(remainingP - principalPart)
      remainingI = roundMoney(remainingI - interest)
      if (remainingP < 0.005) remainingP = 0
      if (remainingI < 0.005) remainingI = 0
      periodStart = nextPeriodStartAfter(due, freq)
    }
    return rows
  }

  const r = annual / periodsPerYear(freq) / 100
  let balance = roundMoney(P0)
  for (let i = 1; i <= n; i += 1) {
    const due = periodEndDate(periodStart, freq)
    const interest = roundMoney(balance * r)
    let principalPart = i === n ? balance : roundMoney(emi - interest)
    if (principalPart > balance) principalPart = balance
    if (principalPart < 0) principalPart = 0
    rows.push({
      installmentNo: i,
      periodStart,
      dueDate: due,
      ledgerDate: emiLedgerDate(due, freq),
      principalComponent: principalPart,
      interestComponent: interest,
      emiAmount: roundMoney(principalPart + interest),
    })
    balance = roundMoney(balance - principalPart)
    if (balance < 0.005) balance = 0
    periodStart = nextPeriodStartAfter(due, freq)
  }
  return rows
}

/** @deprecated use defaultEmiStartDate + periodEndDate */
export function firstEmiDueDate(emiStartDate) {
  return periodEndDate(normalizePeriodStart(emiStartDate, 'monthly'), 'monthly')
}

/** @deprecated */
export function addMonthsMonthEnd(dueDate, months) {
  const d = parseDate(dueDate)
  return lastDayOfMonth(d.getFullYear(), d.getMonth() + months)
}
