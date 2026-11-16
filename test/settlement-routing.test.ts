import { expect, test } from "vitest";
import { settlementRoute } from "../src/settlement-routing.js";

test("never sends fee-split authorizations to direct ERC-3009 settlement", () => {
  const contract = "0x0000000000000000000000000000000000000001";
  expect(settlementRoute(contract, contract)).toBe("CONTRACT");
  expect(
    settlementRoute("0x0000000000000000000000000000000000000002", contract),
  ).toBe("DIRECT");
});
