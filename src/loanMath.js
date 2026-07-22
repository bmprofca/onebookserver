/**
 * Customer loan / sale-on-EMI helpers.
 * Interest: flat | reducing
 * Frequency: monthly | weekly
 * Interest posts on the last day of each EMI period.
 */

function pad(n) {
  return String(n).padStart(2, '0')
}

export function dateOnly(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + days)
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
 * Monthly → 1 day before EMI due (30th day when due is sale+30)
 * Weekly → last day of the 7-day period (= EMI due, date-to-date)
 */
export function emiLedgerDate(dueDate, frequency = 'monthly') {
  const due = String(dueDate).slice(0, 10)
  if (normalizeEmiFrequency(frequency) === 'weekly') return due
  return addDays(due, -1)
}

/**
 * Default first EMI due date.
 * Monthly → sale + 30 days · Weekly → sale + 7 days (date-to-date).
 */
export function defaultEmiStartDate(loanDate, frequency = 'monthly') {
  const from = String(loanDate).slice(0, 10)
  const freq = normalizeEmiFrequency(frequency)
  if (freq === 'weekly') return addDays(from, 7)
  return addDays(from, 30)
}

/**
 * Period end / EMI due date from period start.
 * For both monthly and weekly, periodStart is the due date in the +N day chain.
 */
export function periodEndDate(periodStart, frequency = 'monthly') {
  return String(periodStart).slice(0, 10)
}

/**
 * Next EMI due after the previous due date.
 * Monthly → +30 days · Weekly → +7 days.
 */
export function nextPeriodStartAfter(periodEnd, frequency = 'monthly') {
  const end = String(periodEnd).slice(0, 10)
  const freq = normalizeEmiFrequency(frequency)
  if (freq === 'weekly') return addDays(end, 7)
  return addDays(end, 30)
}

/**
 * First EMI due date — keep as entered (sale+30 / sale+7 by default).
 */
export function normalizePeriodStart(emiStartDate, frequency = 'monthly') {
  return String(emiStartDate).slice(0, 10)
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

  let periodStart = normalizePeriodStart(emiStartDate || defaultEmiStartDate(dateOnly(), freq), freq)
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
  const d = new Date(`${dueDate}T12:00:00`)
  return lastDayOfMonth(d.getFullYear(), d.getMonth() + months)
}
