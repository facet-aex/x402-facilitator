import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

loadEnvFile();
loadEnvFile("../executor/.env");
loadEnvFile("../mcp-server/.env");
const payer = privateKeyToAccount(process.env.FACET_DEMO_PAYER_PRIVATE_KEY);
const facilitatorToken = process.env.FACET_FACILITATOR_TOKEN;
const executorToken = process.env.FACET_EXECUTOR_TOKEN;
const contract = process.env.FACET_FEE_SPLIT_ADDRESS;
const creator = process.env.FACET_DEMO_PAY_TO;
if (!facilitatorToken || !executorToken || !contract || !creator)
  throw new Error("SMOKE_CONFIG_MISSING");

const chain = createPublicClient({
  transport: http(process.env.FACET_FUJI_RPC_URL),
});
if ((await chain.getChainId()) !== 43113)
  throw new Error("SMOKE_CHAIN_INVALID");
const token = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";
const balanceAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const balance = (address) =>
  chain.readContract({
    address: token,
    abi: balanceAbi,
    functionName: "balanceOf",
    args: [address],
  });
const payerBefore = await balance(payer.address);
const creatorBefore = await balance(creator);
const requirements = {
  scheme: "exact",
  network: "eip155:43113",
  asset: token,
  amount: "1000",
  payTo: contract,
  maxTimeoutSeconds: 60,
  extra: { name: "FACET USD", version: "2" },
};
const client = new ExactEvmScheme({
  address: payer.address,
  signTypedData: (args) => payer.signTypedData(args),
});
const signed = await client.createPaymentPayload(2, requirements);
const paymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: signed.payload,
};
const runId = randomUUID();
const facetId = randomUUID();
process.stdout.write(
  JSON.stringify({ phase: "PREPARED", runId, facetId }) + "\n",
);

async function post(url, tokenValue, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [url.includes("4030")
        ? "x-facet-executor-token"
        : "x-facet-facilitator-token"]: tokenValue,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${url}: ${JSON.stringify(result)}`);
  return result;
}

const verified = await post("http://127.0.0.1:4022/verify", facilitatorToken, {
  x402Version: 2,
  paymentPayload,
  paymentRequirements: requirements,
});
if (
  !verified.isValid ||
  verified.payer?.toLowerCase() !== payer.address.toLowerCase()
)
  throw new Error("SMOKE_VERIFY_FAILED");
const settlement = await post(
  "http://127.0.0.1:4022/v1/contract/SETTLE_RUN",
  facilitatorToken,
  {
    x402Version: 2,
    runId,
    facetId,
    creatorPayTo: creator,
    unitPriceAtomic: "1000",
    paymentPayload,
    paymentRequirements: requirements,
  },
);
if (settlement.status !== "CONFIRMED")
  throw new Error("SMOKE_SETTLEMENT_PENDING");
const usage = await post(
  "http://127.0.0.1:4030/v1/sign-external-result",
  executorToken,
  {
    runId,
    facetId,
    input: { fixture: "local-fuji-smoke" },
    result: { ok: true },
  },
);
const receipt = await post(
  "http://127.0.0.1:4022/v1/receipt",
  facilitatorToken,
  {
    runId,
    facetId,
    inputHash: usage.inputHash,
    outputHash: usage.outputHash,
    itemCount: usage.itemCount,
    runnerSignature: usage.runnerSignature,
    paymentTxHash: settlement.transaction,
  },
);
if (receipt.status !== "CONFIRMED") throw new Error("SMOKE_RECEIPT_PENDING");
const payerAfter = await balance(payer.address);
const creatorAfter = await balance(creator);
if (payerBefore - payerAfter !== 1000n || creatorAfter - creatorBefore !== 950n)
  throw new Error("SMOKE_BALANCE_MISMATCH");
process.stdout.write(
  JSON.stringify({
    runId,
    facetId,
    paymentTxHash: settlement.transaction,
    receiptTxHash: receipt.transaction,
    payerDebitAtomic: String(payerBefore - payerAfter),
    creatorCreditAtomic: String(creatorAfter - creatorBefore),
  }) + "\n",
);
