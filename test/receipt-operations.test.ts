import { expect, test } from "vitest";
import type { Pool } from "pg";
import {
  recordPaidReceipt,
  assertFeePaymentReceipt,
} from "../src/receipt-operations.js";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";

const fee = "0x0000000000000000000000000000000000000001" as const;
const run = `0x${"a".repeat(64)}` as const;
const facet = `0x${"b".repeat(64)}` as const;
const eventAbi = parseAbi([
  "event FeeSplitSettled(bytes32 indexed runId,bytes32 indexed facetId,address indexed creatorPayTo,uint256 creatorAmount,uint256 platformFee)",
]);
const log = (runId: `0x${string}`) => ({
  address: fee,
  topics: encodeEventTopics({
    abi: eventAbi,
    eventName: "FeeSplitSettled",
    args: { runId, facetId: facet, creatorPayTo: fee },
  }),
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [950n, 50n],
  ),
});

test("rejects a successful unrelated payment transaction", () => {
  expect(() =>
    assertFeePaymentReceipt(
      { status: "success", to: fee, logs: [] },
      fee,
      run,
      facet,
      1n,
    ),
  ).toThrow("RECEIPT_PAYMENT_UNLINKED");
  expect(() =>
    assertFeePaymentReceipt(
      { status: "success", to: fee, logs: [log(`0x${"c".repeat(64)}`)] },
      fee,
      run,
      facet,
      1n,
    ),
  ).toThrow("RECEIPT_PAYMENT_UNLINKED");
  expect(() =>
    assertFeePaymentReceipt(
      { status: "success", to: fee, logs: [log(run)] },
      fee,
      run,
      facet,
      1n,
    ),
  ).not.toThrow();
});

test("escrow receipt binds the exact signed item count", () => {
  const escrowAbi = parseAbi([
    "event TaskEscrowSettled(bytes32 indexed runId,bytes32 indexed facetId,uint256 itemCount,uint256 actualAmount,uint256 refundAmount)",
  ]);
  const escrowLog = {
    address: fee,
    topics: encodeEventTopics({
      abi: escrowAbi,
      eventName: "TaskEscrowSettled",
      args: { runId: run, facetId: facet },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [2n, 1000n, 9000n],
    ),
  };
  const receipt = { status: "success", to: fee, logs: [escrowLog] };
  expect(() => assertFeePaymentReceipt(receipt, fee, run, facet, 1n)).toThrow(
    "RECEIPT_PAYMENT_UNLINKED",
  );
  expect(() =>
    assertFeePaymentReceipt(receipt, fee, run, facet, 2n),
  ).not.toThrow();
});

test("rejects incomplete receipt proof before any database or chain write", async () => {
  await expect(
    recordPaidReceipt({} as Pool, {} as never, {
      runId: "019a1234-5678-7abc-8def-123456789abc",
      facetId: "019a1234-5678-7abc-8def-123456789abd",
      itemCount: 1,
      inputHash: `sha256:${"a".repeat(64)}`,
      outputHash: `sha256:${"b".repeat(64)}`,
      paymentTxHash: `0x${"0".repeat(64)}`,
      runnerSignature: `0x${"c".repeat(130)}`,
    }),
  ).rejects.toThrow("RECEIPT_REQUEST_INVALID");
});

test("recordPaidReceipt computes identical canonical requestHash across reordered body keys", async () => {
  const insertedHashes: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.startsWith("INSERT INTO facet_contract_phases")) {
          insertedHashes.push(params[2] as string);
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  const paymentTxHash = `0x${"1".repeat(64)}` as const;
  const runnerAddress = "0x0000000000000000000000000000000000000003" as const;
  const base = {
    runId: "019a1234-5678-7abc-8def-123456789abc",
    facetId: "019a1234-5678-7abc-8def-123456789abd",
    itemCount: 1,
    inputHash: `sha256:${"a".repeat(64)}`,
    outputHash: `sha256:${"b".repeat(64)}`,
    paymentTxHash,
    runnerSignature: `0x${"c".repeat(130)}`,
  };
  const expectedLog = {
    address: fee,
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: "FeeSplitSettled",
      args: {
        runId: keccak256(stringToHex(base.runId)),
        facetId: keccak256(stringToHex(base.facetId)),
        creatorPayTo: fee,
      },
    }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [950n, 50n],
    ),
  };
  const writer = {
    address: "0x0000000000000000000000000000000000000004",
    feeSplitAddress: fee,
    account: { address: "0x0000000000000000000000000000000000000005" },
    runner: runnerAddress,
    publicClient: {
      getTransactionReceipt: async () => ({
        status: "success",
        to: fee,
        logs: [expectedLog],
      }),
      waitForTransactionReceipt: async () => {
        throw new Error("PENDING");
      },
    },
    wallet: {
      prepareTransactionRequest: async (req: unknown) => req,
      signTransaction: async () => `0x${"2".repeat(130)}`,
      sendRawTransaction: async () => `0x${"3".repeat(64)}`,
    },
  } as unknown as Parameters<typeof recordPaidReceipt>[1];
  const reordered = {
    runnerSignature: base.runnerSignature,
    paymentTxHash: base.paymentTxHash,
    outputHash: base.outputHash,
    inputHash: base.inputHash,
    itemCount: base.itemCount,
    facetId: base.facetId,
    runId: base.runId,
  };
  await recordPaidReceipt(pool, writer, base);
  await recordPaidReceipt(pool, writer, reordered);
  expect(insertedHashes).toHaveLength(2);
  expect(insertedHashes[0]).toBe(insertedHashes[1]);
});
