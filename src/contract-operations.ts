import { createHash } from "node:crypto";
import {
  encodeFunctionData,
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
import { verifyReceiveAuthorization } from "./receive-auth.js";
import {
  assertMatchingExtraFields,
  isNonZeroAddress,
  isValidItemsCap,
} from "./request-validation.js";

const DEFAULT_MAX_ITEMS_CAP = 20;
const MIN_ESCROW_TIMEOUT_SECONDS = 300;
const MAX_ESCROW_TIMEOUT_SECONDS = 3600;

const abi = parseAbi([
  "function settlePayPerRunWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint256,bytes32,bytes)",
  "function depositEscrowWithAuthorization(bytes32,bytes32,address,address,uint256,uint256,uint64,uint256,uint256,bytes32,bytes)",
  "function settleEscrow(bytes32,bytes32,bytes32,uint256,bytes)",
  "function refundEscrow(bytes32)",
  "function runState(bytes32) view returns (uint8)",
  "function escrows(bytes32) view returns (bytes32 facetId,address payer,address creatorPayTo,uint256 unitPriceAtomic,uint256 maxAmount,uint64 expiresAt)",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sha = /^sha256:([0-9a-f]{64})$/iu;
const signature = /^0x[0-9a-f]{130}$/iu;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const key = (value: string) => keccak256(stringToHex(value));

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const k of Object.keys(item).sort()) {
        const child = normalize((item as Record<string, unknown>)[k]);
        if (child !== undefined) result[k] = child;
      }
      return result;
    }
    return item;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new Error("INVALID_JSON");
  return serialized;
}

export const hashCanonical = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

const rawHash = (value: unknown): Hex => {
  const match = sha.exec(String(value));
  if (!match) throw new Error("USAGE_HASH_INVALID");
  return `0x${match[1]}` as Hex;
};

function validateExtraAgainstPhase(
  phase: "DEPOSIT" | "SETTLE_RUN",
  extra: unknown,
  unitPriceAtomic: string,
  creatorPayTo: string,
  normalizedCap?: number,
): void {
  if (!record(extra)) return;
  const expectedModel = phase === "DEPOSIT" ? "PAY_PER_RESULT" : "PAY_PER_RUN";
  if (extra.pricingModel !== undefined && extra.pricingModel !== expectedModel)
    throw new Error("CONTRACT_PRICE_MISMATCH");
  if (
    extra.unitPriceAtomic !== undefined &&
    extra.unitPriceAtomic !== unitPriceAtomic
  )
    throw new Error("CONTRACT_PRICE_MISMATCH");
  if (phase === "DEPOSIT") {
    if (extra.maxItemsCap !== undefined && extra.maxItemsCap !== normalizedCap)
      throw new Error("CONTRACT_PRICE_MISMATCH");
  } else if (extra.maxItemsCap !== undefined) {
    throw new Error("CONTRACT_PRICE_MISMATCH");
  }
  if (
    extra.providerPayTo !== undefined &&
    (!isNonZeroAddress(extra.providerPayTo) ||
      extra.providerPayTo.toLowerCase() !== creatorPayTo.toLowerCase())
  )
    throw new Error("CONTRACT_RECIPIENT_MISMATCH");
}

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
  let requestForHash: Record<string, unknown> = body;
  if (phase === "DEPOSIT" || phase === "SETTLE_RUN") {
    if (
      typeof body.facetId !== "string" ||
      !uuid.test(body.facetId) ||
      !isNonZeroAddress(body.creatorPayTo) ||
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
    let normalizedCap: number | undefined;
    if (phase === "DEPOSIT") {
      // Normalize omitted maxItemsCap to 20 so retries reading DB defaults produce an identical requestHash.
      const rawCap =
        body.maxItemsCap === undefined
          ? DEFAULT_MAX_ITEMS_CAP
          : body.maxItemsCap;
      if (!isValidItemsCap(rawCap)) throw new Error("CONTRACT_PRICE_MISMATCH");
      normalizedCap = rawCap;
      if (auth.amount !== unitPrice * BigInt(rawCap))
        throw new Error("CONTRACT_PRICE_MISMATCH");
      requestForHash = { ...body, maxItemsCap: rawCap };
    } else if (auth.amount !== unitPrice) {
      throw new Error("CONTRACT_PRICE_MISMATCH");
    }
    validateExtraAgainstPhase(
      phase,
      requirements.extra,
      body.unitPriceAtomic,
      body.creatorPayTo,
      normalizedCap,
    );
    if (record(requirements.extra) && record(payload.accepted)) {
      if (!record(payload.accepted.extra))
        throw new Error("PAYMENT_ACCEPTED_MISMATCH");
      assertMatchingExtraFields(requirements.extra, payload.accepted.extra);
    }
    verify = async () => {
      const result = await verifyReceiveAuthorization({
        publicClient: clients.publicClient,
        payload,
        requirements,
        expectedRecipient: feeSplitAddress,
      });
      if (
        !result.isValid ||
        result.payer?.toLowerCase() !== auth.payer.toLowerCase()
      )
        throw new Error("CONTRACT_PAYMENT_INVALID");
    };
    if (phase === "DEPOSIT") {
      let timeoutSeconds = 0n;
      if (body.timeoutSeconds !== undefined) {
        if (
          typeof body.timeoutSeconds !== "number" ||
          !Number.isSafeInteger(body.timeoutSeconds) ||
          body.timeoutSeconds < MIN_ESCROW_TIMEOUT_SECONDS ||
          body.timeoutSeconds > MAX_ESCROW_TIMEOUT_SECONDS
        ) {
          throw new Error("CONTRACT_REQUEST_INVALID");
        }
        timeoutSeconds = BigInt(body.timeoutSeconds);
      }
      functionName = "depositEscrowWithAuthorization";
      args = [
        key(runId),
        key(body.facetId),
        auth.payer,
        body.creatorPayTo,
        unitPrice,
        auth.amount,
        timeoutSeconds,
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
      typeof body.escrowSignature !== "string" ||
      !signature.test(body.escrowSignature)
    )
      throw new Error("CONTRACT_USAGE_INVALID");
    functionName = "settleEscrow";
    args = [
      key(runId),
      rawHash(body.inputHash),
      rawHash(body.outputHash),
      BigInt(body.itemCount as number),
      body.escrowSignature,
    ];
  } else {
    try {
      const onChainState = await clients.publicClient.readContract({
        address: feeSplitAddress,
        abi,
        functionName: "runState",
        args: [key(runId)],
      });
      if (Number(onChainState) === 3) {
        return {
          status: "CONFIRMED" as const,
          hash: ("0x" + "0".repeat(64)) as Hex,
          blockNumber: 0n,
          alreadyRefunded: true,
        };
      }
    } catch {
      /* Proceed to submit refund phase via contract store. */
    }
    functionName = "refundEscrow";
    args = [key(runId)];
  }
  const data = encodeFunctionData({ abi, functionName, args: args as never });
  const phaseResult = await submitContractPhase(pool, {
    runId,
    phase: phase as ContractPhase,
    requestHash: hashCanonical(requestForHash),
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
  if (phase === "DEPOSIT" && phaseResult.status === "CONFIRMED") {
    try {
      const escrowTuple = await clients.publicClient.readContract({
        address: feeSplitAddress,
        abi,
        functionName: "escrows",
        args: [key(runId)],
      });
      const expiresAtSec = Number(escrowTuple[5]);
      if (Number.isSafeInteger(expiresAtSec) && expiresAtSec > 0) {
        return {
          ...phaseResult,
          escrowExpiresAt: new Date(expiresAtSec * 1000).toISOString(),
        };
      }
    } catch {
      /* Return confirmed phase result even if readContract fails transiently. */
    }
  }
  return phaseResult;
}
