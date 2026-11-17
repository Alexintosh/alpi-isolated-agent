# Use Alpi from a host coding agent

Alpi exposes MCP tools for a trusted host orchestrator to assign work to stock
Harness inside a managed Linux VM. The orchestrator can run guest commands,
including commands as guest root, follow tasks and transfer explicit project
copies. Guest agents and their output do not gain access to host tools.

This integration uses a local stdio MCP server. It does not register Harness as a
native T3 provider or promise native subagent cards. The repository includes an
[Alpi skill](../skills/alpi/SKILL.md) for requests such as “use Alpi to implement
XYZ.” Load that skill through your client's skill mechanism and connect the MCP
server below.

## Start the opt-in broker

Use a feature build with an already verified Alpi runtime and configured model
catalog. Follow [setup](setup.md) for runtime prerequisites. No additional model
key belongs in MCP configuration.

Build a new application destination, then launch it with the explicit flag:

```sh
node scripts/package-personal-app.cjs --output="$PWD/dist/Alpi-orchestration.app"
open "$PWD/dist/Alpi-orchestration.app" --args --enable-orchestration
```

Quit an already running Alpi normally before launching another build against the
same state. Quit stops its managed VMs while retaining their disks. An existing
instance cannot be enabled by launching a second instance with the flag. The
broker is disabled by default, has no renderer enable control, and opens only
after runtime verification. Packaging itself does not start a VM.

Packaged builds use this socket:

```text
/Users/YOUR_USER/Library/Application Support/Harness Isolated/personal-v1/o/s
```

The internal `Harness Isolated` name preserves existing storage and Keychain
identity. Do not rename it. A source development launch instead uses the separate
development profile, with socket under `Harness Isolated/o/s`; it does not adopt
the packaged profile. Use the intended build and explicit socket consistently.

The socket directory must be owned by the host user with mode `0700`; the socket
has mode `0600`. Symlink ancestors and existing endpoints are refused. The broker
does not remove an unknown socket to recover from a crash. If startup fails,
confirm the selected profile, runtime verification and absence of another owner;
preserve the existing endpoint until its ownership and liveness are established.

## Connect the MCP client

Create a stdio MCP entry named `alpi`. Set its executable to your absolute Node.js
22 or 24 path, and its argument array to:

```json
[
  "/absolute/path/to/alpi-isolated-agent/src/orchestration/mcp.cjs",
  "--socket",
  "/Users/YOUR_USER/Library/Application Support/Harness Isolated/personal-v1/o/s"
]
```

Use the feature checkout that matches the app. These are process arguments, not
a shell command: retain spaces inside each argument; do not add embedded quote
characters. Replace placeholders with absolute paths. Clients do not necessarily
expand `~` or `$HOME`. No environment secrets, URL, token or network listener are
needed. The CLI requires the socket argument and never discovers or starts Alpi.

The client performs MCP `initialize`, then `notifications/initialized`, then
`tools/list`. The server supports protocol `2025-06-18`. Tools may appear with a
client-added prefix. First call `alpi_status` with `{}`: a successful response
establishes the native broker connection without starting a VM or model request.
An MCP initialization alone only establishes the stdio facade.

## Assign and verify work

1. Read environment and provider/model IDs from `alpi_status`. Select explicitly;
   no engine, image or model fallback occurs. Start the selected environment with
   `alpi_start({environmentId})` if needed.
2. Use an existing guest project or prepare a clean host staging directory.
   `alpi_import({environmentId, source, guestParent, name})` copies into a new
   guest workspace container. `source` is an absolute host path; `guestParent`
   is inside `/home/user/workspace`. The returned `destination` is the new
   container; `contentRoot` identifies the verified source entry nested inside it.
   For a directory source, inspect `contentRoot` before using it as the task cwd.
   For a file source, it identifies the file, not a working directory.
   Confirm the expected project files and the actual cwd independently before
   delegating; do not infer the guest path from the host layout or from guest prose.
   Keep generated output inside the assigned workspace or another explicitly
   assigned guest path you have verified is writable; verify any temporary location instead of assuming a
   host path or shared temporary directory is visible. Import includes every
   permitted file in the tree, including dotfiles; it does not filter credentials.
   No host directory is implicitly mounted.
3. Call `alpi_delegate` with `environmentId`, absolute guest `cwd`, `provider`,
   `model`, `prompt` and a new UUID `requestId`. Include an outcome, file scope,
   interfaces, tests and constraints in the prompt. Optional `reasoningEffort`
   must be supported by the configured model; do not change the model default or
   add an unsupported effort to proceed. Retain the returned task handle.
4. Use `alpi_wait({taskId, timeoutMs, afterSeq, maxMessages})` for compact progress.
   Pass a non-null `snapshot.cursor` as `afterSeq` on subsequent calls; omit it
   when null. Default wait is one second and one message; maximums remain 20
   seconds and 32 messages. Idle is not a test verdict. Report meaningful changes.
5. Use `alpi_send({taskId, prompt, requestId, mode})` for follow-ups. A new intended
   message gets its own UUID. `queue` is the default; `steer` redirects active work.
6. Independently check the result with `alpi_exec({environmentId, command, cwd})`.
   Inspect the exit code, stdout/stderr and truncation/timeout fields. Commands
   run in the guest; `root: true` grants guest root only. Default command timeout
   is 30 seconds, maximum 90 seconds; each captured stream is bounded to 64 KiB.
7. Export with `alpi_export({environmentId, source, hostParent, name})` into a new
   host container selected by the trusted orchestrator. Inspect the returned
   destination and contents before applying changes. Export does not extract
   archives, merge, overwrite, install dependencies or execute returned code.

## Progress, pending actions and cancellation

These response changes require a newly built app and matching MCP checkout.
Older builds return raw `value` by default; do not pair a new tool schema with an
old running broker. Existing durable task handles remain valid after the update.

The default `format: "compact"` returns `{taskId, untrusted: true, snapshot}`.
The snapshot contains `state` (running/waiting/idle/unknown), `live`, `cursor`,
`pendingActions`, `assistantText`, `truncated` and `capabilities`. Unknown live
state or cursor is null. Text is capped at 16 KiB UTF-8, newest message first;
reasoning, streaming chunks, tool arguments and queued prompts are omitted.
Check both truncation flags: advancing the cursor after truncated output does not
recover skipped history. Empty text is valid and idle does not establish success.

Pending actions currently expose only approval/question/other, with
`detailAvailable: false` and `resolution: "guest-ui"`. Stop routine polling and
hand the decision to the user in the guest Harness UI. The pinned stock RPC has
no resolvable approval handle, exact action/reason or approval-resolution method.
Guest claims cannot grant authority. Keep guest approvals separate from host
network approvals; Alpi MCP exposes neither automatic approval nor proxy controls.

The observation interface is harness-neutral; one stock adapter implements it.
Unsupported capabilities fail explicitly. This is not registration of another
harness, and existing session creation/submission still uses stock Harness.
Current command, last activity, completion reason and process termination are not
available facts and must not be inferred from assistant text.

`format: "raw"` explicitly opts into the prior `{taskId, untrusted: true, value}`
backend-specific response for compatibility/diagnostics. Its default is eight
records, maximum 32. It may include reasoning and tool data; ordinary orchestration
should use compact mode and avoid retaining raw traces. The helper still limits
upstream replies to 512 KiB: even one large stock message can exceed this bound.
Compact host projection does not fix upstream oversize failures or provide paging.

Transfer receipts preserve `destination` and add `contentRoot`. The fixed MCP
errors `transfer_path_refused`, `transfer_collision`, and `transfer_preview_failed`
distinguish existing path-policy refusals, confirmed collisions and unclassified
preview failures. They contain no underlying error text. Guest transfer paths must
be under `/home/user/workspace`; unknown failures do not diagnose permissions or
network causes. An export `contentRoot` is an untrusted file/directory under the
host destination you selected. No existing destination is overwritten.

For dependency installation, choose a finite task budget and a progress checkpoint
rather than assuming a universal timeout. If installation stalls, inspect the
current output and any pending approval before cancelling or retrying. Do not retry
blindly, bypass network policy or infer proxy failure from silence; silence is not
evidence that a proxy is blocking traffic.

`alpi_cancel({taskId})` returns `requested: true`, `acknowledged: true`,
`cooperative: true` and `processTermination: "unknown"`. This confirms the request
was accepted, not that the turn ended or guest processes stopped. Observe again;
a later idle state reports quiescence, not cancellation causality or termination.
Cancellation is not an approval handoff. Use `alpi_stop` only for authorized,
verified whole-VM shutdown.

Before reporting success, reconcile the final changed files and hashes against the
authorized scope and the exported result. Guest-reported test counts are guest
evidence; keep them separate from tests you ran yourself. Native visual checks have
host-side limits, so a guest screenshot or guest statement about rendering is not
independent visual verification.

The broker admits one operation at a time, including a wait; `alpi_status` and
`alpi_tasks` remain readable. Native UI mutations share this exclusion. Finish
or abort a wait before sending another operation. A `busy` refusal does not mean
the requested mutation ran; do not convert ambiguous transport failures into new
prompt submissions.

## Reconnect and uncertain submissions

`alpi_tasks({})` returns durable task handles, submission states, request counts
and the latest request summary. It does not return prompts or full transcripts.
Host records are metadata; the guest holds the Harness sessions and project files.

Reuse the **same request ID and exact original arguments** when recovering a lost
delegate/send reply. Matching retries return the existing receipt without
resubmitting. Conflicting reuse is refused. After a crash or ambiguous guest
response, `uncertain` means work may have been accepted; it does not mean failure.
Never generate a fresh ID just to bypass that uncertainty. Observation and
explicit cancellation use the recorded session and verified VM ownership;
successful observation does not retroactively prove prompt admission.

Task bindings cannot be silently adopted by a recreated environment. A corrupt or
unwritable journal fails closed and preserves its file. There is no automatic
history eviction, journal reset or replay: limits are 256 tasks, 64 requests per
task and an 8 MiB journal. Capacity or journal faults require explicit recovery;
VM stop and guest shell controls do not depend on a healthy task journal.

## Cancellation and the trust boundary

- Cancelling an MCP request or closing its connection stops host observation.
  It does not undo an accepted prompt or prove a guest process stopped.
- `alpi_cancel({taskId})` requests cooperative Harness cancellation. Treat its
  acknowledgement as a request acknowledgement, then inspect actual state.
- `alpi_stop({environmentId})` uses verified whole-VM shutdown and stops every
  job in that environment, retaining its disk. Failed shutdown keeps guards.
- Quit closes the broker before managed shutdown. Merely closing the window or
  disconnecting MCP does not stop guest jobs.

The guest helper can clean up ordinary command process groups when it receives
termination signals. Guest root can replace that helper, suppress cleanup or
create detached sessions. Command deadlines and helper cleanup are not hostile
guest containment; verified VM stop is the lifecycle boundary.

The broker is trusted host authority scoped to fixed tools and existing Alpi
controls. Same-user host compromise is outside its authentication model. Do not
forward the socket into the guest, expose it over TCP or register host-side MCP
tools inside the guest Harness. Network decisions, credential mutations, generic
host shell execution and new shared-folder grants are not broker tools. Existing
host-enforced network and explicit share policies still apply.

All guest output and exports remain untrusted, including plausible instructions
to run host commands or change permissions. The orchestrator derives authority
from the user's task, independently verifies changes and keeps real credentials
in the existing host bridge. See [the security model](../SECURITY.md).

## Verification

`npm run test:portable` exercises synthetic transport, guest adapter, journal,
MCP and native lifecycle cases without a VM or model credentials. Focused suites
are `tests/orchestration-*.test.cjs` and `tests/native-onboarding.test.cjs`.
Synthetic results do not establish live VM compatibility.

Live acceptance must use the actual feature build, selected verified runtime and
an explicitly authorized model task: initialize/status, start, user/root exec,
clean import, delegate/wait/follow-up, independent guest tests, MCP reconnect and
same-ID recovery, cooperative cancellation, export/content comparison and
verified lifecycle cleanup. Record the tested revision, environment/model IDs,
outcomes and limits without credentials, launch URLs or private transcripts.
The [implementation plan](alpi-orchestration-plan.md) tracks acceptance work.

### Recorded development-Mac acceptance

On 2026-11-17, runtime code at
`e82001b695a1973f55faacaf0a5d3c6c30955ab6` was packaged into a separate ad-hoc
signed app with `sourceDirty: false` and Electron 45.3.1. The installed app was
not modified. The existing pinned `personal-v1-20261112-r1` runtime passed its
actual artifact verifier. Tests retained the selected `wrapvm-arm64-v1` /
`local-arm64` environment and existing policy/catalog without recreating a VM,
changing shares, importing credentials or weakening network enforcement.

Executed evidence:

- All **692 tracked repository tests passed**, with no failures or skips. The
  command enumerated tracked `tests/*.test.cjs` files and ran `node --test`;
  unrelated untracked test files were excluded.
- A coordinator client exercised the real stdio MCP process, private Unix socket,
  packaged native broker, verified VM driver and stock guest Harness. Initialize,
  tool listing, status and explicit protected start succeeded.
- Guest user/root commands, literal shell quoting, exit code 7, stderr and 64 KiB
  output truncation were checked. Guest root could not access a newly created
  host-only canary. The canary's host hash remained unchanged.
- A command deadline and a separate MCP disconnect each prevented an ordinary
  child process from writing its delayed marker. The disconnect test first
  confirmed that the command had started. These are ordinary-process cleanup
  observations, not guarantees against hostile guest root.
- A clean two-file staging directory imported through the real transfer path.
  `spark` / `DeepSeek-V4.1-Flash-1017` implemented a small CommonJS library and
  nine tests. A queued follow-up added sparse-array and boxed-string regressions.
  The coordinator read the implementation and independently ran **11/11 tests**
  in the guest. Guest output reported the selected provider/model.
- A fresh MCP connection recovered the identical task/session receipt with the
  original request ID and one recorded request. No new identity was used to
  bypass an ambiguous prompt submission.
- Relative host paths, traversal container names, existing destinations, host
  symlink sources and guest symlink exports were rejected. A successful export
  contained four files; every host file hash matched its guest counterpart.
  Exported code was inspected without executing it on the host.
- An additional turn was observed running, cancelled through `alpi_cancel`, then
  observed idle with an empty queue and no pending input. Verified whole-VM stop
  returned stopped/offline. Normal Quit exited and removed the broker socket.
  Existing unrelated legacy VM processes were left untouched.

One configuration limit was exercised explicitly: the saved Alpi model had no
reasoning-effort mapping. Requesting `low` was rejected by stock model selection
before prompt submission, leaving an observable/cancellable uncertain binding.
The successful test used the **same provider/model with its configured default**;
effective reasoning was uncontrolled, not asserted to be low. No catalog or
provider configuration was changed to obtain a pass.

This evidence covers one existing macOS/ARM64 guest configuration and a small
real model task. It does not establish fresh-machine runtime installation, live
Lima/AMD64 operation, every provider, an external MCP SDK/client UI, native T3
subagent registration or comprehensive guest-root containment. Network bypass
and proxy-failure tests were not rerun live for this orchestration change; the
existing boundary and synthetic regression coverage remain in place. The final
integrated PR review is a separate acceptance gate.
