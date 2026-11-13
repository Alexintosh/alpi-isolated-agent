# Rebuild a compatible Electron runtime for Alpi

This recipe targets Electron **45.3.1**, Chromium **156.0.8078.96**, on macOS ARM64. It is intended to let recipients rebuild and replace LGPL-covered components. It is not a claim of a bit-for-bit reproduction of Electron's official build, a successful build performed by Alpi, or an offline SDK/toolchain distribution.

## Materials and prerequisites

Preserve the complete source archive set, source placement manifest, checksums and Electron's ordered patch queues together. The Chromium root archive includes Blink, Mozilla-derived URL/NSPR source, Chromium's Opus integration and vendored Symphonia crates. Separate source archives populate the DEPS git checkouts. The Electron Yarn cache and Chromium's packaged JavaScript dependencies accompany their original locks and configuration.

The external tool pins are listed in [build-inputs.json](build-inputs.json). In particular GN is `pt5SZX89AaBzsAqpHbUS-F066dKywK1GlJzaToIE9ioC`, Ninja is `xem0_6s7Lt77xBhJ_IHxFsjQR7JYkGvswGG-nsrwSv0C`, Chromium Clang is `llvmorg-24-init-7747-g62397f8b-53`, and Rust is `1edd55dcfcd573872c727fa3e086369a71661ee0-2`. Preserve `vpython.toml.uv.lock` for the Python build environment, not only its broader version constraints. Chromium/DevTools additionally use pinned native Node, TypeScript and esbuild tools; Electron's Yarn cache includes its separate native TypeScript/Rolldown dependencies. These external build prerequisites must be installed through the pinned upstream mechanisms before compilation.

Use a machine with enough free disk space for a full Chromium/Electron checkout and build; the compressed download size is not an estimate of build space. Install a compatible Apple Xcode/SDK through Apple's normal process and accept its terms yourself. Node.js >=22.18.0, Python 3.11, Git and Chromium's depot_tools are build prerequisites. Alpi's installer does not install or accept SDK licenses.

The pinned manifests also describe compilers, GN, Ninja/Siso, language runtimes and test tools fetched upstream. These tool prerequisites are separate from source for the application and linked libraries. Source availability does not imply that proprietary test artifacts or Apple's SDK may be redistributed. Do not acquire a private Google Xcode package or authenticate as a Googler to follow this recipe.

## Pinned upstream reconstruction

The canonical upstream workflow reconstructs Git metadata and generates the configuration files consumed by the build. Use a new directory, never Alpi's application-data or VM directories. Use depot_tools revision `a07c06fe67a1a9d64ac4728df3a11c1ceb0cf73e` from the source set and disable its automatic updates (`DEPOT_TOOLS_UPDATE=0`). Leave `FORCE_MAC_TOOLCHAIN` **unset**; setting it to the string `0` still selects the private toolchain path. With depot_tools available on PATH:

```sh
unset FORCE_MAC_TOOLCHAIN
export DEPOT_TOOLS_UPDATE=0
mkdir electron-alpi-rebuild
cd electron-alpi-rebuild
gclient config --name src/electron --unmanaged https://github.com/electron/electron
# Select the exact release before synchronization, not the moving default branch.
gclient sync --nohooks --revision src/electron@3025e0491e87674c112f7a7d2646292c0efa4599
```

Confirm the pristine checkout revisions before applying patches:

| Checkout | Revision |
| --- | --- |
| `src/electron` | `3025e0491e87674c112f7a7d2646292c0efa4599` |
| `src` | `2ad9b7f5a86846e0b264090723a6a78964bb84c4` |
| `src/third_party/electron_node` | `f7f273a9bb6445f6f7fb6349105e7532972045fb` (Node v24.22.2) |
| `src/v8` | `6500240d220d9eaba51ea0012f60e926fe4b6472` |
| `src/third_party/ffmpeg` | `9db86ce5b5b454dfc96c435f9f0723012980c37f` |

The source placement manifest records the other exact repositories and revisions. Gitiles archives have no leading repository directory; GitHub archives have one. When restoring from those archives, place the root `src` tree first, then `src/electron` and all nested repositories, outer paths before inner paths. A root archive does not populate gitlinks by itself. Do not substitute the upstream Symphonia workspace for Chromium's already-vendored crates and GN wrappers.

Archives omit Git metadata. Upstream patch and revision-generation scripts may need it. The pinned `gclient` workflow above is the supported reference for reconstructing metadata; merely writing a synthetic HEAD or version string does not recreate the original Git objects. The version override below handles Electron's version lookup, not all Git-dependent build steps.

Run the applicable upstream setup hooks using your developer-installed toolchain, or follow the pinned manual build instructions to acquire those tools and generate the configuration. Preserve the Electron patch configuration and **every** patch queue in `src/electron/patches/config.json`. Within each queue, apply the files in `.patches` order. Do not apply them twice after running the normal patch hook. The four FFmpeg patches are only one of these groups.

For the Electron JavaScript dependencies, the acquired cache was produced with its original `yarn.lock` using `install --immutable --mode=skip-build` and `enableScripts=false`. Restore the cache under Electron's `.yarn/cache` and use its vendored Yarn 4.18.0 with `YARN_ENABLE_GLOBAL_CACHE=false`. Do not replace the lockfile with newly resolved versions.

## Compile a replacement without release-training profiles

In `src`:

```sh
./buildtools/mac/gn gen out/Release --args='import("//electron/build/args/release.gn") target_os="mac" target_cpu="arm64" is_debug=false override_electron_version="45.3.1" use_system_xcode=true use_siso=false use_remoteexec=false use_reclient=false chrome_pgo_phase=0 v8_builtins_profiling_log_file="" enable_dsyms=false'
# FFmpeg only:
./third_party/ninja/ninja -C out/Release ffmpeg
# Complete runtime, including the framework containing Blink:
./third_party/ninja/ninja -C out/Release electron:electron_dist_zip
```

`use_system_xcode=true` selects an already installed full Apple Xcode SDK, while the pinned Chromium Clang remains the compiler. `use_siso=false` selects local Ninja, and remote execution is disabled. `enable_dsyms=false` avoids the separate dSYM tool input. `chrome_pgo_phase=0` disables C++ PGO; the empty builtins profile path disables that V8 profile input. These are replacement-build settings, not the official release-training configuration. The original settings, profile identifiers and download scripts remain in Electron's source. No bit-identical or performance-equivalent result is claimed.

Modify the relevant library source before rebuilding. For Blink, replace the complete matching framework/resources or use the complete rebuilt Electron shell with Alpi's application source. A stripped original Electron Framework does not provide the objects needed to relink a modified Blink.

## Install into a copy, not the active application

Close a disposable **copy** of Alpi.app. For FFmpeg, replace its compatible ARM64 library at:

```text
Alpi.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib
```

For Blink, replace the matching rebuilt `Electron Framework.framework` and required resources, preserving the framework's symlinks. Alternatively, use the complete rebuilt Electron distribution and place Alpi's application source at `Contents/Resources/app`, then apply the branding and preserved application identifier from `scripts/package-personal-app.cjs`. That script is the authoritative record of Alpi's packaging transformations.

Changing the bundle invalidates its previous signature. Re-sign **only your modified copy** locally, then verify it:

```sh
codesign --force --deep --sign - --preserve-metadata=entitlements,flags,runtime /absolute/path/to/modified/Alpi.app
codesign --verify --deep --strict /absolute/path/to/modified/Alpi.app
```

Alpi permits personal modification and reverse engineering to debug such modifications. It imposes no library hash lock on the Electron Framework or FFmpeg. The upstream ABI still matters: an incompatible replacement can fail to load. Do not reset an environment or weaken guest network enforcement to test a library replacement.

## Evidence boundary

Alpi's DMG packaging, ad-hoc signature and mounted contents have been checked. The source archives and package checksums are checked separately. A complete Electron compilation and execution with modified libraries have **not** been performed on the development Mac. See the pinned upstream build instructions and individual component licenses; these materials do not constitute legal certification or full product acceptance.
