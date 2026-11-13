# Electron component sources and replacement

Alpi's client uses the unmodified Electron 45.3.1 macOS ARM64 runtime. Electron includes FFmpeg under LGPL-2.1-or-later, LGPL-covered portions of Blink, and MPL-covered components. These components retain their licenses; Alpi's MIT license does not replace them. Full bundled copyright and license notices are in `Contents/Resources/licenses/LICENSES.chromium.html` in the application.

You may modify these components for your own use and reverse engineer the application to debug those modifications. Alpi imposes no contractual restriction on these rights. It does not enforce an Electron Framework or FFmpeg hash at application startup.

## Exact upstream versions

| Component | Source revision |
| --- | --- |
| Electron 45.3.1 | [`3025e0491e87674c112f7a7d2646292c0efa4599`](https://github.com/electron/electron/tree/3025e0491e87674c112f7a7d2646292c0efa4599) |
| Chromium 156.0.8078.96, including Blink and Mozilla-derived NSPR/URL code | [`2ad9b7f5a86846e0b264090723a6a78964bb84c4`](https://chromium.googlesource.com/chromium/src/+/2ad9b7f5a86846e0b264090723a6a78964bb84c4/) |
| Chromium's FFmpeg fork | [`9db86ce5b5b454dfc96c435f9f0723012980c37f`](https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/9db86ce5b5b454dfc96c435f9f0723012980c37f/) |
| Opus | [`55513e81d8f606bd75d0ff773d2144e5f2a732f5`](https://chromium.googlesource.com/chromium/deps/opus/+/55513e81d8f606bd75d0ff773d2144e5f2a732f5/) |
| Symphonia 0.6.1 | [`ee35874b571a35a9a6e15d3bc9a3aaf8f11fbeee`](https://github.com/pdeljanov/Symphonia/tree/ee35874b571a35a9a6e15d3bc9a3aaf8f11fbeee) |

Electron's [`DEPS`](https://github.com/electron/electron/blob/v45.3.1/DEPS) and Chromium's [`DEPS`](https://chromium.googlesource.com/chromium/src/+/156.0.8078.96/DEPS) identify additional dependencies. Electron's complete `patches/` directory and its ordered `.patches` lists are part of the matching source, including Chromium/Blink changes. A vanilla Chromium or FFmpeg release alone is not the matching source.

The FFmpeg patch sequence is `link_with_loader_path.patch`, `cherry-pick-f4bee18dadeb.patch`, `cherry-pick-5eed87f44b0a.patch`, `cherry-pick-fb424c4f78d1.patch`, from Electron's `patches/ffmpeg/`. The ARM64 Chrome configuration disables GPL, GPLv3 and nonfree code. The binary's `git-2026-08-25-e5441fe421` string is its generated FFmpeg version, not the source checkout revision.

## Mozilla-covered components

`base/third_party/nspr` and Symphonia are covered by **MPL 2.0**. The Mozilla-derived `url/third_party/mozilla/url_parse.cc` is covered by **MPL 1.1**, with alternative GPL/LGPL grants preserved in its source header. Its Original Code is mozilla.org code; the Initial Developer is Netscape Communications Corporation, Copyright 1998, with Darin Fisher credited as the original author. Alpi does not modify these component sources. Their upstream modification and provenance notices remain in the corresponding source archives.

The MPL 1.1 and MPL 2.0 texts are included separately. Release maintainers must retain electronic availability of the MPL 1.1 covered sources for the period required by section 3.2; do not delete their source attachments when superseding a release. This differs from an LGPL written source offer.

## Rebuilding and replacing

Use Electron's [versioned build instructions](https://github.com/electron/electron/blob/v45.3.1/docs/development/build-instructions-gn.md) and [macOS prerequisites](https://github.com/electron/electron/blob/v45.3.1/docs/development/build-instructions-macos.md). Synchronize the exact Electron commit above and its DEPS; apply Electron's patch set through its normal synchronization hooks. In the synchronized `src` directory:

```sh
gn gen out/Release --args='import("//electron/build/args/release.gn") target_cpu="arm64"'
ninja -C out/Release ffmpeg
# To rebuild the framework and the complete Electron distribution:
ninja -C out/Release electron:electron_dist_zip
```

These are upstream build recipes, not a claim that Alpi has reproduced Electron bit for bit. Building Electron requires substantial disk space, downloads and a compatible Apple toolchain. No compiler or SDK is bundled with Alpi.

Work on a **copy** of Alpi.app, with that copy closed. An ABI-compatible macOS ARM64 FFmpeg library can replace:

```text
Alpi.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib
```

The framework can also be replaced with a matching rebuilt `Electron Framework.framework`; preserve its symlinks and supporting resources. For a complete custom Electron build, follow upstream's application-distribution layout and copy Alpi's `Contents/Resources/app` into that runtime. Preserve Alpi's application identifier and storage identity if you intend to use existing environments.

Changing a signed bundle invalidates its signature. The maintainer packaging script demonstrates local ad-hoc re-signing with `codesign --force --deep --sign - --preserve-metadata=entitlements,flags,runtime` and subsequent `codesign --verify --deep --strict`. Apply this only to your modified copy. An incompatible replacement may fail to load; replacement and rebuild execution have not been validated in this alpha.

## Release-source status

This document records the pinned source chain and replacement instructions. It is not a written source offer or a claim that a complete matching source attachment has already been published. The DMG publication gate requires assembling and checking the source materials alongside the binary before public distribution.
