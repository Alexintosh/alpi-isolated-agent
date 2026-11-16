# boxes.dev verification pilot

Status: first script-only Linux verification completed on 2026-11-16.
This is coordinator-observed evidence, not an authenticated factory gate.

The `alpi-factory` Template uses Ubuntu 24.04, 4 CPU / 8 GB, Node 24.13.0
and npm 11.6.2. Its default checkout is remote `main`. Setup reported 111
portable tests passing on that baseline and two successful maintenance runs.
Requested setup agent: Codex `gpt-6.1-sol`, high reasoning; the effective
model and reasoning were not confirmed by runtime metadata.

Verification ran in a separate devbox created without an agent thread.
No model inference was used to execute the tests. The controller fetched
`feat/shared-provider-catalog`, required its exact expected commit, checked
out that commit detached, and checked the tree before and after execution.

| Field | Observed value |
| --- | --- |
| PR | https://github.com/Alexintosh/alpi-isolated-agent/pull/1 |
| Commit | `81fdfa5bc358c30ffb29bd81f3a79e4dcd773a44` |
| Tree | `36ffc01792c20f63c6259b8db52495316e1259ed` |
| Platform | Linux x86_64 |
| Installation | `npm ci --ignore-scripts --no-audit --no-fund` |
| Verification | `npm run test:portable` |
| Tests | 202 discovered, 202 passed; zero failed, skipped, cancelled or todo |
| Command result | Exit 0; 4,739 ms including fetch, install and tests |
| Checkout afterward | Same commit/tree, no tracked modifications |
| Output | Neither stream truncated; no timeout or cancellation |

The first invocation failed before checkout/tests because the controller
assumed an nvm installation. Setup had installed the pinned Node distribution
with stable executable symlinks. The corrected invocation verified the exact
Node/npm versions directly; no product changes or relaxed test checks were used.

Local evidence files are `/tmp/alpi-boxes-feature-pilot-20261116.json`,
`/tmp/alpi-boxes-feature-pilot-20261116.sh` and the corresponding
`-evidence.json`. Raw-result SHA-256:
`8177d5a25be0ccd8a3787f4690b2ad1c284f18dec470215ae5f14203b66fad8f`.
These local files are not a durable CI artifact or runner attestation.

No real provider, GitHub credential helper, Keychain, Electron app, Iron,
VM lifecycle or macOS package was exercised in this lane. The trusted
collector, GitHub required checks and native acceptance remain separate work.
