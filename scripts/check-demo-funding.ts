import { loadEnvFile } from "node:process";
import { createPublicClient, http, parseAbi, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const key = process.env.FACET_FUJI_FACILITATOR_PRIVATE_KEY;
const payer = process.env.FACET_DEMO_PAYER_ADDRESS;
if (!key || !/^0x[a-f0-9]{64}$/iu.test(key) || !payer || !isAddress(payer))
  throw new Error("LOCAL_WALLETS_NOT_CONFIGURED");
const facilitator = privateKeyToAccount(key as `0x${string}`).address;
const rpc =
  process.env.FACET_FUJI_RPC_URL ??
  "https://api.avax-test.network/ext/bc/C/rpc";
const client = createPublicClient({
  transport: http(rpc, { timeout: 15_000 }),
});
const [avaxWei, payerFusdAtomic] = await Promise.all([
  client.getBalance({ address: facilitator }),
  client.readContract({
    address: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [payer],
  }),
]);
process.stdout.write(
  JSON.stringify({
    facilitator,
    payer,
    avaxWei: avaxWei.toString(),
    payerFusdAtomic: payerFusdAtomic.toString(),
    ready: avaxWei > 0n && payerFusdAtomic >= 1000n,
  }) + "\n",
);
