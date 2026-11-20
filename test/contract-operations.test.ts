import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { Pool } from "pg";
import type { createFujiFacilitator } from "../src/fuji.js";
import {
  canonicalJson,
  submitContractAction,
} from "../src/contract-operations.js";
import { buildFacilitatorApp, parseFacilitatorConfig } from "../src/server.js";

const escrowAbi = parseAbi([
  "function depositEscrowWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,bytes32,bytes)",
  "function settlePayPerRunWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint256,bytes32,bytes)",
]);

const feeSplit = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06" as Address;
const payer = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B" as Address;
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

function createMockClients(options?: { receiptPendingOnce?: boolean }) {
  const preparedData: Hex[] = [];
  let receiptCalls = 0;
  const rawTx = `0x${"f".repeat(130)}` as Hex;
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
      waitForTransactionReceipt: async () => {
        receiptCalls++;
        if (options?.receiptPendingOnce && receiptCalls === 1)
          throw new Error("TIMEOUT");
        return { status: "success" as const, blockNumber: 42n };
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
