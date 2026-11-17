import type { Pool } from "pg";
import type { Hex } from "viem";

export type ContractPhase =
  "DEPOSIT" | "SETTLE_RUN" | "SETTLE_RESULT" | "REFUND" | "RECEIPT";

export interface SignedContractTransaction {
  hash: Hex;
  raw: Hex;
}

export interface PhaseRequest {
  runId: string;
  phase: ContractPhase;
  requestHash: string;
  prepare: () => Promise<SignedContractTransaction>;
  broadcast: (raw: Hex) => Promise<void>;
  receipt: (
    hash: Hex,
  ) => Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null>;
}

export type PhaseResult =
  | { status: "PENDING"; hash: Hex }
  | { status: "CONFIRMED"; hash: Hex; blockNumber: bigint };

/** Serializes contract writes by operator and persists a signed tx before broadcast. */
export async function submitContractPhase(
  pool: Pool,
  request: PhaseRequest,
): Promise<PhaseResult> {
  if (
    !/^[0-9a-f-]{36}$/iu.test(request.runId) ||
    !/^sha256:[0-9a-f]{64}$/iu.test(request.requestHash)
  )
    throw new Error("PHASE_REQUEST_INVALID");
  const db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(43113)");
    const existing = await db.query<{
      request_hash: string;
      tx_hash: Hex;
      raw_tx: Hex;
      status: "PENDING" | "CONFIRMED" | "REVERTED";
      block_number: string | null;
    }>(
      "SELECT request_hash,tx_hash,raw_tx,status,block_number FROM facet_contract_phases WHERE run_id=$1 AND phase=$2",
      [request.runId, request.phase],
    );
    let row = existing.rows[0];
    if (row && row.request_hash !== request.requestHash)
      throw new Error("PHASE_REQUEST_CONFLICT");
    if (row?.status === "REVERTED")
      throw new Error("PHASE_TRANSACTION_REVERTED");
    if (row?.status === "CONFIRMED")
      return {
        status: "CONFIRMED",
        hash: row.tx_hash,
        blockNumber: BigInt(row.block_number!),
      };
    if (!row) {
      const pending = await db.query<{
        run_id: string;
        phase: string;
        tx_hash: Hex;
        raw_tx: Hex;
      }>(
        "SELECT run_id,phase,tx_hash,raw_tx FROM facet_contract_phases WHERE status='PENDING' ORDER BY updated_at LIMIT 1",
      );
      if (pending.rows[0]) {
        const stale = pending.rows[0];
        try {
          await request.broadcast(stale.raw_tx);
        } catch {
          /* check chain receipt */
        }
        let resolved;
        try {
          resolved = await request.receipt(stale.tx_hash);
        } catch {
          resolved = null;
        }
        if (!resolved) throw new Error("OPERATOR_PENDING_TRANSACTION");
        await db.query(
          "UPDATE facet_contract_phases SET status=$3,block_number=$4,updated_at=now() WHERE run_id=$1 AND phase=$2",
          [
            stale.run_id,
            stale.phase,
            resolved.status === "success" ? "CONFIRMED" : "REVERTED",
            resolved.blockNumber.toString(),
          ],
        );
      }
      const signed = await request.prepare();
      await db.query(
        "INSERT INTO facet_contract_phases(run_id,phase,request_hash,tx_hash,raw_tx,status) VALUES($1,$2,$3,$4,$5,'PENDING')",
        [
          request.runId,
          request.phase,
          request.requestHash,
          signed.hash,
          signed.raw,
        ],
      );
      row = {
        request_hash: request.requestHash,
        tx_hash: signed.hash,
        raw_tx: signed.raw,
        status: "PENDING",
        block_number: null,
      };
    }
    try {
      await request.broadcast(row.raw_tx);
    } catch {
      /* Reconcile saved hash below. */
    }
    let receipt;
    try {
      receipt = await request.receipt(row.tx_hash);
    } catch {
      receipt = null;
    }
    if (!receipt) return { status: "PENDING", hash: row.tx_hash };
    if (receipt.status !== "success") {
      await db.query(
        "UPDATE facet_contract_phases SET status='REVERTED',block_number=$3,updated_at=now() WHERE run_id=$1 AND phase=$2",
        [request.runId, request.phase, receipt.blockNumber.toString()],
      );
      throw new Error("PHASE_TRANSACTION_REVERTED");
    }
    await db.query(
      "UPDATE facet_contract_phases SET status='CONFIRMED',block_number=$3,updated_at=now() WHERE run_id=$1 AND phase=$2",
      [request.runId, request.phase, receipt.blockNumber.toString()],
    );
    return {
      status: "CONFIRMED",
      hash: row.tx_hash,
      blockNumber: receipt.blockNumber,
    };
  } finally {
    try {
      await db.query("SELECT pg_advisory_unlock(43113)");
    } finally {
      db.release();
    }
  }
}
