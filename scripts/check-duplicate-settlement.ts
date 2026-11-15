import { loadEnvFile } from "node:process";
import { Pool } from "pg";
import { createPublicClient, http, parseAbi } from "viem";
import { FUJI_FUSD } from "../src/fuji.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const runId = process.argv[2];
if (!runId || !/^[0-9a-f-]{36}$/iu.test(runId))
  throw new Error("Pass a settled Run ID");
if (
  !process.env.DATABASE_URL ||
  !process.env.FACET_FACILITATOR_TOKEN ||
  !process.env.FACET_DEMO_PAY_TO
)
  throw new Error("LOCAL_CONFIG_MISSING");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await pool.query<{
    payment_payload: { payload?: { authorization?: { from?: string } } };
    payment_tx_hash: string;
    payment_state: string;
  }>(
    "SELECT payment_payload,payment_tx_hash,payment_state FROM facet_demo_runs WHERE id=$1",
    [runId],
  );
  const run = result.rows[0];
  if (
    !run ||
    run.payment_state !== "SETTLED" ||
    !run.payment_payload ||
    !run.payment_tx_hash
  )
    throw new Error("RUN_NOT_SETTLED");
  const payer = run.payment_payload.payload?.authorization?.from;
  if (!payer || !/^0x[a-f0-9]{40}$/iu.test(payer))
    throw new Error("PAYER_NOT_FOUND");
  const rpc =
    process.env.FACET_FUJI_RPC_URL ??
    "https://api.avax-test.network/ext/bc/C/rpc";
  const client = createPublicClient({
    transport: http(rpc, { timeout: 15_000 }),
  });
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const balance = () =>
    client.readContract({
      address: FUJI_FUSD,
      abi,
      functionName: "balanceOf",
      args: [payer as `0x${string}`],
    });
  const before = await balance();
  const response = await fetch("http://127.0.0.1:4022/settle", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-facet-facilitator-token": process.env.FACET_FACILITATOR_TOKEN,
    },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: run.payment_payload,
      paymentRequirements: {
        scheme: "exact",
        network: "eip155:43113",
        asset: FUJI_FUSD,
        amount: process.env.FACET_DEMO_AMOUNT_ATOMIC ?? "1000",
        payTo: process.env.FACET_DEMO_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "FACET USD", version: "2" },
      },
    }),
    signal: AbortSignal.timeout(40_000),
  });
  const settled = (await response.json()) as {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
  };
  if (
    settled.success &&
    settled.transaction?.toLowerCase() !== run.payment_tx_hash.toLowerCase()
  )
    throw new Error("SECOND_SETTLEMENT_TRANSACTION");
  const after = await balance();
  if (after !== before)
    throw new Error("DUPLICATE_SETTLEMENT_TRANSFERRED_AGAIN");
  process.stdout.write(
    JSON.stringify({
      runId,
      httpStatus: response.status,
      success: settled.success ?? false,
      sameTransaction:
        settled.transaction?.toLowerCase() ===
        run.payment_tx_hash.toLowerCase(),
      payerBalanceUnchanged: true,
      errorReason: settled.errorReason ?? null,
    }) + "\n",
  );
} finally {
  await pool.end();
}
