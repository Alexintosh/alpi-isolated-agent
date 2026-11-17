# Alpi agent orchestration implementation plan

Status: implementation in progress; this document is not acceptance evidence.
Base: `c6d5cb28e062d48b86d37667da8c19dffa165cc6` (`origin/main`).
Branch: `feat/alpi-agent-orchestration`.

## Outcome

A trusted host orchestrator can respond to “use Alpi to implement XYZ” by copying
an authorized project snapshot into a selected VM, assigning a stock Harness
session, following its output, sending corrections, independently executing guest
tests, and collecting results for review. The orchestrator has full guest shell
control, including explicit guest root. Guest content acquires no host tool API.

Deliver a local stdio MCP server, an opt-in host broker in Alpi, a delegation skill,
installation/usage instructions, synthetic boundary tests, live acceptance evidence,
and a PR ready for human review. Native T3 provider registration is a separate
integration: this change exposes standard MCP tools usable from T3, not a claim
that T3 displays a native subagent card for Harness.

## Workflow and acceptance policy

- Coordinator owns this plan, contracts, task order, integration, acceptance and
  commits. It must not silently absorb substantial implementer repairs.
- Primary implementers: OpenCode `tensorfold/DeepSeek-V4.1-Flash-1017`, explicit
  `variant=low`. Current route exposes low/high/max/none, not medium. No automatic
  substitution. Two local inference slots allowed. High-thinking implementation is
  reserved for the final escalation attempt described below.
- Reviewer: **GPT-6.1 Sol, reasoningEffort=high, exclusively review**. No edits,
  implementation or subdelegation. Every review/recheck is a new delegated task.
- Freeze each reviewed slice at a commit; reviewer begins with the PR and records
  the exact head SHA, scope, findings, commands/results, limitations and score there.
  Local-only/private traces stay out of the PR. Same-account comments are not
  independent GitHub approvals.
- Return actionable feedback to the local implementer as a bounded repair task;
  preserve successful code and add reproductions. Repeat review after material fixes.
  Small integration corrections may be coordinator-owned, but still require scored
  re-review if they affect the reviewed boundary.
- Accept a slice only with an honest score **strictly greater than 9.5/10**, no
  unresolved correctness/security blockers and passing scoped checks. Final integrated
  head must independently meet the same threshold; a slice score does not transfer.
- Cap each component and the final integrated feature at **three reviews total**:
  initial review, first repair/review, final repair/review. Never reset a counter
  by renaming or splitting an unsuccessful task. If the first repair improves the
  score by less than 0.2 points or leaves the same substantive finding unresolved,
  raise implementer reasoning for the final repair: medium if exposed by the route,
  otherwise the verified high setting. Record that change and its rationale.
  If the third review remains at or below 9.5 or has blockers, stop that loop,
  preserve the work and report the blockers; do not declare it ready.
- Do not ask the reviewer to increase scores to satisfy a target. It must explain
  deductions, missing evidence and why remaining limitations are acceptable. If a
  material limitation prevents >9.5, implement the necessary change or report the
  concrete blocker instead of relabeling the feature complete.
- Maintain a private per-run record in `.state/orchestration/runs.md`: requested
  and observed model/thinking, exact options, ownership/base, timings when known,
  tests, findings, repair effort and acceptance. Unknown execution settings remain
  explicitly unverified.

### Reviewer rubric

Score each dimension 0–10 and calculate the weighted total to two decimals:
correctness and lifecycle 30%; security and trust boundaries 30%; maintainability
and simplicity 25%; meaningful tests and evidence 15%. Include an overall judgment
and actionable deductions. Passing tests alone do not justify a high score. Treat
unnecessary layers, duplicated validation, swallowed failures and opaque state
machines as maintainability costs. Explain justified complexity rather than applying
an arbitrary line-count cap. A live-evidence gap must be reported, not hidden in a
synthetic result. Component reviews assess component evidence; the final feature
review includes the live acceptance requirements below.

## Architecture and invariants

1. T3 starts `node <checkout>/src/orchestration/mcp.cjs --socket <explicit path>`.
   MCP uses newline-delimited JSON-RPC on stdio. Stdout contains protocol only.
2. Alpi enables its broker only via an explicit startup flag. The broker is owned
   by the existing main process and uses its live runtime/coordinator/catalogs.
   No second runtime, profile fallback, engine fallback or new host network listener.
3. A private same-UID Unix socket inside protected Alpi state connects the facade
   to the broker. Parent directory 0700, socket 0600, no symlink traversal; do not
   unlink unknown or replacement endpoints. Same-host-UID compromise is out of scope.
4. Broker validates a fixed tool schema and dispatch table. It shares app lifecycle
   exclusion with trusted UI controls. No new renderer preload or guest IPC grants.
5. Guest shell/RPC operations pass through `coordinator.withRunning` and verified
   driver operations. Stock Harness and engine binaries remain unchanged. A bounded
   first-party guest helper invokes the stock loopback API; it never executes on the
   host. Real model keys remain in the existing host credential bridge.
6. Full shell powers are inside the guest. Arbitrary host exec/fetch/filesystem RPC,
   generic method forwarding, writable implicit mounts, host SSH agent forwarding,
   network approvals and credential changes are not exposed by the broker.
7. Outputs are untrusted data with byte/deadline bounds. Do not log launch tokens,
   upstream bodies or raw errors. Guest instructions cannot grant host authority.
8. Cancellation is explicit: aborting a wait stops observation, Harness cancel is
   cooperative, and verified VM stop stops all jobs. Never call cancellation rollback.
9. Persist metadata before mutating RPC submission; distinguish submitted from
   uncertain. Request IDs and fingerprints prevent blind duplicate inference after
   disconnect/crash. Do not persist prompts/transcripts/commands/credentials.
10. Recreated environments invalidate old task bindings through host ownership
    identity. Corrupt journals fail explicitly; they do not authorize adoption,
    deletion or clearing user data. Stop/diagnostics remain available.
11. Imports/exports reuse the existing bounded receiver and ownership journal.
    Destination is selected by the trusted caller, never guest output. No archive
    extraction, overwrite, merge, dependency installation or host code execution.
    Import only a deliberate clean project staging copy; the transfer API itself
    does not scan files for secrets.

## Public contract

`src/orchestration/tools.cjs` is the shared input schema and server validator.
Every tool rejects unknown fields and malformed identifiers before invoking runtime.

| Tool | Required behavior |
| --- | --- |
| `alpi_status` | Read environment states and model/provider IDs; no start, probes or secrets. |
| `alpi_start`, `alpi_stop` | Explicit selected environment; existing ownership and lifecycle checks. No recreation. |
| `alpi_exec` | Guest-only shell, cwd, optional root, bounded output and timeout, structured exit status. |
| `alpi_delegate` | Explicit environment/cwd/provider/model/prompt/requestId; return host task handle promptly. |
| `alpi_tasks` | Recover host task handles after MCP reconnect; submission state is not a test verdict. |
| `alpi_send` | Queue or steer a follow-up with idempotent request identity. |
| `alpi_wait` | Bounded wait and assistant output with stock cursor; input-required remains explicit. |
| `alpi_cancel` | Request session cancellation; report acknowledgement without claiming process termination. |
| `alpi_import`, `alpi_export` | Caller-authorized paths, new destination container, existing transfer guards. |

No silent model choice. No automatic replay on a transient error. Preserve
uncertain submissions for inspection using their recorded session identifiers.
Task storage is bounded; capacity errors require an explicit recovery design,
not automatic deletion. Long work lives in guest sessions; per-call waits remain
short and interruptible.

## Implementation slices and ownership

### T1 — Unix transport (existing draft; review and repair first)

Files: `src/orchestration/transport.cjs`, `tests/orchestration-transport.test.cjs`.
Keep `startServer({socketPath,dispatch})` and
`request({socketPath,method,params,signal,timeoutMs})`.

- Review existing framing/permissions/cleanup design and reduce repetition without
  weakening validation. Hard-link listener strategy must be justified and tested.
- Keep deadlines effective while writing responses; a peer that stops reading must
  not occupy a connection slot indefinitely. Add a bounded regression test.
- Test premature EOF, malformed UTF-8/JSON, multi-frame requests, byte limits,
  concurrency cap, cancellation, listener errors and replacement preservation.
- Gate: focused Node tests and Sol score >9.5 for the exact frozen slice.

### G1 — Guest command execution and RPC (partial draft preserved)

Files: `guest/v1/orchestration.cjs`, `src/orchestration/guest.cjs`,
`tests/orchestration-guest.test.cjs`.

- First inspect preserved partial work; complete or simplify it rather than blindly
  regenerate. Export `executeGuest(driver,options,args)` and
  `harnessRpc(driver,options,method,args)` as agreed with the service.
- Execute only pinned guest Node through verified `driver.exec`; quote helper source
  and payload separately. Explicit guest root applies only to shell execution.
- Shell result includes exitCode/signal/stdout/stderr/timedOut/truncated; handle
  nonzero exit, descendants, large output and timeout without unbounded buffers.
- RPC pins guest loopback and launch-file paths; manual authentication, no arbitrary
  redirects, bounded response and correlation. Allow only specified session methods.
- Test actual helper behavior with synthetic configuration and loopback HTTP fixtures,
  never personal profiles or real credentials. Separate guest trust from host parsing.
- Gate: synthetic checks and scored review; live stock compatibility follows at I2.

### H1 — Durable host service (not yet implemented)

Files: `src/orchestration/service.cjs`, `tests/orchestration-service.test.cjs`.

- Inject runtime/catalog/app-exclusion/guest adapter dependencies for tests.
- Implement status/start/stop/exec and strict dispatch using the shared schema.
- Implement task lifecycle with a bounded, validated journal and atomic publication.
  Reserve identities before RPC; preserve uncertain states; latch ambiguous disk errors.
- Verify configured models and environment ownership on task operations. Protect
  against concurrent requests and stale callbacks after shutdown/runtime replacement.
- Reuse transfers with explicit cancellation ownership; never invalidate another UI
  preview or cancel another operation. Status and verified stop survive task-journal fault.
- Tests: full fake-backed delegation cycle, duplicated IDs/conflicts, restart recovery,
  failed persistence, corrupt state, wrong ownership, concurrent admission and transfers.
- Gate: scoped tests and score >9.5. Split implementation into lifecycle vs transfers
  runs if one brief exceeds a bounded change; preserve one write owner at a time.

### M1 — MCP stdio facade

Files: `src/orchestration/mcp.cjs`, `tests/orchestration-mcp.test.cjs`.
Read-only contract: `tools.cjs`, `transport.cjs`.

- Implement initialize/version negotiation, initialized notification, ping, tools/list,
  tools/call and cancellation notifications. Expose only advertised capabilities.
- Strict JSON-RPC IDs/envelopes; bounded lines, concurrency, output/backpressure and
  fixed safe errors. Tool failure uses isError, protocol failure uses JSON-RPC error.
- Explicit socket CLI argument; no auto-discovery of profiles, opening Alpi, starting
  VMs, shell evaluation or MCP-to-guest reverse channel. EOF/SIGTERM closes pending
  calls without stopping autonomous guest tasks implicitly.
- Integration test the actual subprocess over stdio and real synthetic Unix broker:
  initialize/list/call/error/cancel/disconnect, malformed input and blocked output.
- Gate: tests and score >9.5; use official protocol spec as reference.

### I1 — Native integration and packaging

Files: `src/v1-main.cjs`, `package.json`, focused new integration test.
Coordinator serializes ownership of these central files; local implements a precise patch.

- Start opt-in broker only after app/runtime initialization is valid. Fail explicitly
  if unavailable; never crash or weaken an existing guest boundary to enable it.
- Use a fixed private state socket; no extra renderer surface. App operations and
  broker operations share exclusion. Close broker and abort calls during Quit before
  verified runtime shutdown; preserve network guards if stop fails.
- Handle runtime replacement without retaining stale service dependencies.
- Package trusted helper/MCP sources through existing source-copy pipeline. Add
  orchestration tests to portable/CI inventories deliberately.
- Test off-by-default, guest renderer rejection unchanged, app busy exclusion,
  startup failure and shutdown/replacement behavior using synthetic app fixtures.

### D1 — Usage, skill and acceptance instructions

Files: `skills/alpi/SKILL.md`, `docs/alpi-orchestration.md`, README/setup/security
links as a separate owned documentation slice.

- “Use Alpi” routes to these tools, sends a specific implementer brief, records IDs,
  follows output, verifies results inside guest and collects changes for host review.
- Explain clean staging, explicit environment/model selection, recovery/cancellation,
  scope of guest root, untrusted output and no automatic host execution.
- Provide exact MCP startup/config examples, opt-in Alpi flag and socket location.
  Distinguish MCP tool integration from native T3 provider/subagent UI.
- Validate skill syntax and test instructions against the actual shipped interface.

### I2 — Live acceptance and final integrated review

Coordinator owns live operations/evidence; no concurrent agent mutates runtime.
Use an explicitly selected existing Alpi-managed environment with protected networking,
no recreation, no shared-folder change, no personal credential inspection. User has
explicitly requested connection and effectiveness tests, including a small real task.

1. Run npm ci --ignore-scripts and portable checks; restore Electron only through
   pinned official install path if needed for native acceptance. No arbitrary payloads.
2. Start the feature build against its intended existing state without silently
   switching profile/engine/image. Observe broker/MCP initialize and status.
3. Execute synthetic commands as user and root; verify nonzero, quoting, timeout,
   cancellation and bounded output. Check a fresh host-only canary is inaccessible
   through guest filesystem and broker is not a guest-accessible TCP service.
4. Import a tiny clean synthetic repository and delegate a concrete coding task with
   its explicitly configured model. Wait, send a follow-up, independently run the
   generated tests through guest exec, and inspect actual changed files.
5. Disconnect/reconnect MCP and recover the same task. Retry the same submission ID
   and show no second prompt was admitted. Exercise cooperative cancellation and
   verify actual state; do not infer malicious guest termination from an acknowledgement.
6. Export into a new temporary host container; compare hashes/content and verify host
   canary remains unchanged. Exercise rejected traversal/symlink/collision paths.
7. Leave prior user work/data intact and report final app/VM state. Persist only
   sanitized command outcomes and counts/hashes, no credentials or launch URLs.
8. Final Sol high review of the exact full PR head, test results and live evidence;
   repair via low-thinking implementers and repeat until score >9.5 with no blockers.
9. Push cohesive commits, update PR description around final behavior and evidence,
   verify required CI, mark ready for review. Never merge without user authorization.

## Scheduling

First freeze and review T1 while one low-thinking implementer finishes G1. Once T1
feedback arrives, assign its repair to the second local slot. H1 depends on finalized
schema and adapter interfaces; M1 can run independently after T1 is stable. I1 waits
for H1/M1. D1 follows the final interface. Only review frozen files; a new push needs
its own exact-head record. No two writers own the same file, including tests.

## Evidence and limits

The existing transport draft reports 25 passing synthetic Unix tests. It has not
passed independent review or live VM acceptance. Partial guest code is unaccepted.
No score is assigned by the coordinator. Completion means the integrated behavior,
required evidence, CI and reviewer threshold are all met, not merely that code exists.
