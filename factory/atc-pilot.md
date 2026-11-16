# ATC admission pilot: pure guard predicate

## Scope delivered

`factory/atc-adapter.cjs` exports `evaluateAtcGuard({guard, expected})` →
exactly `{admitted: boolean, reason: string}`. Pure, synchronous, deterministic,
no IO, no input mutation, never throws on malformed ordinary JS inputs
(throwing getters and hostile proxies fail as `invalid-input`; no protection is
claimed against arbitrary proxy side effects).

## Pinned upstream protocol

- Repo: `ashhart/ATC` — https://github.com/ashhart/ATC (correct org `ashhart`)
- Commit: `c8787cc58648732e1fb21c4d5ad80b1bab4e4ec0` (version 0.9.6)
- Schema source: `src/hooks/guardResults.js` (+ `hookValues.js`) at that commit; inspected from official source; the coordinator subsequently installed this exact pin outside the project.
- Guard: exactly 10 fields `command,issue,complete,outcome,ready,session,plan,base,files,conflicts`;
  `command='guard'`; booleans; the 19 pinned outcomes; nullable
  issue `1..999999999`, session `1..999999999999999`, plan `1..MAX_SAFE_INTEGER`,
  base lowercase hex SHA 40/64, files `0..32`, conflicts ≤1000 with exact
  `issue/plan/session/sharedFiles` (non-null, sharedFiles `1..32`).
- Upstream semantics enforced: `ready === outcome ∈ {ready,noTicket}`;
  `ready ⇒ complete`; `noTicket` ⇒ null ticket fields, files 0, no conflicts;
  `ready` outcome ⇒ non-null fields, files ≥1, no conflicts.
- `expected` (trusted current identity from the controller, not derived from
  the untrusted guard): exactly `issue/session/plan/base/files`, all non-null,
  same bounds, files `1..32`. Shape rules: exact own data properties only;
  unknown/symbol/inherited/accessor fields and class instances rejected;
  null-prototype plain objects supported; dense standard arrays only; no
  coercion, NaN, Infinity or non-integers. Own descriptors are read, so
  getters never run.

## API example (synthetic IDs)

```js
const { evaluateAtcGuard } = require('./factory/atc-adapter.cjs');
evaluateAtcGuard({
  guard: { command: 'guard', issue: 4217, complete: true, outcome: 'ready',
    ready: true, session: 1717171717171, plan: 88, base: '0'.repeat(39) + 'a',
    files: 3, conflicts: [] },
  expected: { issue: 4217, session: 1717171717171, plan: 88,
    base: '0'.repeat(39) + 'a', files: 3 },
}); // { admitted: true, reason: 'ready' }
```

## Fixed reason vocabulary

- `ready` — admitted (success only).
- `invalid-input` — malformed shape/types or semantic contradiction (including a malformed `expected`).
- `incomplete` — structurally valid, `complete:false` (unknown, not clear).
- `not-ready` — valid `complete:true` but outcome ≠ `ready`; includes a
  legitimate `noTicket` with `ready:true` (upstream-ready but ticket-less).
- `identity-mismatch` — ready guard differs from any `expected` field.

## Assumptions and non-guarantees

- Data validation only: no lease/lock acquisition, no authentication, no
  freshness proof, no exclusivity claim. The controller must still
  authenticate a fresh `atc guard` subprocess and exit status, bind
  cwd/repo/HEAD/base, serialize actual leases across controller processes,
  and enforce required GitHub checks.
- Comparing `files` is a count check only — not validation of actual paths,
  repository, scope or current Git state.
- ATC plans are cooperative; exit code 0 is not success and `complete:false`
  means unknown. `pending`/`uncertain` must be re-run by the controller.

## External prerequisites and current state

- Operator ATC 0.9.6: installed from the pinned official GitHub archive under the local factory tool directory, with lifecycle scripts disabled. `atc doctor --json` passed environment checks and reports repository configuration missing. This does not constitute admission.
- `.github/atc.json` opt-in is prepared locally and validated with the pinned upstream parser. Six stable area IDs cover runtime, controls, guest, tests, factory and build. Presence remains local. It still requires a reviewed PR and merge to the default branch before coordination writes work; product PR #1 is separate. No ATC claims, plans or exchange service are enabled.

## Next controller integration step

Wire the controller to spawn the pinned `atc guard --publish --json`
subprocess, authenticate the run, then feed the parsed result plus the
controller-owned current identity into `evaluateAtcGuard`; admit only
`admitted:true`, re-run `incomplete`, and hold the scope lease in the
controller's own persisted record.

## Actual test results (this machine)

`node --test tests/atc-adapter.test.cjs`: 25 tests, 25 pass, 0 fail. Covers:
40/64-hex positives, null-prototype inputs, frozen-input non-mutation,
`noTicket`+`ready:true` → `not-ready`, incomplete results, every non-ready
outcome, per-field identity mismatch, malformed envelopes/guard/expected
(missing/null/extra/symbol/inherited/accessor/array/class/proxy cases), fixed
vocabulary and no input echo. Mutation calibration ran in temp directories only
via `node:vm` with unique checked source replacements and a positive control:
the same acceptance oracle rejects all seven variants after confirming each
wrongly admits no-ticket, incomplete-ready, or stale-base input. Bounds are checked
before conflict enumeration; getter calls stay zero. No production file was mutated.
