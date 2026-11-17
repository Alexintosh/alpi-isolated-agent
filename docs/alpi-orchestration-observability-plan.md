# Alpi orchestration observability and workflow plan

Status: planned; contract discovery is the first gate, not completed implementation.
Branch: `feat/alpi-agent-orchestration`; base `628600af4c6704e133afe8c667dc09fb8ee8edfb`.
Tracking PR: https://github.com/Alexintosh/alpi-isolated-agent/pull/3.
The separately committed Settings change `8cd26a1` remains on `feat/settings-sliders`.
Preserve unrelated `factory/collect-check.cjs` and `tests/factory-collector.test.cjs`.

## Outcome and design decision

Make guest tasks understandable and recoverable without exposing stock Harness
records as the primary orchestration interface. Alpi will support other harnesses:
public progress, pending-action and cancellation semantics must be harness-neutral.
Implement one small adapter boundary backed by current stock code, not a plugin
framework or hypothetical implementations. If current evidence cannot support a
portable contract, postpone the direct API change and deliver workflow guidance.

Observed evidence: a real slider task succeeded with explicit transfers and durable
handles. It also produced bulky raw wait records, an opaque import error and a
pending approval that needed a guest-UI handoff. The failed /tmp import and stalled
npm install have unknown causes. Do not declare /tmp unsupported, diagnose the proxy
without evidence, or call cooperative cancellation broken. Guest-reported 34 tests
and independently executed 19 tests are distinct evidence sets.

## Scope and invariants

- Compact, bounded task observations; structured pending-action visibility when
  supported; explicit user handoff otherwise.
- Preserve cursor semantics and distinguish observed state from inferred success.
- Transfer content-root metadata and safe actionable errors where causes are known.
- Clear cancellation receipt semantics and better staging/install/verification guidance.
- No change to guest trust, stock Harness core, engine selection, credential custody,
  socket permissions, host IPC authorization, networking grants or shared folders.
- No generic host shell, filesystem, credential or proxy-control APIs in the guest.
- No automatic approval. Pending actions and guest descriptions are untrusted data.
- No direct approval-resolution tool in this increment unless discovery proves a
  harness-neutral capability with exact request identity and stale-request protection;
  otherwise explicitly defer it. UI handoff is a valid supported outcome.
- Defer completion manifests and install/network-control APIs. Prefer existing
  independent checks and safe read-only evidence to inventing a diagnosis.

## Architecture and contract gate

R0 must inspect pinned stock package source/types and current callers before O1 code.
Record the package version, paths/symbols, real wait/state/approval/cancel envelopes,
streaming/cursor behavior, and which fields are actually available. Avoid private
transcripts, model reasoning, personal profiles and credentials.

Proposed minimal adapter contract, to be frozen after R0:

- Capabilities explicitly describe observation, pending-action detail, cancellation
  request and approval-resolution support. Capability absence is not permission to
  guess another RPC or silently switch harnesses.
- Observation takes a task binding, cursor and bounded wait/message limits. Returns
  a normalized snapshot plus a cursor, not arbitrary stock records by default.
- Snapshot fields: observed task state (running/waiting/idle/unknown), bounded current
  operation, last activity only when sourced, pending actions, bounded assistant text,
  truncation flags and capabilities. Idle is not a success claim. Missing fields
  remain null/unknown; never synthesize timestamps or exact actions.
- Pending action: adapter-provided ID if available, kind, bounded action/reason,
  source/provenance and handoff mode. Unavailable IDs/details are explicit. Keep guest
  approval separate from host network approval. No launch URL, cookie or secret output.
- Cancellation requests return requested/acknowledged facts, cooperative semantics,
  and processTermination=unknown. Later observations can show turn ended; do not
  claim causality or termination from acknowledgment. Preserve task binding ownership.
- Optional raw observation is an explicit diagnostic mode with existing authentication
  filtering and byte limits, labeled untrusted. No default reasoning or raw tool args.
- Projection must be deterministic and bounded. Unknown stock record types are omitted
  or summarized as unsupported, never traversed into arbitrary displayed payloads.

Keep stock RPC method names and parsing in the adapter. Shared tools/service consume
normalized results. Do not build a harness registry, change persisted task ownership
schema or add a second backend merely to demonstrate extensibility. Test portability
with a minimal fake adapter and unsupported capabilities. Existing saved tasks remain
usable; no automatic replay or journal migration. Define the compact response change
and explicit raw compatibility mode in docs before switching defaults.

## Work breakdown and ownership

| ID | Deliverable | Write ownership | Dependencies |
| --- | --- | --- | --- |
| R0 | Bounded contract research and adapter recommendation | `.state/orchestration/observability-contracts.md` only | None |
| D1 | Safer task workflow guidance using existing tools | `skills/alpi/SKILL.md`, `docs/alpi-orchestration.md` | None; no unimplemented API claims |
| O1 | Small harness adapter, normalized progress/pending actions | proposed `src/orchestration/harness-adapter.cjs`, `tests/orchestration-observation.test.cjs` | R0 contract frozen by coordinator |
| O2 | Service/schema wiring, compact default/raw option, cancellation receipt | `src/orchestration/service.cjs`, `src/orchestration/tools.cjs`, `tests/orchestration-service.test.cjs` | O1; serialize central files |
| T2 | Accurate contentRoot and safe transfer failure categories | same service/test files, plus narrowly justified `src/runtime/file-transfers.cjs` changes | O2 releases files; inspect real manager first |
| I2 | MCP error vocabulary, actual stdio integration, portable inventory and docs | coordinator owns `src/orchestration/mcp.cjs`, `tests/orchestration-mcp.test.cjs`, `package.json`, `factory/ci-policy.json`, plan and integration docs after D1 | O2/T2 |
| V2 | Independent component and final integrated reviews, package/live evidence | Reviewers read only; reports on exact PR SHA | Frozen changes |

Paths above are provisional only for R0-dependent implementation. Coordinator must
freeze exports, result fields, bounds, options and focused checks in standalone
briefs before launching O1/O2. No worker can expand ownership on its own. Transfer
work is serialized with service wiring rather than concurrent edits to service.cjs.

### D1 concrete guidance

Inspect actual imported root: destination is the container, source basename is
nested inside it. Verify expected project files before delegating. Keep result paths
inside the authorized workspace. Give dependency installation a finite timeout and
progress checkpoint, stop blind retries and inspect pending actions before intervening.
No universal install timeout assumption; choose a task budget and report it. Do not
bypass network policy or infer proxy blockage from silence. Use afterSeq cursors,
bounded observations and updates only on meaningful state changes; never hide a
required human handoff behind repetitive polling. Cancellation is not an approval
handoff. Reconcile final files/hashes before declaring done, with independent test
counts and native visual limits separate from guest reports.

### Transfer contract

Retain destination as container path and add contentRoot only from verified transfer
metadata. Cover file and directory sources, Unicode/spaces and trailing separators;
never derive a guest path from guest prose. Preserve collision/no-overwrite and
ownership-scoped cleanup. Safe categories may distinguish invalid input, collision,
policy/path refusal, unavailable service, aborted and unknown failure, but only where
existing typed evidence supports them. Unknown errors remain generic; never parse raw
messages or return absolute internal paths, stacks, causes, credentials or command text.
Trace the vocabulary across service, Unix transport and MCP so it is not collapsed
back to request_failed. Do not relax transport validation to accept arbitrary codes.

## Validation and acceptance

1. Contract evidence from pinned real stock source/types, not invented mocks.
2. Projection tests: running/idle/approval, unavailable details, missing/unknown record
   kinds, repeated chunks/cursors, final text, empty output, large/deep/malformed input,
   Unicode, bounded truncation, no reasoning/tool argument leakage by default.
3. Adapter conformance with a minimal alternate fake and unsupported operations;
   ensure service never branches on stock record shapes or unsafe method names.
4. Service tests: existing/uncertain bindings, ownership mismatch, runtime replacement,
   disconnect/abort, late completion after cancel, no replay or stale success.
5. Real transfer-manager fixtures at driver/channel boundary: contentRoot matches
   actual layout; errors survive facade sanitization without canary leakage.
6. Actual MCP stdio -> private socket -> service tests: schemas, compact/default and
   raw behavior, invalid options, bounded frames, compatibility and error vocabulary.
7. Focused suites then portable/full applicable checks, Node 22/24 portability and
   package verification. Do not install dependencies again unless required.
8. Bounded live smoke with an explicitly selected existing environment: compact task
   progress, controlled pending-action handoff if reproducible, transfer root and final
   file reconciliation. No arbitrary package downloads or changes to network grants.
   Do not replace/quit the running app or interrupt current guest tasks blindly:
   first inspect active work and ownership. If concurrent user work prevents live
   validation, preserve it and state that acceptance remains pending.
9. Record exact commands/results, supplied versus independently rerun evidence,
   limitations and final reviewed SHA. Update installed Alpi skill from accepted repo
   content, verify parity, and report any client refresh requirement honestly.

## Model routing, review budget and delivery

Implementers: OpenCode `tensorfold/DeepSeek-V4.1-Flash-1017`, explicit `variant:low`.
Current route exposes low/high/max/none, not medium. R0 is finite source research;
D1 is a bounded documentation slice. Effective model/effort stays unknown unless
execution metadata confirms it. Sol `gpt-6.1-sol` high is exclusively a reviewer.
Two inference slots limit requests, not total agents; respect host concurrency too.

Use the $local weighted 1–10 rubric: correctness 30%, security 30%, maintainability
25%, evidence 15%. Gate is strictly >9.5, no blockers and required evidence complete.
At most three scored reviews for each new coherent component scope and three for
this new integrated increment. Preserve original T1/G1/M1/H1/I1 review histories;
these new scopes do not reset old unresolved findings or permit evading an exhausted
budget. Regressions reopening an old exhausted scope require an explicit budget
resolution. New functionality is reviewed as new scope, with original invariants
included in regression checks.

After repair 1, gain <0.2 or repeated substantive finding escalates final repair to
verified high. Stop at cap; preserve work and report gate failure. Do not chase 10 or
self-award a passing score. Reviewer posts every report on PR #3 at the full frozen
SHA, with findings, actual checks, old/new regression evidence and resolution commits.
Same-account comments are not independent GitHub approvals. Final new head needs its
own integrated acceptance; previous 9.57 does not cover this work. Mark PR draft when
new implementation is pushed until required gates pass. No merge without instruction.

## Ledger

| Scope | State | Reviews used | Score / findings | Evidence / next action |
| --- | --- | --- | --- | --- |
| R0 | ready for source discovery | n/a | unscored | Freeze adapter contract or defer unsupported API |
| D1 | ready for implementation | 0/3 | unscored | Existing-tool guidance only |
| O1/O2 | blocked on contract discovery | 0/3 | unscored | Coordinator freezes cohesive observation scope |
| T2 | queued | 0/3 | unscored | Preserve service ownership order |
| Integrated increment | pending | 0/3 | unscored | Separate whole-feature assessment |

Durable per-run records: `.state/orchestration/observability-runs.md`. Create each
entry before launch; add run ID, confirmed settings, duration, results and limits.
