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
   is inside the guest. Use the returned `destination`, not a guessed path.
   Import includes every permitted file in the tree, including dotfiles; it
   does not filter credentials. No host directory is implicitly mounted.
3. Call `alpi_delegate` with `environmentId`, absolute guest `cwd`, `provider`,
   `model`, `prompt` and a new UUID `requestId`. Include an outcome, file scope,
   interfaces, tests and constraints in the prompt. Optional `reasoningEffort`
   must be supported by the configured model. Retain the returned task handle.
4. Use `alpi_wait({taskId, timeoutMs, afterSeq, maxMessages})` for bounded progress.
   Retain the stock output cursor and pass it as `afterSeq` on subsequent calls.
   Wait defaults to one second and eight records; limits are 20 seconds and 32
   records. Inspect stock `reason`, state and output; idle is not a test verdict.
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
