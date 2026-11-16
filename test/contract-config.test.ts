import { expect, test } from "vitest";
import type { PublicClient } from "viem";
import { verifyFeeContractConfig } from "../src/contract-config.js";

const contract = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06";
const operator = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
const wrong = "0x0000000000000000000000000000000000000001";

test("rejects a facilitator key that cannot call the deployed settlement contract", async () => {
  const client = {
    getCode: async () => "0x6000",
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "settlementOperator" ? operator : wrong,
  } as unknown as PublicClient;
  await expect(
    verifyFeeContractConfig(client, contract, wrong),
  ).rejects.toThrow("FEE_SPLIT_OPERATOR_MISMATCH");
  await expect(
    verifyFeeContractConfig(client, contract, operator),
  ).resolves.toEqual({
    operator,
    runner: wrong,
  });
});
