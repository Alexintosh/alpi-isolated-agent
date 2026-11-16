# Alpi software factory: research and proposed workflow

Status: PR pilot, 2026-11-16. The pinned ATC CLI is installed locally;
repository coordination activates only after `.github/atc.json` reaches the
default branch. `.github/workflows/factory.yml` runs explicit portable and
factory inventories on Linux/macOS, with structured results and SHA-bound
artifacts. `ci-policy.json` is the executable pilot inventory;
`workflow.proposal.json` remains the broader, unenforced design.

The initial CI policy is candidate-owned and advisory. It is not a trusted
external collector, merge authorization, native acceptance, UI fuzzing or a
formal proof. No repository protection rule or automatic merge is enabled.
See [review history](reviews-20261116.md) and [boxes pilot](boxes-pilot.md).

Run locally on a clean committed checkout with Node 24.13.0:

```sh
FACTORY_REPOSITORY=Alexintosh/alpi-isolated-agent \
FACTORY_HEAD_SHA=$(git rev-parse HEAD) \
FACTORY_BASE_SHA=$(git rev-parse HEAD^) node factory/ci-run.cjs
```

Reports in `.factory-results/` bind the head/tree, policy bytes, evaluator
files and test-tree digest. Missing reports, zero declared tests, skipped/todo
suites, output overflow, inventory aliases and incomplete cleanup cannot pass.
The runner holds a process-group leader until cleanup; it cannot contain hostile
same-UID code or descendants that deliberately create separate process groups.
GitHub jobs and boxes.dev isolate the whole worker. No host credentials are
needed by the tests. The additional collector prototype is excluded from this PR.

The objective is to let local models implement most feature work while making
acceptance depend on independently collected, current evidence. Determinism
belongs in dispatch, ownership, state transitions and acceptance rules. Model
generation and exploratory UI fuzzing remain stochastic.

## Findings from the sources

HumanLayer's recent position emphasizes product decisions, architecture,
program-level contracts and small vertical slices. It explicitly challenges the
idea that more automated review loops establish maintainability. We should
retain design ownership and inspect the resulting code, not count generated
tokens or passing checks as quality. These are practitioner conclusions, not a
universal comparative experiment. [HumanLayer essay](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)

StrongDM describes separately maintained acceptance scenarios and behavioral
twins of external services. The useful transfer is independent acceptance plus
controlled failure simulation. Its autonomous-development account does not
establish that an LLM judge can certify Alpi's credential or VM boundaries.
[StrongDM](https://factory.strongdm.ai/)

Anthropic's planner/generator/evaluator work uses explicit sprint contracts and
separate evaluation. This supports focused handoffs and an evaluator that runs
the product, while its reported results remain specific to its experiments.
[Harness design](https://www.anthropic.com/research/harness-design-long-running-apps)

OpenAI describes repository-local plans and mechanically enforced architectural
boundaries. Its permissive merge philosophy is not appropriate evidence for
relaxing Alpi's secret/lifecycle gates. Symphony supplies a useful published
scheduler contract, but its reference agent transport is not proof of support
for our changing local-model endpoints. [Harness engineering](https://openai.com/index/harness-engineering/),
[Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md)

SlopCodeBench's staged requirements suggest an evaluation we currently lack:
extend the same implementation repeatedly and rerun all earlier acceptance
cases. The published small model comparison is not enough to rank our local
models or equate a complexity score with maintainability.
[Staged evaluation report](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/benchmarking-opus-5-on-slop-code-bench.md)

### ATC: reuse coordination before building another board

The supplied Ash Hart account describes a chief-of-staff workflow and hardware
experiments. It is useful operational experience; it is not an independently
measured benchmark. The public ATC repository is a concrete, narrower component.

Inspected version: 0.9.6, commit
`c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0`. Its CLI/MCP interfaces expose claims,
planned-file coordination and overlap checks. It does not launch models or prove
semantic compatibility. Tmux can host worker terminals; it cannot establish
completion or correctness. [ATC](https://github.com/ashhart/ATC)

Work tickets bind a checkout, scope and comparison base. Reservations are
cooperative; hooks do not intercept every possible shell operation. Separate
worker checkouts are still needed. Dependency ordering is advice, with GitHub
checks retaining merge authority. [Parallel workflows](https://github.com/ashhart/ATC/blob/c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0/docs/workflows.md)

One important adapter detail from the inspected code: `ready: true` can accompany
`outcome: "noTicket"`. Our managed factory must require `outcome: "ready"`, complete
coverage and a valid ticket, rather than trusting that boolean alone. This is a
deliberate compatibility behavior, not a claim of an ATC vulnerability.
[Guard result parser](https://github.com/ashhart/ATC/blob/c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0/src/hooks/guardResults.js)

The optional exchange binds receipts to head and base, marks stale evidence and
records same-account self-review. It needs a separate service and does not grant
merge approval. A receipt digest identifies bytes; it does not establish that
tests really ran. Start with core ATC and CI artifacts; evaluate exchange only
when multi-machine handoffs need it. [Exchange contract](https://github.com/ashhart/ATC/blob/c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0/docs/exchange.md)

### Bombadil: useful, with a specific proof obligation

Bombadil checks TypeScript properties while generating UI actions. Its external
browser driver explicitly supports Electron. This makes it suitable for a pilot
against Alpi's actual renderer with controlled backend fixtures.
[Execution model](https://antithesishq.github.io/bombadil/browser/1.2-how-it-works.html),
[Electron attachment](https://antithesishq.github.io/bombadil/browser/5.1.2-bombadil-browser-test-external.html)

The inspected manual is v0.7.10. Replay can diverge; shrinking and the separate
`fuzz` command are experimental. Preserve traces, pin tooling and reset fixtures
between runs. Promote discovered failures into ordinary deterministic regression
tests. A finite run without violations is evidence of exercised behavior, not a
proof over every UI state. [Replay](https://antithesishq.github.io/bombadil/browser/4.1-reproducing-violations.html),
[Shrinking](https://antithesishq.github.io/bombadil/browser/4.2-shrinking-violations.html),
[Fuzz command](https://antithesishq.github.io/bombadil/browser/5.1.3-bombadil-browser-fuzz.html)

Complement it with fast-check for state transitions and asynchronous schedules,
Playwright for named user journeys, and targeted mutation testing. fast-check
provides shrunk command sequences and replay metadata; the reference model must
be simpler than the implementation. Playwright Electron support is experimental.
Stryker can use a command runner for Node projects, so a test-framework migration
is not a prerequisite; its cost and integration still need a pilot.
[fast-check](https://fast-check.dev/docs/advanced/model-based-testing/),
[Playwright Electron](https://playwright.dev/docs/api/class-electron),
[Stryker Node](https://stryker-mutator.io/docs/stryker-js/guides/nodejs/)

## What is actually present in Alpi

Inspection baseline: `661578bbf1bcdffe3de8488e04993ea75e0f497d`. The parallel model
catalog task remains separately owned; research does not modify its files.

- Node's built-in test runner and a portable synthetic suite already exist.
- Real Iron model/Git tests exist, with platform/artifact-dependent skip guards.
  A successful portable suite does not establish those boundaries were exercised.
- Several renderer suites execute real handlers against a simulated DOM. The
  earlier password-label bug illustrates why real DOM integration is needed.
- Packaging verifies an ad-hoc macOS bundle and records source revision/dirty
  state. Packaging is not native acceptance or VM containment testing.
- There is a tracked CI example at `docs/portable-tests.workflow.yml`, but no
  tracked workflow under `.github/workflows` in this checkout. This is not an
  audit of all remote branch settings or external CI services.
- Startup uses the legacy app-data path and can reconcile managed environments.
  A test must not launch the normal personal profile just to inspect a form.
- `docs/*` is mostly ignored. Public factory specifications live here instead;
  private traces and model session notes must not be accidentally published.

The GitHub API reports a public, personal-account repository with default branch
`main`. Native GitHub merge queues require an organization-owned repository
under the documented eligibility rules. Plan a serialized merge coordinator for
this repository, or revisit the choice if ownership changes. If native queues are
used later, required workflows must handle `merge_group`.
[GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)

## Proposed control plane

GitHub issues and PRs identify work. ATC coordinates claims, intended files and
dependencies. A small policy controller determines which checks are required and
whether evidence is current. Model workers implement; reviewers report findings;
only the controller can make a candidate eligible for integration.

Reuse existing agent harnesses behind an adapter rather than building a new
coding harness. The adapter contract is discovery, launch, structured events,
cancel, terminal-result collection and resume. T3, OpenCode CLI or another harness
can implement it. Select one route for a run; route failure cannot silently change
the model, provider or permissions.

Before dispatch, freshly resolve the requested model/variant. Record requested
and reported identities separately. A mutable server alias without a weight
digest is not proof of immutable model identity. Unknown thinking settings stay
unknown. Changing models starts a new attempt with a preserved handoff. Confirm
the old attempt has stopped before giving its scope to a replacement.

Use one job per known inference backend initially. Keep inference work separate
from performance measurements. Give every worker a separate checkout and a
finite write scope. The coordinator serializes shared integration files. A fresh
reviewer session reduces conversational bias; two agents using the same GitHub
account are not two independent organizational approvals.

Persist transitions and handoffs: issue, PR, attempt, checkout, owner, current
head/base, policy digest, model settings, blockers, commands, artifacts and next
action. Recover by reconciling that record against GitHub and actual running
processes. Do not infer completion from a terminal prompt, silence or a prose
summary. A board displays this state; it is not the state authority.

## State machine and required evidence

The detailed proposal is [workflow.proposal.json](workflow.proposal.json).
Every transition has a positive condition. `missing`, `skipped`, `unknown`,
`cancelled` and `inconclusive` do not mean pass.

| Stage | Work and evidence required to leave it |
| --- | --- |
| Specify | User outcome, non-goals, interfaces, invariants, affected boundaries, acceptance cases and risk class. Resolve consequential ambiguity here. |
| Reserve | Current base; dependency order; active work ticket; no unhandled overlap; tool/model availability; isolated fixtures and resource lease. |
| Implement | One bounded behavior, regression reproducer where applicable, focused tests, reviewed diff and handoff. Create a draft PR early. |
| Fast checks | Syntax/static checks, relevant unit tests and baseline regressions. Assert test discovery and expected counts; zero unexpected skips. |
| Integration | Catalog/vault/main/bridge contracts, failures and cancellation; tests of actual boundaries where required. |
| Build | Clean checkout, pinned dependencies, fresh app artifact, revision manifest, digest and signature verification. |
| Acceptance | Named user journeys on the built candidate; real DOM checks; bounded UI property exploration; retained failing traces. |
| Assurance | Relevant property/mutation/fault tests, security checks, performance comparison and maintainability review. |
| Independent review | DeepSeek first, then Sol high for the current feature work. Review the exact candidate and evidence; resolve concrete findings. |
| Integrate | Revalidate head/base, dependencies and required evidence on the candidate integration tree; merge only through the authorized coordinator. |
| Observe | Post-merge smoke, regression tracking, artifact retention and rollback plan. Release remains a separate explicit decision. |

Any product-code fix or refactor returns to validation on a new head. Evidence
reuse requires identical inputs and a declared dependency scope; an old whole-PR
pass cannot qualify a new push. Policy/evaluator changes cannot waive their own
checks. An unresolved blocking finding prevents eligibility even if other checks
pass. Optional refactoring responds to a demonstrated design issue, rather than
an unconditional extra agent rewriting every feature.

Starting retry policy: two repair attempts for the same product failure, then
coordinator diagnosis and a revised task or authorized model escalation. Transport
failures are recorded separately from product defects. One infrastructure retry
is allowed when safe; uncertain mutations are inspected before any retry. These
are initial operating limits to evaluate, not measured optima.

### Risk-based selection without weakening boundaries

- Documentation-only: document/contract checks; no invented need for VM tests.
- Renderer behavior: unit plus actual DOM journeys, accessibility/focus checks,
  and UI property exploration of affected controls.
- Secrets, IPC, networking, lifecycle, ownership, persistence or migrations:
  all affected integration/failure cases, independent security review, and native
  boundary evidence. Missing hardware/artifacts means blocked evidence, not skip.
- Performance-sensitive paths: same-hardware baseline/candidate runs and a
  predeclared budget. A textual review alone does not pass this gate.
- Build, signing or dependency changes: provenance, license/dependency review,
  packaging verification and startup acceptance on an isolated account/machine.

Classification comes from an approved path/boundary map plus the task contract.
Use their union; unknown files conservatively require classification. An agent
cannot lower the class by editing a label. CI policy is read from the trusted base.

## Tests that increase confidence

Write acceptance behavior and security invariants before implementation. Keep
some independently owned black-box scenarios outside the worker's writable
checkout. The implementation may add tests, but cannot delete acceptance cases,
raise limits, suppress failures or change a success oracle to make itself pass.
After a holdout exposes a bug, turn it into a visible regression and replenish
independent coverage. Do not hide the intended product behavior from implementers.

Use controlled synthetic services: an OpenAI-compatible HTTP(S)/SSE fixture,
Git smart-HTTP fixture, failing vault, atomic-file fault hooks and a controllable
driver. Test the real Iron boundary separately. An adapter fixture is useful for
exhaustive failure injection; it does not establish real networking or VM safety.

The first pilot is [Models/Secrets/Git scenarios](pilot-scenarios.md). It must
exercise save, edit, import, cancellation, stop failures and reopen, not just
click every button. Track whether each critical state/transition was reached;
a fuzzer that never enters an editor has not covered secret handling.

The test launcher needs an explicit temporary state root and injected fixture
dependencies before initialization. The packaged production entry must not
enable fixture IPC or a debug port through a guest-controlled flag. Run native
acceptance in a disposable OS account or dedicated clean test machine. Actual
Keychain behavior needs a dedicated test keychain/profile; a fake vault is
reported as fake. VM acceptance requires isolated owned VMs and pinned artifacts.

Measure test effectiveness using seeded known-bad changes in disposable
checkouts: remove a stop-before-write guard, persist after cancellation, leak a
substitute upstream, remove a real DOM input with `textContent`, or accept stale
evidence. Acceptance must detect the intended defect. General mutation scores
are secondary; equivalent mutants need documented dispositions, not arbitrary
score inflation. Do not mutate the shared implementation checkout.

## Security, performance and maintainability

### Static analysis and formal methods

The first CI lane should run syntax checks and focused static rules on the
changed boundaries. Add AST-based import/dependency rules and taint rules for
credential-bearing inputs, logging/IPC outputs and process invocation. Rules need
positive and negative fixtures; a green scanner result is not a proof that every
secret flow is safe. Semgrep's taint mode describes source/propagator/sink analysis;
the engine's supported scope must be recorded rather than assuming whole-program
coverage. [Semgrep taint analysis](https://docs.semgrep.dev/writing-rules/data-flow/taint-mode/overview)

Model the factory's small critical protocols in TLA+: evidence freshness at
promotion, exclusive task ownership, cancellation before reassignment and
idempotent completion. Start with finite TLC safety checking. Record the model,
configuration, tool digest, state-space bounds and assumptions. TLC can check
safety/liveness; that is distinct from a TLAPS deductive proof. We do not claim
unbounded verification from a finite model check.
[TLA+ tools](https://lamport.azurewebsites.net/tla/tools.html)

Initial safety properties: no promotion using an old head/base or missing gate;
no simultaneous live owners for one write scope; no cancelled attempt can publish
an accepted result; duplicate completion cannot advance the state twice. Model
network loss, stale responses, target movement and restart. Separate liveness
claims and explicitly declare fairness and eventual-service-recovery assumptions.

Keep a transition mapping from model actions to controller code and exercise the
implementation with generated/concrete counterexample traces. A correct model
without this conformance evidence does not verify the implementation. Later
consider the credential rotation/revocation protocol, whose filesystem and
Keychain assumptions require their own native fault tests. Formal verification
is a targeted gate for protocol changes, not a mandatory theorem for every UI edit.

These analyses are planned; no static security engine, TLA+ model checker or
implementation refinement proof has run as part of the initial research.

Review security before coding and again on the final diff. Checks include
unauthorized IPC callers, host/guest credential separation, path/origin/method
scope, redirects, encoded inputs, response reflection, ownership changes and
failure recovery. Scanner findings supplement, rather than replace, these tests.

Treat PR code, comments, dependencies and uploaded reports as untrusted. Use
ephemeral unprivileged test environments without publishing credentials. Trusted
report collection and merge credentials live outside the worker. Do not run
public PR code on the user's everyday Mac or use privileged workflows to execute
an untrusted checkout. Pin actions/tools and constrain access to private runtime
artifacts. [GitHub Actions security](https://docs.github.com/en/actions/reference/security/secure-use)

Performance evidence compares the base and candidate on the same idle machine,
with fixed fixtures, warmup and a predeclared number of paired trials. Report
sample count and variability. Separate startup, renderer response, relay first
byte, throughput, RSS and resource cleanup. Set budgets after measuring baseline
noise; do not invent a universal percentage. Canary correctness and scope checks
must still pass in benchmark workloads. A faster broken result fails.

Maintainability review asks whether a concrete next change remains localized,
dependencies follow the boundary map, obsolete paths were removed, and new
abstractions have a purpose. Track coupling, file growth and duplication as
signals; they are not mechanical proof of readable code. Validate a series of
small feature extensions, retaining every earlier regression, to detect decay.

## Evidence and PR coordination

Every result binds repository, PR, base SHA, head SHA, tested tree, artifact digest,
policy version, evaluator version and fixture version. Include environment and
commands, exact outcome, test/skip counts, failure trace references and model
provenance where relevant. [run-record.example.json](run-record.example.json)
shows an empty, unexecuted record; it is not a test result.

Only the trusted collector publishes required checks. Worker-written JSON is a
report to inspect, not an attestation. Protect policy, evaluator and CI changes
with separate review. Configure required checks to the expected GitHub App where
supported and invalidate stale approvals. [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

Until native merge queues are available, use a single serialized landing lane:
refresh the target, prepare the candidate integration commit/tree, test it, then
recheck the PR head and target tip before merging. Require an up-to-date branch
and expected head at the GitHub merge boundary. If either moves, recompute and
retest. The landing bot has no rule-bypass permission; it must not race unrelated
writers. If the chosen merge API/rules cannot enforce freshness atomically, do
not auto-merge. Verify the resulting tree and run a post-merge smoke.

Use ATC dependencies for an explicit PR DAG. A textual conflict-free result is
not semantic integration. Stack only genuinely dependent slices; after a parent
lands, update descendants and invalidate affected evidence. Keep unrelated
factory tooling separate from Models/Git feature PRs.

## Delivery sequence as coordinated PRs

These are planned PR scopes, not claims that PRs have been opened.

1. **Factory contract and CI foundation.** This proposal, machine-readable
   policy, test inventory, artifact schema and a minimal trusted collector.
   Activate portable CI with explicit expected checks. Prove missing/skipped/
   stale results cannot pass. Do not enable auto-merge yet.
2. **ATC pilot and worker adapter.** Pin the inspected version; opt in through a
   reviewed config PR. Test same-account overlap, expired plans, changed bases,
   incomplete reads, cancellation and model changes. Start without public
   presence or exchange hosting. Depend on PR 1.
3. **Isolated native acceptance harness.** Real renderer and IPC with controllable
   synthetic backend failures; resettable state and fixture services. Recover
   the historical DOM-label bug as a known-bad acceptance test. Depend on PR 1.
4. **Property testing and UI exploration.** fast-check state machines plus a
   pinned Bombadil Electron pilot, trace retention/replay and seeded-defect
   checks. Depend on PR 3. Benchmark its runtime before making it a required gate.
5. **Native integration and performance lane.** Owned clean macOS runner,
   verified Iron artifacts, built-app acceptance and repeatable A/B fixtures.
   Depend on PR 3; document unavailable private artifacts rather than replacing
   them. Add targeted mutation checks where the pilot finds weak tests.
6. **Merge coordinator and model evaluation.** Connect current evidence and ATC
   dependency ordering to guarded landing. Fault-test the controller before
   allowing automated merges. Use the pilot results to select task/model/thinking
   policies. Depend on PRs 2, 4 and 5.

Each PR must deliver a working vertical slice with its own tests. Prefer existing
tools and a small integration layer. Do not implement a replacement forge,
general scheduler or dashboard before the pilot demonstrates a gap.

## Evaluating local models and thinking settings

Record requested variant, provider-confirmed variant, and confirmation method.
The current DeepSeek catalog task used no explicit variant: default/unknown.
Previous sessions cannot establish that default equals off. Do not relabel them.

Initial hypotheses: off/low for narrow mechanical work; medium for unfamiliar
cross-module work; high for security/concurrency design and independent review.
Only request settings the provider actually supports. Unsupported settings are
not silently mapped. Model identity, quantization, harness version, prompt,
context, tools, hardware and inference contention are part of every experiment.

Start with a small frozen set: renderer bug, multi-model import, cancellation
race, atomic recovery, review with planted defects, and a multi-step extension.
Compare supported settings in paired isolated runs; repeat before drawing a
conclusion. Keep oracle/fixtures fixed. Report accepted tasks, first-pass success,
missed defects, false review findings, repairs, coordinator minutes, wall time and
infrastructure failures. Do not rank by tokens, changed lines or raw test count.

Adopt a routing rule only when it improves time to accepted code without losing
critical defect detection. Preserve failed attempts in the denominator. Store
sanitized summaries suitable for skill updates separately from private prompts
and raw inference logs.

## Pilot exit conditions

The pilot is ready to inform automation policy when the scenarios are executable,
known-bad variants are detected, traces can be diagnosed/replayed or honestly
classified as divergent, required lanes have no silent skips, and a stale-result
or duplicate-worker event cannot promote a PR. Native evidence must identify
which actual boundaries ran. No numerical reliability percentage is justified
merely by completing this checklist.
