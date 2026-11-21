import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  getAddress,
  verifyTypedData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { verifyReceiveAuthorization } from "../src/receive-auth.js";
import { FUJI_FUSD } from "../src/fuji.js";

const PAYER_KEY = `0x${"a".repeat(64)}` as Hex;
const OTHER_KEY = `0x${"b".repeat(64)}` as Hex;
const payerAccount = privateKeyToAccount(PAYER_KEY);
const feeSplit = "0xc50cb5d5ff6c71eb1b065971c198a9edb0ecff06" as Address;

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function makePublicClient(opts?: {
  authorizationUsed?: boolean;
  balance?: bigint;
}) {
  return {
    verifyTypedData: (args: Parameters<typeof verifyTypedData>[0]) =>
      verifyTypedData(args),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "authorizationState")
        return opts?.authorizationUsed ?? false;
      if (functionName === "balanceOf") return opts?.balance ?? 1_000_000n;
      throw new Error(`unexpected readContract ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe("verifyReceiveAuthorization", () => {
  const now = Math.floor(Date.now() / 1000);
  const requirements = {
    scheme: "exact" as const,
    network: "eip155:43113" as const,
    asset: FUJI_FUSD,
    amount: "5000",
    payTo: feeSplit,
    maxTimeoutSeconds: 60,
    extra: {
      name: "FACET USD",
      version: "2",
      authorizationType: "ReceiveWithAuthorization",
    },
  };

  async function buildSignedPayload(
    kind: "ReceiveWithAuthorization" | "TransferWithAuthorization",
    key = PAYER_KEY,
  ) {
    const signer = privateKeyToAccount(key);
    const authorization = {
      from: payerAccount.address,
      to: getAddress(feeSplit),
      value: "5000",
      validAfter: "0",
      validBefore: String(now + 120),
      nonce: `0x${"1".repeat(64)}` as Hex,
    };
    const domain = {
      name: "FACET USD",
      version: "2",
      chainId: 43113,
      verifyingContract: getAddress(FUJI_FUSD),
    };
    const message = {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    };
    const signature =
      kind === "ReceiveWithAuthorization"
        ? await signer.signTypedData({
            domain,
            types: RECEIVE_TYPES,
            primaryType: "ReceiveWithAuthorization",
            message,
          })
        : await signer.signTypedData({
            domain,
            types: TRANSFER_TYPES,
            primaryType: "TransferWithAuthorization",
            message,
          });
    return {
      x402Version: 2 as const,
      accepted: requirements,
      payload: { authorization, signature },
    };
  }

  it("accepts a valid EIP-712 ReceiveWithAuthorization signature", async () => {
    const payload = await buildSignedPayload("ReceiveWithAuthorization");
    const result = await verifyReceiveAuthorization({
      publicClient: makePublicClient(),
      payload,
      requirements,
      expectedRecipient: feeSplit,
    });
    expect(result).toEqual({ isValid: true, payer: payerAccount.address });
  });

  it("rejects a TransferWithAuthorization signature and wrong-signer signatures", async () => {
    const transferPayload = await buildSignedPayload(
      "TransferWithAuthorization",
    );
    const transferRes = await verifyReceiveAuthorization({
      publicClient: makePublicClient(),
      payload: transferPayload,
      requirements,
      expectedRecipient: feeSplit,
    });
    expect(transferRes.isValid).toBe(false);
    expect(transferRes.invalidReason).toBe(
      "INVALID_RECEIVE_AUTHORIZATION_SIGNATURE",
    );

    const wrongSignerPayload = await buildSignedPayload(
      "ReceiveWithAuthorization",
      OTHER_KEY,
    );
    const wrongSignerRes = await verifyReceiveAuthorization({
      publicClient: makePublicClient(),
      payload: wrongSignerPayload,
      requirements,
      expectedRecipient: feeSplit,
    });
    expect(wrongSignerRes.isValid).toBe(false);
  });

  it("rejects used nonces and insufficient fUSD balance", async () => {
    const payload = await buildSignedPayload("ReceiveWithAuthorization");
    const usedRes = await verifyReceiveAuthorization({
      publicClient: makePublicClient({ authorizationUsed: true }),
      payload,
      requirements,
      expectedRecipient: feeSplit,
    });
    expect(usedRes).toEqual({
      isValid: false,
      invalidReason: "AUTHORIZATION_ALREADY_USED",
      payer: payerAccount.address,
    });

    const lowBalanceRes = await verifyReceiveAuthorization({
      publicClient: makePublicClient({ balance: 4999n }),
      payload,
      requirements,
      expectedRecipient: feeSplit,
    });
    expect(lowBalanceRes).toEqual({
      isValid: false,
      invalidReason: "INSUFFICIENT_BALANCE",
      payer: payerAccount.address,
    });
  });
});
