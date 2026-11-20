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
  it("accepts a dynamic per-version amount and recipient within the configured cap", () => {
    const dynamic = {
      ...requirements,
      amount: "1200",
      payTo: "0x0000000000000000000000000000000000000002",
    };
    const request = {
      ...body,
      paymentRequirements: dynamic,
      paymentPayload: { ...body.paymentPayload, accepted: dynamic },
    };
    expect(
      validatePaymentRequest(request, { maxAmountAtomic: 100000n })
        .paymentRequirements,
    ).toEqual(dynamic);
  });

  it("rejects zero, non-integer and over-cap dynamic amounts", () => {
    for (const amount of ["0", "1.5", "100001", "-1"]) {
      const dynamic = { ...requirements, amount };
      const request = {
        ...body,
        paymentRequirements: dynamic,
        paymentPayload: { ...body.paymentPayload, accepted: dynamic },
      };
      expect(() =>
        validatePaymentRequest(request, { maxAmountAtomic: 100000n }),
      ).toThrow();
    }
    const overCap = { ...requirements, amount: "100001" };
    expect(() =>
      validatePaymentRequest(
        {
          ...body,
          paymentRequirements: overCap,
          paymentPayload: { ...body.paymentPayload, accepted: overCap },
        },
        { maxAmountAtomic: 100000n },
      ),
    ).toThrow("PAYMENT_AMOUNT_EXCEEDS_CAP");
  });

  it("accepts FACET multi-pricing extra fields for PAY_PER_RESULT and PAY_PER_RUN", () => {
    const providerPayTo = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
    const payPerResult = {
      ...requirements,
      amount: "5000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        providerPayTo,
      },
    };
    expect(
      validatePaymentRequest(
        {
          ...body,
          paymentRequirements: payPerResult,
          paymentPayload: {
            ...body.paymentPayload,
            accepted: {
              ...payPerResult,
              extra: {
                ...payPerResult.extra,
                providerPayTo: providerPayTo.toLowerCase(),
              },
            },
          },
        },
        { maxAmountAtomic: 100000n },
      ).paymentRequirements,
    ).toEqual(payPerResult);

    const payPerRun = {
      ...requirements,
      amount: "10000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "10000",
        providerPayTo,
      },
    };
    expect(
      validatePaymentRequest(
        {
          ...body,
          paymentRequirements: payPerRun,
          paymentPayload: { ...body.paymentPayload, accepted: payPerRun },
        },
        { maxAmountAtomic: 100000n },
      ).paymentRequirements,
    ).toEqual(payPerRun);
  });

  it("rejects accepted.extra pricingModel mismatch when amount is identical", () => {
    const providerPayTo = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
    const reqRun = {
      ...requirements,
      amount: "10000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "10000",
        providerPayTo,
      },
    };
    const accResult = {
      ...requirements,
      amount: "10000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 20,
        providerPayTo,
      },
    };
    expect(() =>
      validatePaymentRequest(
        {
          ...body,
          paymentRequirements: reqRun,
          paymentPayload: { ...body.paymentPayload, accepted: accResult },
        },
        { maxAmountAtomic: 100000n },
      ),
    ).toThrow("PAYMENT_ACCEPTED_MISMATCH");

    expect(() =>
      validatePaymentRequest(
        {
          ...body,
          paymentRequirements: reqRun,
          paymentPayload: {
            ...body.paymentPayload,
            accepted: {
              ...reqRun,
              extra: {
                ...reqRun.extra,
                providerPayTo: "0x0000000000000000000000000000000000000009",
              },
            },
          },
        },
        { maxAmountAtomic: 100000n },
      ),
    ).toThrow("PAYMENT_ACCEPTED_MISMATCH");
  });

  it("rejects PAY_PER_RESULT extra when unitPriceAtomic * maxItemsCap !== amount or maxItemsCap out of 1..1000", () => {
    const providerPayTo = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
    for (const extra of [
      {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 9,
        providerPayTo,
      },
      {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 0,
        providerPayTo,
      },
      {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 1001,
        providerPayTo,
      },
      {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 1.5,
        providerPayTo,
      },
      {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        providerPayTo: "0x0000000000000000000000000000000000000000",
      },
    ]) {
      const bad = { ...requirements, amount: "5000", extra };
      expect(() =>
        validatePaymentRequest(
          {
            ...body,
            paymentRequirements: bad,
            paymentPayload: { ...body.paymentPayload, accepted: bad },
          },
          { maxAmountAtomic: 1000000n },
        ),
      ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
    }
  });

  it("rejects PAY_PER_RUN extra with maxItemsCap present", () => {
    const bad = {
      ...requirements,
      amount: "1000",
      extra: {
        name: "FACET USD",
        version: "2",
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "1000",
        maxItemsCap: 10,
      },
    };
    expect(() =>
      validatePaymentRequest(
        {
          ...body,
          paymentRequirements: bad,
          paymentPayload: { ...body.paymentPayload, accepted: bad },
        },
        { maxAmountAtomic: 100000n },
      ),
    ).toThrow("PAYMENT_REQUIREMENTS_MISMATCH");
  });
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
