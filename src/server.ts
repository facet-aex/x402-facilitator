import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Pool } from "pg";
import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { createFujiFacilitator } from "./fuji.js";
import { validatePaymentRequest } from "./request-validation.js";
import { settlementRoute } from "./settlement-routing.js";
import { verifyFeeContractConfig } from "./contract-config.js";
import { verifyReceiveAuthorization } from "./receive-auth.js";
import {
  submitContractAction,
  type ContractAction,
} from "./contract-operations.js";
import {
  createReceiptWriter,
  recordPaidReceipt,
} from "./receipt-operations.js";

export interface FacilitatorConfig {
  databaseUrl: string;
  key: Hex;
  rpc: string;
  token: string;
  feeSplitAddress?: Address;
  receiptAddress?: string;
  receiptKey?: string;
  runnerAddress?: string;
  maxAmountAtomic: bigint;
}

export interface FacilitatorAppDeps {
  pool: Pool;
  clients: Awaited<ReturnType<typeof createFujiFacilitator>>;
  token: string;
  feeSplitAddress?: Address;
  maxAmountAtomic: bigint;
  receiptWriter?: Awaited<ReturnType<typeof createReceiptWriter>>;
}

export function parseFacilitatorConfig(
  env: NodeJS.ProcessEnv = process.env,
): FacilitatorConfig {
  const databaseUrl = env.DATABASE_URL;
  const key = env.FACET_FUJI_FACILITATOR_PRIVATE_KEY;
  const rpc =
    env.FACET_FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc";
  const token = env.FACET_FACILITATOR_TOKEN;
  const feeSplitAddress = env.FACET_FEE_SPLIT_ADDRESS?.trim() || undefined;
  const receiptAddress = env.FACET_RECEIPT_LOG_ADDRESS?.trim() || undefined;
  const receiptKey =
    env.FACET_RECEIPT_RECORDER_PRIVATE_KEY?.trim() || undefined;
  const runnerAddress = env.FACET_RUNNER_ADDRESS?.trim() || undefined;
  const maxAmountAtomic = env.FACET_MAX_PAYMENT_ATOMIC ?? "100000";
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
  if (!!receiptAddress !== !!receiptKey)
    throw new Error("RECEIPT_CONFIG_INCOMPLETE");
  if (receiptAddress && !feeSplitAddress)
    throw new Error("RECEIPT_FEE_CONTRACT_REQUIRED");
  return {
    databaseUrl,
    key: key as Hex,
    rpc,
    token,
    feeSplitAddress: feeSplitAddress as Address | undefined,
    receiptAddress,
    receiptKey,
    runnerAddress,
    maxAmountAtomic: BigInt(maxAmountAtomic),
  };
}

export function buildFacilitatorApp({
  pool,
  clients,
  token,
  feeSplitAddress,
  maxAmountAtomic,
  receiptWriter,
}: FacilitatorAppDeps) {
  const { facilitator } = clients;
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
        if (
          !request.body ||
          typeof request.body !== "object" ||
          Array.isArray(request.body)
        )
          return reply.code(400).send({ error: "PAYMENT_REQUEST_INVALID" });
        try {
          validatePaymentRequest(
            { x402Version: 2, ...(request.body as Record<string, unknown>) },
            { maxAmountAtomic },
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          return reply.code(400).send({
            error: /^(PAYMENT_|CONTRACT_)/u.test(code)
              ? code
              : "PAYMENT_REQUEST_INVALID",
          });
        }
      }
      try {
        const result = await submitContractAction(
          pool,
          clients,
          feeSplitAddress,
          phase,
          request.body,
          maxAmountAtomic,
        );
        const extraResult = result as {
          escrowExpiresAt?: string;
          alreadyRefunded?: boolean;
        };
        return reply.code(result.status === "PENDING" ? 202 : 200).send({
          status: result.status,
          transaction: result.hash,
          ...(result.status === "CONFIRMED"
            ? { blockNumber: result.blockNumber.toString() }
            : {}),
          ...(extraResult.escrowExpiresAt
            ? { escrowExpiresAt: extraResult.escrowExpiresAt }
            : {}),
          ...(extraResult.alreadyRefunded ? { alreadyRefunded: true } : {}),
        });
      } catch (error) {
        const code = (error as Error).message;
        if (/^(CONTRACT_|USAGE_|PAYMENT_|PHASE_REQUEST_)/u.test(code))
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
          maxAmountAtomic,
        });
      } catch (error) {
        return reply.code(400).send({ error: (error as Error).message });
      }
      if (
        operation === "settle" &&
        settlementRoute(
          validated.paymentRequirements.payTo,
          feeSplitAddress,
        ) === "CONTRACT"
      )
        return reply
          .code(501)
          .send({ error: "CONTRACT_SETTLEMENT_NOT_CONFIGURED" });
      try {
        if (
          operation === "verify" &&
          feeSplitAddress &&
          settlementRoute(
            validated.paymentRequirements.payTo,
            feeSplitAddress,
          ) === "CONTRACT"
        ) {
          const authType = (
            validated.paymentRequirements.extra as
              { authorizationType?: unknown } | undefined
          )?.authorizationType;
          if (authType !== "ReceiveWithAuthorization") {
            return {
              isValid: false,
              invalidReason: "AUTHORIZATION_TYPE_MISMATCH",
            };
          }
          return await verifyReceiveAuthorization({
            publicClient: clients.publicClient,
            payload: validated.paymentPayload,
            requirements: validated.paymentRequirements,
            expectedRecipient: feeSplitAddress,
          });
        }
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

  return app;
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(entry))
    );
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config = parseFacilitatorConfig(process.env);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    application_name: "facet-x402-facilitator",
  });
  const clients = await createFujiFacilitator(pool, config.rpc, config.key);
  const chainClient = createPublicClient({ transport: http(config.rpc) });
  if (config.feeSplitAddress)
    await verifyFeeContractConfig(
      chainClient,
      config.feeSplitAddress,
      clients.signerAddress,
      config.runnerAddress,
    );
  const balance = await chainClient.getBalance({
    address: clients.signerAddress,
  });
  if (balance === 0n) throw new Error("FUJI_SIGNER_UNFUNDED");
  const receiptWriter =
    config.receiptAddress && config.receiptKey && config.feeSplitAddress
      ? await createReceiptWriter(
          config.rpc,
          config.receiptAddress,
          config.receiptKey,
          config.feeSplitAddress,
        )
      : undefined;
  const app = buildFacilitatorApp({
    pool,
    clients,
    token: config.token,
    feeSplitAddress: config.feeSplitAddress,
    maxAmountAtomic: config.maxAmountAtomic,
    receiptWriter,
  });
  await app.listen({
    host: process.env.FACET_FACILITATOR_HOST ?? "127.0.0.1",
    port: Number(process.env.FACET_FACILITATOR_PORT ?? "4022"),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => pool.end());
    });
}

if (isMainModule(import.meta.url)) {
  await startServer();
}
