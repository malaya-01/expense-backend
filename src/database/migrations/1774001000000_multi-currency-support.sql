-- Up Migration
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country VARCHAR(2);

COMMENT ON COLUMN users.country IS 'ISO 3166-1 alpha-2 country code';
COMMENT ON COLUMN users.currency IS 'User reporting / base currency (ISO 4217)';

ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS exchange_rate DECIMAL(18, 8) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_rate_to_base DECIMAL(18, 8) DEFAULT 1,
  ADD COLUMN IF NOT EXISTS amount_base DECIMAL(14, 2);

COMMENT ON COLUMN ledger_transactions.exchange_rate IS
  'For transfers: destination units received per 1 source unit. Default 1 for same-currency.';
COMMENT ON COLUMN ledger_transactions.fx_rate_to_base IS
  'Units of user base currency per 1 unit of transaction/source currency at post time.';
COMMENT ON COLUMN ledger_transactions.amount_base IS
  'Transaction amount converted to the user base currency for reporting.';

UPDATE ledger_transactions
SET exchange_rate = COALESCE(exchange_rate, 1),
    fx_rate_to_base = COALESCE(fx_rate_to_base, 1),
    amount_base = COALESCE(amount_base, amount)
WHERE amount_base IS NULL;

-- Down Migration
ALTER TABLE ledger_transactions
  DROP COLUMN IF EXISTS amount_base,
  DROP COLUMN IF EXISTS fx_rate_to_base,
  DROP COLUMN IF EXISTS exchange_rate;

ALTER TABLE users
  DROP COLUMN IF EXISTS country;
