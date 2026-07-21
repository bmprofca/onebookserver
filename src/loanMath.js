/**
 * Customer loan helpers — EMI (reducing balance) + month-end schedule.
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

/** Ledger post date = 2 days before EMI due date. */
export function emiLedgerDate(dueDate) {
  return addDays(dueDate, -2)
}

/**
 * First EMI due = last calendar day of the EMI-start month
 * (or next month if EMI start is already that last day).
 */
export function firstEmiDueDate(emiStartDate) {
  const d = new Date(`${emiStartDate}T12:00:00`)
  const endThis = lastDayOfMonth(d.getFullYear(), d.getMonth())
  if (endThis > emiStartDate) return endThis
  return lastDayOfMonth(d.getFullYear(), d.getMonth() + 1)
}

export function addMonthsMonthEnd(dueDate, months) {
  const d = new Date(`${dueDate}T12:00:00`)
  return lastDayOfMonth(d.getFullYear(), d.getMonth() + months)
}

/**
 * Standard reducing-balance EMI.
 * @param {number} principal
 * @param {number} annualRatePercent e.g. 12 for 12% p.a.
 * @param {number} tenureMonths
 */
export function calculateEmi(principal, annualRatePercent, tenureMonths) {
  const P = Number(principal)
  const n = Math.round(Number(tenureMonths))
  const annual = Number(annualRatePercent)
  if (!(P > 0) || !(n > 0)) {
    throw new Error('Principal and tenure (months) must be greater than 0')
  }
  if (!(annual >= 0)) {
    throw new Error('Interest rate cannot be negative')
  }
  const r = annual / 12 / 100
  if (r === 0) {
    return Math.round((P / n) * 100) / 100
  }
  const factor = Math.pow(1 + r, n)
  const emi = (P * r * factor) / (factor - 1)
  return Math.round(emi * 100) / 100
}

/**
 * @returns {Array<{ installmentNo: number, dueDate: string, ledgerDate: string, principalComponent: number, interestComponent: number, emiAmount: number }>}
 */
export function buildAmortizationSchedule(
  principal,
  annualRatePercent,
  tenureMonths,
  emiStartDate,
) {
  const P0 = Number(principal)
  const n = Math.round(Number(tenureMonths))
  const r = Number(annualRatePercent) / 12 / 100
  const emi = calculateEmi(P0, annualRatePercent, n)
  let balance = Math.round(P0 * 100) / 100
  let due = firstEmiDueDate(emiStartDate)
  const rows = []

  for (let i = 1; i <= n; i += 1) {
    const interest = Math.round(balance * r * 100) / 100
    let principalPart =
      i === n ? balance : Math.round((emi - interest) * 100) / 100
    if (principalPart > balance) principalPart = balance
    if (principalPart < 0) principalPart = 0
    const emiAmount = Math.round((principalPart + interest) * 100) / 100
    rows.push({
      installmentNo: i,
      dueDate: due,
      ledgerDate: emiLedgerDate(due),
      principalComponent: principalPart,
      interestComponent: interest,
      emiAmount,
    })
    balance = Math.round((balance - principalPart) * 100) / 100
    if (balance < 0.005) balance = 0
    due = addMonthsMonthEnd(due, 1)
  }
  return rows
}

export function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100
}
