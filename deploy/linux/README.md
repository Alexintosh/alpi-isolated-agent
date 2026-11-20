# Alpi Server control service

The control service runs under a dedicated Linux account. It can pair with a T3 provider before the host has KVM, Iron, an engine or a guest image installed. The systemd unit listens on loopback by default.

## Install the service

From the repository root, run `node scripts/pack-alpi-control.cjs alpi-server dist/control` and `node scripts/pack-alpi-control.cjs alpi-client dist/control`. The server build includes the same artifact downloader used by Desktop. Copy the server tarball to the Linux PC and the client tarball to the machine running the T3 provider. Both commands require Node.js 24. The server also needs the system OpenSSL executable for initial TLS identity generation.

As the Linux operator, create the service account if it does not exist. The following commands assume a distribution with `useradd`, systemd and a Node.js 24 installation visible to the system service.

```sh
getent passwd alpi-server >/dev/null || sudo useradd --system --user-group --home-dir /var/lib/alpi-server --shell /usr/sbin/nologin alpi-server
sudo npm install --global --prefix /usr/local --ignore-scripts ./alpi-server-0.1.0-alpha.1.tgz
sudo install -m 0644 /usr/local/lib/node_modules/alpi-server/deploy/linux/alpi-server.service /etc/systemd/system/alpi-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now alpi-server.service
systemctl is-active alpi-server.service
```

The system service owns its private state under `/var/lib/alpi-server`. Run administrative commands as the service account or through the Linux operator's authorized administration channel. The database, TLS key and admin socket belong on the host.

## Reach the service from T3

For the default loopback listener, open the tunnel on the machine and account running the T3 provider. Substitute the SSH alias of the Linux PC.

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:7443:127.0.0.1:7443 GAMING_PC
```

Install the client tarball using Node.js 24. Prepare an owner-only directory and a separate private 32-byte key file for the encrypted context store. Set `ALPI_CONFIG_DIR` and `ALPI_CONTEXT_KEY_FILE` in the environments of both the pairing command and the provider that launches the MCP. The key file path can be configured in T3. Keep its contents and the one-time enrollment envelope out of chat and MCP configuration.

Use the remote console to issue an invitation and transfer its output through a trusted channel into an owner-only file. Treat a lost exchange response as a possibly successful enrollment. Inspect the enrolled clients from the Linux console before issuing a replacement. Confirm the pinned server fingerprint and server ID through the console.

The following example pairs from the provider machine using the existing SSH operator channel. It assumes the tunnel above is running. Run key creation once per encrypted store and keep a private backup. Use separate contexts for automation and interactive administration.

```sh
export ALPI_CONFIG_DIR="$HOME/.config/alpi"
export ALPI_CONTEXT_KEY_FILE="$HOME/.local/share/alpi-keys/context.key"
(umask 077 && mkdir -p "$(dirname "$ALPI_CONTEXT_KEY_FILE")" && set -C && openssl rand 32 > "$ALPI_CONTEXT_KEY_FILE")
```

Display the server UUID and SHA-256 TLS fingerprint through the trusted Linux console before exchanging the invitation. The one-time envelope contains both values. If SSH sudo needs a password, issue the invitation in an authenticated operator session and transfer the envelope through a private file instead of combining a password prompt with the pipeline.

```sh
ssh GAMING_PC sudo -n -u alpi-server /usr/local/bin/alpi-server pair issue --state-dir /var/lib/alpi-server --project demo --role runner --expires 5m --origin https://127.0.0.1:7443 | alpi pair --name gaming-pc
alpi capabilities --context gaming-pc
```

After pairing a context named `gaming-pc`, register the client with the provider selected in T3. For the Codex provider, use the absolute installed executable:

```sh
codex mcp add alpi-server -- /absolute/path/to/alpi mcp --context gaming-pc
```

In a fresh provider session, list the tools and call `alpi_capabilities`. Compare the returned server ID to the one on the Linux console. With only the control package installed, the runtime list should be empty.

## Guest profiles and local models

The server tarball includes the Pi build recipe under `profiles/pi-dev/`. The recipe pins the Linux amd64 base image and Pi dependencies. Build it with an OCI builder and use the resulting registry manifest digest when registering the image. A Docker local image ID identifies the image configuration and cannot substitute for the manifest digest.

The Linux operator can pass `--profiles /etc/alpi/profiles.json` to `serve`. Each profile names its permitted projects, engine, harnesses, model providers and resource ceiling. The following example grants project `demo` access to a Pi profile and one model on a loopback inference service. Replace the image reference and model ID with values from your installation.

```json
{
  "version": 1,
  "providers": [{
    "name": "gaming-gpu",
    "models": ["local-coder"],
    "upstream": { "scheme": "http", "host": "127.0.0.1", "port": 11434 },
    "concurrency": 2
  }],
  "profiles": [{
    "name": "pi-dev",
    "engine": "boxlite",
    "image": "registry.example/alpi/pi-dev@sha256:<registry-manifest-digest>",
    "projects": ["demo"],
    "harnesses": ["pi"],
    "providers": ["gaming-gpu"],
    "limits": { "vcpus": 2, "memoryMiB": 2048, "diskMiB": 8192 }
  }]
}
```

Run `alpi-server profiles list --config /etc/alpi/profiles.json --project demo` as the service account to inspect the public view. The file must be owned by root or the service account and writable only by its owner. Paired clients see configured profiles for their project on the active engine. The host keeps the inference address and optional systemd credential reference private. Creating a networked sandbox also requires a working engine and a qualified Iron route.

After configuring the catalog, install the selected host dependencies and warm the pinned image cache using the service account.

```sh
sudo -u alpi-server alpi-server runtime install --state-dir /var/lib/alpi-server --engine boxlite --profile pi-dev
sudo -u alpi-server alpi-server doctor --runtime --state-dir /var/lib/alpi-server
```

The default catalog is `/etc/alpi/profiles.json`. Use `--profiles FILE` with both the install and serve commands for another location. Omitting `--profile` installs the engine and Iron alone. The doctor checks the active files against the package's release manifests and reports KVM device access. Image acquisition uses the local BoxLite SDK and requires a host on which its runtime can open.
