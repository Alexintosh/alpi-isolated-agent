# Alpi security model

Alpi separates an AI agent's working environment from the computer that controls it. Its security goal is to keep an untrusted Linux guest—including a process with guest root privileges—behind host-enforced network, filesystem and credential boundaries.

**Status: alpha / developer preview.** The implementation has automated regression tests and bounded live evidence from a development Mac. It has not completed independent penetration testing or full end-to-end release acceptance. There is no claim of universal containment, suitability for sensitive production data, or protection against every exfiltration channel.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Alexintosh/alpi-isolated-agent/security/advisories/new). Include the affected revision, host OS/architecture, engine/image, reproduction steps, expected boundary and observed result. Use synthetic data where possible. Do not attach real credentials, launch URLs, private repositories, browser cookies or unredacted diagnostic logs.

Only the current prerelease is maintained at this stage; there is no stable support or response-time guarantee. If the private report form is unavailable, open an issue requesting a private contact without publishing exploit details or sensitive data.

## Assets and trust assumptions

| Component or asset | Trust assumption |
| --- | --- |
| Model output, agent tools, plugins, visited pages, repository files | Untrusted input. They may be malicious or prompt-injected. |
| Guest OS and guest root | Untrusted. Guest proxy settings and guest firewalls are not the enforcement boundary. |
| Host OS, Alpi main process, engine binaries, policy service, vault | Trusted computing base. A compromised host or malicious process under the host user account is outside this model. |
| Hypervisor, virtual devices, host renderer sandbox | Trusted isolation mechanisms. A vulnerability in them can invalidate containment. |
| Upstream inference service | Receives the prompts and requests you authorize. Host-held credentials do not make the service private or trustworthy. |
| User decisions | Explicit grants of capability. Broad network permissions or writable shares deliberately increase exposure. |

The host vault protects credentials managed by Alpi. It does not discover or protect every secret in files you import, directories you share, prompts you send or browser sessions you create.

## Where enforcement happens

### Guest execution and the UI

Harness, its agent loop, tools, sessions and workspace run inside the selected Linux VM. The native Electron shell displays the original guest-served UI through an authenticated local connection. It does not start a second Harness backend on the host.

Guest UI and plugin content run in a sandboxed renderer with context isolation, no Node integration, and no privileged preload. Local controls use a separate, restricted IPC surface. Main-process handlers validate the trusted local main frame; guest content cannot invoke VM lifecycle or host-file pickers through that bridge. External navigation, popups, permissions and downloads are constrained separately.

A guest filesystem path is not treated as a host path. Closing a viewer revokes its authentication boundary and transport. The desktop viewer shows the guest desktop; focusing the browser is not a separate browser-only isolation boundary.

### Network policy outside the VM

Managed guest application egress is intended to pass through **Iron Proxy on the host**. This does not install a system-wide host proxy or route unrelated host applications through Alpi.

- **Lima:** the verified macOS launch uses `sandbox-exec` to deny general outbound networking from the process that contains its user-mode network stack. Narrow loopback allowances serve the guest-control, proxy and credential channels. No extra unrestricted VM NIC is configured. `sandbox-exec` is deprecated; compatibility and containment need revalidation after OS/engine changes.
- **WrapVM/smolvm:** the stock mediated-egress path authorizes a host mediation session. The configured synthetic destination and exact DNS gateway name are restricted; direct egress and unsupported datagram traffic are not granted. Root inside the guest cannot change the host mediator's rules.
- **Iron:** the host policy callback controls forwarding. HTTPS inspection uses an app-managed CA trusted inside the guest; its private key stays on the host. Upstream TLS verification remains enabled. Alpi does not install this CA in the host's global trust store.

The default policy asks before a new destination is permitted. Saved deny rules take precedence. Once-only decisions, persistent decisions and policy revocation have distinct lifetimes. An expired or cancelled request is not silently replayed after approval.

**Allow all is a policy mode, not a proxy bypass.** It broadly permits destinations, subject to applicable denies and other enforcement, and removes much of the protection against data leaving the guest. **Block all** blocks guest application egress, not the local management connection. If the proxy or policy path fails, guest egress should fail closed. Recovery revalidates the retained launch and requires an explicit user retry after unexpected proxy failure; it must not stop a healthy guest merely to reconnect its UI.

Host operations such as approved model availability probes, artifact downloads, or Git credential-helper access are separate trusted host actions. The guest-egress policy is not a firewall for the whole host.

### Model, Git and scoped API credentials

The current vault uses Electron safeStorage backed by macOS Keychain; stored values are encrypted, with no plaintext fallback. This is one reason the Linux host port is not yet supported.

The guest receives substitutes and scoped access to a host credential bridge. The bridge binds requests to the environment and permitted route, method and destination; host-issued tickets are short-lived and single-use. The host applies network policy and injects the real credential on the authorized upstream request. Closing a bridge revokes outstanding tickets and active connections.

The Secrets panel extends this boundary to user-entered Bearer, API-key and Basic-auth credentials. Each grant belongs to one environment, one HTTPS origin, a conservative path prefix and explicit methods. Credentials are never returned by renderer IPC or written into guest configuration. The guest manifest contains per-launch substitutes and relay URLs. Rotation and removal wait for an owned environment to stop before changing access; a failed stop retains the previous grant. Ambiguous catalog persistence failures retain encrypted records and prevent new credential leases until disk state is revalidated.

Model providers and Git repository grants have a different scope: their catalogs
are shared across all managed environments. Their trusted UI mutations stop all
old environment leases before publishing changes. Manual provider keys and GitHub
tokens use the same host vault as imported credentials. An explicitly
unauthenticated model endpoint still requires the guest substitute and host policy
approval, but the relay strips authentication before forwarding and never reads a
secret for that provider. Changing a keyed provider's endpoint requires a fresh
key. Git grants remain restricted to one exact repository's smart-Git routes;
they do not authorize arbitrary GitHub REST API calls.

The relay rejects redirects and compressed responses, forwards only selected request headers, and strips arbitrary upstream response headers. Streaming redaction covers literal and JSON-escaped secret values (including the Basic encoding). It cannot prevent a permitted upstream service from encoding a secret differently or communicating it through a covert channel. The approved destination remains part of the credential trust assumption.

Keeping a key out of the guest **does not prevent abuse of the capability that key authorizes**. A guest permitted to call a model can spend its quota or submit data. A guest permitted to push to a Git repository can push malicious content. Use limited-scope credentials, repository permissions and provider-side limits. Private GitHub push acceptance is still pending a designated test repository; local Git fixtures are not proof of every GitHub workflow.

Browser logins create cookies and session state inside the guest. Those values are guest-readable. Personal browser logins are outside the current tested use case.

### Files and shared folders

Workspace data stays in the guest by default. Import/export requires a host action and a preview. Transfers use bounded streams, explicit destination handling and ownership markers for interrupted output. Recovery does not authorize arbitrary recursive deletion of a supplied path.

A shared folder is an intentional exception to isolation:

- Read-only sharing exposes **all readable contents**, including `.env`, keys and cookies in that tree. It only restricts writes through the shared device.
- Read-write sharing lets the guest modify or delete files within the granted tree.
- Host-side read-only enforcement matters even if guest root remounts its filesystem.
- Private app/runtime roots and specified credential locations are excluded, but that exclusion is not a general secret scanner.
- Revocation stops the guest before the grant is removed. Recreation revokes grants without deleting their host contents.

Treat exported code, archives and documents as untrusted. Opening them in a host tool, installing their dependencies or executing generated code can cross the boundary outside Alpi.

### Identity, persistence and lifecycle

Persisted registry entries are intent, not proof of live ownership. Drivers verify engine-specific ownership markers, configuration and launch identity before controlling an environment. Unknown resources are refused; there is no fallback to a personal host Harness backend.

Restart retains guest data and stops active jobs. Recreation requires a native confirmation, stops the guest, revokes shares and removes the selected instance. A durable pending-reset record blocks ordinary startup until explicit recovery completes. Other environments, host credentials and exported files are preserved. Saved network rules and the network mode also survive recreation; review them separately when beginning a less-trusted task.

The stock deletion CLIs lack atomic ownership-conditional deletion. Alpi serializes its own operations, but another trusted host process racing an external instance replacement remains a limitation. Do not operate on Alpi's private runtime directories concurrently through external engine commands.

## What this boundary does not guarantee

- No claim that model alignment, benign benchmarks or a clean conversation make a model safe.
- No protection against data exfiltration to a destination you have permitted, including an inference endpoint or allowed Git remote. URL rules are not a semantic data-loss-prevention system.
- No model-backdoor detection, code-correctness guarantee, malware scanning or automatic review of exports.
- No guarantee against hypervisor, browser, Electron, kernel or dependency vulnerabilities; denial of service and resource exhaustion are not comprehensively solved.
- No protection from a compromised host account, host administrator or physical attacker.
- No fleet isolation, multi-user service, remote-cloud security guarantee or Linux-host boundary in this release.

The official AMD64 desktop runs through Rosetta on Apple Silicon. Its guest Chrome uses `--no-sandbox` in the verified setup; this weakens containment *inside* the already untrusted guest. Electron's host renderer remains sandboxed. The optional adapted ARM64 image has a distinct provenance and is not represented as an unmodified upstream release.

The runtime installer verifies pinned bytes and refuses mismatches; hashes establish identity, not that those bytes are benign. Distribution, source provenance and license compliance are separate concerns. The macOS client DMG and local client builds are ad-hoc signed and not notarized. VM runtime payloads are not distributed in this prerelease. The DMG does not establish fresh-machine runtime readiness or complete end-to-end acceptance.

## Research context

These papers motivate treating models and their inputs as untrusted. They are not audits of Alpi, endorsements by their authors, or evidence that this implementation defeats the described attacks. The design inference is to limit capabilities outside the model rather than rely on the model to enforce its own boundaries.

| Paper | Relevance to this threat model |
| --- | --- |
| [Sleeper Agents: Training Deceptive LLMs that Persist Through Safety Training](https://arxiv.org/abs/2401.05566) — Hubinger et al., 2024 | Demonstrates constructed backdoors that can survive subsequent safety training. Safety training alone is not a host access-control mechanism. |
| [Poisoning Web-Scale Training Datasets is Practical](https://arxiv.org/abs/2302.10149) — Carlini et al., 2023/2024 | Studies practical attacks on distributed training datasets. The model supply chain is part of the trust problem, even when ordinary outputs look reasonable. |
| [BadEdit: Backdooring large language models by model editing](https://arxiv.org/abs/2403.13355) — Li et al., 2024 | Shows targeted parameter editing as a backdoor route. A useful checkpoint can still carry malicious conditional behavior. |
| [Poisoning Attacks on LLMs Require a Near-constant Number of Poison Samples](https://arxiv.org/abs/2510.07192) — Souly et al., 2025 | Reports poisoning experiments where the required poison count did not scale with training size as a fixed fraction would. Larger training corpora do not by themselves justify trusting an agent with host access. |
| [Watch Out for Your Agents! Investigating Backdoor Threats to LLM-Based Agents](https://arxiv.org/abs/2402.11208) — Yang et al., 2024 | Investigates agent-specific backdoors, including triggers encountered through interaction. Tool permissions matter beyond the initial user prompt. |
| [What the Model Cannot See: Covert and Provable Text Invisibility in LLMs](https://arxiv.org/abs/2610.15883) — Russinovich, 2026 | Studies selective suppression of marked text, including hidden vulnerabilities in AI review. Model-based inspection is not a substitute for an external trust boundary. |
| [Agentic Backdoors via Pretraining Poisoning](https://arxiv.org/abs/2610.37741) — Hu et al., 2026 | Reports poisoned pretraining leading to attacker-chosen command execution by a downstream agent. This directly motivates separating agent execution from the user's host environment. |

## Validation and future work

Automated tests cover policy decisions, bridge constraints, renderer IPC, lifecycle recovery, ownership checks and filesystem edge cases. Historical live tests exercised specific macOS/engine combinations. Mock tests and successful UI rendering do not establish a complete guest-root containment proof.

Before expanding support, revalidate the network boundary—including DNS, IPv6, UDP, alternate routes and proxy failure—on the actual target platform, verify credential storage without plaintext fallback, and exercise the whole native workflow. A Linux port must implement those host controls; changing a platform check or environment variable is not sufficient.
