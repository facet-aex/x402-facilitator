# FACET x402 Facilitator (`@facet/x402-facilitator`)

[![FACET](https://img.shields.io/badge/FACET-facet.briandev.space-050505?style=flat-square&labelColor=DFFF4F)](https://facet.briandev.space)
[![Layer](https://img.shields.io/badge/PAYMENTS-X402%20SETTLEMENT-0D0D0D?style=flat-square&labelColor=343434)](https://github.com/facet-aex)

> Self-hosted HTTP x402 verification and Avalanche on-chain settlement service for FACET.

## Overview

`x402-facilitator` handles cryptographic payment verification and blockchain settlement for **FACET**. It bridges HTTP `402` client authorizations with FACET's smart contracts on Avalanche so callers never need to manage gas fees directly.

## Role in FACET

- **EIP-3009 Verification:** Validates signed `fUSD` (`transferWithAuthorization`) payment headers submitted to `gateway` before workload execution begins.
- **Multi-Pricing Settlement:** Executes instant creator revenue splits (`FeeSplit`) for `PAY_PER_RUN` calls and runner-verified settlement with automatic buyer refunds (`TaskEscrow`) for `PAY_PER_RESULT` calls.
- **On-Chain Receipt Logging:** Records immutable execution proofs in `FacetReceiptLog` alongside settlement transactions.
- **Idempotent Phase Tracking:** Persists pending settlement phases in PostgreSQL to prevent duplicate on-chain submissions and support safe recovery.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime & HTTP | Node.js 24 (ESM), TypeScript, Fastify 5 |
| x402 & Web3 | `@x402/core`, `@x402/evm`, `viem` |
| Database | PostgreSQL (`pg`) |
| Testing & Container | Vitest, Prettier, Docker (`node:24-alpine`) |

---

Part of **[FACET](https://facet.briandev.space)** (`facet-aex`) — Federated Agent Capability Exchange & Trust on Avalanche.
