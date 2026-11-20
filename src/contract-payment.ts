import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { isNonZeroAddress } from "./request-validation.js";

const UINT256_LIMIT = 1n << 256n;

export interface ContractAuthorization {
  payer: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

export function contractAuthorization(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  feeSplitAddress: Address,
): ContractAuthorization {
  if (requirements.payTo.toLowerCase() !== feeSplitAddress.toLowerCase())
    throw new Error("CONTRACT_RECIPIENT_MISMATCH");
  const raw = payload.payload;
  const rawRecord =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const authRaw = rawRecord?.authorization;
  const auth =
    typeof authRaw === "object" && authRaw !== null && !Array.isArray(authRaw)
      ? (authRaw as Record<string, unknown>)
      : undefined;
  if (
    !auth ||
    !isNonZeroAddress(auth.from) ||
    typeof auth.to !== "string" ||
    !isAddress(auth.to) ||
    getAddress(auth.to) !== getAddress(feeSplitAddress) ||
    typeof auth.value !== "string" ||
    !/^[1-9][0-9]*$/u.test(auth.value) ||
    auth.value !== requirements.amount ||
    typeof auth.validAfter !== "string" ||
    !/^[0-9]+$/u.test(auth.validAfter) ||
    typeof auth.validBefore !== "string" ||
    !/^[0-9]+$/u.test(auth.validBefore) ||
    typeof auth.nonce !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(auth.nonce) ||
    typeof rawRecord?.signature !== "string" ||
    !/^0x[0-9a-f]{130}$/iu.test(rawRecord.signature)
  )
    throw new Error("CONTRACT_AUTHORIZATION_INVALID");
  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  if (validAfter >= UINT256_LIMIT || validBefore >= UINT256_LIMIT)
    throw new Error("CONTRACT_AUTHORIZATION_INVALID");
  return {
    payer: getAddress(auth.from),
    amount: BigInt(auth.value),
    validAfter,
    validBefore,
    nonce: auth.nonce as Hex,
    signature: rawRecord.signature as Hex,
  };
}
