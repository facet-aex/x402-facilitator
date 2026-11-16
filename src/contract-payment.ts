import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

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
  const raw = payload.payload as Record<string, unknown>;
  const auth = raw?.authorization as Record<string, unknown> | undefined;
  if (
    !auth ||
    typeof auth.from !== "string" ||
    !isAddress(auth.from) ||
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
    typeof raw.signature !== "string" ||
    !/^0x[0-9a-f]{130}$/iu.test(raw.signature)
  )
    throw new Error("CONTRACT_AUTHORIZATION_INVALID");
  return {
    payer: getAddress(auth.from),
    amount: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce as Hex,
    signature: raw.signature as Hex,
  };
}
