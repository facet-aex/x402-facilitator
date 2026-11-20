import { expect, test } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { contractAuthorization } from "../src/contract-payment.js";

const contract = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06";
const payer = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
const requirements = {
  scheme: "exact",
  network: "eip155:43113",
  asset: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
  amount: "1000",
  payTo: contract,
  maxTimeoutSeconds: 60,
  extra: { name: "FACET USD", version: "2" },
} as PaymentRequirements;
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    authorization: {
      from: payer,
      to: contract,
      value: "1000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${"a".repeat(64)}`,
    },
    signature: `0x${"b".repeat(130)}`,
  },
} as PaymentPayload;

test("extracts only an exact EOA EIP-3009 authorization addressed to the contract", () => {
  expect(contractAuthorization(payload, requirements, contract).amount).toBe(
    1000n,
  );
  expect(() =>
    contractAuthorization(
      {
        ...payload,
        payload: {
          ...payload.payload,
          authorization: { ...payload.payload.authorization, to: payer },
        },
      } as PaymentPayload,
      requirements,
      contract,
    ),
  ).toThrow("CONTRACT_AUTHORIZATION_INVALID");
  expect(() =>
    contractAuthorization(
      {
        ...payload,
        payload: { ...payload.payload, signature: "0x01" },
      } as PaymentPayload,
      requirements,
      contract,
    ),
  ).toThrow("CONTRACT_AUTHORIZATION_INVALID");
});

test("rejects zero-address payer and validBefore >= 2^256 with CONTRACT_AUTHORIZATION_INVALID", () => {
  const zeroPayer = "0x0000000000000000000000000000000000000000";
  expect(() =>
    contractAuthorization(
      {
        ...payload,
        payload: {
          ...payload.payload,
          authorization: {
            ...((payload.payload as Record<string, unknown>)
              .authorization as Record<string, unknown>),
            from: zeroPayer,
          },
        },
      } as PaymentPayload,
      requirements,
      contract,
    ),
  ).toThrow("CONTRACT_AUTHORIZATION_INVALID");

  const overflowUint256 = (1n << 256n).toString();
  expect(() =>
    contractAuthorization(
      {
        ...payload,
        payload: {
          ...payload.payload,
          authorization: {
            ...((payload.payload as Record<string, unknown>)
              .authorization as Record<string, unknown>),
            validBefore: overflowUint256,
          },
        },
      } as PaymentPayload,
      requirements,
      contract,
    ),
  ).toThrow("CONTRACT_AUTHORIZATION_INVALID");

  expect(() =>
    contractAuthorization(
      {
        ...payload,
        payload: {
          ...payload.payload,
          authorization: {
            ...((payload.payload as Record<string, unknown>)
              .authorization as Record<string, unknown>),
            validAfter: overflowUint256,
          },
        },
      } as PaymentPayload,
      requirements,
      contract,
    ),
  ).toThrow("CONTRACT_AUTHORIZATION_INVALID");
});
