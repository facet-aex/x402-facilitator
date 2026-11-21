import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { FUJI_NETWORK, FUJI_FUSD } from "./fuji.js";
import { isAddress } from "viem";

export interface ValidPaymentRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
export const MIN_ITEMS_CAP = 1;
export const MAX_ITEMS_CAP = 1000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonZeroAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    isAddress(value) &&
    value.toLowerCase() !== ZERO_ADDRESS
  );
}

export function isValidItemsCap(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_ITEMS_CAP &&
    value <= MAX_ITEMS_CAP
  );
}

function sameOptionalAddress(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function validateExtraMetadata(
  extra: Record<string, unknown>,
  amountAtomic: string,
): void {
  if (
    extra.authorizationType !== undefined &&
    extra.authorizationType !== "ReceiveWithAuthorization" &&
    extra.authorizationType !== "TransferWithAuthorization"
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");

  if (
    extra.providerPayTo !== undefined &&
    !isNonZeroAddress(extra.providerPayTo)
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");

  if (extra.pricingModel === undefined) {
    if (extra.unitPriceAtomic !== undefined || extra.maxItemsCap !== undefined)
      throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
    return;
  }

  if (extra.pricingModel === "PAY_PER_RUN") {
    if (extra.maxItemsCap !== undefined)
      throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
    if (
      extra.unitPriceAtomic !== undefined &&
      (typeof extra.unitPriceAtomic !== "string" ||
        !POSITIVE_INTEGER.test(extra.unitPriceAtomic) ||
        extra.unitPriceAtomic !== amountAtomic)
    )
      throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
    return;
  }

  if (extra.pricingModel !== "PAY_PER_RESULT")
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");

  if (
    typeof extra.unitPriceAtomic !== "string" ||
    !POSITIVE_INTEGER.test(extra.unitPriceAtomic) ||
    !isValidItemsCap(extra.maxItemsCap) ||
    BigInt(extra.unitPriceAtomic) * BigInt(extra.maxItemsCap) !==
      BigInt(amountAtomic)
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
}

export function assertMatchingExtraFields(
  requirementsExtra: Record<string, unknown>,
  acceptedExtra: Record<string, unknown>,
): void {
  if (
    acceptedExtra.name !== requirementsExtra.name ||
    acceptedExtra.version !== requirementsExtra.version ||
    acceptedExtra.authorizationType !== requirementsExtra.authorizationType ||
    acceptedExtra.pricingModel !== requirementsExtra.pricingModel ||
    acceptedExtra.unitPriceAtomic !== requirementsExtra.unitPriceAtomic ||
    acceptedExtra.maxItemsCap !== requirementsExtra.maxItemsCap ||
    !sameOptionalAddress(
      acceptedExtra.providerPayTo,
      requirementsExtra.providerPayTo,
    )
  )
    throw new Error("PAYMENT_ACCEPTED_MISMATCH");
}

export function validatePaymentRequest(
  body: unknown,
  payToOrOptions: string | { maxAmountAtomic: bigint },
  amount?: string,
): ValidPaymentRequest {
  if (
    !record(body) ||
    body.x402Version !== 2 ||
    !record(body.paymentPayload) ||
    !record(body.paymentRequirements)
  )
    throw new Error("PAYMENT_REQUEST_INVALID");
  const payload = body.paymentPayload;
  const requirements = body.paymentRequirements;
  const dynamic = typeof payToOrOptions !== "string";
  if (
    payload.x402Version !== 2 ||
    !record(payload.accepted) ||
    !record(payload.payload)
  )
    throw new Error("PAYMENT_PAYLOAD_INVALID");

  const validAmountFormat =
    typeof requirements.amount === "string" &&
    POSITIVE_INTEGER.test(requirements.amount);
  const payToValid =
    isNonZeroAddress(requirements.payTo) &&
    (dynamic ||
      requirements.payTo.toLowerCase() === payToOrOptions.toLowerCase());
  if (
    requirements.scheme !== "exact" ||
    requirements.network !== FUJI_NETWORK ||
    String(requirements.asset).toLowerCase() !== FUJI_FUSD.toLowerCase() ||
    !validAmountFormat ||
    !payToValid
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");

  if (dynamic) {
    if (BigInt(requirements.amount as string) > payToOrOptions.maxAmountAtomic)
      throw new Error("PAYMENT_AMOUNT_EXCEEDS_CAP");
  } else if (requirements.amount !== amount) {
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
  }

  if (
    requirements.maxTimeoutSeconds !== 60 ||
    !record(requirements.extra) ||
    requirements.extra.name !== "FACET USD" ||
    requirements.extra.version !== "2"
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");

  validateExtraMetadata(requirements.extra, requirements.amount as string);

  for (const key of [
    "scheme",
    "network",
    "asset",
    "amount",
    "payTo",
  ] as const) {
    if (
      String(payload.accepted[key]).toLowerCase() !==
      String(requirements[key]).toLowerCase()
    )
      throw new Error("PAYMENT_ACCEPTED_MISMATCH");
  }
  if (
    payload.accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
    !record(payload.accepted.extra)
  )
    throw new Error("PAYMENT_ACCEPTED_MISMATCH");
  assertMatchingExtraFields(requirements.extra, payload.accepted.extra);
  return {
    paymentPayload: payload as PaymentPayload,
    paymentRequirements: requirements as PaymentRequirements,
  };
}
