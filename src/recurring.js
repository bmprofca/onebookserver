import { newTxId, uniqueTxCreatedAt } from './store.js';
import {
    APP_TIME_ZONE,
    indiaBillingDateTime,
    isAutoBillTimeReached,
    normalizeAutoBillTime,
    toIndiaDateInput,
} from './time.js';
import { isLive } from './softDelete.js';
export const RECURRING_INTERVALS = [
    'daily',
    'weekly',
    'every_15_days',
    'monthly',
    'quarterly',
    'half_yearly',
    'yearly',
];
const MAX_OCCURRENCES_PER_RUN = 1000;
function pad(value) {
    return String(value).padStart(2, '0');
}
/** Calendar day in Asia/Kolkata (YYYY-MM-DD). */
export function localDateString(date = new Date()) {
    return toIndiaDateInput(date);
}
export function isDateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        return false;
    const parsed = new Date(`${value}T12:00:00`);
    return !Number.isNaN(parsed.getTime()) && localDateString(parsed) === value;
}
export function addDays(dateOnly, days) {
    const date = new Date(`${dateOnly}T12:00:00`);
    date.setDate(date.getDate() + days);
    return localDateString(date);
}
function addMonths(dateOnly, months) {
    const date = new Date(`${dateOnly}T12:00:00`);
    return localDateString(new Date(date.getFullYear(), date.getMonth() + months, 1, 12));
}
export function periodEndDate(periodStartDate, interval) {
    if (interval === 'daily')
        return periodStartDate;
    if (interval === 'weekly')
        return addDays(periodStartDate, 6);
    if (interval === 'every_15_days') {
        const date = new Date(`${periodStartDate}T12:00:00`);
        return date.getDate() <= 15
            ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-15`
            : localDateString(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12));
    }
    const months = interval === 'monthly'
        ? 1
        : interval === 'quarterly'
            ? 3
            : interval === 'half_yearly'
                ? 6
                : 12;
    return addDays(addMonths(periodStartDate, months), -1);
}
export function nextPeriodStartDate(periodStartDate, interval) {
    if (interval === 'daily')
        return addDays(periodStartDate, 1);
    if (interval === 'weekly')
        return addDays(periodStartDate, 7);
    if (interval === 'every_15_days') {
        const date = new Date(`${periodStartDate}T12:00:00`);
        if (date.getDate() <= 15) {
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-16`;
        }
        return localDateString(new Date(date.getFullYear(), date.getMonth() + 1, 1, 12));
    }
    if (interval === 'monthly')
        return addMonths(periodStartDate, 1);
    if (interval === 'quarterly')
        return addMonths(periodStartDate, 3);
    if (interval === 'half_yearly')
        return addMonths(periodStartDate, 6);
    return addMonths(periodStartDate, 12);
}
export function daysAfterPeriodEnd(periodStartDate, interval, billingDate) {
    const end = new Date(`${periodEndDate(periodStartDate, interval)}T12:00:00`);
    const bill = new Date(`${billingDate}T12:00:00`);
    return Math.round((bill.getTime() - end.getTime()) / 86_400_000);
}

/** Bill date may be on/after period start (within or after the period). */
export function isBillingDateAllowed(periodStartDate, billingDate) {
    if (!isDateOnly(periodStartDate) || !isDateOnly(billingDate))
        return false;
    return billingDate >= periodStartDate;
}
export function billingDateForPeriod(periodStartDate, interval, delayDays) {
    return addDays(periodEndDate(periodStartDate, interval), delayDays);
}
export function recurringPeriodLabel(periodStartDate, interval) {
    const start = new Date(`${periodStartDate}T12:00:00+05:30`);
    const month = start.toLocaleString('en-IN', { timeZone: APP_TIME_ZONE, month: 'short' });
    const year = Number(toIndiaDateInput(start).slice(0, 4));
    const day = Number(toIndiaDateInput(start).slice(8, 10));
    const monthIndex = Number(toIndiaDateInput(start).slice(5, 7)) - 1;
    if (interval === 'daily')
        return localDateString(start);
    if (interval === 'weekly') {
        return `${localDateString(start)} to ${periodEndDate(periodStartDate, interval)}`;
    }
    if (interval === 'every_15_days') {
        return `${day <= 15 ? '1–15' : '16–end'} ${month} ${year}`;
    }
    if (interval === 'monthly')
        return `${month} ${year}`;
    if (interval === 'quarterly')
        return `Q${Math.floor(monthIndex / 3) + 1} ${year}`;
    if (interval === 'half_yearly')
        return `${monthIndex < 6 ? 'H1' : 'H2'} ${year}`;
    return String(year);
}
function generatedTransaction(state, schedule, billingDate, periodStartDate, postedAt = new Date()) {
    // Manual: sales/purchase date = when the user posts (editable later in Entry/Sales).
    // Auto: use billing day + configured auto bill time (IST).
    const baseDate = schedule.autoBilling
        ? indiaBillingDateTime(billingDate, schedule.autoBillTime)
        : postedAt;
    const createdAt = uniqueTxCreatedAt(state.transactions, baseDate);
    let id = newTxId(new Date(createdAt));
    const ids = new Set(state.transactions.map((tx) => tx.id));
    while (ids.has(id))
        id = newTxId(new Date(createdAt));
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
    };
}
function advanceSchedule(schedule) {
    const billedPeriod = schedule.nextPeriodStartDate;
    schedule.lastPeriodStartDate = billedPeriod;
    schedule.lastRunDate = schedule.nextRunDate;
    schedule.nextPeriodStartDate = nextPeriodStartDate(billedPeriod, schedule.interval);
    schedule.nextRunDate = billingDateForPeriod(schedule.nextPeriodStartDate, schedule.interval, schedule.billingDelayDays);
    schedule.updatedAt = new Date().toISOString();
}
export function postNextRecurringBill(state, schedule, postedAt = new Date()) {
    const billingDate = schedule.nextRunDate;
    const exists = state.transactions.some((tx) => tx.recurringBillingId === schedule.id &&
        tx.recurringOccurrenceDate === billingDate);
    let transaction = null;
    if (!exists) {
        transaction = generatedTransaction(state, schedule, billingDate, schedule.nextPeriodStartDate, postedAt);
        state.transactions.unshift(transaction);
    }
    advanceSchedule(schedule);
    return transaction;
}

/**
 * Earliest allowed stop date = last generated bill date for this schedule.
 * Past ledger rows stay untouched; stop only blocks future generation.
 */
export function lastGeneratedBillDate(state, schedule) {
    let latest = schedule.lastRunDate || null;
    for (const tx of state.transactions ?? []) {
        if (tx.recurringBillingId !== schedule.id)
            continue;
        const occurrence = tx.recurringOccurrenceDate
            || (typeof tx.createdAt === 'string' ? tx.createdAt.slice(0, 10) : null);
        if (occurrence && (!latest || occurrence > latest))
            latest = occurrence;
    }
    return latest || schedule.effectiveDate || localDateString();
}

/** Earliest resume bill date = day after last generated bill (gap stays unbilled). */
export function minResumeBillingDate(state, schedule) {
    return addDays(lastGeneratedBillDate(state, schedule), 1);
}

/**
 * Reactivate schedule from a chosen period/bill date.
 * Does not rewrite past ledger entries; cursor jumps to resume point so the
 * stopped gap is skipped in calculations and reports.
 */
export function applyResumeSchedule(schedule, { resumePeriodStart, resumeBillingDate }) {
    if (!isDateOnly(resumePeriodStart)) {
        throw new Error('Enter a valid resume period start');
    }
    if (!isDateOnly(resumeBillingDate)) {
        throw new Error('Enter a valid resume bill date');
    }
    if (!isBillingDateAllowed(resumePeriodStart, resumeBillingDate)) {
        throw new Error('Resume bill date must be on or after the period start');
    }
    schedule.active = true;
    schedule.stopDate = null;
    schedule.nextPeriodStartDate = resumePeriodStart;
    schedule.nextRunDate = resumeBillingDate;
    schedule.billingDelayDays = daysAfterPeriodEnd(
        resumePeriodStart,
        schedule.interval,
        resumeBillingDate,
    );
    schedule.updatedAt = new Date().toISOString();
    return schedule;
}

/** Post all due auto-billing schedules (nextRunDate <= today, and time reached on billing day). Called on GET /api/state and after create/update/resume. Manual schedules are never touched here — they appear on the client Pending bill card. */
export function materializeRecurringBillings(state, today = localDateString(), now = new Date()) {
    let created = 0;
    for (const schedule of state.recurringBillings) {
        if (!schedule.active || !schedule.autoBilling || !isLive(schedule))
            continue;
        // Never post bills after an explicit stop date (safety if still marked active).
        const stopCap = schedule.stopDate || null;
        let guard = 0;
        while (
            isAutoBillTimeReached(schedule.nextRunDate, schedule.autoBillTime, now) &&
            guard < MAX_OCCURRENCES_PER_RUN
        ) {
            if (stopCap && schedule.nextRunDate > stopCap)
                break;
            // Safety: never post future calendar days
            if (schedule.nextRunDate > today)
                break;
            if (postNextRecurringBill(state, schedule, now))
                created += 1;
            guard += 1;
        }
    }
    return created;
}
export function createRecurringBilling(input) {
    const now = new Date().toISOString();
    const billingDelayDays = daysAfterPeriodEnd(input.effectiveDate, input.interval, input.billingDate);
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
        autoBillTime: normalizeAutoBillTime(input.autoBillTime),
        active: true,
        stopDate: null,
        createdByUserId: input.account.id,
        createdByName: input.account.name,
        createdAt: now,
        updatedAt: now,
    };
}
