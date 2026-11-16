CREATE TABLE IF NOT EXISTS facet_contract_phases (
  run_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('DEPOSIT', 'SETTLE_RUN', 'SETTLE_RESULT', 'REFUND', 'RECEIPT')),
  request_hash text NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  raw_tx text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REVERTED')),
  block_number bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, phase)
);
