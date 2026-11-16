import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { submitContractPhase } from "../src/contract-phase-store.js";

test.skipIf(process.env.FACET_DB_TEST !== "1")(
  "persists a signed transaction before broadcast and reconciles the same hash after timeout",
  async () => {
    loadEnvFile();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const runId = randomUUID();
    const hash = `0x${"a".repeat(64)}` as const;
    const raw = `0x${"b".repeat(130)}` as const;
    const requestHash = `sha256:${"c".repeat(64)}`;
    let prepared = 0;
    let broadcasted = 0;
    let mined = false;
    try {
      const request = {
        runId,
        phase: "SETTLE_RUN" as const,
        requestHash,
        prepare: async () => {
          prepared++;
          return { hash, raw };
        },
        broadcast: async (transaction: `0x${string}`) => {
          broadcasted++;
          expect(transaction).toBe(raw);
          const row = await pool.query(
            "SELECT tx_hash,raw_tx FROM facet_contract_phases WHERE run_id=$1 AND phase='SETTLE_RUN'",
            [runId],
          );
          expect(row.rows[0]).toMatchObject({ tx_hash: hash, raw_tx: raw });
          if (!mined) throw new Error("RPC_TIMEOUT");
        },
        receipt: async (transaction: `0x${string}`) => {
          expect(transaction).toBe(hash);
          return mined
            ? { status: "success" as const, blockNumber: 123n }
            : null;
        },
      };
      expect(await submitContractPhase(pool, request)).toEqual({
        status: "PENDING",
        hash,
      });
      mined = true;
      expect(await submitContractPhase(pool, request)).toEqual({
        status: "CONFIRMED",
        hash,
        blockNumber: 123n,
      });
      expect(prepared).toBe(1);
      expect(broadcasted).toBe(2);
      await expect(
        submitContractPhase(pool, {
          ...request,
          requestHash: `sha256:${"d".repeat(64)}`,
        }),
      ).rejects.toThrow("PHASE_REQUEST_CONFLICT");
    } finally {
      await pool.query("DELETE FROM facet_contract_phases WHERE run_id=$1", [
        runId,
      ]);
      await pool.end();
    }
  },
);
