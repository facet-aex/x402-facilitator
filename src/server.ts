import { loadEnvFile } from "node:process";
import Fastify from "fastify";
import { Pool } from "pg";
import { createPublicClient, http, isAddress } from "viem";
import { createFujiFacilitator } from "./fuji.js";
import { validatePaymentRequest } from "./request-validation.js";
import { settlementRoute } from "./settlement-routing.js";
import { verifyFeeContractConfig } from "./contract-config.js";
import {
  submitContractAction,
  type ContractAction,
} from "./contract-operations.js";
import {
  createReceiptWriter,
  recordPaidReceipt,
} from "./receipt-operations.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const databaseUrl = process.env.DATABASE_URL;
const key = process.env.FACET_FUJI_FACILITATOR_PRIVATE_KEY;
const rpc =
  process.env.FACET_FUJI_RPC_URL ??
  "https://api.avax-test.network/ext/bc/C/rpc";
const token = process.env.FACET_FACILITATOR_TOKEN;
const feeSplitAddress = process.env.FACET_FEE_SPLIT_ADDRESS;
const receiptAddress = process.env.FACET_RECEIPT_LOG_ADDRESS;
const receiptKey = process.env.FACET_RECEIPT_RECORDER_PRIVATE_KEY;
const maxAmountAtomic = process.env.FACET_MAX_PAYMENT_ATOMIC ?? "100000";
if (
  !databaseUrl ||
  !key ||
  !/^0x[a-f0-9]{64}$/iu.test(key) ||
  !token ||
  token.length < 32 ||
  !/^[1-9][0-9]*$/u.test(maxAmountAtomic) ||
  (feeSplitAddress !== undefined && !isAddress(feeSplitAddress))
)
  throw new Error("FACILITATOR_CONFIG_INVALID");
const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "facet-x402-facilitator",
});
const clients = await createFujiFacilitator(pool, rpc, key as `0x${string}`);
const { facilitator, signerAddress } = clients;
const chainClient = createPublicClient({ transport: http(rpc) });
if (feeSplitAddress)
  await verifyFeeContractConfig(
    chainClient,
    feeSplitAddress,
    signerAddress,
    process.env.FACET_RUNNER_ADDRESS,
  );
const balance = await chainClient.getBalance({
  address: signerAddress,
});
if (balance === 0n) throw new Error("FUJI_SIGNER_UNFUNDED");
if (!!receiptAddress !== !!receiptKey)
  throw new Error("RECEIPT_CONFIG_INCOMPLETE");
const receiptWriter =
  receiptAddress && receiptKey
    ? await createReceiptWriter(rpc, receiptAddress, receiptKey)
    : undefined;
const app = Fastify({ logger: false, bodyLimit: 65_536 });

app.get("/health/live", async () => ({
  status: "ok",
  network: "eip155:43113",
}));
app.get("/supported", async (request, reply) => {
  if (request.headers["x-facet-facilitator-token"] !== token)
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  return facilitator.getSupported();
});
app.post("/v1/receipt", async (request, reply) => {
  if (request.headers["x-facet-facilitator-token"] !== token)
    return reply.code(401).send({ error: "UNAUTHORIZED" });
  if (!receiptWriter)
    return reply.code(501).send({ error: "RECEIPT_NOT_CONFIGURED" });
  try {
    const result = await recordPaidReceipt(pool, receiptWriter, request.body);
    return reply.code(result.status === "PENDING" ? 202 : 200).send({
      status: result.status,
      transaction: result.hash,
      ...(result.status === "CONFIRMED"
        ? { blockNumber: result.blockNumber.toString() }
        : {}),
    });
  } catch (error) {
    const code = (error as Error).message;
    if (code === "OPERATOR_PENDING_TRANSACTION")
      return reply.code(409).send({ error: code });
    if (/^(RECEIPT_|PHASE_REQUEST_)/u.test(code))
      return reply.code(400).send({ error: code });
    return reply.code(502).send({ error: "RECEIPT_OPERATION_FAILED" });
  }
});
app.post<{ Params: { phase: string } }>(
  "/v1/contract/:phase",
  async (request, reply) => {
    if (request.headers["x-facet-facilitator-token"] !== token)
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    if (!feeSplitAddress)
      return reply
        .code(501)
        .send({ error: "CONTRACT_SETTLEMENT_NOT_CONFIGURED" });
    const phase = request.params.phase as ContractAction;
    if (!["DEPOSIT", "SETTLE_RUN", "SETTLE_RESULT", "REFUND"].includes(phase))
      return reply.code(400).send({ error: "CONTRACT_PHASE_INVALID" });
    if (phase === "DEPOSIT" || phase === "SETTLE_RUN") {
      try {
        validatePaymentRequest(
          { x402Version: 2, ...(request.body as object) },
          { maxAmountAtomic: BigInt(maxAmountAtomic) },
        );
      } catch {
        return reply.code(400).send({ error: "PAYMENT_REQUEST_INVALID" });
      }
    }
    try {
      const result = await submitContractAction(
        pool,
        clients,
        feeSplitAddress,
        phase,
        request.body,
        BigInt(maxAmountAtomic),
      );
      return reply.code(result.status === "PENDING" ? 202 : 200).send({
        status: result.status,
        transaction: result.hash,
        ...(result.status === "CONFIRMED"
          ? { blockNumber: result.blockNumber.toString() }
          : {}),
      });
    } catch (error) {
      const code = (error as Error).message;
      if (/^(CONTRACT_|USAGE_|PAYMENT_AMOUNT_|PHASE_REQUEST_)/u.test(code))
        return reply.code(400).send({ error: code });
      if (code === "OPERATOR_PENDING_TRANSACTION")
        return reply.code(409).send({ error: code });
      return reply.code(502).send({ error: "CONTRACT_OPERATION_FAILED" });
    }
  },
);
for (const operation of ["verify", "settle"] as const) {
  app.post(`/${operation}`, async (request, reply) => {
    if (request.headers["x-facet-facilitator-token"] !== token)
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    let validated;
    try {
      validated = validatePaymentRequest(request.body, {
        maxAmountAtomic: BigInt(maxAmountAtomic),
      });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    if (
      operation === "settle" &&
      settlementRoute(validated.paymentRequirements.payTo, feeSplitAddress) ===
        "CONTRACT"
    )
      return reply
        .code(501)
        .send({ error: "CONTRACT_SETTLEMENT_NOT_CONFIGURED" });
    try {
      return operation === "verify"
        ? await facilitator.verify(
            validated.paymentPayload,
            validated.paymentRequirements,
          )
        : await facilitator.settle(
            validated.paymentPayload,
            validated.paymentRequirements,
          );
    } catch {
      return reply.code(502).send({ error: "FACILITATOR_OPERATION_FAILED" });
    }
  });
}

await app.listen({
  host: process.env.FACET_FACILITATOR_HOST ?? "127.0.0.1",
  port: Number(process.env.FACET_FACILITATOR_PORT ?? "4022"),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
