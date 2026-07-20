-- OneBook multi-tenant schema (auto-created by server on startup)
-- Roles:
--   shopkeeper = admin of a shop (adds customers, records txs)
--   customer   = app user who can login with OTP and see their own transactions

-- users: every person who can open the app
-- shops: one shop per shopkeeper
-- transactions.customer_user_id links a tx to a customer user

-- See server/src/db.js ensureSchema() for the live CREATE TABLE statements.
