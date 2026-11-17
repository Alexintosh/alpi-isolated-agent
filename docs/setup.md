# Alpi setup and development

## Release scope

`v0.1.0-alpha.2` adds a **client-only macOS Apple Silicon DMG** to the source prerelease. [Download it from the release](https://github.com/Alexintosh/alpi-isolated-agent/releases/tag/v0.1.0-alpha.2) and follow the [installation guide](macos-distribution.md). Source, guest integration, tests, manifests, documentation and branding remain available. The release does not include VM disks, desktop images or the combined VM runtime payload. Matching Electron component source archives are separate optional downloads for rebuilding those components.

You can install the DMG, build the client locally or run synthetic tests. Neither the DMG nor a fresh checkout alone can start a protected guest: the installer requires the exact runtime artifacts in `src/runtime/artifact-manifest.cjs`. The current local build pipeline does not reproduce those historical bytes automatically. Do not remove digest checks to get past this limitation.

## macOS client

Prerequisites:

- Apple Silicon Mac. Historical live runtime checks used macOS 27.2.1; other releases are not certified by this prerelease.
- For source development only: Node.js 22 or 24 and npm (Node 24 recommended), Git, and Apple Command Line Tools for packaging/signing. The DMG includes Electron; it does not require a separate host Node installation for the client.
- Enough storage for Electron and build output. A complete runtime adds several gigabytes, then guest disks grow separately.
- A graphical session to inspect the app. Building and tests do not require opening it.

```sh
git clone https://github.com/Alexintosh/alpi-isolated-agent.git
cd alpi-isolated-agent
npm ci
npm run test:portable
npm run notices
npm run package:mac
open dist/Alpi.app
```

`package:mac` copies the installed Electron runtime, production dependencies, Alpi code, notices and icon into a new bundle. It signs that copy ad hoc and verifies the signature. It never replaces an existing destination. To make another build:

```sh
node scripts/package-personal-app.cjs --output="$PWD/dist/Alpi-next.app"
```

No VM starts during packaging. Do not use `--check-startup` casually: although it does not request a guest start, app initialization reconciles managed environments, and its normal exit stops them. Open the app manually when you are ready to control your environments.

Gatekeeper may require an explicit local trust decision because the app is not Developer ID signed/notarized. Alpi does not modify system-wide Gatekeeper policy or install a privileged helper.

### Runtime preparation

The embedded manifest fixes versions, byte lengths and SHA-256 digests. It currently expects:

- Lima 1.0.7 and its ARM64 guest agent; a pinned Ubuntu 24.04 ARM64 disk.
- smolvm 1.34.1 for macOS ARM64; the official AMD64 WrapVM image.
- Iron Proxy 0.56.0; guest Node 24.13.0 and DSH 0.2.2-rc.2 bundles for ARM64 and x64.
- agent-browser 0.41.2 and a private CPython 3.13.18 host runtime.

For an already prepared compatible payload, choose **Settings → Install runtime package** and select its folder. Installation verifies all required files, including both engine payloads. A Lima-only folder is not accepted by the current all-files manifest.

The stock AMD64 desktop needs Linux Rosetta support already installed on the host. Alpi does not install Rosetta or accept its terms for you. The optional local ARM64/Chromium image is separately pinned and not available from this repository; selecting it requires the exact locally prepared archive. There is no architecture or image fallback.

Maintainer build helpers include `build-guest-bundle.cjs`, `acquire-wrapvm-stock.cjs`, `acquire-browser-tool.cjs`, `acquire-host-python.cjs` and `package-lima-runtime.cjs`. These are ingredients, **not a complete fresh-machine installer**. The guest builder records timestamps; its new archive will differ from the historical manifest. Lima packaging expects an exact preinstalled version. A new runtime release must deliberately inventory, license-review, test and pin its resulting bytes in application code.

Runtime redistribution remains blocked on permissions and complete license/source obligations described in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Do not attach the local Runtime Package to a public release.

### Manage model providers

Source builds support an editable **Models** catalog for OpenAI Chat Completions
compatible endpoints, local or remote. Add a provider with a stable ID, display
name, explicit HTTP(S) API base URL and one or more model definitions. Supply
context and output token limits for each model; these are configuration, not
capabilities discovered by Alpi. Select a saved model as the default.

Choose **API key** or **No authentication** explicitly. Keys are encrypted in the
existing host vault and are never returned to the renderer. An unchanged endpoint
can retain its saved key; changing the endpoint requires a new key. Unauthenticated
providers need no dummy key and do not read the vault. Their guest requests still
require a substitute and pass through the same host network policy; no
Authorization header reaches the upstream endpoint.

**Import from DSH** is optional. It reads all configured providers and models from
`~/.dsh/profiles/desktop/cordis.patch.yml`, plus referenced credentials from
`~/.dsh/.credentials.yaml` when needed. Import merges matching provider IDs and
preserves unrelated Alpi providers. It retains the current default when still
valid; select another default before an import or edit that would remove it.
Unsupported protocols, invalid defaults and unavailable referenced credentials
fail explicitly without a partial import. Source files remain unchanged.

Existing version-1 catalogs and their authorization metadata remain readable.
An explicit successful catalog change writes version 2; new UI grants no longer
need the former one-model-per-provider `model-authorizations.json` workflow. The
old authorization file is not rewritten or removed.

Models and Git repository grants are currently **shared across all managed
environments**. Saving, importing, selecting a default or removing access stops
all environments and their running jobs before updating the catalog. A failed
stop prevents the update. Connect again to use the new catalog. If catalog
publication is uncertain, Alpi preserves encrypted values and blocks new leases
until restart revalidates the stored state. A cleanup warning means the access
change succeeded but an unused encrypted record remains.

Inference endpoints are reached from the host bridge. A host-local server can
therefore use `127.0.0.1`; that is not the guest's loopback. Host-side availability
checks are separate explicit host actions that request `/models` without running
inference. They do not establish guest-side or full inference acceptance.

### GitHub repository credentials

In **Secrets**, authorize one exact `owner/repository` for HTTPS clone, fetch and
push. Enter a GitHub username and a limited-scope token, or explicitly import the
credential available for that repository through the Mac credential helper.
Replacing a token requires a fresh username and token; saved values are never
shown. The helper does not scan other repositories or start a browser login.

These grants use the host vault and the existing smart-Git bridge. They are
shared across environments and stop all environments on mutation, as described
above. The guest receives a per-launch substitute. GitHub REST API access belongs
in a separate scoped API credential. Redirects and Git LFS are not supported.
Local synthetic Git/Iron tests do not establish live private-GitHub acceptance.

### Scoped API credentials

Open **Secrets → Add secret** to save a Bearer token, an API key in an `x-` header, or a Basic-auth password. Enter a name, select one environment, and set the exact HTTPS origin, an allowed path prefix and explicit HTTP methods. API keys also require their header name; Basic auth requires a username. Names, usernames and scopes are metadata; put the secret only in the password field.

Prefixes must start and end with `/`: `/v1/` permits paths below that prefix, while `/` permits all paths on the selected origin. Encoded path segments, dot segments, wildcard origins and reserved internal headers are rejected. Query parameters are not restricted by the prefix. Saving a credential does not create a network allow rule; normal Iron approvals still apply.

**Save and stop environment** stores the value in the existing encrypted host vault and stops that credential's environment before changing access. Removing access also stops that environment. Files and sessions survive; choose **Connect** to resume. The environment of a saved entry is fixed: create a separate entry to grant another environment access. **Replace** rotates the saved value; it never reveals the old value. Changing the authentication type or Basic username requires a fresh value.

On connection, Alpi writes `~/.harness-isolated/secrets.json` inside the guest. This manifest contains names, scopes, a relay `baseURL` and a per-launch substitute `authorization`, never the real values. Guest tools append the original API path and query to `baseURL`, then send the substitute in the `Authorization` header. The host validates the environment, path, method and substitute, and uses a single-use ticket to inject the real header through Iron after network approval. The guest environment's existing proxy exclusions cover this local relay.

This supports scoped HTTP API calls and text/JSON/event-stream responses. It does not inject plaintext environment variables, SSH keys, browser cookies or arbitrary files into the guest. Only a small set of request headers is forwarded (Accept, Content-Type, Anthropic-Version, OpenAI-Beta, X-GitHub-API-Version and Idempotency-Key). Redirects and compressed responses are rejected; arbitrary upstream response headers are discarded. Literal and JSON-escaped reflected secrets are filtered from response bodies; arbitrary encodings or covert channels are outside that guarantee.

Synthetic catalog, renderer, lifecycle and relay tests do not establish live acceptance against every API or a running VM. Revalidate the actual provider workflow before relying on it.

### Existing installations and data

For host coding-agent delegation, see [Alpi orchestration](alpi-orchestration.md).
It documents the explicit `--enable-orchestration` startup flag, private socket,
stdio MCP configuration and guest task workflow. The MCP client does not start
Alpi or choose a profile automatically.

Alpi retains the original internal application identifier, safeStorage name and directories to avoid silently migrating VM disks or changing Keychain identity:

- Packaged state: `~/Library/Application Support/Harness Isolated/personal-v1`.
- Packaged runtime: `~/.harness-isolated/v1`.
- Development state uses a different profile under `Harness Isolated`; development runtime defaults differ as well.

The visible app name and icon are Alpi. Do not rename those internal directories or run two differently branded copies against the same storage. Use normal **Quit** before replacing a running build. Closing the window merely hides it and leaves jobs running.

VM recreation, stop behavior and recovery are explained in [environment management](environment-management.md). Export needed files first; do not delete broad Lima, Docker, smolvm or home-directory trees as a cleanup shortcut.

## Linux development

There is no supported Linux-host launcher or packaged AppImage in this release. Linux is currently the VM guest OS.

You can run the portable synthetic test subset with Node 22/24:

```sh
npm ci --ignore-scripts
npm run test:portable
```

Skipping install scripts avoids downloading Electron for these tests. The subset uses temporary fixtures and mocked services, not personal credentials or live VMs. `npm test` is broader and includes fixtures requiring pinned host tools; it is not the Linux compatibility command.

A proper Linux port still needs:

1. A stock Linux engine backend with host-enforced egress restrictions that guest root cannot disable.
2. A supported encrypted secret store with no plaintext fallback; the current vault explicitly requires macOS Keychain.
3. Linux artifact manifests, runtime acquisition, packaging and host-native path/dialog validation.
4. Real tests for proxy failure, DNS/IPv6/UDP bypass attempts, filesystem grants, reconnection and guest lifecycle.

Do not emulate Linux support by disabling the sandbox, the proxy, TLS verification or the vault platform check.

## Tests and release discipline

- `npm run test:portable`: dependency-installed, synthetic subset suitable for contributing and CI.
- `npm test`: full local suite; some tests require separately acquired pinned artifacts.
- `npm run notices`: reproduce production dependency notices from the lockfile and installed packages.
- `npm run package:mac`: local Apple Silicon client bundle; no guest runtime included.
- `npm run package:dmg`: build and verify a client-only DMG without launching the app; see [disk-image packaging](macos-distribution.md).

No inference key is needed for unit tests. See [AGENTS.md](../AGENTS.md) for agent-facing instructions and [SECURITY.md](../SECURITY.md) for security assumptions. A passing mock test is never a substitute for live acceptance of a new platform or engine.

A [GitHub Actions template](portable-tests.workflow.yml) is provided for portable checks on Ubuntu and macOS. It is not installed as an active workflow: publishing credentials used for this prerelease did not have GitHub's `workflow` scope. A maintainer with that permission can copy it to `.github/workflows/portable-tests.yml`. No Linux CI result is claimed for this prerelease.

### Synthetic Models/Git form acceptance

Run `npm run test:ui-dom` on a graphical Electron host. It loads the shipped
HTML, renderer and preload in a hidden BrowserWindow with a temporary profile
and synthetic IPC handlers; external network requests are blocked. It checks
real form validation, password clearing, deferred/rejected requests, optional
Git helper import and provider editor edge cases. It never loads the application
main process, accesses Keychain, reads DSH profiles or starts a VM. This is real
DOM acceptance, not proof of live provider, GitHub or VM operation.
