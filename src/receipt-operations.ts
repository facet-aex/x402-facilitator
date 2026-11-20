import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { avalancheFuji } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "pg";
import { submitContractPhase } from "./contract-phase-store.js";
import { canonicalJson, hashCanonical } from "./contract-operations.js";

export { canonicalJson };

const abi = parseAbi([
  "function recorder() view returns (address)",
  "function runnerSigner() view returns (address)",
  "function recordReceipt(bytes32,bytes32,bytes32,bytes32,uint256,bytes32,bytes)",
  "function getReceipt(bytes32) view returns ((bytes32 facetId,bytes32 inputHash,bytes32 outputHash,uint256 itemCount,bytes32 paymentTxHash,address runnerSigner))",
]);
const feeEvents = parseAbi([
  "event FeeSplitSettled(bytes32 indexed runId,bytes32 indexed facetId,address indexed creatorPayTo,uint256 creatorAmount,uint256 platformFee)",
  "event TaskEscrowSettled(bytes32 indexed runId,bytes32 indexed facetId,uint256 itemCount,uint256 actualAmount,uint256 refundAmount)",
]);

export function assertFeePaymentReceipt(
  receipt: {
    status: string;
    to: Address | null;
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
  },
  feeSplitAddress: Address,
  runKey: Hex,
  facetKey: Hex,
  itemCount: bigint,
) {
  if (
    receipt.status !== "success" ||
    receipt.to?.toLowerCase() !== feeSplitAddress.toLowerCase()
  )
    throw new Error("RECEIPT_PAYMENT_UNLINKED");
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== feeSplitAddress.toLowerCase() ||
      !log.topics.length
    )
      continue;
    try {
      const event = decodeEventLog({
        abi: feeEvents,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (event.args.runId !== runKey || event.args.facetId !== facetKey)
        continue;
      if (
        event.eventName === "FeeSplitSettled" ||
        (event.eventName === "TaskEscrowSettled" &&
          event.args.itemCount === itemCount)
      )
        return;
    } catch {
      /* unrelated log */
    }
  }
  throw new Error("RECEIPT_PAYMENT_UNLINKED");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sha = /^sha256:([0-9a-f]{64})$/iu;
const rawSha = (value: unknown): Hex => {
  const match = sha.exec(String(value));
  if (!match) throw new Error("RECEIPT_HASH_INVALID");
  return `0x${match[1]}` as Hex;
};

export async function createReceiptWriter(
  rpc: string,
  address: string,
  key: string,
  feeSplitAddress: string,
) {
  if (
    !isAddress(address) ||
    !isAddress(feeSplitAddress) ||
    !/^0x[0-9a-f]{64}$/iu.test(key)
  )
    throw new Error("RECEIPT_CONFIG_INVALID");
  const account = privateKeyToAccount(key as Hex);
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(rpc),
  });
  const code = await publicClient.getCode({ address });
  if ((await publicClient.getChainId()) !== 43113 || !code || code === "0x")
    throw new Error("RECEIPT_CONTRACT_MISSING");
  const [recorder, runner] = await Promise.all([
    publicClient.readContract({ address, abi, functionName: "recorder" }),
    publicClient.readContract({ address, abi, functionName: "runnerSigner" }),
  ]);
  if (recorder.toLowerCase() !== account.address.toLowerCase())
    throw new Error("RECEIPT_RECORDER_MISMATCH");
  const wallet = createWalletClient({
    account,
    chain: avalancheFuji,
    transport: http(rpc),
  });
  return {
    address: address as Address,
    feeSplitAddress: feeSplitAddress as Address,
    account,
    publicClient,
    wallet,
    runner,
  };
}

export async function recordPaidReceipt(
  pool: Pool,
  writer: Awaited<ReturnType<typeof createReceiptWriter>>,
  body: unknown,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("RECEIPT_REQUEST_INVALID");
  const input = body as Record<string, unknown>;
  if (
    typeof input.runId !== "string" ||
    !uuid.test(input.runId) ||
    typeof input.facetId !== "string" ||
    !uuid.test(input.facetId) ||
    !Number.isSafeInteger(input.itemCount) ||
    (input.itemCount as number) < 0 ||
    typeof input.paymentTxHash !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(input.paymentTxHash) ||
    /^0x0{64}$/iu.test(input.paymentTxHash) ||
    typeof input.runnerSignature !== "string" ||
    !/^0x[0-9a-f]{130}$/iu.test(input.runnerSignature)
  )
    throw new Error("RECEIPT_REQUEST_INVALID");
  const runKey = keccak256(stringToHex(input.runId));
  const facetKey = keccak256(stringToHex(input.facetId));
  const inputHash = rawSha(input.inputHash);
  const outputHash = rawSha(input.outputHash);
  const itemCount = BigInt(input.itemCount as number);
  const paymentHash = input.paymentTxHash as Hex;
  const paymentReceipt = await writer.publicClient.getTransactionReceipt({
    hash: paymentHash,
  });
  assertFeePaymentReceipt(
    paymentReceipt,
    writer.feeSplitAddress,
    runKey,
    facetKey,
    itemCount,
  );
  const data = encodeFunctionData({
    abi,
    functionName: "recordReceipt",
    args: [
      runKey,
      facetKey,
      inputHash,
      outputHash,
      itemCount,
      paymentHash,
      input.runnerSignature as Hex,
    ],
  });
  const requestHash = hashCanonical(input);
  const result = await submitContractPhase(pool, {
    runId: input.runId,
    phase: "RECEIPT",
    requestHash,
    prepare: async () => {
      const request = await writer.wallet.prepareTransactionRequest({
        account: writer.account,
        chain: avalancheFuji,
        to: writer.address,
        data,
      });
      const raw = await writer.wallet.signTransaction(request);
      return { raw, hash: keccak256(raw) };
    },
    broadcast: async (raw) => {
      await writer.wallet.sendRawTransaction({ serializedTransaction: raw });
    },
    receipt: async (hash) => {
      try {
        const receipt = await writer.publicClient.waitForTransactionReceipt({
          hash,
          timeout: 30_000,
        });
        return { status: receipt.status, blockNumber: receipt.blockNumber };
      } catch {
        return null;
      }
    },
  });
  if (result.status === "CONFIRMED") {
    const onChain = await writer.publicClient.readContract({
      address: writer.address,
      abi,
      functionName: "getReceipt",
      args: [runKey],
    });
    if (
      onChain.facetId !== facetKey ||
      onChain.inputHash !== inputHash ||
      onChain.outputHash !== outputHash ||
      onChain.itemCount !== itemCount ||
      onChain.paymentTxHash.toLowerCase() !== paymentHash.toLowerCase() ||
      onChain.runnerSigner.toLowerCase() !== writer.runner.toLowerCase()
    )
      throw new Error("RECEIPT_READBACK_MISMATCH");
  }
  return result;
}
