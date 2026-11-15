import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Pool } from "pg";
import { PostgresPendingSettlementStore } from "./pending-store.js";

export const FUJI_NETWORK = "eip155:43113";
export const FUJI_FUSD = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";

export async function createFujiFacilitator(
  pool: Pool,
  rpcUrl: string,
  privateKey: `0x${string}`,
) {
  const chain = defineChain({
    id: 43113,
    name: "Avalanche Fuji",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });
  if ((await publicClient.getChainId()) !== 43113)
    throw new Error("FUJI_CHAIN_MISMATCH");
  const code = await publicClient.getCode({ address: FUJI_FUSD });
  if (!code || code === "0x") throw new Error("FUJI_FUSD_CODE_MISSING");
  const abi = parseAbi([
    "function name() view returns (string)",
    "function version() view returns (string)",
    "function decimals() view returns (uint8)",
  ]);
  const [name, version, decimals] = await Promise.all([
    publicClient.readContract({
      address: FUJI_FUSD,
      abi,
      functionName: "name",
    }),
    publicClient.readContract({
      address: FUJI_FUSD,
      abi,
      functionName: "version",
    }),
    publicClient.readContract({
      address: FUJI_FUSD,
      abi,
      functionName: "decimals",
    }),
  ]);
  if (name !== "FACET USD" || version !== "2" || decimals !== 6)
    throw new Error("FUJI_FUSD_DOMAIN_MISMATCH");
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl, { timeout: 15_000 }),
  }).extend(publicActions);
  const signerInput: Parameters<typeof toFacilitatorEvmSigner>[0] = {
    address: account.address,
    readContract: (args) =>
      publicClient.readContract(
        args as Parameters<typeof publicClient.readContract>[0],
      ),
    verifyTypedData: (args) =>
      publicClient.verifyTypedData(
        args as Parameters<typeof publicClient.verifyTypedData>[0],
      ),
    writeContract: (args) =>
      wallet.writeContract({ ...args, account, chain } as Parameters<
        typeof wallet.writeContract
      >[0]),
    sendTransaction: (args) =>
      wallet.sendTransaction({ ...args, account, chain }),
    waitForTransactionReceipt: (args) =>
      publicClient.waitForTransactionReceipt(args),
    getCode: (args) => publicClient.getCode(args),
  };
  const signer = toFacilitatorEvmSigner(signerInput, {
    confirmationTimeoutMs: 25_000,
  });
  const facilitator = new x402Facilitator().register(
    FUJI_NETWORK,
    new ExactEvmScheme(signer, {
      pendingSettlementStore: new PostgresPendingSettlementStore(pool),
    }),
  );
  return { facilitator, signerAddress: account.address };
}
