# `x402-facilitator` instructions

**Owner in Wave 2:** Codex  
**Port:** `4022`  
**Active architectural authority:** `../docs/architecture/decisions/ADR-0015-actorbazaar-docker-and-a2a-mvp.md`

## Role

Self-hosted x402 payment verification and settlement service on **Avalanche Fuji C-Chain (`eip155:43113`)** for `FacetUSD` (`fUSD` at `0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f`).

## Responsibilities

- Expose `/supported`, `/verify`, `/settle`, and optional `/escrow/deposit` & `/escrow/refund` (or handle escrow deposit/settlement inside `/verify` and `/settle` metadata).
- Replace the static global `FACET_DEMO_PAY_TO` / `FACET_DEMO_AMOUNT_ATOMIC` restriction in `request-validation.ts` with dynamic per-version `payTo` and `amount` validation bounded by `FACET_MAX_PAYMENT_ATOMIC` (default `100000` = `0.1 fUSD`).
- Verify EIP-3009 `transferWithAuthorization` signatures and nonces on `FacetUSD` (`fUSD`).
- Prevent duplicate settlement via durable PostgreSQL state (`x402_demo_settlements`).
- When `FACET_FEE_SPLIT_ADDRESS` is configured and `paymentRequirements.payTo === FACET_FEE_SPLIT_ADDRESS`:
  - For `PAY_PER_RUN`: call `FacetFeeSplitAndEscrow.settlePayPerRunWithAuthorization(...)` so creators receive `95%` immediately on settle.
  - For `PAY_PER_RESULT`: deposit `maxAmount` via `depositEscrowWithAuthorization(...)` prior to run, and settle via `settleEscrow(runId, inputHash, outputHash, itemCount, runnerSignature)` (which refunds `maxAmount - actualAmount` to the payer), or `refundEscrow(runId)` on failure.
