# x402-facilitator instructions

- This is a standalone repository; it must never depend on parent/sibling source or configuration.
- Do not add application code until Phase 4 is explicitly started.
- Implement `/supported`, `/verify` and `/settle` only for explicitly registered/tested schemes.
- Capture live `/supported`, token authorization and Fuji settlement evidence before claiming support.
- Keep signer material behind the accepted signer/policy interface and never claim TEE security.
- Preserve separate Run and payment state and test indeterminate settlement/reconciliation.
