import { isAddress, parseAbi, type Address, type PublicClient } from "viem";

const abi = parseAbi([
  "function settlementOperator() view returns (address)",
  "function runnerSigner() view returns (address)",
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
  return { operator: onChainOperator, runner: onChainRunner };
}
