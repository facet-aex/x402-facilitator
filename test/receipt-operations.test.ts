import { expect, test } from "vitest";
import type { Pool } from "pg";
import { recordPaidReceipt } from "../src/receipt-operations.js";

test("rejects incomplete receipt proof before any database or chain write", async () => {
  await expect(
    recordPaidReceipt({} as Pool, {} as never, {
      runId: "019a1234-5678-7abc-8def-123456789abc",
      facetId: "019a1234-5678-7abc-8def-123456789abd",
      itemCount: 1,
      inputHash: `sha256:${"a".repeat(64)}`,
      outputHash: `sha256:${"b".repeat(64)}`,
      paymentTxHash: `0x${"0".repeat(64)}`,
      runnerSignature: `0x${"c".repeat(130)}`,
    }),
  ).rejects.toThrow("RECEIPT_REQUEST_INVALID");
});
