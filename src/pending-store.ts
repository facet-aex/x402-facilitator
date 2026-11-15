import type { PendingSettlementStore } from "@x402/core/facilitator";
import type { Pool } from "pg";

export class PostgresPendingSettlementStore implements PendingSettlementStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<string | undefined> {
    const result = await this.pool.query<{ tx_hash: string }>(
      "SELECT tx_hash FROM facet_x402_pending_settlements WHERE payment_key=$1",
      [key],
    );
    return result.rows[0]?.tx_hash;
  }

  async set(key: string, txHash: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO facet_x402_pending_settlements(payment_key,tx_hash) VALUES($1,$2) ON CONFLICT(payment_key) DO UPDATE SET tx_hash=EXCLUDED.tx_hash, updated_at=now()",
      [key, txHash],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM facet_x402_pending_settlements WHERE payment_key=$1",
      [key],
    );
  }
}
