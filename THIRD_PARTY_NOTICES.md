# Third-party notices and distribution scope

Alpi's original code is licensed under the [MIT License](LICENSE). That grant does not relicense third-party code, binaries, images, fonts or trademarks. The source prerelease contains no VM images or third-party runtime binaries. Dependency lockfiles identify packages acquired separately during development.

## Included third-party source and notices

- `src/protocol/iron-transform.proto` is the unchanged Iron Proxy v0.56.0 external transform contract, commit `3d96ce8dd2ca093051b75ccb0c9e5e1db52d1c04`. It is **Apache-2.0**, Copyright 2025 The iron-proxy Authors. The full license is in [src/protocol/IRON-LICENSE](src/protocol/IRON-LICENSE), with provenance in [src/protocol/README.md](src/protocol/README.md).
- [licenses/production-notices.txt](licenses/production-notices.txt) preserves the actual installed notices for all 36 locked production npm entries. Regenerate with `npm run notices`. Package notices take precedence over this summary.
- The banner and application icon are project branding assets supplied for Alpi. Upstream names and marks in this document identify dependencies and do not imply endorsement.

## Application dependencies

| Project | Version / license | Role |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron/tree/v45.3.1) | [MIT](https://github.com/electron/electron/blob/v45.3.1/LICENSE), plus bundled Chromium/dependency licenses | Native shell. Local builds retain Electron's complete LICENSE and LICENSES.chromium.html. |
| [gRPC for Node](https://github.com/grpc/grpc-node) | grpc-js 1.14.7, proto-loader 0.8.0; Apache-2.0 | Iron extension protocol. |
| [js-yaml](https://github.com/nodeca/js-yaml/tree/4.3.2) | 4.3.2; MIT | Host profile parsing. |
| [Undici](https://github.com/nodejs/undici/tree/v7.30.2) | 7.30.2; MIT | HTTP transport. |
| [protobuf.js](https://github.com/protobufjs/protobuf.js) | 7.6.6 and support packages; BSD-3-Clause | Protocol serialization. |

Other production dependency licenses include MIT, ISC, Apache-2.0, BSD-3-Clause and the Python license stack carried by argparse. Exact names, versions and complete notices are in the generated inventory. Local packaging copies whole dependency directories so their own notices remain present, and adds licenses under `Contents/Resources/licenses`.

## Separately acquired guest and host runtimes

These projects are used by Alpi's runtime design but are **not redistributed in this source prerelease**. Their source licenses do not necessarily describe every linked library or OS package in their binary releases.

| Project | Verified source/license information | Important qualification |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.2) | 0.2.2-rc.2; MIT, Copyright 2026 DeepSeek | Guest dependencies include MPL/LGPL components; DSH's MIT license is not a license for the whole bundle. |
| [Lima](https://github.com/lima-vm/lima/tree/v1.0.7) | 1.0.7; Apache-2.0, The Lima Authors | Binary dependency notices also apply. |
| [smolvm](https://github.com/smol-machines/smolvm/tree/v1.34.1) | 1.34.1; Apache-2.0, Copyright 2024–2025 smolvm contributors | Its libraries and rootfs have additional licenses. See [upstream notices](https://github.com/smol-machines/smolvm/blob/v1.34.1/THIRD-PARTY-NOTICES.md). |
| [libkrun](https://github.com/containers/libkrun) / [libkrunfw](https://github.com/smol-machines/libkrunfw) | Apache-2.0 / LGPL-2.1-only, with a GPL-2.0-only embedded Linux kernel | Corresponding-source obligations apply to binary distribution. |
| [Iron Proxy](https://github.com/paradigmxyz/iron-proxy/tree/v0.56.0) | 0.56.0; Apache-2.0, Copyright 2025 The iron-proxy Authors | Runtime binary and its dependencies are separate from the included protocol source. |
| [WrapVM](https://github.com/tobi/wrapvm/tree/41e3b0b3ef40fde457241cd7f17ae3410455256f) | Pinned revision `41e3b0b…`; no explicit license grant found in that tree | Public availability is not redistribution permission. Resolve permission before redistributing WrapVM-authored material. |
| [voxl](https://github.com/tembo/voxl/tree/f5d6ec93dd2745a680054071eae31aec45049a49) | Source MIT, Copyright 2026 Tembo | The x264-linked binary is GPL-covered, as explained upstream. |
| [agent-browser](https://github.com/vercel-labs/agent-browser/tree/v0.41.2) | 0.41.2; Apache-2.0 | Includes axe-core under MPL-2.0 and other third-party notices. |
| [Node.js](https://github.com/nodejs/node/blob/v24.13.0/LICENSE) | 24.13.0; MIT plus the complete bundled dependency license stack | Preserve the full license bundle, including npm material. |
| [CPython](https://github.com/python/cpython/blob/v3.13.18/LICENSE) / [python-build-standalone](https://github.com/astral-sh/python-build-standalone/tree/20261110) | Python 3.13.18 PSF/historical licenses; build tooling MPL-2.0 | The standalone distribution includes separately licensed dependencies. |
| [Ubuntu](https://ubuntu.com/), [Linux](https://kernel.org/), [XFCE](https://www.xfce.org/) | Collections of independently licensed packages | Preserve exact package notices and meet applicable source obligations; no blanket MIT license. |
| [Chromium](https://www.chromium.org/) | BSD-style core plus many third-party licenses | The adapted ARM64 image also needs its own provenance and complete inventory. |
| [Google Chrome](https://www.google.com/chrome/terms/) / Widevine | Proprietary executable/component terms in addition to open-source components | The pinned desktop contains Widevine material requiring separate redistribution permission. No such agreement is asserted here. |

## Why there is no public runtime or binary bundle yet

The existing local payload has unresolved WrapVM redistribution permissions, Chrome/Widevine restrictions and complete corresponding-source/notice obligations for GPL, LGPL and MPL components. Separating downloads does not remove those obligations. The source prerelease also avoids distributing an Electron binary until its complete bundled-component distribution requirements have been addressed.

GPL/LGPL software can be redistributed with compliance; these licenses do not automatically relicense independent Alpi code merely because the programs are used together. Before a binary release, inventory the actual artifacts, preserve notices, provide required corresponding source/build information and honor applicable replacement/relinking rights. Runtime integrity verification must not be assumed to settle licensing rights.

Useful primary references: [MPL 2.0 obligations](https://www.mozilla.org/en-US/MPL/2.0/), [FFmpeg legal guidance](https://ffmpeg.org/legal.html), [Canonical's policy](https://canonical.com/legal/intellectual-property-policy), [smolvm notices](https://github.com/smol-machines/smolvm/blob/v1.34.1/THIRD-PARTY-NOTICES.md), and the exact license files linked above.
