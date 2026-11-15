import {
  createPublicClient,
  decodeFunctionData,
  http,
  parseAbi,
  parseEventLogs,
} from "viem";
import { FUJI_FUSD } from "../src/fuji.js";

const hash = process.argv[2];
if (!hash || !/^0x[a-f0-9]{64}$/iu.test(hash))
  throw new Error("Pass a Fuji transaction hash");
const rpc =
  process.env.FACET_FUJI_RPC_URL ??
  "https://api.avax-test.network/ext/bc/C/rpc";
const client = createPublicClient({
  transport: http(rpc, { timeout: 15_000 }),
});
if ((await client.getChainId()) !== 43113)
  throw new Error("FUJI_CHAIN_MISMATCH");
const receipt = await client.getTransactionReceipt({
  hash: hash as `0x${string}`,
});
if (
  receipt.status !== "success" ||
  receipt.to?.toLowerCase() !== FUJI_FUSD.toLowerCase()
)
  throw new Error("SETTLEMENT_RECEIPT_INVALID");
const abi = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const tx = await client.getTransaction({ hash: hash as `0x${string}` });
const decoded = decodeFunctionData({ abi, data: tx.input });
if (decoded.functionName !== "transferWithAuthorization")
  throw new Error("NOT_EIP3009_TRANSFER");
const [from, to, value, , , nonce] = decoded.args;
const transfers = parseEventLogs({
  abi,
  eventName: "Transfer",
  logs: receipt.logs,
  strict: true,
});
if (
  transfers.length !== 1 ||
  transfers[0]?.args.from.toLowerCase() !== from.toLowerCase() ||
  transfers[0]?.args.to.toLowerCase() !== to.toLowerCase() ||
  transfers[0]?.args.value !== value
)
  throw new Error("TRANSFER_EVENT_MISMATCH");
const used = await client.readContract({
  address: FUJI_FUSD,
  abi,
  functionName: "authorizationState",
  args: [from, nonce],
});
if (!used) throw new Error("AUTHORIZATION_NONCE_NOT_USED");
process.stdout.write(
  JSON.stringify({
    chainId: 43113,
    asset: FUJI_FUSD,
    transaction: hash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
    from,
    to,
    amountAtomic: value.toString(),
    decimals: 6,
    transferEvents: transfers.length,
    authorizationUsed: used,
  }) + "\n",
);
