import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const mnemonic = "test test test test test test test test test test test junk";
const port = 18545;
const rpc = `http://127.0.0.1:${port}`;
const chain = defineChain({
  id: 43113,
  name: "Local Fuji integration",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const anvil = spawn(
  process.env.ANVIL_BIN ?? "anvil",
  [
    "--chain-id",
    "43113",
    "--port",
    String(port),
    "--mnemonic",
    mnemonic,
    "--silent",
  ],
  { stdio: "ignore" },
);
const clients = [0, 1, 2, 3, 4].map((index) => {
  const account = mnemonicToAccount(mnemonic, { addressIndex: index });
  return {
    account,
    wallet: createWalletClient({ account, chain, transport: http(rpc) }),
  };
});
const publicClient = createPublicClient({ chain, transport: http(rpc) });
const [operator, payer, creator, treasury, runner] = clients;

async function waitForAnvil() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await publicClient.getChainId()) === 43113) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("ANVIL_NOT_READY");
}

async function deploy(name, args) {
  const artifact = JSON.parse(
    await readFile(
      new URL(`../../contracts/out/${name}.sol/${name}.json`, import.meta.url),
    ),
  );
  const hash = await operator.wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  return { address: receipt.contractAddress, abi: artifact.abi };
}

async function signedPayment(tokenAddress, escrowAddress, amount) {
  const requirements = {
    scheme: "exact",
    network: "eip155:43113",
    asset: tokenAddress,
    amount: String(amount),
    payTo: escrowAddress,
    maxTimeoutSeconds: 60,
    extra: { name: "FACET USD", version: "2" },
  };
  const client = new ExactEvmScheme({
    address: payer.account.address,
    signTypedData: (args) => payer.wallet.signTypedData(args),
  });
  const payload = await client.createPaymentPayload(2, requirements);
  assert.equal(
    payload.payload.authorization.to.toLowerCase(),
    escrowAddress.toLowerCase(),
  );
  assert.equal(payload.payload.authorization.value, requirements.amount);
  return payload.payload;
}

async function call(contract, functionName, args) {
  const hash = await operator.wallet.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", functionName);
  return hash;
}

async function main() {
  await waitForAnvil();
  const token = await deploy("FacetUSD", [
    operator.account.address,
    payer.account.address,
  ]);
  const contract = await deploy("FacetFeeSplitAndEscrow", [
    token.address,
    treasury.account.address,
    500,
    runner.account.address,
    operator.account.address,
  ]);
  const runId = keccak256(stringToHex("x402-run"));
  const facetId = keccak256(stringToHex("x402-facet"));
  const payment = await signedPayment(token.address, contract.address, 10000n);
  const auth = payment.authorization;
  await call(contract, "settlePayPerRunWithAuthorization", [
    runId,
    facetId,
    auth.from,
    creator.account.address,
    BigInt(auth.value),
    BigInt(auth.validAfter),
    BigInt(auth.validBefore),
    auth.nonce,
    payment.signature,
  ]);
  const tokenAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
  ]);
  const balance = (address) =>
    publicClient.readContract({
      address: token.address,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [address],
    });
  assert.equal(await balance(creator.account.address), 9500n);
  assert.equal(await balance(treasury.account.address), 500n);

  const escrowRun = keccak256(stringToHex("x402-escrow"));
  const escrowPayment = await signedPayment(
    token.address,
    contract.address,
    20000n,
  );
  const escrowAuth = escrowPayment.authorization;
  const payerBefore = await balance(payer.account.address);
  await call(contract, "depositEscrowWithAuthorization", [
    escrowRun,
    facetId,
    escrowAuth.from,
    creator.account.address,
    1000n,
    BigInt(escrowAuth.value),
    BigInt(escrowAuth.validAfter),
    BigInt(escrowAuth.validBefore),
    escrowAuth.nonce,
    escrowPayment.signature,
  ]);
  const inputHash = keccak256(stringToHex("input"));
  const outputHash = keccak256(stringToHex("output"));
  const usageDigest = keccak256(
    encodePacked(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [escrowRun, facetId, inputHash, outputHash, 7n],
    ),
  );
  const signature = await runner.account.signMessage({
    message: { raw: usageDigest },
  });
  await call(contract, "settleEscrow", [
    escrowRun,
    inputHash,
    outputHash,
    7n,
    signature,
  ]);
  assert.equal(await balance(payer.account.address), payerBefore - 7000n);
  assert.equal(await balance(creator.account.address), 9500n + 6650n);
  assert.equal(await balance(treasury.account.address), 500n + 350n);
  process.stdout.write(
    "x402 2.30.0 EIP-3009 payload settled both contract pricing models on Anvil.\n",
  );
}

try {
  await main();
} finally {
  anvil.kill("SIGTERM");
}
