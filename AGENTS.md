# Working on Alpi

Alpi is a macOS native client controlling a stock DeepSeek Harness backend inside a Linux VM. Read README.md, SECURITY.md and docs/setup.md before changing runtime behavior.

## Setup without user data

Use Node.js 22 or 24 and npm (24 recommended). Run `npm ci --ignore-scripts` followed by `npm run test:portable` for the portable synthetic checks. This needs no model credentials, running VM or personal profile. `npm ci` installs Electron for macOS client development; `npm run package:mac` builds a new local Alpi.app without launching it.

`npm test` includes host-specific integration fixtures and can require private pinned artifacts in vendor/. Missing artifacts are not permission to download arbitrary replacements or disable verification. Do not claim skipped/mocked tests as live VM acceptance.

## Repository map

- `src/v1-main.cjs`: native lifecycle, authenticated local IPC, connection and viewer management.
- `src/v1/`: trusted local controls and notifications. Guest Harness UI is upstream, not reconstructed here.
- `src/runtime/`: engine drivers, ownership coordinator, proxy/policy, credential bridges, transfers and artifact installation.
- `guest/v1/`: our guest launcher/provisioning integration; keep upstream packages stock.
- `tests/`: synthetic, temporary-directory and local fixture tests.
- `scripts/`: explicit build/acquisition tooling. Review each script before invoking it.

## Boundaries to preserve

1. Guest root is untrusted. Enforce networking and read-only shares outside the guest. Proxy failure must not open a direct route.
2. Never give guest/plugin content generic host Node, shell, filesystem or VM-control access. Validate trusted local main-frame IPC.
3. Real app-managed credentials stay on the host. Do not print keys, tokens, launch URLs, upstream bodies or YAML error snippets.
4. Do not patch Harness core, the installed official app or the user's existing plugins. Stock dependencies only unless the user explicitly changes scope.
5. Never silently switch engine, image, architecture, credentials or runtime paths. Missing hashes, ownership or dependencies must fail explicitly.
6. Stop and independently verify ownership before destructive lifecycle work. Preserve guards after a failed stop. Cancellation after deletion is not rollback.
7. Workspaces and personal data must survive routine updates. Never reset a user's VM, change a shared folder, or run inference as a test without task authorization.
8. Keep user-visible text in English. Reuse the existing native-style controls and strict CSP.

## Validation and commits

Prefer focused regression tests for the affected boundary, then appropriate broader checks. Use temporary fixtures with synthetic credentials; do not inspect personal Keychain or DSH profiles for ordinary tests. Explain what was actually executed and what remains unverified. Commit cohesive changes. Publishing, tagging or pushing is separate from local edits and must be requested.

Record every code review on its PR, tied to the exact reviewed head SHA. Include findings, executed checks, limits, resolution commits and regression evidence there. Reviewers start from the PR and leave a durable report; an earlier approval does not cover a later push. Same-account model reviews are comments, not independent GitHub approvals.

This alpha preserves legacy storage and application identities for existing installations. Branding is not authorization to migrate/delete those locations or to change Keychain identity. See docs/setup.md.
