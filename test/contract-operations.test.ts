import { expect, test } from "vitest";
import type { Pool } from "pg";
import type { createFujiFacilitator } from "../src/fuji.js";
import { submitContractAction } from "../src/contract-operations.js";

const feeSplit = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06";
const payer = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
const requirements = {
  scheme: "exact",
  network: "eip155:43113",
  asset: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
  amount: "1000",
  payTo: feeSplit,
  maxTimeoutSeconds: 60,
  extra: { name: "FACET USD", version: "2" },
};
const body = {
  runId: "019a1234-5678-7abc-8def-123456789abc",
  facetId: "019a1234-5678-7abc-8def-123456789abd",
  creatorPayTo: payer,
  unitPriceAtomic: "1000",
  paymentRequirements: requirements,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: {
      authorization: {
        from: payer,
        to: feeSplit,
        value: "1000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"a".repeat(64)}`,
      },
      signature: `0x${"b".repeat(130)}`,
    },
  },
};

test("rejects a per-result deposit that is not exactly 20 units before any write", async () => {
  const clients = {} as Awaited<ReturnType<typeof createFujiFacilitator>>;
  const pool = {} as Pool;
  await expect(
    submitContractAction(pool, clients, feeSplit, "DEPOSIT", body, 100000n),
  ).rejects.toThrow("CONTRACT_PRICE_MISMATCH");
});
