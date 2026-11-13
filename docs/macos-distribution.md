# macOS disk image

Alpi's disk-image builder packages the native **client only**, for macOS on Apple Silicon. VM disks, desktop images, Iron and other VM runtime artifacts are not included. Installing the client on a fresh Mac is not sufficient to start an environment: see [runtime preparation](setup.md#runtime-preparation).

## Build and verify

Use the locked dependencies and a reviewed source checkout:

```sh
npm ci
npm run notices
npm run test:portable
npm run package:dmg
```

The default output is `dist/Alpi-<version>-macOS-arm64.dmg`. Existing applications and disk images are never overwritten. To choose a different new destination:

```sh
node scripts/package-dmg.cjs --output="$PWD/dist/Alpi-preview.dmg"
```

The builder creates a new Alpi.app, signs it ad hoc, includes the icon and third-party notices, and adds an Applications shortcut and installation instructions. It verifies the disk image, mounts it read-only without opening Finder, checks the app signature and metadata, then detaches it. It does not launch Alpi, install into Applications or operate a VM. A SHA-256 checksum is printed after successful verification.

## Install a released image

1. Download the Apple Silicon DMG and the checksum file from the same Alpi release. Verify the checksum before opening it.
2. Open the disk image and drag **Alpi.app** into **Applications**.
3. If updating, quit the old Alpi instance before replacing it. Quit stops managed VMs and their active jobs; it preserves workspace data. Do not recreate an environment as part of an application update.
4. Open Alpi when ready. This preview is ad-hoc signed, **not Developer ID signed or notarized**. macOS may require the per-app **Open Anyway** process in System Settings → Privacy & Security. Do not disable Gatekeeper globally.
5. Use an existing compatible runtime or install its verified package through Settings. The runtime is not bundled with this DMG.

No Intel or Linux binary support is claimed. Existing internal storage and Keychain identities remain unchanged. See [existing installations](setup.md#existing-installations-and-data).

## Component sources and validation

The client release co-publishes the matching Electron component source set in three optional archive parts. Users installing Alpi need only the DMG; recipients rebuilding or modifying the components need all three source parts and their manifest. See [source provenance and licenses](../licenses/electron/README.md) and [rebuilding/replacement instructions](../licenses/electron/REBUILD.md).

Source and disk-image checksums are included with the release. The source set preserves the pinned upstream archives and ordered Electron patches. External developer toolchains and Apple SDKs are prerequisites; this is not a hermetic toolchain distribution or a bit-for-bit rebuild claim.

Signing validation checks bundle integrity, not Developer ID identity, notarization, fresh-machine runtime readiness or end-to-end VM acceptance. Complete Electron recompilation and execution with modified libraries have not been performed. Full product acceptance remains separate from the packaging checks.
