# Models / Secrets / Git factory pilot

Status: proposed acceptance inventory, not implemented or executed.
These cases supplement the product contract; they do not change the scope of
the currently delegated implementation.

Use synthetic keys with unique canaries, temporary directories and explicit
fixture services. Record scenario ID, preconditions, tested SHA, outcome and
evidence. Backend fixtures and actual Iron/native lanes have separate results.

| ID | Trigger | Required observable result | Primary layer |
| --- | --- | --- | --- |
| M01 | DSH provider has multiple models and a default absent from Alpi's old single-model grant | All supported models import; selected-model handling matches the explicit contract; no generic unexplained failure | Catalog + real renderer |
| M02 | Import alongside an unrelated manually created provider | Unrelated provider survives; source DSH files stay byte-identical | Integration |
| M03 | Import missing credential reference or unsupported protocol | Whole operation fails without partial publication; safe actionable error, no YAML excerpt | Catalog + UI |
| M04 | Change endpoint while leaving the key blank | Existing key is not silently sent to the new scope | Catalog + relay |
| M05 | Configure explicit unauthenticated provider | No vault lookup required; neither real nor substitute Authorization reaches upstream | Actual Iron |
| M06 | Remove/edit the selected model or final provider | Selection remains valid or becomes null according to contract; no silent fallback to another provider | Catalog + UI |
| M07 | Probe concurrently with save, removal or import | Stale probe cannot overwrite current provider status | Scheduled integration |
| S01 | Save a key; inspect response, snapshot, disk metadata, guest manifest, errors and logs | No real canary outside the designated synthetic vault/upstream; do not rely on password masking alone | Integration + artifact inspection |
| S02 | Submit key while IPC is delayed | Input is cleared before the request completes; pending/error status stays usable | Actual DOM |
| S03 | Change panel, selection or auth type after typing a key | Draft secret clears at the documented boundaries; nonsecret metadata behaves as specified | UI property sequences |
| S04 | Rerender auth labels repeatedly | Password input remains connected, usable and correctly typed; no label update deletes it | Actual DOM |
| S05 | Save/remove during stop failure | No catalog mutation; old ownership guard retained; UI does not announce success | Native lifecycle fixture |
| S06 | Cancel during credential lookup/encryption | No metadata published after abort; UI and lifecycle settle consistently | Scheduled integration |
| S07 | Failure before rename, then separately after rename/fsync | No ciphertext loss; uncertain publication blocks new leases until disk revalidation | Fault injection + reopen |
| S08 | Cleanup of retired ciphertext fails | New grant remains usable; warning represents cleanup failure rather than failed save | Integration + UI |
| S09 | Attempt unauthorized IPC from guest frame or another local frame | Rejected before secret/VM operation; no sensitive side effect | Native IPC |
| S10 | Wrong environment token, altered method/path/origin, redirect or guessed ticket | Rejected before real credential forwarding; no direct-route fallback | Actual Iron + scope properties |
| S11 | Revoke while streaming a response | Authorized active request closes; revoked substitute cannot be reused | Actual Iron |
| G01 | Manually save/rotate a repository token | Only exact smart-HTTP repository operations receive host credential; saved token never reappears in UI | Git fixture + actual Iron |
| G02 | Import repository credential from a failing helper | No implicit login, unrelated lookup or partial mutation; safe error | Injected helper + UI |
| G03 | Remove repository access; reconnect | Old grant unusable and regenerated guest configuration no longer advertises it | Provisioner + actual Iron |
| U01 | Random valid/invalid forms, repeated submit, back navigation and status updates | No unhandled error, duplicate publication or false success; editor remains reachable | Bombadil + state assertions |
| U02 | Keyboard traversal, narrow window and long labels | Critical controls reachable and labeled; feedback perceivable without color alone | Named UI journey |
| F01 | Agent publishes report for old head/base | Controller marks stale; no passing required check/merge eligibility | Controller unit/integration |
| F02 | Test skips because Iron is absent, or discovers zero tests | Required lane blocked; never counted as validated | Collector negative test |
| F03 | ATC returns noTicket/partial data or two workers claim overlapping scope | No managed dispatch/publish; ambiguity visible | ATC adapter fixture |
| F04 | Model alias changes or worker cancellation is uncertain | Attempt identity invalidated; scope not reassigned until ownership resolved | Worker adapter fixture |
| F05 | PR edits its evaluator, required-check list or stored pass report | PR cannot certify itself using changed policy or fabricated evidence | Controller trust-boundary test |
| F06 | Base changes during landing; duplicate completion event arrives | Reconcile idempotently; stale candidate is not merged | Landing-controller fault test |

## Known-bad calibration

In disposable checkouts, deliberately reintroduce the S04 label-removal defect,
skip the S05 stop guard, publish after S06 cancellation, retain a key across M04,
or accept old evidence in F01. Require each targeted scenario to fail for the
intended reason and pass after restoring the correct implementation. Record the
actual calibration diff and result. These experiments have not run yet.

## UI exploration contract

Generate domain-aware actions as well as generic clicks: create provider, add
second model, edit endpoint, switch authentication, save, import, remove, cancel
and navigate away. Inject controlled delayed/failed responses. Track visited
states and completed transitions. Keep property oracles separate from the UI's
own success labels. A transition is not covered merely because a button exists.

Inspect canaries at specific boundaries: a key is expected in a password input
while being entered and in the captured save request, but not in status snapshots,
persisted plaintext metadata or later rendered output. A blanket 'no key anywhere
at any time' property would reject correct behavior.

Start with a fixed replay corpus and a bounded exploration campaign. Choose the
campaign size after measuring runtime. Preserve failing traces and classify
replay divergence explicitly; a successful retry does not erase the initial
failure. Longer nightly exploration extends the corpus without weakening PR gates.

## Acceptance levels

- Synthetic: fixtures validate contracts and failure behavior.
- Real renderer: actual HTML/DOM/Electron behavior with synthetic backend.
- Host boundary: actual Iron and IPC with synthetic secrets and upstreams.
- Native credential/storage: dedicated clean macOS profile/Keychain.
- VM boundary: isolated owned guest on the pinned engine/image.

Keep these labels on results. Passing one level does not imply the next. No
personal DSH profile, Keychain, workspace or running VM is a test fixture.
