export function settlementRoute(
  payTo: string,
  feeSplitAddress?: string,
): "CONTRACT" | "DIRECT" {
  return feeSplitAddress &&
    payTo.toLowerCase() === feeSplitAddress.toLowerCase()
    ? "CONTRACT"
    : "DIRECT";
}
