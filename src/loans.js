import { randomUUID } from 'node:crypto'
import { getPool } from './db.js'
import {
  asDateOnly,
  buildAmortizationSchedule,
  calculateEmi,
  dateOnly,
  emiLedgerDate,
  roundMoney,
} from './loanMath.js'
import { newTxId, uniqueTxCreatedAt } from './store.js'

function newLoanNo(loanDate = dateOnly()) {
  const raw = String(loanDate).replace(/-/g, '')
  const stamp = raw.length >= 8 ? raw.slice(2, 8) : dateOnly().replace(/-/g, '').slice(2)
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `LN${stamp}-${rand}`
}

function loanLabel(loanNo, remarks) {
  const note = String(remarks || '').trim()
  return note ? `${loanNo} · ${note}` : loanNo
}

function mapLoan(row) {
  const startDate = asDateOnly(row.start_date)
  const emiStartDate = asDateOnly(row.emi_start_date) || startDate
  const loanNo =
    row.loan_no == null || row.loan_no === ''
      ? `LN${String(row.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`
      : String(row.loan_no)
  return {
    id: String(row.id),
    loanNo,
    shopAppId: String(row.shop_app_id),
    customerId: String(row.customer_user_id),
    customerName: String(row.customer_name ?? ''),
    customerPhone: String(row.customer_phone ?? ''),
    principal: Number(row.principal),
    outstandingPrincipal: Number(row.outstanding_principal),
    interestRate: Number(row.interest_rate),
    tenureMonths: Number(row.tenure_months),
    emiAmount: Number(row.emi_amount),
    startDate,
    loanDate: startDate,
    emiStartDate,
    nextDueDate: asDateOnly(row.next_due_date),
    status: String(row.status),
    remarks: String(row.remarks ?? ''),
    disbursementTxId: row.disbursement_tx_id == null ? null : String(row.disbursement_tx_id),
    closedAt: row.closed_at
      ? row.closed_at instanceof Date
        ? row.closed_at.toISOString()
        : String(row.closed_at)
      : null,
    preclosureCharge: Number(row.preclosure_charge || 0),
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : new Date(row.updated_at).toISOString(),
  }
}

function mapInstallment(row) {
  const dueDate = asDateOnly(row.due_date)
  return {
    id: String(row.id),
    loanId: String(row.loan_id),
    installmentNo: Number(row.installment_no),
    dueDate,
    ledgerDate: dueDate ? emiLedgerDate(dueDate) : null,
    principalComponent: Number(row.principal_component),
    interestComponent: Number(row.interest_component),
    emiAmount: Number(row.emi_amount),
    status: String(row.status),
    postedTxId: row.posted_tx_id == null ? null : String(row.posted_tx_id),
    paidTxId: row.paid_tx_id == null ? null : String(row.paid_tx_id),
    paidAt: row.paid_at
      ? row.paid_at instanceof Date
        ? row.paid_at.toISOString()
        : String(row.paid_at)
      : null,
  }
}

function pushTx(state, partial) {
  const createdAt = uniqueTxCreatedAt(
    state.transactions,
    partial.createdAt ? new Date(partial.createdAt) : new Date(),
  )
  let id = newTxId(new Date(createdAt))
  const ids = new Set(state.transactions.map((tx) => tx.id))
  while (ids.has(id)) id = newTxId(new Date(createdAt))
  const tx = {
    id,
    type: partial.type,
    category: partial.category,
    amount: roundMoney(partial.amount),
    remarks: partial.remarks,
    userId: partial.userId,
    userName: partial.userName,
    customerId: partial.customerId,
    customerName: partial.customerName,
    customerPhone: partial.customerPhone ?? '',
    cashAccountId: partial.cashAccountId ?? null,
    cashAccountName: partial.cashAccountName ?? null,
    attachmentName: null,
    attachmentPath: null,
    recurringBillingId: null,
    recurringOccurrenceDate: null,
    loanId: partial.loanId ?? null,
    loanInstallmentId: partial.loanInstallmentId ?? null,
    serviceId: null,
    serviceName: null,
    createdAt,
  }
  state.transactions.unshift(tx)
  return tx
}

export async function listLoansForCustomer(shopAppId, customerId) {
  const [rows] = await getPool().query(
    `SELECT * FROM customer_loans
     WHERE shop_app_id = ? AND customer_user_id = ?
     ORDER BY created_at DESC`,
    [shopAppId, customerId],
  )
  return rows.map(mapLoan)
}

export async function getLoanWithSchedule(shopAppId, loanId) {
  const [rows] = await getPool().query(
    `SELECT * FROM customer_loans WHERE shop_app_id = ? AND id = ? LIMIT 1`,
    [shopAppId, loanId],
  )
  if (!rows.length) return null
  const loan = mapLoan(rows[0])
  const [inst] = await getPool().query(
    `SELECT * FROM loan_installments WHERE loan_id = ? ORDER BY installment_no ASC`,
    [loanId],
  )
  return { loan, installments: inst.map(mapInstallment) }
}

export async function createCustomerLoan(state, account, input) {
  const customer = state.users.find(
    (u) => u.id === input.customerId && u.role === 'customer',
  )
  if (!customer) throw new Error('Customer not found')
  const principal = roundMoney(input.principal)
  const interestRate = Number(input.interestRate)
  const tenureMonths = Math.round(Number(input.tenureMonths))
  const loanDate = String(input.loanDate || input.startDate || dateOnly())
  const emiStartDate = String(input.emiStartDate || loanDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(loanDate)) {
    throw new Error('Enter a valid loan date')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emiStartDate)) {
    throw new Error('Enter a valid EMI start date')
  }
  if (emiStartDate < loanDate) {
    throw new Error('EMI start date cannot be before loan date')
  }
  const emiAmount = calculateEmi(principal, interestRate, tenureMonths)
  const schedule = buildAmortizationSchedule(
    principal,
    interestRate,
    tenureMonths,
    emiStartDate,
  )
  const loanId = randomUUID()
  let loanNo = newLoanNo(loanDate)
  // Avoid rare collisions within the shop
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [exists] = await getPool().query(
      `SELECT id FROM customer_loans WHERE shop_app_id = ? AND loan_no = ? LIMIT 1`,
      [state.appId, loanNo],
    )
    if (!exists.length) break
    loanNo = newLoanNo(loanDate)
  }
  const now = new Date()
  const nextDueDate = schedule[0]?.dueDate ?? null
  const remarks = String(input.remarks ?? '').trim() || 'Customer loan'
  const label = loanLabel(loanNo, remarks)

  // 1) Principal Out on customer ledger (loan date).
  const cash = (state.cashAccounts ?? []).find((a) => a.id === input.cashAccountId)
  if (!cash) throw new Error('Select a cash/bank account for disbursement')
  const disbursementTx = pushTx(state, {
    type: 'payment',
    category: 'payment',
    amount: principal,
    remarks: `${label} · Principal Out`,
    userId: account.id,
    userName: account.name,
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone ?? '',
    cashAccountId: cash.id,
    cashAccountName: cash.name,
    loanId,
    createdAt: `${loanDate}T12:00:00`,
  })

  await getPool().query(
    `INSERT INTO customer_loans
      (id, loan_no, shop_app_id, customer_user_id, customer_name, customer_phone,
       principal, outstanding_principal, interest_rate, tenure_months, emi_amount,
       start_date, emi_start_date, next_due_date, status, remarks, disbursement_tx_id,
       closed_at, preclosure_charge, created_by_user_id, created_by_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, 0, ?, ?, ?, ?)`,
    [
      loanId,
      loanNo,
      state.appId,
      customer.id,
      customer.name,
      customer.phone ?? '',
      principal,
      principal,
      interestRate,
      tenureMonths,
      emiAmount,
      loanDate,
      emiStartDate,
      nextDueDate,
      remarks,
      disbursementTx?.id ?? null,
      account.id,
      account.name,
      now,
      now,
    ],
  )

  for (const row of schedule) {
    await getPool().query(
      `INSERT INTO loan_installments
        (id, loan_id, installment_no, due_date, principal_component, interest_component,
         emi_amount, status, posted_tx_id, paid_tx_id, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
      [
        randomUUID(),
        loanId,
        row.installmentNo,
        row.dueDate,
        row.principalComponent,
        row.interestComponent,
        row.emiAmount,
      ],
    )
  }

  // Backdated loans: post every EMI whose ledger date (due − 2 days) is already due.
  await materializeLoanEmis(state, dateOnly())

  return getLoanWithSchedule(state.appId, loanId)
}

/** Post EMIs to ledger 2 days before due date (catch-up for past loans included). */
export async function materializeLoanEmis(state, today = dateOnly()) {
  if (!state.appId) return 0
  const [pendingRows] = await getPool().query(
    `SELECT i.*, l.customer_user_id, l.customer_name, l.customer_phone, l.remarks AS loan_remarks,
            l.loan_no, l.shop_app_id, l.status AS loan_status
     FROM loan_installments i
     INNER JOIN customer_loans l ON l.id = i.loan_id
     WHERE l.shop_app_id = ?
       AND l.status = 'active'
       AND i.status = 'pending'
     ORDER BY i.due_date ASC, i.installment_no ASC`,
    [state.appId],
  )
  const dueRows = pendingRows.filter((row) => {
    const dueDate = asDateOnly(row.due_date)
    if (!dueDate) return false
    return emiLedgerDate(dueDate) <= today
  })
  let created = 0
  for (const row of dueRows) {
    const dueDate = asDateOnly(row.due_date)
    const ledgerDate = dueDate ? emiLedgerDate(dueDate) : today
    const loanNo =
      row.loan_no == null || row.loan_no === ''
        ? `LN${String(row.loan_id).replace(/-/g, '').slice(0, 8).toUpperCase()}`
        : String(row.loan_no)
    const label = loanLabel(loanNo, row.loan_remarks)
    const already = state.transactions.some(
      (tx) => tx.loanInstallmentId === String(row.id) && tx.category === 'sales',
    )
    let postedTx = null
    if (!already) {
      const interest = roundMoney(row.interest_component)
      const principalPart = roundMoney(row.principal_component)
      const emiTotal = roundMoney(row.emi_amount)
      // 2) Interest income Out on customer ledger (2 days before due).
      // Principal was already Out at disbursement — only interest increases due here.
      if (interest > 0) {
        postedTx = pushTx(state, {
          type: 'payment',
          category: 'sales',
          amount: interest,
          remarks: `${label} · Interest income · EMI #${row.installment_no} · Due ${dueDate} · EMI ${emiTotal} (P ${principalPart} + I ${interest})`,
          userId: state.activeUserId || state.users.find((u) => u.role === 'shopkeeper')?.id,
          userName:
            state.users.find((u) => u.id === state.activeUserId)?.name ||
            state.users.find((u) => u.role === 'shopkeeper')?.name ||
            'Shop',
          customerId: String(row.customer_user_id),
          customerName: String(row.customer_name),
          customerPhone: String(row.customer_phone ?? ''),
          loanId: String(row.loan_id),
          loanInstallmentId: String(row.id),
          createdAt: `${ledgerDate}T12:00:00`,
        })
        created += 1
      }
    }
    const txId =
      postedTx?.id ||
      state.transactions.find((tx) => tx.loanInstallmentId === String(row.id))?.id ||
      null
    await getPool().query(
      `UPDATE loan_installments SET status = 'due', posted_tx_id = COALESCE(?, posted_tx_id) WHERE id = ?`,
      [txId, row.id],
    )
  }

  // Refresh next_due_date on active loans
  const [active] = await getPool().query(
    `SELECT id FROM customer_loans WHERE shop_app_id = ? AND status = 'active'`,
    [state.appId],
  )
  for (const loan of active) {
    const [next] = await getPool().query(
      `SELECT due_date FROM loan_installments
       WHERE loan_id = ? AND status IN ('pending','due')
       ORDER BY installment_no ASC LIMIT 1`,
      [loan.id],
    )
    const nextDue = asDateOnly(next[0]?.due_date)
    await getPool().query(
      `UPDATE customer_loans SET next_due_date = ?, updated_at = ? WHERE id = ?`,
      [nextDue, new Date(), loan.id],
    )
  }
  return created
}

export async function payLoanEmi(
  state,
  account,
  loanId,
  installmentId,
  cashAccountId,
  amountOverride = null,
) {
  const detail = await getLoanWithSchedule(state.appId, loanId)
  if (!detail || detail.loan.status !== 'active') {
    throw new Error('Active loan not found')
  }
  const inst = detail.installments.find((i) => i.id === installmentId)
  if (!inst) throw new Error('Installment not found')
  if (inst.status === 'paid') throw new Error('Installment already paid')

  // Ensure EMI is on the ledger first (allows early pay before the auto post day)
  if (inst.status === 'pending') {
    await materializeLoanEmis(state, emiLedgerDate(inst.dueDate))
  }

  const cash = (state.cashAccounts ?? []).find((a) => a.id === cashAccountId)
  if (!cash) throw new Error('Cash account not found')

  const refreshed = await getLoanWithSchedule(state.appId, loanId)
  const row = refreshed.installments.find((i) => i.id === installmentId)
  if (!row || row.status === 'paid') throw new Error('Installment not payable')

  const payAmount =
    amountOverride != null && Number(amountOverride) > 0
      ? roundMoney(amountOverride)
      : row.emiAmount
  if (!(payAmount > 0)) throw new Error('Enter a valid EMI amount')

  const payTx = pushTx(state, {
    type: 'receipt',
    category: 'receipt',
    amount: payAmount,
    remarks: `${loanLabel(detail.loan.loanNo, detail.loan.remarks)} · EMI #${row.installmentNo} payment · In`,
    userId: account.id,
    userName: account.name,
    customerId: detail.loan.customerId,
    customerName: detail.loan.customerName,
    customerPhone: detail.loan.customerPhone,
    cashAccountId: cash.id,
    cashAccountName: cash.name,
    loanId,
    loanInstallmentId: installmentId,
  })

  const newOutstanding = roundMoney(
    Math.max(0, detail.loan.outstandingPrincipal - row.principalComponent),
  )
  await getPool().query(
    `UPDATE loan_installments
     SET status = 'paid', paid_tx_id = ?, paid_at = ?
     WHERE id = ?`,
    [payTx.id, new Date(), installmentId],
  )

  const [next] = await getPool().query(
    `SELECT due_date FROM loan_installments
     WHERE loan_id = ? AND status IN ('pending','due')
     ORDER BY installment_no ASC LIMIT 1`,
    [loanId],
  )
  const nextDue = asDateOnly(next[0]?.due_date)
  const allPaid = !nextDue
  await getPool().query(
    `UPDATE customer_loans
     SET outstanding_principal = ?, next_due_date = ?, status = ?, closed_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      newOutstanding,
      nextDue,
      allPaid ? 'closed' : 'active',
      allPaid ? new Date() : null,
      new Date(),
      loanId,
    ],
  )

  return getLoanWithSchedule(state.appId, loanId)
}

export async function precloseLoan(state, account, loanId, preclosureCharge, cashAccountId) {
  const detail = await getLoanWithSchedule(state.appId, loanId)
  if (!detail || detail.loan.status !== 'active') {
    throw new Error('Active loan not found')
  }
  const charge = roundMoney(Math.max(0, Number(preclosureCharge) || 0))
  const outstanding = roundMoney(detail.loan.outstandingPrincipal)
  const closingAmount = roundMoney(outstanding + charge)
  const cash = (state.cashAccounts ?? []).find((a) => a.id === cashAccountId)
  if (!cash) throw new Error('Cash account not found')

  const loanNo = detail.loan.loanNo || loanId.slice(0, 8).toUpperCase()
  const label = loanLabel(loanNo, detail.loan.remarks)
  const postedOn = dateOnly()
  const loanDate = detail.loan.loanDate || detail.loan.startDate
  const loanDetails =
    `${loanNo} · Principal ${roundMoney(detail.loan.principal)} · ` +
    `Outstanding ${outstanding} · ${detail.loan.tenureMonths} mo @ ${detail.loan.interestRate}% · ` +
    `EMI ${roundMoney(detail.loan.emiAmount)} · Loan date ${loanDate}`

  // Clear unpaid billed interest (principal is already on ledger from disbursement).
  const unpaidDue = detail.installments.filter((i) => i.status === 'due')
  const billedInterest = roundMoney(
    unpaidDue.reduce((sum, i) => sum + Number(i.interestComponent), 0),
  )
  if (billedInterest > 0) {
    pushTx(state, {
      type: 'receipt',
      category: 'adjustment',
      amount: billedInterest,
      remarks: `${label} · Pre-closure clear billed interest · Posted ${postedOn}`,
      userId: account.id,
      userName: account.name,
      customerId: detail.loan.customerId,
      customerName: detail.loan.customerName,
      customerPhone: detail.loan.customerPhone,
      loanId,
      createdAt: `${postedOn}T12:00:00`,
    })
  }

  // Pre-closure charge as Out on customer ledger (named clearly + loan details + posting date).
  if (charge > 0) {
    pushTx(state, {
      type: 'payment',
      category: 'sales',
      amount: charge,
      remarks: `Pre-closure charge · ${loanDetails} · Posted ${postedOn}`,
      userId: account.id,
      userName: account.name,
      customerId: detail.loan.customerId,
      customerName: detail.loan.customerName,
      customerPhone: detail.loan.customerPhone,
      loanId,
      createdAt: `${postedOn}T12:00:00`,
    })
  }

  if (closingAmount > 0) {
    pushTx(state, {
      type: 'receipt',
      category: 'receipt',
      amount: closingAmount,
      remarks:
        `${label} · Pre-closure payment · Principal ${outstanding}` +
        `${charge ? ` + Pre-closure charge ${charge}` : ''} · Posted ${postedOn}`,
      userId: account.id,
      userName: account.name,
      customerId: detail.loan.customerId,
      customerName: detail.loan.customerName,
      customerPhone: detail.loan.customerPhone,
      cashAccountId: cash.id,
      cashAccountName: cash.name,
      loanId,
      createdAt: `${postedOn}T12:00:00`,
    })
  }

  const closedAt = new Date()
  await getPool().query(
    `UPDATE loan_installments
     SET status = 'waived'
     WHERE loan_id = ? AND status IN ('pending','due')`,
    [loanId],
  )
  await getPool().query(
    `UPDATE customer_loans
     SET outstanding_principal = 0, next_due_date = NULL, status = 'closed',
         preclosure_charge = ?, closed_at = ?, updated_at = ?
     WHERE id = ?`,
    [charge, closedAt, closedAt, loanId],
  )

  return getLoanWithSchedule(state.appId, loanId)
}

/**
 * Edit loan note always.
 * Terms (amount / rate / tenure / dates) only if active and no EMI paid or interest posted yet.
 */
export async function updateCustomerLoan(state, loanId, input) {
  const detail = await getLoanWithSchedule(state.appId, loanId)
  if (!detail) throw new Error('Loan not found')
  const loan = detail.loan
  const installments = detail.installments
  const hasPaid = installments.some((i) => i.status === 'paid')
  const hasPostedInterest = installments.some(
    (i) => i.status === 'due' || Boolean(i.postedTxId),
  )
  const canEditTerms =
    loan.status === 'active' && !hasPaid && !hasPostedInterest

  const remarks =
    input.remarks === undefined
      ? loan.remarks
      : String(input.remarks ?? '').trim() || 'Customer loan'

  if (!canEditTerms) {
    await getPool().query(
      `UPDATE customer_loans SET remarks = ?, updated_at = ? WHERE id = ? AND shop_app_id = ?`,
      [remarks, new Date(), loanId, state.appId],
    )
    // Refresh remarks on future-facing labels is enough
    return getLoanWithSchedule(state.appId, loanId)
  }

  const principal = roundMoney(
    input.principal === undefined ? loan.principal : input.principal,
  )
  const interestRate = Number(
    input.interestRate === undefined ? loan.interestRate : input.interestRate,
  )
  const tenureMonths = Math.round(
    Number(input.tenureMonths === undefined ? loan.tenureMonths : input.tenureMonths),
  )
  const loanDate = String(
    input.loanDate || input.startDate || loan.loanDate || loan.startDate,
  )
  const emiStartDate = String(
    input.emiStartDate || loan.emiStartDate || loanDate,
  )
  if (!/^\d{4}-\d{2}-\d{2}$/.test(loanDate)) {
    throw new Error('Enter a valid loan date')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emiStartDate)) {
    throw new Error('Enter a valid EMI start date')
  }
  if (emiStartDate < loanDate) {
    throw new Error('EMI start date cannot be before loan date')
  }
  if (!(principal > 0)) throw new Error('Principal must be greater than 0')
  if (!(tenureMonths > 0)) throw new Error('Tenure must be greater than 0')
  if (!(interestRate >= 0)) throw new Error('Interest rate cannot be negative')

  const emiAmount = calculateEmi(principal, interestRate, tenureMonths)
  const schedule = buildAmortizationSchedule(
    principal,
    interestRate,
    tenureMonths,
    emiStartDate,
  )
  const nextDueDate = schedule[0]?.dueDate ?? null

  // Update disbursement ledger amount / date if principal or loan date changed
  if (loan.disbursementTxId) {
    const tx = state.transactions.find((t) => t.id === loan.disbursementTxId)
    if (tx) {
      tx.amount = principal
      tx.createdAt = uniqueTxCreatedAt(
        state.transactions.filter((t) => t.id !== tx.id),
        new Date(`${loanDate}T12:00:00`),
      )
      const label = loanLabel(loan.loanNo, remarks)
      tx.remarks = `${label} · Principal Out`
    }
  }

  await getPool().query(
    `UPDATE customer_loans
     SET principal = ?, outstanding_principal = ?, interest_rate = ?, tenure_months = ?,
         emi_amount = ?, start_date = ?, emi_start_date = ?, next_due_date = ?,
         remarks = ?, updated_at = ?
     WHERE id = ? AND shop_app_id = ?`,
    [
      principal,
      principal,
      interestRate,
      tenureMonths,
      emiAmount,
      loanDate,
      emiStartDate,
      nextDueDate,
      remarks,
      new Date(),
      loanId,
      state.appId,
    ],
  )

  await getPool().query(`DELETE FROM loan_installments WHERE loan_id = ?`, [loanId])
  for (const row of schedule) {
    await getPool().query(
      `INSERT INTO loan_installments
        (id, loan_id, installment_no, due_date, principal_component, interest_component,
         emi_amount, status, posted_tx_id, paid_tx_id, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
      [
        randomUUID(),
        loanId,
        row.installmentNo,
        row.dueDate,
        row.principalComponent,
        row.interestComponent,
        row.emiAmount,
      ],
    )
  }

  await materializeLoanEmis(state, dateOnly())
  return getLoanWithSchedule(state.appId, loanId)
}

export { calculateEmi, buildAmortizationSchedule }

function monthKeyFromDate(dateStr) {
  return String(dateStr || '').slice(0, 7)
}

function nextMonthKey(today = dateOnly()) {
  const d = new Date(`${today}T12:00:00`)
  d.setMonth(d.getMonth() + 1)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export async function listLoansForShop(shopAppId) {
  const [rows] = await getPool().query(
    `SELECT * FROM customer_loans
     WHERE shop_app_id = ?
     ORDER BY FIELD(status, 'active', 'closed'), created_at DESC`,
    [shopAppId],
  )
  return rows.map(mapLoan)
}

/**
 * Shop-wide loan list + income / outstanding stats for the home Loans hub.
 */
export async function getShopLoanOverview(state, today = dateOnly()) {
  if (!state?.appId) {
    return {
      loans: [],
      stats: {
        activeCount: 0,
        closedCount: 0,
        outstandingPrincipal: 0,
        monthInterestIncome: 0,
        monthPreclosureIncome: 0,
        nextMonthInterest: 0,
        futureInterest: 0,
      },
    }
  }
  const loans = await listLoansForShop(state.appId)
  const active = loans.filter((l) => l.status === 'active')
  const outstandingPrincipal = roundMoney(
    active.reduce((sum, l) => sum + Number(l.outstandingPrincipal || 0), 0),
  )

  const thisMonth = monthKeyFromDate(today)
  const nextMonth = nextMonthKey(today)

  let monthInterestIncome = 0
  let monthPreclosureIncome = 0
  for (const tx of state.transactions ?? []) {
    if (!tx.loanId || tx.category !== 'sales' || tx.type !== 'payment') continue
    const txMonth = monthKeyFromDate(tx.createdAt)
    if (txMonth !== thisMonth) continue
    const remarks = String(tx.remarks || '')
    if (/Pre-closure charge/i.test(remarks)) {
      monthPreclosureIncome = roundMoney(monthPreclosureIncome + Number(tx.amount || 0))
    } else if (/Interest income/i.test(remarks)) {
      monthInterestIncome = roundMoney(monthInterestIncome + Number(tx.amount || 0))
    }
  }

  const [instRows] = await getPool().query(
    `SELECT i.due_date, i.interest_component, i.status
     FROM loan_installments i
     INNER JOIN customer_loans l ON l.id = i.loan_id
     WHERE l.shop_app_id = ?
       AND l.status = 'active'
       AND i.status IN ('pending', 'due')`,
    [state.appId],
  )

  let nextMonthInterest = 0
  let futureInterest = 0
  for (const row of instRows) {
    const due = asDateOnly(row.due_date)
    const interest = Number(row.interest_component || 0)
    if (!(interest > 0) || !due) continue
    futureInterest += interest
    if (monthKeyFromDate(due) === nextMonth) nextMonthInterest += interest
  }

  return {
    loans,
    stats: {
      activeCount: active.length,
      closedCount: loans.length - active.length,
      outstandingPrincipal,
      monthInterestIncome,
      monthPreclosureIncome,
      nextMonthInterest: roundMoney(nextMonthInterest),
      futureInterest: roundMoney(futureInterest),
    },
  }
}
