# x402-facilitator

Self-hosted x402 facilitator for the local Fuji Demo Track.

**Status:** fUSD Fuji RPC/token probe and live `/supported` passed; `/verify` and `/settle` completed one real 0.001 fUSD x402 payment through MCP/Gateway. The receipt has one Transfer event and a consumed EIP-3009 nonce. See the root `docs/implementation/demo-runbook.md`. Timeout-after-broadcast and restart fault checks remain open.

Run `npm ci` and `npm run probe:fuji` to check RPC, chain ID, fUSD bytecode, name/version, decimals and EIP-3009 `authorizationState`. No key is needed for this probe. After funding the dedicated signer, copy `.env.example` to ignored `.env`, configure the signer, fixed recipient and shared facilitator token, run `npm run db:migrate`, then `npm run dev`. The service binds loopback port 4022 and rejects startup with an unfunded signer. `GET /supported`, `POST /verify` and `POST /settle` require `x-facet-facilitator-token`. Run `npm run verify:settlement -- <hash>` to inspect a payment receipt and nonce.

Dependencies: official `@x402/core` and `@x402/evm` 2.30.0 (Apache-2.0) are required for the self-hosted facilitator and EVM exact scheme; viem 2.57.17 (MIT) is required for Fuji RPC/signing; Fastify 5.12.8 (MIT) will serve facilitator HTTP; pg 8.23.1 (MIT) will store pending settlement records. These packages were checked against current npm versions and the official x402 Foundation SDK on 2026-11-11. TypeScript, tsx, Vitest and Prettier are development dependencies.
