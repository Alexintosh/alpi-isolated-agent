# Verification inventory: Models/Secrets/Git pilot

Status: static research only. Read-only commands and public source fetches ran; no tests, installation, app launch or commits.
Baseline `661578bbf1bcdffe3de8488e04993ea75e0f497d` plus the uncommitted feature
integration (`src/runtime/model-catalog.cjs`, `git-catalog.cjs`, `credential-bridge.cjs`,
`src/v1-main.cjs`, `src/v1/preload.cjs`, matching tests, new `tests/model-relay.test.cjs`).
Renderer (`src/v1/control.js`) findings are provisional: another worker owns that code.
No personal profile, Keychain, credentials, VM or inference was touched.

## 1. Existing coverage (read from fixtures, not filenames)

`npm run test:portable` (package.json) runs 17 synthetic files on temporary directories
with mocked vaults/services; Linux-portable per README/docs/setup.md. `npm test` adds
host-gated fixtures. Skip guards read in source:

- Real local Iron tests (`vendor/m0/iron-bin/iron-proxy`): `credential-bridge`, `git-bridge`,
  `network`, `network-policy-integration` skip unless darwin+arm64+binary+192.168.x LAN.
  `git-bridge` additionally needs the git-http fixture (`tests/fixtures/git-http.cjs`) with
  `/Library/Developer/CommandLineTools/usr/bin/git` → macOS-only.
- `lima-profile` skips off darwin. `secret-vault` mocks crypto and states "not Keychain
  proof". Real Keychain only via explicit `tests/vault-keychain-smoke.cjs` (Electron, not
  in the `*.test.cjs` glob). Live VM acceptance only via explicit `tests/v1-app-smoke.cjs`
  and `tests/m0/*` probes — never in `npm test`.
- Fake-DOM suites (`secret-controls`, `welcome-screen`, `environment-management-ui`,
  `ui-control-polish`) run shipped `src/v1/control.js` in `node:vm` against nodes parsed
  from `control.html` IDs. Real handlers, simulated DOM; no Electron.
- `native-onboarding` runs real `src/v1-main.cjs` in `node:vm` with mocked Electron and a
  stub catalog/coordinator. `coordinator`/`environment-management` use fake drivers.

| Feature area | Covered today | Layer |
| --- | --- | --- |
| Model catalog CRUD, selection, limits, v1→v2 migration | `model-catalog.test.cjs` | Portable synthetic |
| DSH import (multi-model, default, atomicity, no-auth-only, YAML sanitization) | `model-catalog.test.cjs` | Portable synthetic |
| Credential rotation/retirement (catalog) | `model-catalog`, `git-catalog` | Portable synthetic |
| Relay no-auth, model-list filtering, bearer injection, reflected-secret filtering | `model-relay.test.cjs` (new) | Portable; injected `requestUpstream`, not Iron |
| Revocation interrupting live SSE; redirect/compressed rejection | `credential-bridge.test.cjs` | Real Iron, macOS-gated |
| Git PAT manual save/rotation, helper import failure/abort, serialization | `git-catalog.test.cjs` | Portable synthetic |
| Real Git clone/fetch/push through Iron with host Basic auth | `git-bridge.test.cjs` | Real Iron + macOS git fixture |
| Shared catalog IPC: untrusted senders, stop-all-before-publish, failed stop retains guard, quit cancellation | `native-onboarding.test.cjs` | Mocked Electron/coordinator |
| Ownership, failed stop retains guard, recreate ordering | `coordinator`, `environment-management` | Fake drivers |
| Renderer Secrets/welcome/environment controls | fake-DOM suites above | Simulated DOM |

Provisional renderer gap: `preload.cjs` now exposes `saveModelProvider`,
`removeModelProvider`, `selectModel`, `saveGit`, but `control.js` wires only
`importModels`/`importGit` (control.js ~702, ~858). New forms are unimplemented/untested.

## 2. Five highest-value missing checks

| # | Invariant | Target | Command/harness | Known-bad mutation | Environment | Why existing checks miss it |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | After rotation/removal, the old guest substitute is rejected at the relay; only the current credential is injected | `src/runtime/credential-bridge.cjs` (`guestProviders`/`transform`) | Integration fixture: close old bridge, mutate real catalog, create replacement bridge | Skip old bridge closure before publication, or accept an old substitute in the replacement bridge | Portable Node | Relay suite has no rotation case; revocation is only in Iron-gated `credential-bridge` |
| V2 | Endpoint change with blank key never sends the retained key to the new scope through the relay (M04 end-to-end) | `credential-bridge.cjs` + `model-catalog.cjs` | New portable relay test driving catalog save then relay request | Remove sameEndpoint/keyPresent enforcement in ModelCatalog.prepareSave | Portable Node | Catalog test proves retention policy only at catalog layer; relay never exercised post-change |
| V3 | Real `GitCatalog`/`ModelCatalog` behind main IPC: helper-imported token never appears in snapshots, guest manifest or errors; publish only after all leases close | `src/v1-main.cjs` `sharedCatalogChange` with real catalogs | New `native-onboarding`-style vm harness injecting real catalog modules + fake vault | Snapshot path returns `credentialRef`/helper password | Portable Node | `native-onboarding` uses `CatalogFixture` stubs; `git-catalog` never crosses IPC |
| V4 | Stale probe cannot overwrite current provider status after concurrent save/import (M07) | `src/runtime/model-catalog.cjs` `probe()` | Deferred-promise portable test in `model-catalog.test.cjs` | Remove probe serialization or mutation-time probes.clear() | Portable Node | Probe tests are sequential; no interleaved mutation race |
| V5 | Model/Git editor forms: password input survives auth-label re-render; draft key cleared before IPC resolves; canonical input posted (S02/S04 analog) | `src/v1/control.js` + `control.html` (renderer worker owns) | Real DOM harness loading shipped markup and controls with synthetic IPC; fake-DOM checks supplementary | Re-render replaces label container via `textContent`, dropping the input | Browser-capable Linux sandbox, plus native macOS acceptance | Existing fake DOM cannot establish that textContent destroys a nested input in real DOM |

## 3. ATC integration (verified against official source)

Inspected: `ashhart/ATC` @ `c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0`, version 0.9.6
(package.json at that commit). Paths cited at that revision; nothing is installed or
configured here.

| Need | Actual ATC interface (source-backed) |
| --- | --- |
| Task claims | `/atc claim` issue comments replayed by CLI; `atc check` → `free|yours|...`; requires committed `.github/atc.json` opt-in; claims expire after 7 days idle (README, docs/commands.md) |
| Overlapping files | `atc begin <issue> <files...>` posts typed plan (≤32 salted fingerprints, 1h); cooperative, not a lock; earliest valid overlapping plan wins even same-account; later gets `scopeTaken` (docs/workflows.md) |
| Check-ins | `atc start/pulse/land`; sessions expire 5 min without pulse; git-shared presence experimental/advisory (README) |
| Handoffs | `propose split|pair|takeover|review` + `accept/decline`; 0.9 help queue/handoffs via MCP (README, docs/collaboration.md) |
| PR/check links | `depends`/`landing` compute advisory order only; "GitHub approvals, branch protections and required CI remain the actual merge requirements; ATC does not merge anything" (docs/workflows.md) |
| Evidence binding | Optional `atc-exchange` v2 receipts bind head+base, mark `headChanged|baseChanged|unknownBase` stale, flag `selfReview` same-account; needs separately operated HTTPS service + `.github/atc-exchange.json`; never grants merge (docs/exchange.md) |

Adapters we must build (none exists):
1. **Admission adapter**: parse `atc guard --publish --json`; accept only
   `complete:true && outcome:"ready" && ready:true` with non-null issue/session/plan/base.
   Source proof that `ready:true` alone is insufficient: `src/hooks/guardResults.js`
   accepts `ready` for outcome `noTicket` (null ticket fields) — matches
   `atcAdmission` in factory/workflow.proposal.json.
2. **Evidence collector**: GitHub Checks API bound to exact head SHA is the authoritative
   merge evidence; ATC comments/receipts are coordination records only. Collector
   invalidates on head/base movement (exchange `freshness` shows the pattern).
3. **State reconciler**: persist issue/PR/owner/head/base per factory/README.md; recover by
   reconciling against GitHub + live processes.

Avoiding two owners / stale evidence, without inventing guarantees:
- ATC cannot prevent the `check`→`claim` race or duplicate PRs (README "What ATC can't
  promise"); plans are cooperative. So exclusive ownership comes from our controller
  granting a scope lease only after `outcome:"ready"` plus its own persisted record;
  ATC overlap is a pre-check, not the lock.
- Exit code 0 is not success; `complete:false` means unknown, not clear (docs/commands.md).
  Adapter must re-run incomplete reads and treat `pending|uncertain` as unresolved.
- Same-account receipts are flagged `selfReview` by exchange. Separate model reviews can
  still provide independent code analysis; they do not become independent GitHub approvals.
  Honor repository approval rules separately; do not create identities to bypass them.
- GitHub PR checks stay authoritative: required checks on the trusted collector App,
  `invalidate stale approvals`, up-to-date-branch requirement (factory/README.md); ATC
  `landing` never substitutes for them.

## 4. Next implementation slice (not started)

**ATC admission adapter + fixture tests.** Owned files (new):
`factory/atc-adapter.cjs`, `tests/atc-adapter.test.cjs`, `factory/atc-pilot.md`.
First slice: pure `evaluateAtcGuard({guard, expected})` → `{admitted, reason}`; admits
only complete ready guard results with valid non-null ticket fields matching the trusted
expected issue/session/plan/base/files count. It does not acquire a lease or verify paths.
Atomic scope reservation, repository binding, freshness and runner authentication remain
controller responsibilities; a pure predicate must not claim to enforce exclusivity.
Acceptance: portable `node --test tests/atc-adapter.test.cjs`; known-bad mutations —
admitting `noTicket`+`ready`, admitting `complete:false`, admitting changed base — each
must fail the suite. No ATC install in-repo.
External prerequisites (explicit, none done): pin ATC 0.9.6@`c8787cc…` as an operator
tool; `gh auth`; commit `.github/atc.json` (opt-in, separate reviewed PR); GitHub issue +
draft PR per task; later, exchange needs a separately operated HTTPS service.

## 5. Static/formal placement (brief)

- Existing: `node --check`-style syntax checks and the portable suite; add the CI lane
  from factory/README.md PR-1. No new dependency needed for V1–V5.
- Proposed (deferred, one at a time): Semgrep taint rules for credential→log/IPC sinks
  (positive+negative fixtures required); Stryker targeted mutation only where V1–V5
  pilots show weak tests.
- Formal: model-check exactly one state machine — the shared-catalog change protocol
  (prepare → stop-all → publish; failed stop retains guard; cancellation before publish;
  no publish after cancel; single owner per scope) in TLA+/TLC with finite bounds, per
  factory/README.md. Everything else stays with ordinary tests. No blanket formal gate.