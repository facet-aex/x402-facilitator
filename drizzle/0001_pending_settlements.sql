CREATE TABLE IF NOT EXISTS facet_x402_pending_settlements (
  payment_key text PRIMARY KEY,
  tx_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
