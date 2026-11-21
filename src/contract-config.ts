import { isAddress, parseAbi, type Address, type PublicClient } from "viem";
import { FUJI_FUSD } from "./fuji.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const abi = parseAbi([
  "function settlementOperator() view returns (address)",
  "function runnerSigner() view returns (address)",
  "function token() view returns (address)",
  "function owner() view returns (address)",
  "function DEFAULT_ESCROW_TIMEOUT() view returns (uint64)",
  "function totalEscrowed() view returns (uint256)",
]);

export async function verifyFeeContractConfig(
  client: PublicClient,
  contract: string,
  operator: Address,
  expectedRunner?: string,
) {
  if (!isAddress(contract)) throw new Error("FEE_SPLIT_ADDRESS_INVALID");
  const address = contract as Address;
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error("FEE_SPLIT_CODE_MISSING");
  const [onChainOperator, onChainRunner] = await Promise.all([
    client.readContract({ address, abi, functionName: "settlementOperator" }),
    client.readContract({ address, abi, functionName: "runnerSigner" }),
  ]);
  if (onChainOperator.toLowerCase() !== operator.toLowerCase())
    throw new Error("FEE_SPLIT_OPERATOR_MISMATCH");
  if (
    expectedRunner &&
    onChainRunner.toLowerCase() !== expectedRunner.toLowerCase()
  )
    throw new Error("FEE_SPLIT_RUNNER_MISMATCH");

  let onChainToken: Address;
  let onChainOwner: Address;
  let defaultEscrowTimeout: bigint;
  try {
    [onChainToken, onChainOwner, defaultEscrowTimeout] = await Promise.all([
      client.readContract({ address, abi, functionName: "token" }),
      client.readContract({ address, abi, functionName: "owner" }),
      client.readContract({
        address,
        abi,
        functionName: "DEFAULT_ESCROW_TIMEOUT",
      }),
      client.readContract({ address, abi, functionName: "totalEscrowed" }),
    ]);
  } catch {
    throw new Error("FEE_SPLIT_V2_REQUIRED");
  }
  if (
    onChainToken.toLowerCase() !== FUJI_FUSD.toLowerCase() ||
    onChainOwner.toLowerCase() === ZERO_ADDRESS ||
    defaultEscrowTimeout <= 0n
  ) {
    throw new Error("FEE_SPLIT_V2_REQUIRED");
  }

  return {
    operator: onChainOperator,
    runner: onChainRunner,
    owner: onChainOwner,
    defaultEscrowTimeout,
  };
}
