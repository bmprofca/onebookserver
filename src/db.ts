import 'dotenv/config'
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return pool
}

export async function initDb(): Promise<Pool> {
  const host = process.env.MYSQL_HOST || 'localhost'
  const port = Number(process.env.MYSQL_PORT || 3306)
  const user = process.env.MYSQL_USER
  const password = process.env.MYSQL_PASSWORD
  const database = process.env.MYSQL_DATABASE

  if (!user || !password || !database) {
    throw new Error('Missing MYSQL_USER, MYSQL_PASSWORD, or MYSQL_DATABASE in .env')
  }

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
    timezone: 'Z',
    connectTimeout: 15000,
    enableKeepAlive: true,
  })

  const conn = await pool.getConnection()
  try {
    await conn.ping()
    console.log(`MySQL connected: ${user}@${host}:${port}/${database}`)
  } finally {
    conn.release()
  }

  await ensureSchema()
  return pool
}

/**
 * Multi-tenant OneBook schema
 * - users: shopkeepers (admin of a shop) + customers (can login & see own txs)
 * - shops: one shop per shopkeeper
 * - customers belong to a shop via users.shop_app_id
 */
async function ensureSchema() {
  const p = getPool()

  // Keep legacy document store for one-time migration
  await p.query(`
    CREATE TABLE IF NOT EXISTS app_documents (
      doc_key VARCHAR(64) NOT NULL PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      phone VARCHAR(15) NOT NULL,
      email VARCHAR(120) NULL,
      role ENUM('shopkeeper','customer') NOT NULL,
      phone_verified TINYINT(1) NOT NULL DEFAULT 0,
      shop_app_id VARCHAR(32) NULL COMMENT 'Shop this user belongs to / owns',
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_users_phone (phone),
      KEY idx_users_shop (shop_app_id),
      KEY idx_users_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS shops (
      app_id VARCHAR(32) NOT NULL PRIMARY KEY,
      shop_name VARCHAR(120) NOT NULL DEFAULT '',
      shop_address VARCHAR(240) NOT NULL DEFAULT '',
      opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
      setup_complete TINYINT(1) NOT NULL DEFAULT 0,
      owner_user_id CHAR(36) NULL,
      active_user_id CHAR(36) NULL,
      action_confirm_code VARCHAR(6) NOT NULL DEFAULT '123456',
      created_at DATETIME(3) NOT NULL,
      KEY idx_shops_owner (owner_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  try {
    await p.query(`
      ALTER TABLE shops
        ADD COLUMN action_confirm_code VARCHAR(6) NOT NULL DEFAULT '123456'
          AFTER active_user_id
    `)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/Duplicate column/i.test(msg)) {
      console.warn('[MySQL] action_confirm_code migrate skipped:', msg)
    }
  }

  try {
    await p.query(`
      UPDATE shops SET action_confirm_code = '123456'
      WHERE action_confirm_code IS NULL OR action_confirm_code = ''
    `)
  } catch (err) {
    console.warn('[MySQL] action_confirm_code backfill skipped:', err instanceof Error ? err.message : err)
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(191) NOT NULL PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      expires_at BIGINT NOT NULL,
      KEY idx_sessions_user (user_id),
      KEY idx_sessions_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS otps (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(15) NOT NULL,
      code VARCHAR(6) NOT NULL,
      purpose ENUM('login','register') NOT NULL,
      expires_at BIGINT NOT NULL,
      KEY idx_otps_lookup (phone, purpose)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      phone VARCHAR(15) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      shop_name VARCHAR(120) NOT NULL DEFAULT '',
      shop_address VARCHAR(240) NOT NULL DEFAULT '',
      role ENUM('shopkeeper','customer') NOT NULL DEFAULT 'shopkeeper',
      created_at DATETIME(3) NOT NULL,
      expires_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS cash_accounts (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      name VARCHAR(120) NOT NULL,
      kind ENUM('cash','bank') NOT NULL DEFAULT 'cash',
      bank_name VARCHAR(120) NULL,
      account_name VARCHAR(120) NULL,
      account_number VARCHAR(64) NULL,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      KEY idx_cash_shop (shop_app_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS bank_accounts (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      bank_name VARCHAR(120) NOT NULL,
      account_name VARCHAR(120) NOT NULL,
      account_number VARCHAR(64) NULL,
      ifsc_code VARCHAR(20) NULL,
      branch VARCHAR(120) NULL,
      opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NULL,
      KEY idx_bank_shop (shop_app_id),
      UNIQUE KEY uq_bank_shop_acct (shop_app_id, account_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  // Move legacy bank rows from cash_accounts → bank_accounts (once)
  try {
    await p.query(`
      INSERT IGNORE INTO bank_accounts
        (id, shop_app_id, bank_name, account_name, account_number, ifsc_code, branch, opening_balance, created_at)
      SELECT
        id,
        shop_app_id,
        COALESCE(NULLIF(TRIM(bank_name), ''), name),
        COALESCE(NULLIF(TRIM(account_name), ''), name),
        NULLIF(TRIM(account_number), ''),
        NULL,
        NULL,
        opening_balance,
        created_at
      FROM cash_accounts
      WHERE kind = 'bank' AND is_system = 0
    `)
    await p.query(`DELETE FROM cash_accounts WHERE kind = 'bank' AND is_system = 0`)
  } catch (err) {
    console.warn('[MySQL] bank_accounts migrate skipped:', err instanceof Error ? err.message : err)
  }

  // Extra columns if an older bank_accounts exists without them
  for (const col of [
    `ADD COLUMN ifsc_code VARCHAR(20) NULL AFTER account_number`,
    `ADD COLUMN branch VARCHAR(120) NULL AFTER ifsc_code`,
    `ADD COLUMN updated_at DATETIME(3) NULL AFTER created_at`,
  ]) {
    try {
      await p.query(`ALTER TABLE bank_accounts ${col}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Duplicate column/i.test(msg)) {
        console.warn('[MySQL] bank_accounts alter skipped:', msg)
      }
    }
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      type ENUM('receipt','payment') NOT NULL,
      category ENUM('receipt','adjustment','sales','payment','purchase') NOT NULL DEFAULT 'receipt',
      amount DECIMAL(14,2) NOT NULL,
      remarks TEXT NOT NULL,
      recorded_by_user_id CHAR(36) NOT NULL,
      recorded_by_name VARCHAR(120) NOT NULL,
      customer_user_id CHAR(36) NULL,
      customer_name VARCHAR(120) NULL,
      customer_phone VARCHAR(15) NULL,
      cash_account_id VARCHAR(64) NULL,
      cash_account_name VARCHAR(120) NULL,
      attachment_name VARCHAR(255) NULL,
      attachment_path VARCHAR(512) NULL,
      recurring_billing_id CHAR(36) NULL,
      recurring_occurrence_date DATE NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_tx_shop (shop_app_id),
      KEY idx_tx_customer (customer_user_id),
      KEY idx_tx_created (created_at),
      KEY idx_tx_recurring (recurring_billing_id, recurring_occurrence_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  try {
    await p.query(`
      ALTER TABLE transactions
        MODIFY COLUMN category ENUM('receipt','adjustment','sales','payment','purchase')
          NOT NULL DEFAULT 'receipt'
    `)
  } catch (err) {
    console.warn('[MySQL] purchase category migrate skipped:', err instanceof Error ? err.message : err)
  }

  // Allow null account on adjustment transactions (existing DBs)
  try {
    await p.query(`
      ALTER TABLE transactions
        MODIFY COLUMN cash_account_id VARCHAR(64) NULL,
        MODIFY COLUMN cash_account_name VARCHAR(120) NULL
    `)
  } catch (err) {
    console.warn('[MySQL] cash_account nullable migrate skipped:', err instanceof Error ? err.message : err)
  }

  try {
    await p.query(`
      ALTER TABLE transactions
        ADD COLUMN attachment_name VARCHAR(255) NULL AFTER cash_account_name,
        ADD COLUMN attachment_path VARCHAR(512) NULL AFTER attachment_name
    `)
  } catch (err) {
    // Duplicate column name = already migrated
    const msg = err instanceof Error ? err.message : String(err)
    if (!/Duplicate column/i.test(msg)) {
      console.warn('[MySQL] attachment columns migrate skipped:', msg)
    }
  }

  for (const column of [
    `ADD COLUMN recurring_billing_id CHAR(36) NULL AFTER attachment_path`,
    `ADD COLUMN recurring_occurrence_date DATE NULL AFTER recurring_billing_id`,
  ]) {
    try {
      await p.query(`ALTER TABLE transactions ${column}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Duplicate column/i.test(msg)) {
        console.warn('[MySQL] recurring transaction column migrate skipped:', msg)
      }
    }
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS recurring_billings (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      customer_user_id CHAR(36) NOT NULL,
      customer_name VARCHAR(120) NOT NULL,
      customer_phone VARCHAR(15) NOT NULL DEFAULT '',
      amount DECIMAL(14,2) NOT NULL,
      remarks VARCHAR(500) NOT NULL DEFAULT '',
      service_id CHAR(36) NULL,
      service_name VARCHAR(160) NULL,
      transaction_category ENUM('sales','purchase') NOT NULL DEFAULT 'sales',
      billing_interval ENUM(
        'daily','weekly','every_15_days','monthly',
        'quarterly','half_yearly','yearly'
      ) NOT NULL,
      effective_date DATE NOT NULL,
      next_period_start_date DATE NOT NULL,
      last_period_start_date DATE NULL,
      billing_delay_days INT NOT NULL DEFAULT 0,
      next_run_date DATE NOT NULL,
      last_run_date DATE NULL,
      auto_billing TINYINT(1) NOT NULL DEFAULT 1,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_by_user_id CHAR(36) NOT NULL,
      created_by_name VARCHAR(120) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_recurring_shop (shop_app_id),
      KEY idx_recurring_customer (customer_user_id),
      KEY idx_recurring_due (active, next_run_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  for (const column of [
    `ADD COLUMN service_id CHAR(36) NULL AFTER remarks`,
    `ADD COLUMN service_name VARCHAR(160) NULL AFTER service_id`,
    `ADD COLUMN transaction_category ENUM('sales','purchase') NOT NULL DEFAULT 'sales' AFTER service_name`,
    `ADD COLUMN next_period_start_date DATE NULL AFTER effective_date`,
    `ADD COLUMN last_period_start_date DATE NULL AFTER next_period_start_date`,
    `ADD COLUMN billing_delay_days INT NOT NULL DEFAULT 0 AFTER last_period_start_date`,
    `ADD COLUMN auto_billing TINYINT(1) NOT NULL DEFAULT 1 AFTER last_run_date`,
  ]) {
    try {
      await p.query(`ALTER TABLE recurring_billings ${column}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Duplicate column/i.test(msg)) {
        console.warn('[MySQL] recurring service column migrate skipped:', msg)
      }
    }
  }

  try {
    await p.query(`
      UPDATE recurring_billings
      SET next_period_start_date = effective_date
      WHERE next_period_start_date IS NULL
    `)
  } catch (err) {
    console.warn('[MySQL] recurring period backfill skipped:', err instanceof Error ? err.message : err)
  }

  for (const column of [
    `ADD COLUMN service_id CHAR(36) NULL AFTER recurring_occurrence_date`,
    `ADD COLUMN service_name VARCHAR(160) NULL AFTER service_id`,
  ]) {
    try {
      await p.query(`ALTER TABLE transactions ${column}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Duplicate column/i.test(msg)) {
        console.warn('[MySQL] transaction service column migrate skipped:', msg)
      }
    }
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS shop_services (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      name VARCHAR(160) NOT NULL,
      amount DECIMAL(14,2) NOT NULL DEFAULT 0,
      description VARCHAR(500) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_services_shop (shop_app_id),
      UNIQUE KEY uq_services_shop_name (shop_app_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await p.query(`
    CREATE TABLE IF NOT EXISTS shop_todos (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      title VARCHAR(200) NOT NULL,
      notes VARCHAR(1000) NOT NULL DEFAULT '',
      activity VARCHAR(40) NOT NULL DEFAULT 'custom',
      due_date DATE NOT NULL,
      due_time CHAR(5) NOT NULL DEFAULT '09:00',
      done TINYINT(1) NOT NULL DEFAULT 0,
      remind_3_days TINYINT(1) NOT NULL DEFAULT 1,
      remind_1_day TINYINT(1) NOT NULL DEFAULT 1,
      remind_due_morning TINYINT(1) NOT NULL DEFAULT 1,
      whatsapp_reminder TINYINT(1) NOT NULL DEFAULT 0,
      customer_user_id CHAR(36) NULL,
      customer_name VARCHAR(120) NULL,
      customer_phone VARCHAR(15) NULL,
      reminded_3_days_on DATE NULL,
      reminded_1_day_on DATE NULL,
      reminded_due_on DATE NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_todos_shop (shop_app_id),
      KEY idx_todos_due (shop_app_id, due_date, done)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  for (const column of [
    `ADD COLUMN activity VARCHAR(40) NOT NULL DEFAULT 'custom' AFTER notes`,
    `ADD COLUMN due_time CHAR(5) NOT NULL DEFAULT '09:00' AFTER due_date`,
    `ADD COLUMN whatsapp_reminder TINYINT(1) NOT NULL DEFAULT 0 AFTER remind_due_morning`,
    `ADD COLUMN customer_user_id CHAR(36) NULL AFTER whatsapp_reminder`,
    `ADD COLUMN customer_name VARCHAR(120) NULL AFTER customer_user_id`,
    `ADD COLUMN customer_phone VARCHAR(15) NULL AFTER customer_name`,
  ]) {
    try {
      await p.query(`ALTER TABLE shop_todos ${column}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/Duplicate column/i.test(msg)) {
        console.warn('[MySQL] shop_todos column migrate skipped:', msg)
      }
    }
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS day_closes (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      close_date DATE NOT NULL,
      opening_balance DECIMAL(14,2) NOT NULL,
      closing_balance DECIMAL(14,2) NOT NULL,
      total_receipts DECIMAL(14,2) NOT NULL,
      total_payments DECIMAL(14,2) NOT NULL,
      transaction_count INT NOT NULL,
      closed_at DATETIME(3) NOT NULL,
      closed_by VARCHAR(120) NOT NULL,
      KEY idx_day_shop (shop_app_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  console.log('[MySQL] Schema ready (users, shops, cash_accounts, bank_accounts, transactions, …)')
}

export async function getDocument<T>(key: string): Promise<T | null> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT payload FROM app_documents WHERE doc_key = :key LIMIT 1',
    { key },
  )
  if (!rows.length) return null
  try {
    return JSON.parse(String(rows[0].payload)) as T
  } catch {
    return null
  }
}

export async function setDocument(key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value)
  await getPool().query<ResultSetHeader>(
    `INSERT INTO app_documents (doc_key, payload)
     VALUES (:key, :payload)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
    { key, payload },
  )
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
