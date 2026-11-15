import { createPublicClient, http, parseAbi } from "viem";

const rpc =
  process.env.FACET_FUJI_RPC_URL ??
  "https://api.avax-test.network/ext/bc/C/rpc";
const asset = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f" as const;
const client = createPublicClient({
  transport: http(rpc, { timeout: 15_000 }),
});
const chainId = await client.getChainId();
if (chainId !== 43113) throw new Error(`Fuji chain ID mismatch: ${chainId}`);
const code = await client.getCode({ address: asset });
if (!code || code === "0x") throw new Error("Fuji token has no bytecode");
const abi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
const [name, version, decimals, authorizationUsed] = await Promise.all([
  client.readContract({ address: asset, abi, functionName: "name" }),
  client.readContract({ address: asset, abi, functionName: "version" }),
  client.readContract({ address: asset, abi, functionName: "decimals" }),
  client.readContract({
    address: asset,
    abi,
    functionName: "authorizationState",
    args: ["0x0000000000000000000000000000000000000000", `0x${"0".repeat(64)}`],
  }),
]);
if (decimals !== 6 || authorizationUsed !== false)
  throw new Error("Unexpected Fuji fUSD interface result");
process.stdout.write(
  JSON.stringify({
    chainId,
    asset,
    bytecodeBytes: (code.length - 2) / 2,
    name,
    version,
    decimals,
    authorizationUsed,
  }) + "\n",
);
