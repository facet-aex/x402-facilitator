import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { FUJI_NETWORK, FUJI_FUSD } from "./fuji.js";

export interface ValidPaymentRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validatePaymentRequest(
  body: unknown,
  payTo: string,
  amount: string,
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
  if (
    payload.x402Version !== 2 ||
    !record(payload.accepted) ||
    !record(payload.payload)
  )
    throw new Error("PAYMENT_PAYLOAD_INVALID");
  if (
    requirements.scheme !== "exact" ||
    requirements.network !== FUJI_NETWORK ||
    String(requirements.asset).toLowerCase() !== FUJI_FUSD.toLowerCase() ||
    requirements.amount !== amount ||
    String(requirements.payTo).toLowerCase() !== payTo.toLowerCase()
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
  if (
    requirements.maxTimeoutSeconds !== 60 ||
    !record(requirements.extra) ||
    requirements.extra.name !== "FACET USD" ||
    requirements.extra.version !== "2"
  )
    throw new Error("PAYMENT_REQUIREMENTS_MISMATCH");
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
    !record(payload.accepted.extra) ||
    payload.accepted.extra.name !== requirements.extra.name ||
    payload.accepted.extra.version !== requirements.extra.version
  )
    throw new Error("PAYMENT_ACCEPTED_MISMATCH");
  return {
    paymentPayload: payload as PaymentPayload,
    paymentRequirements: requirements as PaymentRequirements,
  };
}
