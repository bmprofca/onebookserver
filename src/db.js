import 'dotenv/config';
import mysql from 'mysql2/promise';
let pool = null;

const TRANSIENT_DB_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_ENQUEUE_AFTER_QUIT',
    'POOL_CLOSED',
]);

function isTransientDbError(err) {
    const code = err?.code || err?.errno;
    const msg = String(err?.message || '');
    if (TRANSIENT_DB_CODES.has(code))
        return true;
    return /ECONNRESET|Connection lost|server has gone away|socket hang up/i.test(msg);
}

function friendlyDbError(err) {
    if (!isTransientDbError(err))
        return err;
    const next = new Error('Database connection was reset. Please try again.');
    next.cause = err;
    next.code = err?.code;
    return next;
}

async function withDbRetry(fn, attempts = 3) {
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            if (!isTransientDbError(err) || attempt === attempts - 1) {
                throw friendlyDbError(err);
            }
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
    }
    throw friendlyDbError(lastErr);
}

/** Wrap pool query/execute so stale remote MySQL sockets auto-retry once or twice. */
function wrapPoolWithRetry(rawPool) {
    const origQuery = rawPool.query.bind(rawPool);
    const origExecute = rawPool.execute.bind(rawPool);
    rawPool.query = (...args) => withDbRetry(() => origQuery(...args));
    rawPool.execute = (...args) => withDbRetry(() => origExecute(...args));
    return rawPool;
}

export function getPool() {
    if (!pool) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return pool;
}
export async function initDb() {
    const host = process.env.MYSQL_HOST || 'localhost';
    const port = Number(process.env.MYSQL_PORT || 3306);
    const user = process.env.MYSQL_USER;
    const password = process.env.MYSQL_PASSWORD;
    const database = process.env.MYSQL_DATABASE;
    if (!user || !password || !database) {
        throw new Error('Missing MYSQL_USER, MYSQL_PASSWORD, or MYSQL_DATABASE in .env');
    }
    pool = wrapPoolWithRetry(mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
        maxIdle: 5,
        idleTimeout: 60000,
        namedPlaceholders: true,
        timezone: 'Z',
        connectTimeout: 15000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
    }));
    const conn = await pool.getConnection();
    try {
        await conn.ping();
        console.log(`MySQL connected: ${user}@${host}:${port}/${database}`);
    }
    finally {
        conn.release();
    }
    await ensureSchema();
    return pool;
}
/**
 * Multi-tenant OneBook schema
 * - users: shopkeepers (admin of a shop) + customers (can login & see own txs)
 * - shops: one shop per shopkeeper
 * - customers belong to a shop via users.shop_app_id
 */
async function ensureSchema() {
    const p = getPool();
    // Keep legacy document store for one-time migration
    await p.query(`
    CREATE TABLE IF NOT EXISTS app_documents (
      doc_key VARCHAR(64) NOT NULL PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      phone VARCHAR(15) NOT NULL,
      email VARCHAR(120) NULL,
      role ENUM('shopkeeper','customer') NOT NULL,
      phone_verified TINYINT(1) NOT NULL DEFAULT 0,
      shop_app_id VARCHAR(32) NULL COMMENT 'Shop this user belongs to / owns',
      opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'Signed: +receivable / -payable for customers',
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_users_phone_shop (phone, shop_app_id),
      KEY idx_users_phone (phone),
      KEY idx_users_shop (shop_app_id),
      KEY idx_users_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    // Allow one phone across multiple shops / roles (was global UNIQUE phone)
    try {
        await p.query('ALTER TABLE users DROP INDEX uq_users_phone');
        console.log('[MySQL] Dropped global unique phone index (multi-profile enabled)');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/check that it exists|Can't DROP|Unknown key/i.test(msg)) {
            console.warn('[MySQL] drop uq_users_phone skipped:', msg);
        }
    }
    try {
        await p.query('ALTER TABLE users ADD UNIQUE KEY uq_users_phone_shop (phone, shop_app_id)');
        console.log('[MySQL] Added unique (phone, shop_app_id) for multi-profile');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate key name|already exists/i.test(msg)) {
            console.warn('[MySQL] uq_users_phone_shop migrate skipped:', msg);
        }
    }
    try {
        await p.query('ALTER TABLE users ADD KEY idx_users_phone (phone)');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate key name|already exists/i.test(msg)) {
            console.warn('[MySQL] idx_users_phone migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      ALTER TABLE users
        ADD COLUMN opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0
          COMMENT 'Signed: +receivable / -payable for customers'
          AFTER shop_app_id
    `);
        console.log('[MySQL] Added users.opening_balance');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] users.opening_balance migrate skipped:', msg);
        }
    }
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
  `);
    try {
        await p.query(`
      ALTER TABLE shops
        ADD COLUMN action_confirm_code VARCHAR(6) NOT NULL DEFAULT '123456'
          AFTER active_user_id
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] action_confirm_code migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      UPDATE shops SET action_confirm_code = '123456'
      WHERE action_confirm_code IS NULL OR action_confirm_code = ''
    `);
    }
    catch (err) {
        console.warn('[MySQL] action_confirm_code backfill skipped:', err instanceof Error ? err.message : err);
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
  `);
    await p.query(`
    CREATE TABLE IF NOT EXISTS otps (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(15) NOT NULL,
      code VARCHAR(6) NOT NULL,
      purpose ENUM('login','register') NOT NULL,
      expires_at BIGINT NOT NULL,
      KEY idx_otps_lookup (phone, purpose)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
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
  `);
    await p.query(`
    CREATE TABLE IF NOT EXISTS cash_accounts (
      id VARCHAR(64) NOT NULL,
      shop_app_id VARCHAR(32) NOT NULL,
      name VARCHAR(120) NOT NULL,
      kind ENUM('cash','bank') NOT NULL DEFAULT 'cash',
      bank_name VARCHAR(120) NULL,
      account_name VARCHAR(120) NULL,
      account_number VARCHAR(64) NULL,
      is_system TINYINT(1) NOT NULL DEFAULT 0,
      opening_balance DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (shop_app_id, id),
      KEY idx_cash_shop (shop_app_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    // Legacy installs used global PRIMARY KEY (id) — break multi-shop Cash defaults
    try {
        const [pkRows] = await p.query(`
      SELECT COLUMN_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'cash_accounts'
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `);
        const pkCols = pkRows.map((r) => String(r.COLUMN_NAME));
        if (pkCols.length === 1 && pkCols[0] === 'id') {
            await p.query('ALTER TABLE cash_accounts DROP PRIMARY KEY, ADD PRIMARY KEY (shop_app_id, id)');
            console.log('[MySQL] Migrated cash_accounts PK → (shop_app_id, id)');
        }
    }
    catch (err) {
        console.warn('[MySQL] cash_accounts PK migrate skipped:', err instanceof Error ? err.message : err);
    }
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
  `);
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
    `);
        await p.query(`DELETE FROM cash_accounts WHERE kind = 'bank' AND is_system = 0`);
    }
    catch (err) {
        console.warn('[MySQL] bank_accounts migrate skipped:', err instanceof Error ? err.message : err);
    }
    // Extra columns if an older bank_accounts exists without them
    for (const col of [
        `ADD COLUMN ifsc_code VARCHAR(20) NULL AFTER account_number`,
        `ADD COLUMN branch VARCHAR(120) NULL AFTER ifsc_code`,
        `ADD COLUMN updated_at DATETIME(3) NULL AFTER created_at`,
    ]) {
        try {
            await p.query(`ALTER TABLE bank_accounts ${col}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Duplicate column/i.test(msg)) {
                console.warn('[MySQL] bank_accounts alter skipped:', msg);
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
  `);
    try {
        await p.query(`
      ALTER TABLE transactions
        MODIFY COLUMN category ENUM('receipt','adjustment','sales','payment','purchase')
          NOT NULL DEFAULT 'receipt'
    `);
    }
    catch (err) {
        console.warn('[MySQL] purchase category migrate skipped:', err instanceof Error ? err.message : err);
    }
    // Allow null account on adjustment transactions (existing DBs)
    try {
        await p.query(`
      ALTER TABLE transactions
        MODIFY COLUMN cash_account_id VARCHAR(64) NULL,
        MODIFY COLUMN cash_account_name VARCHAR(120) NULL
    `);
    }
    catch (err) {
        console.warn('[MySQL] cash_account nullable migrate skipped:', err instanceof Error ? err.message : err);
    }
    try {
        await p.query(`
      ALTER TABLE transactions
        ADD COLUMN attachment_name VARCHAR(255) NULL AFTER cash_account_name,
        ADD COLUMN attachment_path VARCHAR(512) NULL AFTER attachment_name
    `);
    }
    catch (err) {
        // Duplicate column name = already migrated
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] attachment columns migrate skipped:', msg);
        }
    }
    for (const column of [
        `ADD COLUMN recurring_billing_id CHAR(36) NULL AFTER attachment_path`,
        `ADD COLUMN recurring_occurrence_date DATE NULL AFTER recurring_billing_id`,
    ]) {
        try {
            await p.query(`ALTER TABLE transactions ${column}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Duplicate column/i.test(msg)) {
                console.warn('[MySQL] recurring transaction column migrate skipped:', msg);
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
  `);
    for (const column of [
        `ADD COLUMN service_id CHAR(36) NULL AFTER remarks`,
        `ADD COLUMN service_name VARCHAR(160) NULL AFTER service_id`,
        `ADD COLUMN transaction_category ENUM('sales','purchase') NOT NULL DEFAULT 'sales' AFTER service_name`,
        `ADD COLUMN next_period_start_date DATE NULL AFTER effective_date`,
        `ADD COLUMN last_period_start_date DATE NULL AFTER next_period_start_date`,
        `ADD COLUMN billing_delay_days INT NOT NULL DEFAULT 0 AFTER last_period_start_date`,
        `ADD COLUMN auto_billing TINYINT(1) NOT NULL DEFAULT 1 AFTER last_run_date`,
        `ADD COLUMN stop_date DATE NULL AFTER active`,
    ]) {
        try {
            await p.query(`ALTER TABLE recurring_billings ${column}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Duplicate column/i.test(msg)) {
                console.warn('[MySQL] recurring service column migrate skipped:', msg);
            }
        }
    }
    try {
        await p.query(`
      UPDATE recurring_billings
      SET next_period_start_date = effective_date
      WHERE next_period_start_date IS NULL
    `);
    }
    catch (err) {
        console.warn('[MySQL] recurring period backfill skipped:', err instanceof Error ? err.message : err);
    }
    for (const column of [
        `ADD COLUMN service_id CHAR(36) NULL AFTER recurring_occurrence_date`,
        `ADD COLUMN service_name VARCHAR(160) NULL AFTER service_id`,
    ]) {
        try {
            await p.query(`ALTER TABLE transactions ${column}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Duplicate column/i.test(msg)) {
                console.warn('[MySQL] transaction service column migrate skipped:', msg);
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
  `);
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
  `);
    for (const column of [
        `ADD COLUMN activity VARCHAR(40) NOT NULL DEFAULT 'custom' AFTER notes`,
        `ADD COLUMN due_time CHAR(5) NOT NULL DEFAULT '09:00' AFTER due_date`,
        `ADD COLUMN whatsapp_reminder TINYINT(1) NOT NULL DEFAULT 0 AFTER remind_due_morning`,
        `ADD COLUMN customer_user_id CHAR(36) NULL AFTER whatsapp_reminder`,
        `ADD COLUMN customer_name VARCHAR(120) NULL AFTER customer_user_id`,
        `ADD COLUMN customer_phone VARCHAR(15) NULL AFTER customer_name`,
    ]) {
        try {
            await p.query(`ALTER TABLE shop_todos ${column}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Duplicate column/i.test(msg)) {
                console.warn('[MySQL] shop_todos column migrate skipped:', msg);
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
  `);
    await p.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_message_logs (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      customer_user_id CHAR(36) NULL,
      customer_name VARCHAR(180) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      kind VARCHAR(40) NOT NULL,
      template_name VARCHAR(120) NOT NULL,
      message_body TEXT NOT NULL,
      status VARCHAR(20) NOT NULL,
      error_message VARCHAR(500) NULL,
      provider_message_id VARCHAR(120) NULL,
      cost_inr DECIMAL(10,4) NOT NULL DEFAULT 0,
      sent_by_user_id CHAR(36) NULL,
      sent_by_name VARCHAR(120) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_wa_shop_created (shop_app_id, created_at),
      KEY idx_wa_shop_status (shop_app_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

    await p.query(`
    CREATE TABLE IF NOT EXISTS shop_whatsapp_config (
      shop_app_id VARCHAR(32) NOT NULL PRIMARY KEY,
      provider VARCHAR(40) NOT NULL DEFAULT 'aisensy',
      api_key VARCHAR(500) NULL,
      project_name VARCHAR(160) NOT NULL DEFAULT '',
      project_id VARCHAR(120) NULL,
      waba_id VARCHAR(120) NULL,
      phone_number_id VARCHAR(120) NULL,
      country_code VARCHAR(8) NOT NULL DEFAULT '91',
      connected TINYINT(1) NOT NULL DEFAULT 0,
      activity_map TEXT NULL,
      connection_status TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

    await p.query(`
    CREATE TABLE IF NOT EXISTS shop_whatsapp_templates (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      name VARCHAR(120) NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'UTILITY',
      language VARCHAR(20) NOT NULL DEFAULT 'en',
      body_text TEXT NOT NULL,
      campaign_name VARCHAR(160) NOT NULL,
      external_id VARCHAR(120) NULL,
      activity VARCHAR(40) NOT NULL DEFAULT 'custom',
      header_format VARCHAR(20) NULL,
      header_media_url TEXT NULL,
      header_text VARCHAR(500) NULL,
      footer_text VARCHAR(500) NULL,
      param_labels TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_wa_tpl_shop (shop_app_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

    await p.query(`
    CREATE TABLE IF NOT EXISTS shop_whatsapp_campaigns (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      name VARCHAR(160) NOT NULL,
      template_id CHAR(36) NULL,
      campaign_name VARCHAR(160) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      last_sent_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_wa_camp_shop (shop_app_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

    await p.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_chat_threads (
      id CHAR(36) NOT NULL PRIMARY KEY,
      shop_app_id VARCHAR(32) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      phone_key VARCHAR(10) NOT NULL,
      customer_user_id CHAR(36) NULL,
      customer_name VARCHAR(180) NOT NULL DEFAULT '',
      assigned_user_id CHAR(36) NULL,
      assigned_user_name VARCHAR(120) NULL,
      unread_count INT NOT NULL DEFAULT 0,
      last_read_at DATETIME(3) NULL,
      last_message_at DATETIME(3) NULL,
      last_message_preview VARCHAR(500) NULL,
      last_message_status VARCHAR(20) NULL,
      last_direction VARCHAR(10) NOT NULL DEFAULT 'out',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_wa_chat_phone (shop_app_id, phone_key),
      KEY idx_wa_chat_shop_updated (shop_app_id, last_message_at),
      KEY idx_wa_chat_shop_unread (shop_app_id, unread_count),
      KEY idx_wa_chat_assigned (shop_app_id, assigned_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

    for (const column of [
        `ADD COLUMN loan_id CHAR(36) NULL AFTER service_name`,
        `ADD COLUMN loan_installment_id CHAR(36) NULL AFTER loan_id`,
    ]) {
        try {
            await p.query(`ALTER TABLE transactions ${column}`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/Duplicate column/i.test(msg)) {
                console.warn('[MySQL] loan transaction column migrate skipped:', msg);
            }
        }
    }
    await p.query(`
    CREATE TABLE IF NOT EXISTS customer_loans (
      id CHAR(36) NOT NULL PRIMARY KEY,
      loan_no VARCHAR(32) NULL,
      shop_app_id VARCHAR(32) NOT NULL,
      customer_user_id CHAR(36) NOT NULL,
      customer_name VARCHAR(120) NOT NULL,
      customer_phone VARCHAR(15) NOT NULL DEFAULT '',
      principal DECIMAL(14,2) NOT NULL,
      outstanding_principal DECIMAL(14,2) NOT NULL,
      down_payment DECIMAL(14,2) NOT NULL DEFAULT 0,
      sale_amount DECIMAL(14,2) NULL,
      interest_rate DECIMAL(8,4) NOT NULL,
      interest_type VARCHAR(20) NOT NULL DEFAULT 'reducing',
      emi_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
      tenure_months INT NOT NULL,
      emi_amount DECIMAL(14,2) NOT NULL,
      start_date DATE NOT NULL,
      emi_start_date DATE NULL,
      next_due_date DATE NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      remarks VARCHAR(500) NOT NULL DEFAULT '',
      disbursement_tx_id CHAR(36) NULL,
      down_payment_tx_id CHAR(36) NULL,
      closed_at DATETIME(3) NULL,
      preclosure_charge DECIMAL(14,2) NOT NULL DEFAULT 0,
      created_by_user_id CHAR(36) NOT NULL,
      created_by_name VARCHAR(120) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_loans_shop (shop_app_id),
      KEY idx_loans_customer (shop_app_id, customer_user_id),
      KEY idx_loans_status (shop_app_id, status, next_due_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN emi_start_date DATE NULL AFTER start_date
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] emi_start_date migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      UPDATE customer_loans
      SET emi_start_date = start_date
      WHERE emi_start_date IS NULL
    `);
    }
    catch (err) {
        console.warn('[MySQL] emi_start_date backfill skipped:', err instanceof Error ? err.message : err);
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN loan_no VARCHAR(32) NULL AFTER id
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] loan_no migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      UPDATE customer_loans
      SET loan_no = CONCAT('LN', UPPER(SUBSTRING(REPLACE(id, '-', ''), 1, 8)))
      WHERE loan_no IS NULL OR loan_no = ''
    `);
    }
    catch (err) {
        console.warn('[MySQL] loan_no backfill skipped:', err instanceof Error ? err.message : err);
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD UNIQUE KEY uq_loans_shop_no (shop_app_id, loan_no)
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate|exists/i.test(msg)) {
            console.warn('[MySQL] loan_no unique migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN interest_type VARCHAR(20) NOT NULL DEFAULT 'reducing' AFTER interest_rate
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] interest_type migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN emi_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly' AFTER interest_type
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] emi_frequency migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN down_payment DECIMAL(14,2) NOT NULL DEFAULT 0 AFTER outstanding_principal
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] down_payment migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN sale_amount DECIMAL(14,2) NULL AFTER down_payment
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] sale_amount migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      ALTER TABLE customer_loans
        ADD COLUMN down_payment_tx_id CHAR(36) NULL AFTER disbursement_tx_id
    `);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/Duplicate column/i.test(msg)) {
            console.warn('[MySQL] down_payment_tx_id migrate skipped:', msg);
        }
    }
    try {
        await p.query(`
      UPDATE customer_loans
      SET sale_amount = principal + COALESCE(down_payment, 0)
      WHERE sale_amount IS NULL
    `);
    }
    catch (err) {
        console.warn('[MySQL] sale_amount backfill skipped:', err instanceof Error ? err.message : err);
    }
    await p.query(`
    CREATE TABLE IF NOT EXISTS loan_installments (
      id CHAR(36) NOT NULL PRIMARY KEY,
      loan_id CHAR(36) NOT NULL,
      installment_no INT NOT NULL,
      due_date DATE NOT NULL,
      principal_component DECIMAL(14,2) NOT NULL,
      interest_component DECIMAL(14,2) NOT NULL,
      emi_amount DECIMAL(14,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      posted_tx_id CHAR(36) NULL,
      paid_tx_id CHAR(36) NULL,
      paid_at DATETIME(3) NULL,
      UNIQUE KEY uq_loan_installment (loan_id, installment_no),
      KEY idx_loan_inst_due (loan_id, status, due_date),
      KEY idx_loan_inst_due_date (due_date, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    console.log('[MySQL] Schema ready (users, shops, cash_accounts, bank_accounts, transactions, …)');
}
export async function getDocument(key) {
    const [rows] = await getPool().query('SELECT payload FROM app_documents WHERE doc_key = :key LIMIT 1', { key });
    if (!rows.length)
        return null;
    try {
        return JSON.parse(String(rows[0].payload));
    }
    catch {
        return null;
    }
}
export async function setDocument(key, value) {
    const payload = JSON.stringify(value);
    await getPool().query(`INSERT INTO app_documents (doc_key, payload)
     VALUES (:key, :payload)
     ON DUPLICATE KEY UPDATE payload = VALUES(payload)`, { key, payload });
}
export async function closeDb() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
