# Changelog

## 0.1.0-alpha.2 — macOS client DMG

- Added a verified, client-only Apple Silicon DMG with Alpi branding and an Applications shortcut.
- Included Electron/Chromium notices, matching component source archives, checksums and rebuilding/replacement instructions.
- Added a repeatable DMG packaging command and installation/update guidance.

The client is ad-hoc signed, not notarized. VM runtime payloads remain separate and undistributed; installing this DMG alone does not make a fresh Mac ready to start guests. No Linux host runtime, full Electron rebuild, modified-library ABI test or full end-to-end release acceptance is claimed.

## 0.1.0-alpha.1

First public source prerelease of **Alpi — isolated workspaces for AI agents**.

### Included

- Native macOS controls around the original DeepSeek Harness UI served by a Linux guest.
- Lima and WrapVM/smolvm engine adapters, persistent environments and explicit image profiles.
- Host-side Iron Proxy policy, grouped approval notifications and saved Allow/Deny decisions.
- Host-encrypted model/Git credentials with scoped guest bridge access.
- Explicit file import/export, optional RO/RW folder sharing and interrupted-transfer recovery.
- Desktop/browser viewing, connection recovery, VM restart and confirmed environment recreation.
- Alpi banner/icon, English documentation, security model, research references and dependency notices.
- Configurable host model authorization with no personal inference endpoints in the public source.

### Release limits

Source only. No prebuilt app, VM runtime, model keys or private test evidence is included. A locally built macOS client still requires the exact separately prepared runtime payload. No fresh-machine turnkey installer, Linux host runtime, notarization or production security certification is claimed. Full end-to-end release acceptance and live private GitHub push acceptance remain incomplete.

Runtime redistribution requires resolving upstream permission and corresponding-source obligations. See THIRD_PARTY_NOTICES.md, SECURITY.md and docs/setup.md.
