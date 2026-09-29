BEGIN;
-- Sponsored submission of dual-signed offline vouchers to the event vault.
ALTER TABLE financial_operations DROP CONSTRAINT IF EXISTS financial_operations_operation_kind_check;
ALTER TABLE financial_operations ADD CONSTRAINT financial_operations_operation_kind_check CHECK (
  operation_kind IN (
    'PAYMENT','CANCELLATION','REFUND','RESERVE_OPEN','RESERVE_RECLAIM','WITHDRAWAL','VOUCHER_SETTLE'
  )
);
COMMIT;
