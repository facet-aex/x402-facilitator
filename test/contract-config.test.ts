import { expect, test } from "vitest";
import type { PublicClient } from "viem";
import { verifyFeeContractConfig } from "../src/contract-config.js";
import { FUJI_FUSD } from "../src/fuji.js";

const contract = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06";
const operator = "0xA8fd48580a3f16B86cfC9c4efbd9fa68bC0F4E3B";
const owner = "0x9Ba67CbB2af751af5e874a7EB57691828F43658e";
const wrong = "0x0000000000000000000000000000000000000001";

test("verifies v2 FeeSplit getters and rejects operator mismatch or v1 contract", async () => {
  const client = {
    getCode: async () => "0x6000",
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "settlementOperator":
          return operator;
        case "runnerSigner":
          return wrong;
        case "token":
          return FUJI_FUSD;
        case "owner":
          return owner;
        case "DEFAULT_ESCROW_TIMEOUT":
          return 900n;
        case "totalEscrowed":
          return 0n;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    },
  } as unknown as PublicClient;

  await expect(
    verifyFeeContractConfig(client, contract, wrong),
  ).rejects.toThrow("FEE_SPLIT_OPERATOR_MISMATCH");

  await expect(
    verifyFeeContractConfig(client, contract, operator),
  ).resolves.toEqual({
    operator,
    runner: wrong,
    owner,
    defaultEscrowTimeout: 900n,
  });

  const v1Client = {
    getCode: async () => "0x6000",
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "settlementOperator") return operator;
      if (functionName === "runnerSigner") return wrong;
      throw new Error("missing v2 function");
    },
  } as unknown as PublicClient;

  await expect(
    verifyFeeContractConfig(v1Client, contract, operator),
  ).rejects.toThrow("FEE_SPLIT_V2_REQUIRED");
});
