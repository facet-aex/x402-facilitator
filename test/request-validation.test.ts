import { describe, expect, it } from "vitest";
import { validatePaymentRequest } from "../src/request-validation.js";

const payTo = "0x0000000000000000000000000000000000000001";
const requirements = {
  scheme: "exact",
  network: "eip155:43113",
  asset: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
  amount: "1000",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { name: "FACET USD", version: "2" },
};
const body = {
  x402Version: 2,
  paymentRequirements: requirements,
  paymentPayload: { x402Version: 2, accepted: requirements, payload: {} },
};

describe("facilitator request boundary", () => {
  it("accepts only the configured Fuji quote shape", () => {
    expect(
      validatePaymentRequest(body, payTo, "1000").paymentRequirements.network,
    ).toBe("eip155:43113");
  });
  it("rejects wrong chain, asset, amount or recipient before SDK verification", () => {
    for (const change of [
      { network: "eip155:84532" },
      { asset: "0x0000000000000000000000000000000000000000" },
      { amount: "2000" },
      { payTo: "0x0000000000000000000000000000000000000002" },
    ]) {
      expect(() =>
        validatePaymentRequest(
          { ...body, paymentRequirements: { ...requirements, ...change } },
          payTo,
          "1000",
        ),
      ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
    }
  });
  it("rejects a payload accepting different requirements", () => {
    expect(() =>
      validatePaymentRequest(
        {
          ...body,
          paymentPayload: {
            ...body.paymentPayload,
            accepted: { ...requirements, amount: "2000" },
          },
        },
        payTo,
        "1000",
      ),
    ).toThrow("PAYMENT_ACCEPTED_MISMATCH");
  });
});
