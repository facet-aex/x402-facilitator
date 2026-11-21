import {
  getAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { contractAuthorization } from "./contract-payment.js";
import { FUJI_FUSD } from "./fuji.js";

const FUSD_RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const FUSD_CHECK_ABI = parseAbi([
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

export interface ReceiveVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

export async function verifyReceiveAuthorization(params: {
  publicClient: PublicClient;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  expectedRecipient: Address;
}): Promise<ReceiveVerifyResult> {
  const auth = contractAuthorization(
    params.payload,
    params.requirements,
    params.expectedRecipient,
  );
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now <= auth.validAfter || now + 5n >= auth.validBefore) {
    return {
      isValid: false,
      invalidReason: "AUTHORIZATION_WINDOW_INVALID",
      payer: auth.payer,
    };
  }

  const extra = params.requirements.extra as
    { name?: string; version?: string; authorizationType?: string } | undefined;
  if (
    extra?.authorizationType !== undefined &&
    extra.authorizationType !== "ReceiveWithAuthorization"
  ) {
    return {
      isValid: false,
      invalidReason: "AUTHORIZATION_TYPE_MISMATCH",
      payer: auth.payer,
    };
  }

  const sigOk = await params.publicClient.verifyTypedData({
    address: auth.payer,
    domain: {
      name: extra?.name ?? "FACET USD",
      version: extra?.version ?? "2",
      chainId: 43113,
      verifyingContract: getAddress(FUJI_FUSD),
    },
    types: FUSD_RECEIVE_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: auth.payer,
      to: getAddress(params.expectedRecipient),
      value: auth.amount,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
    signature: auth.signature as Hex,
  });

  if (!sigOk) {
    return {
      isValid: false,
      invalidReason: "INVALID_RECEIVE_AUTHORIZATION_SIGNATURE",
      payer: auth.payer,
    };
  }

  const [used, balance] = await Promise.all([
    params.publicClient.readContract({
      address: FUJI_FUSD,
      abi: FUSD_CHECK_ABI,
      functionName: "authorizationState",
      args: [auth.payer, auth.nonce],
    }),
    params.publicClient.readContract({
      address: FUJI_FUSD,
      abi: FUSD_CHECK_ABI,
      functionName: "balanceOf",
      args: [auth.payer],
    }),
  ]);

  if (used) {
    return {
      isValid: false,
      invalidReason: "AUTHORIZATION_ALREADY_USED",
      payer: auth.payer,
    };
  }
  if (balance < auth.amount) {
    return {
      isValid: false,
      invalidReason: "INSUFFICIENT_BALANCE",
      payer: auth.payer,
    };
  }

  return { isValid: true, payer: auth.payer };
}
