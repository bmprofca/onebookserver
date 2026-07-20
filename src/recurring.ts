import type {
  Account,
  RecurringBilling,
  RecurringInterval,
  ShopState,
  Transaction,
} from './types.js'
import { newTxId, uniqueTxCreatedAt } from './store.js'

export const RECURRING_INTERVALS: RecurringInterval[] = [
  'daily',
  'weekly',
  'every_15_days',
  'monthly',
  'quarterly',
  'half_yearly',
  'yearly',
]

const MAX_OCCURRENCES_PER_RUN = 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function localDateString(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00`)
  return !Number.isNaN(parsed.getTime()) && localDateString(parsed) === value
}

export function addDays(dateOnly: string, days: number): string {
  const date = new Date(`${dateOnly}T12:00:00`)
  date.setDate(date.getDate() + days)
  return localDateString(date)
}

function addMonths(dateOnly: string, months: number): string {
  const date = new Date(`${dateOnly}T12:00:00`)
  return localDateString(new Date(date.getFullYear(), date.getMonth() + months, 1, 12))
}

export function periodEndDate(
  periodStartDate: string,
  interval: RecurringInterval,
): string {
  if (interval === 'daily') return periodStartDate
  if (interval === 'weekly') return addDays(periodStartDate, 6)
  if (interval === 'every_15_days') {
    const date = new Date(`${periodStartDate}T12:00:00`)
    return date.getDate() <= 15
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-15`
      : localDateString(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12))
  }
  const months =
    interval === 'monthly'
      ? 1
      : interval === 'quarterly'
        ? 3
        : interval === 'half_yearly'
          ? 6
          : 12
  return addDays(addMonths(periodStartDate, months), -1)
}

export function nextPeriodStartDate(
  periodStartDate: string,
  interval: RecurringInterval,
): string {
  if (interval === 'daily') return addDays(periodStartDate, 1)
  if (interval === 'weekly') return addDays(periodStartDate, 7)
  if (interval === 'every_15_days') {
    const date = new Date(`${periodStartDate}T12:00:00`)
    if (date.getDate() <= 15) {
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-16`
    }
    return localDateString(new Date(date.getFullYear(), date.getMonth() + 1, 1, 12))
  }
  if (interval === 'monthly') return addMonths(periodStartDate, 1)
  if (interval === 'quarterly') return addMonths(periodStartDate, 3)
  if (interval === 'half_yearly') return addMonths(periodStartDate, 6)
  return addMonths(periodStartDate, 12)
}

export function daysAfterPeriodEnd(
  periodStartDate: string,
  interval: RecurringInterval,
  billingDate: string,
): number {
  const end = new Date(`${periodEndDate(periodStartDate, interval)}T12:00:00`)
  const bill = new Date(`${billingDate}T12:00:00`)
  return Math.round((bill.getTime() - end.getTime()) / 86_400_000)
}

export function billingDateForPeriod(
  periodStartDate: string,
  interval: RecurringInterval,
  delayDays: number,
): string {
  return addDays(periodEndDate(periodStartDate, interval), delayDays)
}

export function recurringPeriodLabel(
  periodStartDate: string,
  interval: RecurringInterval,
): string {
  const start = new Date(`${periodStartDate}T12:00:00`)
  const month = start.toLocaleString('en-IN', { month: 'short' })
  const year = start.getFullYear()
  if (interval === 'daily') return localDateString(start)
  if (interval === 'weekly') {
    return `${localDateString(start)} to ${periodEndDate(periodStartDate, interval)}`
  }
  if (interval === 'every_15_days') {
    return `${start.getDate() <= 15 ? '1–15' : '16–end'} ${month} ${year}`
  }
  if (interval === 'monthly') return `${month} ${year}`
  if (interval === 'quarterly') return `Q${Math.floor(start.getMonth() / 3) + 1} ${year}`
  if (interval === 'half_yearly') return `${start.getMonth() < 6 ? 'H1' : 'H2'} ${year}`
  return String(year)
}

function generatedTransaction(
  state: ShopState,
  schedule: RecurringBilling,
  billingDate: string,
  periodStartDate: string,
): Transaction {
  const createdAt = uniqueTxCreatedAt(
    state.transactions,
    new Date(`${billingDate}T12:00:00`),
  )
  let id = newTxId(new Date(createdAt))
  const ids = new Set(state.transactions.map((tx) => tx.id))
  while (ids.has(id)) id = newTxId(new Date(createdAt))

  return {
    id,
    type: schedule.transactionCategory === 'purchase' ? 'receipt' : 'payment',
    category: schedule.transactionCategory,
    amount: schedule.amount,
    remarks: `${schedule.remarks} · Period ${recurringPeriodLabel(periodStartDate, schedule.interval)}`,
    userId: schedule.createdByUserId,
    userName: schedule.createdByName,
    customerId: schedule.customerId,
    customerName: schedule.customerName,
    customerPhone: schedule.customerPhone,
    cashAccountId: null,
    cashAccountName: null,
    attachmentName: null,
    attachmentPath: null,
    recurringBillingId: schedule.id,
    recurringOccurrenceDate: billingDate,
    serviceId: schedule.serviceId ?? null,
    serviceName: schedule.serviceName ?? null,
    createdAt,
  }
}

function advanceSchedule(schedule: RecurringBilling): void {
  const billedPeriod = schedule.nextPeriodStartDate
  schedule.lastPeriodStartDate = billedPeriod
  schedule.lastRunDate = schedule.nextRunDate
  schedule.nextPeriodStartDate = nextPeriodStartDate(billedPeriod, schedule.interval)
  schedule.nextRunDate = billingDateForPeriod(
    schedule.nextPeriodStartDate,
    schedule.interval,
    schedule.billingDelayDays,
  )
  schedule.updatedAt = new Date().toISOString()
}

export function postNextRecurringBill(
  state: ShopState,
  schedule: RecurringBilling,
): Transaction | null {
  const billingDate = schedule.nextRunDate
  const exists = state.transactions.some(
    (tx) =>
      tx.recurringBillingId === schedule.id &&
      tx.recurringOccurrenceDate === billingDate,
  )
  let transaction: Transaction | null = null
  if (!exists) {
    transaction = generatedTransaction(
      state,
      schedule,
      billingDate,
      schedule.nextPeriodStartDate,
    )
    state.transactions.unshift(transaction)
  }
  advanceSchedule(schedule)
  return transaction
}

export function materializeRecurringBillings(
  state: ShopState,
  today = localDateString(),
): number {
  let created = 0
  for (const schedule of state.recurringBillings) {
    if (!schedule.active || !schedule.autoBilling) continue

    let guard = 0
    while (schedule.nextRunDate <= today && guard < MAX_OCCURRENCES_PER_RUN) {
      if (postNextRecurringBill(state, schedule)) created += 1
      guard += 1
    }
  }
  return created
}

export function createRecurringBilling(input: {
  account: Account
  customer: ShopState['users'][number]
  amount: number
  remarks: string
  interval: RecurringInterval
  effectiveDate: string
  billingDate: string
  transactionCategory: RecurringBilling['transactionCategory']
  autoBilling: boolean
  serviceId?: string | null
  serviceName?: string | null
}): RecurringBilling {
  const now = new Date().toISOString()
  const billingDelayDays = daysAfterPeriodEnd(
    input.effectiveDate,
    input.interval,
    input.billingDate,
  )
  return {
    id: crypto.randomUUID(),
    customerId: input.customer.id,
    customerName: input.customer.name,
    customerPhone: input.customer.phone,
    amount: input.amount,
    remarks: input.remarks,
    serviceId: input.serviceId ?? null,
    serviceName: input.serviceName ?? null,
    transactionCategory: input.transactionCategory,
    interval: input.interval,
    effectiveDate: input.effectiveDate,
    nextPeriodStartDate: input.effectiveDate,
    lastPeriodStartDate: null,
    billingDelayDays,
    nextRunDate: input.billingDate,
    lastRunDate: null,
    autoBilling: input.autoBilling,
    active: true,
    createdByUserId: input.account.id,
    createdByName: input.account.name,
    createdAt: now,
    updatedAt: now,
  }
}
