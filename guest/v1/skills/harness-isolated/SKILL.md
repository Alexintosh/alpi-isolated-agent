---
name: harness-isolated
description: Understand this Harness guest environment, its workspace, network approvals, and available browser or desktop tools.
---

# Harness Isolated environment

Harness, its shell processes, sessions, and workspace run inside this Linux guest. The Mac application is a client. A guest path is not a Mac path.

## Workspace and transfers

Use the current Harness workspace. The initial workspace is beneath `/home/user/workspace`. Files are guest-local unless the user has explicitly configured a shared folder under `/mnt/harness-shares`. Do not assume a shared folder exists or is writable. The user's Mac app provides import, export and explicit folder sharing; you cannot invoke its native file picker from a guest shell.

## Network and credentials

Guest egress passes through the host's Iron Proxy. In approval mode, a new destination waits for the user in the app's Network panel. A rejected or expired request may need the user to approve the destination and then ask you to retry the operation. Explain the destination and why it is needed; avoid repeated retries that generate approval noise. A proxy outage can leave Harness connected while Internet/model access is offline. The user can retry the network from the app without restarting the VM.

Real model and Git credentials are held by the host application. Guest configuration contains scoped substitutes. Missing real keys in the guest is intentional. Do not request copying host keys into this workspace or attempt to bypass the proxy.

For additional API credentials granted in Alpi's Secrets panel, read `~/.harness-isolated/secrets.json`. An entry has a name, upstream origin, allowed path prefix and methods, a relay `baseURL`, and a substitute `authorization`. Append the API's original path and query to that base URL; send the substitute as the `Authorization` header even when the upstream uses an API-key header or Basic auth. The host injects the real credential only after scope checks and Iron approval. Do not print the substitute or copy it to unrelated tools or hosts. Read the manifest again after reconnecting; substitutes expire with their environment's bridge.

Use only the listed methods and paths. This relay supports text/JSON/event-stream API responses, not redirects, compressed responses or arbitrary HTTP headers. A missing entry needs a user grant in the Mac app; it is not permission to search host credentials. Do not retry denied requests automatically.

## Browser and desktop (WrapVM only)

If the browser/desktop tools are installed, they operate the guest desktop and its shared Chrome session. Start by reading their actual stock guides:

```sh
agent-browser skills get core
agent-desktop skills get desktop
agent-desktop skills get platform
```

The browser guide data is installed at `/opt/agent-browser/skill-data`; the launcher sets `AGENT_BROWSER_SKILLS_DIR` for discovery. Follow the available guide/tool help instead of guessing browser commands. The guest's Chrome is separate from any browser on the Mac.

The app's Desktop button shows the full guest desktop. Browser focuses an existing Chrome window within that same desktop stream. These are viewing controls; they are not agent tools. A stock Harness web sidebar or iframe is also a client-side display and is not the guest browser automation tool. Do not assume a missing sidebar means Chrome is unavailable.

The Lima environment has shell/files/terminal; do not claim it has the WrapVM desktop or Chrome unless the installed capabilities actually demonstrate that.
