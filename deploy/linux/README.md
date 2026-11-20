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

After pairing a context named `gaming-pc`, register the client with the provider selected in T3. For the Codex provider, use the absolute installed executable:

```sh
codex mcp add alpi-server -- /absolute/path/to/alpi mcp --context gaming-pc
```

In a fresh provider session, list the tools and call `alpi_capabilities`. Compare the returned server ID to the one on the Linux console. With only the control package installed, the runtime list should be empty.
