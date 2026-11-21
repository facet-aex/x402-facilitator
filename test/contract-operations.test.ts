import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  decodeFunctionData,
  parseAbi,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "pg";
import type { createFujiFacilitator } from "../src/fuji.js";
import {
  canonicalJson,
  submitContractAction,
} from "../src/contract-operations.js";
import { buildFacilitatorApp, parseFacilitatorConfig } from "../src/server.js";

const escrowAbi = parseAbi([
  "function depositEscrowWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint64,uint256,uint256,bytes32,bytes)",
  "function settlePayPerRunWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint256,bytes32,bytes)",
  "function settleEscrow(bytes32,bytes32,bytes32,uint256,bytes)",
]);

const PAYER_KEY = `0x${"a".repeat(64)}` as Hex;
const payerAccount = privateKeyToAccount(PAYER_KEY);
const feeSplit = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06" as Address;
const payer = payerAccount.address;
const creator = "0x0000000000000000000000000000000000000002" as Address;
const requirements = {
  scheme: "exact",
  network: "eip155:43113",
  asset: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
  amount: "1000",
  payTo: feeSplit,
  maxTimeoutSeconds: 60,
  extra: { name: "FACET USD", version: "2" },
};
const body = {
  runId: "019a1234-5678-7abc-8def-123456789abc",
  facetId: "019a1234-5678-7abc-8def-123456789abd",
  creatorPayTo: payer,
  unitPriceAtomic: "1000",
  paymentRequirements: requirements,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: {
      authorization: {
        from: payer,
        to: feeSplit,
        value: "1000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"a".repeat(64)}`,
      },
      signature: `0x${"b".repeat(130)}`,
    },
  },
};

interface PhaseRow {
  run_id: string;
  phase: string;
  request_hash: string;
  tx_hash: Hex;
  raw_tx: Hex;
  status: "PENDING" | "CONFIRMED" | "REVERTED";
  block_number: string | null;
}

function createMockPhasePool() {
  const rows = new Map<string, PhaseRow>();
  const pool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM facet_contract_phases WHERE run_id=$1")) {
          const row = rows.get(`${params[0]}:${params[1]}`);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("WHERE status='PENDING'")) {
          const pending = [...rows.values()].find(
            (r) => r.status === "PENDING",
          );
          return { rows: pending ? [pending] : [] };
        }
        if (sql.startsWith("INSERT INTO facet_contract_phases")) {
          const [runId, phase, requestHash, txHash, rawTx] = params as [
            string,
            string,
            string,
            Hex,
            Hex,
          ];
          rows.set(`${runId}:${phase}`, {
            run_id: runId,
            phase,
            request_hash: requestHash,
            tx_hash: txHash,
            raw_tx: rawTx,
            status: "PENDING",
            block_number: null,
          });
          return { rows: [] };
        }
        if (sql.startsWith("UPDATE facet_contract_phases")) {
          const [runId, phase, status, blockNumber] = params as [
            string,
            string,
            "CONFIRMED" | "REVERTED",
            string,
          ];
          const existing = rows.get(`${runId}:${phase}`);
          if (existing) {
            existing.status = status;
            existing.block_number = blockNumber;
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  return { pool, rows };
}

function createMockClients(options?: {
  receiptPendingOnce?: boolean;
  onChainRunState?: number;
  escrowExpiresAtSec?: bigint;
  skipSignatureCheck?: boolean;
}) {
  const preparedData: Hex[] = [];
  let receiptCalls = 0;
  const rawTx = `0x${"f".repeat(130)}` as Hex;
  const expiresAtSec = options?.escrowExpiresAtSec ?? 1_800_000_900n;
  const clients = {
    facilitator: {
      verify: async () => ({ isValid: true, payer }),
      getSupported: async () => ({ kinds: [] }),
    },
    wallet: {
      account: { address: payer },
      chain: { id: 43113 },
      prepareTransactionRequest: async (req: { data: Hex }) => {
        preparedData.push(req.data);
        return req;
      },
      signTransaction: async () => rawTx,
      sendRawTransaction: async () => `0x${"e".repeat(64)}` as Hex,
    },
    publicClient: {
      verifyTypedData: async (args: Parameters<typeof verifyTypedData>[0]) =>
        options?.skipSignatureCheck === false ? verifyTypedData(args) : true,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "authorizationState") return false;
        if (functionName === "balanceOf") return 10_000_000n;
        if (functionName === "runState") return options?.onChainRunState ?? 1;
        if (functionName === "escrows") {
          return [
            `0x${"0".repeat(64)}`,
            payer,
            creator,
            500n,
            5000n,
            expiresAtSec,
          ];
        }
        return 0n;
      },
      waitForTransactionReceipt: async () => {
        receiptCalls++;
        if (options?.receiptPendingOnce && receiptCalls === 1)
          throw new Error("TIMEOUT");
        return { status: "success" as const, blockNumber: 42n, logs: [] };
      },
    },
  } as unknown as Awaited<ReturnType<typeof createFujiFacilitator>>;
  return { clients, preparedData };
}

function makeDepositBody(overrides?: {
  unitPriceAtomic?: string;
  amount?: string;
  maxItemsCap?: unknown;
  includeMaxItemsCap?: boolean;
  creatorPayTo?: string;
  extra?: Record<string, unknown>;
  acceptedExtra?: Record<string, unknown>;
}) {
  const unitPriceAtomic = overrides?.unitPriceAtomic ?? "500";
  const amount = overrides?.amount ?? "5000";
  const creatorPayTo = overrides?.creatorPayTo ?? creator;
  const reqExtra = overrides?.extra ?? {
    name: "FACET USD",
    version: "2",
    pricingModel: "PAY_PER_RESULT",
    unitPriceAtomic,
    maxItemsCap:
      overrides?.maxItemsCap !== undefined ? overrides.maxItemsCap : 10,
    providerPayTo: creatorPayTo,
  };
  const req = {
    ...requirements,
    amount,
    extra: reqExtra,
  };
  const acc = {
    ...req,
    extra: overrides?.acceptedExtra ?? reqExtra,
  };
  const depositBody: Record<string, unknown> = {
    runId: "019a1234-5678-7abc-8def-123456789abc",
    facetId: "019a1234-5678-7abc-8def-123456789abd",
    creatorPayTo,
    unitPriceAtomic,
    paymentRequirements: req,
    paymentPayload: {
      x402Version: 2,
      accepted: acc,
      payload: {
        authorization: {
          from: payer,
          to: feeSplit,
          value: amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"a".repeat(64)}`,
        },
        signature: `0x${"b".repeat(130)}`,
      },
    },
  };
  if (overrides?.includeMaxItemsCap !== false) {
    depositBody.maxItemsCap =
      overrides && "maxItemsCap" in overrides ? overrides.maxItemsCap : 10;
  }
  return depositBody;
}

test("rejects a per-result deposit that is not exactly 20 units before any write", async () => {
  const clients = {} as Awaited<ReturnType<typeof createFujiFacilitator>>;
  const pool = {} as Pool;
  await expect(
    submitContractAction(pool, clients, feeSplit, "DEPOSIT", body, 100000n),
  ).rejects.toThrow("CONTRACT_PRICE_MISMATCH");
});

test("DEPOSIT succeeds with custom maxItemsCap=10 and auth.amount=5000", async () => {
  const { pool } = createMockPhasePool();
  const { clients, preparedData } = createMockClients();
  const depositBody = makeDepositBody({
    unitPriceAtomic: "500",
    maxItemsCap: 10,
    amount: "5000",
  });
  const result = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "DEPOSIT",
    depositBody,
    100000n,
  );
  expect(result.status).toBe("CONFIRMED");
  expect(preparedData).toHaveLength(1);
  const decoded = decodeFunctionData({ abi: escrowAbi, data: preparedData[0] });
  expect(decoded.functionName).toBe("depositEscrowWithAuthorization");
  expect(decoded.args[4]).toBe(500n);
  expect(decoded.args[5]).toBe(5000n);
});

test("DEPOSIT defaults maxItemsCap to 20 when omitted", async () => {
  const { pool } = createMockPhasePool();
  const { clients, preparedData } = createMockClients();
  const depositBody = makeDepositBody({
    unitPriceAtomic: "500",
    amount: "10000",
    includeMaxItemsCap: false,
    extra: {
      name: "FACET USD",
      version: "2",
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 20,
      providerPayTo: creator,
    },
  });
  const result = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "DEPOSIT",
    depositBody,
    100000n,
  );
  expect(result.status).toBe("CONFIRMED");
  const decoded = decodeFunctionData({ abi: escrowAbi, data: preparedData[0] });
  expect(decoded.args[4]).toBe(500n);
  expect(decoded.args[5]).toBe(10000n);
});

test("DEPOSIT rejects invalid maxItemsCap values with CONTRACT_PRICE_MISMATCH", async () => {
  const clients = {} as Awaited<ReturnType<typeof createFujiFacilitator>>;
  const pool = {} as Pool;
  for (const invalidCap of [-1, 0, 1001, 1.5, null, "10"]) {
    const depositBody = makeDepositBody({
      unitPriceAtomic: "500",
      amount: "5000",
      maxItemsCap: invalidCap,
      extra: { name: "FACET USD", version: "2" },
    });
    await expect(
      submitContractAction(
        pool,
        clients,
        feeSplit,
        "DEPOSIT",
        depositBody,
        100000n,
      ),
    ).rejects.toThrow("CONTRACT_PRICE_MISMATCH");
  }
  const mismatchedAmount = makeDepositBody({
    unitPriceAtomic: "500",
    maxItemsCap: 10,
    amount: "10000",
    extra: { name: "FACET USD", version: "2" },
  });
  await expect(
    submitContractAction(
      pool,
      clients,
      feeSplit,
      "DEPOSIT",
      mismatchedAmount,
      100000n,
    ),
  ).rejects.toThrow("CONTRACT_PRICE_MISMATCH");
});

test("DEPOSIT rejects auth.amount exceeding maxAmount with PAYMENT_AMOUNT_EXCEEDS_CAP", async () => {
  const clients = {} as Awaited<ReturnType<typeof createFujiFacilitator>>;
  const pool = {} as Pool;
  const overCap = makeDepositBody({
    unitPriceAtomic: "15000",
    maxItemsCap: 10,
    amount: "150000",
  });
  await expect(
    submitContractAction(pool, clients, feeSplit, "DEPOSIT", overCap, 100000n),
  ).rejects.toThrow("PAYMENT_AMOUNT_EXCEEDS_CAP");
});

test("DEPOSIT rejects zero-address creatorPayTo and mismatched extra metadata", async () => {
  const clients = {} as Awaited<ReturnType<typeof createFujiFacilitator>>;
  const pool = {} as Pool;
  const zeroCreator = makeDepositBody({
    creatorPayTo: "0x0000000000000000000000000000000000000000",
    extra: { name: "FACET USD", version: "2" },
  });
  await expect(
    submitContractAction(
      pool,
      clients,
      feeSplit,
      "DEPOSIT",
      zeroCreator,
      100000n,
    ),
  ).rejects.toThrow("CONTRACT_REQUEST_INVALID");

  const wrongModel = makeDepositBody({
    extra: {
      name: "FACET USD",
      version: "2",
      pricingModel: "PAY_PER_RUN",
      unitPriceAtomic: "5000",
      providerPayTo: creator,
    },
  });
  await expect(
    submitContractAction(
      pool,
      clients,
      feeSplit,
      "DEPOSIT",
      wrongModel,
      100000n,
    ),
  ).rejects.toThrow("CONTRACT_PRICE_MISMATCH");

  const wrongCapInExtra = makeDepositBody({
    unitPriceAtomic: "500",
    maxItemsCap: 10,
    amount: "5000",
    extra: {
      name: "FACET USD",
      version: "2",
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 5,
      providerPayTo: creator,
    },
  });
  await expect(
    submitContractAction(
      pool,
      clients,
      feeSplit,
      "DEPOSIT",
      wrongCapInExtra,
      100000n,
    ),
  ).rejects.toThrow("CONTRACT_PRICE_MISMATCH");

  const wrongProvider = makeDepositBody({
    extra: {
      name: "FACET USD",
      version: "2",
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      providerPayTo: payer,
    },
  });
  await expect(
    submitContractAction(
      pool,
      clients,
      feeSplit,
      "DEPOSIT",
      wrongProvider,
      100000n,
    ),
  ).rejects.toThrow("CONTRACT_RECIPIENT_MISMATCH");
});

test("canonical requestHash matches across reordered paymentPayload keys and omitted vs explicit maxItemsCap=20", async () => {
  const { pool, rows } = createMockPhasePool();
  const { clients } = createMockClients({ receiptPendingOnce: true });
  const initialBody = makeDepositBody({
    unitPriceAtomic: "500",
    amount: "10000",
    includeMaxItemsCap: false,
    extra: {
      name: "FACET USD",
      version: "2",
      pricingModel: "PAY_PER_RESULT",
      unitPriceAtomic: "500",
      maxItemsCap: 20,
      providerPayTo: creator,
    },
  });
  const first = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "DEPOSIT",
    initialBody,
    100000n,
  );
  expect(first.status).toBe("PENDING");

  const req = initialBody.paymentRequirements as typeof requirements & {
    extra: Record<string, unknown>;
  };
  const reorderedBody = {
    unitPriceAtomic: "500",
    maxItemsCap: 20,
    facetId: initialBody.facetId,
    runId: initialBody.runId,
    creatorPayTo: creator,
    paymentRequirements: req,
    paymentPayload: {
      payload: {
        signature: `0x${"b".repeat(130)}`,
        authorization: {
          validBefore: "9999999999",
          nonce: `0x${"a".repeat(64)}`,
          validAfter: "0",
          value: "10000",
          to: feeSplit,
          from: payer,
        },
      },
      accepted: {
        extra: {
          providerPayTo: creator,
          maxItemsCap: 20,
          unitPriceAtomic: "500",
          pricingModel: "PAY_PER_RESULT",
          version: "2",
          name: "FACET USD",
        },
        maxTimeoutSeconds: 60,
        payTo: feeSplit,
        amount: "10000",
        asset: req.asset,
        network: req.network,
        scheme: "exact",
      },
      x402Version: 2,
    },
  };

  const hash1 = `sha256:${createHash("sha256")
    .update(canonicalJson({ ...initialBody, maxItemsCap: 20 }))
    .digest("hex")}`;
  const hash2 = `sha256:${createHash("sha256")
    .update(canonicalJson(reorderedBody))
    .digest("hex")}`;
  expect(hash1).toBe(hash2);
  expect(
    rows.get("019a1234-5678-7abc-8def-123456789abc:DEPOSIT")?.request_hash,
  ).toBe(hash1);

  const retry = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "DEPOSIT",
    reorderedBody,
    100000n,
  );
  expect(retry.status).toBe("CONFIRMED");
});

test("POST /v1/contract/:phase forwards exact 400 error codes and empty FACET_FEE_SPLIT_ADDRESS is undefined", async () => {
  const token = "t".repeat(32);
  const parsed = parseFacilitatorConfig({
    DATABASE_URL: "postgres://facet:facet@127.0.0.1:5432/facet",
    FACET_FUJI_FACILITATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    FACET_FACILITATOR_TOKEN: token,
    FACET_FEE_SPLIT_ADDRESS: "",
  });
  expect(parsed.feeSplitAddress).toBeUndefined();

  const { pool } = createMockPhasePool();
  const { clients } = createMockClients();
  const app = buildFacilitatorApp({
    pool,
    clients,
    token,
    feeSplitAddress: feeSplit,
    maxAmountAtomic: 100000n,
  });

  const overCap = makeDepositBody({
    unitPriceAtomic: "15000",
    maxItemsCap: 10,
    amount: "150000",
  });
  const resOverCap = await app.inject({
    method: "POST",
    url: "/v1/contract/DEPOSIT",
    headers: { "x-facet-facilitator-token": token },
    payload: overCap,
  });
  expect(resOverCap.statusCode).toBe(400);
  expect(resOverCap.json()).toEqual({ error: "PAYMENT_AMOUNT_EXCEEDS_CAP" });

  const badExtra = makeDepositBody({
    unitPriceAtomic: "500",
    maxItemsCap: 10,
    amount: "4000",
  });
  const resBadReq = await app.inject({
    method: "POST",
    url: "/v1/contract/DEPOSIT",
    headers: { "x-facet-facilitator-token": token },
    payload: badExtra,
  });
  expect(resBadReq.statusCode).toBe(400);
  expect(resBadReq.json()).toEqual({ error: "PAYMENT_REQUIREMENTS_MISMATCH" });

  const mismatchAccepted = makeDepositBody({
    unitPriceAtomic: "500",
    maxItemsCap: 20,
    amount: "10000",
    acceptedExtra: {
      name: "FACET USD",
      version: "2",
      pricingModel: "PAY_PER_RUN",
      unitPriceAtomic: "10000",
      providerPayTo: creator,
    },
  });
  const resBadAccepted = await app.inject({
    method: "POST",
    url: "/v1/contract/DEPOSIT",
    headers: { "x-facet-facilitator-token": token },
    payload: mismatchAccepted,
  });
  expect(resBadAccepted.statusCode).toBe(400);
  expect(resBadAccepted.json()).toEqual({ error: "PAYMENT_ACCEPTED_MISMATCH" });

  const resNonObject = await app.inject({
    method: "POST",
    url: "/v1/contract/DEPOSIT",
    headers: {
      "x-facet-facilitator-token": token,
      "content-type": "application/json",
    },
    payload: JSON.stringify([1, 2, 3]),
  });
  expect(resNonObject.statusCode).toBe(400);
  expect(resNonObject.json()).toEqual({ error: "PAYMENT_REQUEST_INVALID" });

  const invalidCapLegacyExtra = makeDepositBody({
    unitPriceAtomic: "500",
    maxItemsCap: 0,
    amount: "5000",
    extra: { name: "FACET USD", version: "2" },
  });
  const resBadCap = await app.inject({
    method: "POST",
    url: "/v1/contract/DEPOSIT",
    headers: { "x-facet-facilitator-token": token },
    payload: invalidCapLegacyExtra,
  });
  expect(resBadCap.statusCode).toBe(400);
  expect(resBadCap.json()).toEqual({ error: "CONTRACT_PRICE_MISMATCH" });

  const resVerifyOverCap = await app.inject({
    method: "POST",
    url: "/verify",
    headers: { "x-facet-facilitator-token": token },
    payload: {
      x402Version: 2,
      paymentRequirements: overCap.paymentRequirements,
      paymentPayload: overCap.paymentPayload,
    },
  });
  expect(resVerifyOverCap.statusCode).toBe(400);
  expect(resVerifyOverCap.json()).toEqual({
    error: "PAYMENT_AMOUNT_EXCEEDS_CAP",
  });

  await app.close();
});

test("DEPOSIT supports boundary maxItemsCap 1 and 1000, and SETTLE_RUN enforces PAY_PER_RUN extra", async () => {
  for (const cap of [1, 1000]) {
    const { pool } = createMockPhasePool();
    const { clients, preparedData } = createMockClients();
    const depositBody = makeDepositBody({
      unitPriceAtomic: "10",
      maxItemsCap: cap,
      amount: String(10 * cap),
    });
    const res = await submitContractAction(
      pool,
      clients,
      feeSplit,
      "DEPOSIT",
      depositBody,
      100000n,
    );
    expect(res.status).toBe("CONFIRMED");
    const decoded = decodeFunctionData({
      abi: escrowAbi,
      data: preparedData[0],
    });
    expect(decoded.args[5]).toBe(BigInt(10 * cap));
  }

  const { pool } = createMockPhasePool();
  const { clients, preparedData } = createMockClients();
  const settleBody = {
    runId: "019a1234-5678-7abc-8def-123456789abc",
    facetId: "019a1234-5678-7abc-8def-123456789abd",
    creatorPayTo: creator,
    unitPriceAtomic: "1000",
    paymentRequirements: {
      ...requirements,
      amount: "1000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "1000",
        providerPayTo: creator,
      },
    },
    paymentPayload: {
      x402Version: 2,
      accepted: {
        ...requirements,
        amount: "1000",
        extra: {
          name: "FACET USD",
          version: "2",
          pricingModel: "PAY_PER_RUN",
          unitPriceAtomic: "1000",
          providerPayTo: creator,
        },
      },
      payload: {
        authorization: {
          from: payer,
          to: feeSplit,
          value: "1000",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"a".repeat(64)}`,
        },
        signature: `0x${"b".repeat(130)}`,
      },
    },
  };
  const settled = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "SETTLE_RUN",
    settleBody,
    100000n,
  );
  expect(settled.status).toBe("CONFIRMED");
  const decodedSettle = decodeFunctionData({
    abi: escrowAbi,
    data: preparedData[0],
  });
  expect(decodedSettle.functionName).toBe("settlePayPerRunWithAuthorization");
  expect(decodedSettle.args[4]).toBe(1000n);
});

test("DEPOSIT passes timeoutSeconds and returns escrowExpiresAt; SETTLE_RESULT requires escrowSignature; REFUND reconciles external on-chain reclaim", async () => {
  const { pool } = createMockPhasePool();
  const { clients, preparedData } = createMockClients({
    escrowExpiresAtSec: 1_800_000_900n,
  });
  const depositBody = {
    ...makeDepositBody({
      unitPriceAtomic: "500",
      maxItemsCap: 10,
      amount: "5000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        providerPayTo: creator,
        authorizationType: "ReceiveWithAuthorization",
      },
    }),
    timeoutSeconds: 900,
  };
  const dep = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "DEPOSIT",
    depositBody,
    100000n,
  );
  expect(dep.status).toBe("CONFIRMED");
  expect((dep as { escrowExpiresAt?: string }).escrowExpiresAt).toBe(
    new Date(1_800_000_900 * 1000).toISOString(),
  );
  const decodedDep = decodeFunctionData({
    abi: escrowAbi,
    data: preparedData[0],
  });
  expect(decodedDep.args[6]).toBe(900n);

  // SETTLE_RESULT rejects missing escrowSignature even if legacy runnerSignature is provided
  await expect(
    submitContractAction(
      pool,
      clients,
      feeSplit,
      "SETTLE_RESULT",
      {
        runId: "019a1234-5678-7abc-8def-123456789abc",
        inputHash: `sha256:${"1".repeat(64)}`,
        outputHash: `sha256:${"2".repeat(64)}`,
        itemCount: 3,
        runnerSignature: `0x${"c".repeat(130)}`,
      },
      100000n,
    ),
  ).rejects.toThrow("CONTRACT_USAGE_INVALID");

  const escrowSig = `0x${"d".repeat(130)}`;
  const settled = await submitContractAction(
    pool,
    clients,
    feeSplit,
    "SETTLE_RESULT",
    {
      runId: "019a1234-5678-7abc-8def-123456789abc",
      inputHash: `sha256:${"1".repeat(64)}`,
      outputHash: `sha256:${"2".repeat(64)}`,
      itemCount: 3,
      escrowSignature: escrowSig,
    },
    100000n,
  );
  expect(settled.status).toBe("CONFIRMED");
  const decodedSettle = decodeFunctionData({
    abi: escrowAbi,
    data: preparedData[1],
  });
  expect(decodedSettle.functionName).toBe("settleEscrow");
  expect(decodedSettle.args[4]).toBe(escrowSig);

  // REFUND detects on-chain RunState.REFUNDED (3) from permissionless external reclaim without submitting a reverting tx
  const externalRefundClients = createMockClients({ onChainRunState: 3 });
  const refundRes = await submitContractAction(
    createMockPhasePool().pool,
    externalRefundClients.clients,
    feeSplit,
    "REFUND",
    { runId: "019a1234-5678-7abc-8def-123456789abd" },
    100000n,
  );
  expect(refundRes.status).toBe("CONFIRMED");
  expect((refundRes as { alreadyRefunded?: boolean }).alreadyRefunded).toBe(
    true,
  );
  expect(externalRefundClients.preparedData).toHaveLength(0);
});

test("POST /verify routes CONTRACT targets to ReceiveWithAuthorization and rejects missing authorizationType", async () => {
  const token = "t".repeat(32);
  const { pool } = createMockPhasePool();
  const { clients } = createMockClients();
  const app = buildFacilitatorApp({
    pool,
    clients,
    token,
    feeSplitAddress: feeSplit,
    maxAmountAtomic: 100000n,
  });

  const receiveReq = {
    ...requirements,
    extra: {
      name: "FACET USD",
      version: "2",
      authorizationType: "ReceiveWithAuthorization",
    },
  };
  const validVerify = await app.inject({
    method: "POST",
    url: "/verify",
    headers: { "x-facet-facilitator-token": token },
    payload: {
      x402Version: 2,
      paymentRequirements: receiveReq,
      paymentPayload: {
        x402Version: 2,
        accepted: receiveReq,
        payload: body.paymentPayload.payload,
      },
    },
  });
  expect(validVerify.statusCode).toBe(200);
  expect(validVerify.json()).toEqual({ isValid: true, payer });

  const missingTypeVerify = await app.inject({
    method: "POST",
    url: "/verify",
    headers: { "x-facet-facilitator-token": token },
    payload: {
      x402Version: 2,
      paymentRequirements: requirements,
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: body.paymentPayload.payload,
      },
    },
  });
  expect(missingTypeVerify.statusCode).toBe(200);
  expect(missingTypeVerify.json()).toEqual({
    isValid: false,
    invalidReason: "AUTHORIZATION_TYPE_MISMATCH",
  });

  await app.close();
});
