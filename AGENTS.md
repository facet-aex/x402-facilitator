# x402-facilitator instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Use npm only and commit this repository's own `package-lock.json` when application code begins.
- ADR-0011 permits a self-hosted Fuji testnet facilitator for the supervised Demo Track before formal Phase 4. Do not claim Phase 4 completion from the demo.
- Implement `/supported`, `/verify` and `/settle` only for explicitly registered/tested schemes.
- Capture live `/supported`, token authorization and Fuji settlement evidence before claiming support.
- For the local Demo Track, a dedicated low-balance testnet key may be loaded from ignored local configuration under ADR-0011. Keep it out of logs and tracked files; KMS/HSM remains a later gate. Never claim TEE security.
- Preserve separate Run and payment state and test indeterminate settlement/reconciliation.
