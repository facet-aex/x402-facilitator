import { createHash } from "node:crypto";
import {
  encodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { Pool } from "pg";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { contractAuthorization } from "./contract-payment.js";
import {
  submitContractPhase,
  type ContractPhase,
} from "./contract-phase-store.js";
import type { createFujiFacilitator } from "./fuji.js";

const abi = parseAbi([
  "function settlePayPerRunWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint256,bytes32,bytes)",
  "function depositEscrowWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint256,uint256,bytes32,bytes)",
  "function settleEscrow(bytes32,bytes32,bytes32,uint256,bytes)",
  "function refundEscrow(bytes32)",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sha = /^sha256:([0-9a-f]{64})$/iu;
const signature = /^0x[0-9a-f]{130}$/iu;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const key = (value: string) => keccak256(stringToHex(value));
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const rawHash = (value: unknown): Hex => {
  const match = sha.exec(String(value));
  if (!match) throw new Error("USAGE_HASH_INVALID");
  return `0x${match[1]}` as Hex;
};

export type ContractAction =
  "DEPOSIT" | "SETTLE_RUN" | "SETTLE_RESULT" | "REFUND";

export async function submitContractAction(
  pool: Pool,
  clients: Awaited<ReturnType<typeof createFujiFacilitator>>,
  feeSplitAddress: Address,
  phase: ContractAction,
  body: unknown,
  maxAmount: bigint,
) {
  if (!record(body) || typeof body.runId !== "string" || !uuid.test(body.runId))
    throw new Error("CONTRACT_REQUEST_INVALID");
  const runId = body.runId;
  let functionName:
    | "settlePayPerRunWithAuthorization"
    | "depositEscrowWithAuthorization"
    | "settleEscrow"
    | "refundEscrow";
  let args: readonly unknown[];
  let verify: (() => Promise<void>) | undefined;
  if (phase === "DEPOSIT" || phase === "SETTLE_RUN") {
    if (
      typeof body.facetId !== "string" ||
      !uuid.test(body.facetId) ||
      typeof body.creatorPayTo !== "string" ||
      !isAddress(body.creatorPayTo) ||
      typeof body.unitPriceAtomic !== "string" ||
      !/^[1-9][0-9]*$/u.test(body.unitPriceAtomic)
    )
      throw new Error("CONTRACT_REQUEST_INVALID");
    const requirements = body.paymentRequirements as PaymentRequirements;
    const payload = body.paymentPayload as PaymentPayload;
    if (!record(requirements) || !record(payload))
      throw new Error("CONTRACT_REQUEST_INVALID");
    const auth = contractAuthorization(payload, requirements, feeSplitAddress);
    if (auth.amount > maxAmount) throw new Error("PAYMENT_AMOUNT_EXCEEDS_CAP");
    const unitPrice = BigInt(body.unitPriceAtomic);
    if (
      (phase === "DEPOSIT" && auth.amount !== unitPrice * 20n) ||
      (phase === "SETTLE_RUN" && auth.amount !== unitPrice)
    )
      throw new Error("CONTRACT_PRICE_MISMATCH");
    verify = async () => {
      const result = await clients.facilitator.verify(payload, requirements);
      if (
        !result.isValid ||
        result.payer?.toLowerCase() !== auth.payer.toLowerCase()
      )
        throw new Error("CONTRACT_PAYMENT_INVALID");
    };
    if (phase === "DEPOSIT") {
      functionName = "depositEscrowWithAuthorization";
      args = [
        key(runId),
        key(body.facetId),
        auth.payer,
        body.creatorPayTo,
        unitPrice,
        auth.amount,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
      ];
    } else {
      functionName = "settlePayPerRunWithAuthorization";
      args = [
        key(runId),
        key(body.facetId),
        auth.payer,
        body.creatorPayTo,
        auth.amount,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
      ];
    }
  } else if (phase === "SETTLE_RESULT") {
    if (
      !Number.isSafeInteger(body.itemCount) ||
      (body.itemCount as number) < 0 ||
      (body.itemCount as number) > 1_000_000 ||
      typeof body.runnerSignature !== "string" ||
      !signature.test(body.runnerSignature)
    )
      throw new Error("CONTRACT_USAGE_INVALID");
    functionName = "settleEscrow";
    args = [
      key(runId),
      rawHash(body.inputHash),
      rawHash(body.outputHash),
      BigInt(body.itemCount as number),
      body.runnerSignature,
    ];
  } else {
    functionName = "refundEscrow";
    args = [key(runId)];
  }
  const data = encodeFunctionData({ abi, functionName, args: args as never });
  return submitContractPhase(pool, {
    runId,
    phase: phase as ContractPhase,
    requestHash: hash(body),
    prepare: async () => {
      await verify?.();
      const request = await clients.wallet.prepareTransactionRequest({
        account: clients.wallet.account,
        chain: clients.wallet.chain,
        to: feeSplitAddress,
        data,
      });
      const raw = await clients.wallet.signTransaction(request);
      return { raw, hash: keccak256(raw) };
    },
    broadcast: async (raw) => {
      await clients.wallet.sendRawTransaction({ serializedTransaction: raw });
    },
    receipt: async (txHash) => {
      try {
        const receipt = await clients.publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 30_000,
        });
        return { status: receipt.status, blockNumber: receipt.blockNumber };
      } catch {
        return null;
      }
    },
  });
}
