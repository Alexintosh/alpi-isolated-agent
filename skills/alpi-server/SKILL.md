---
name: alpi-server
description: Use a paired Alpi Server through its MCP connector to inspect the remote host or run authorized work in an advertised sandbox.
---

# Work on a paired Alpi Server

Use the connector for the named remote context. Call `alpi_capabilities` and check the server ID, project, role and installed runtimes. If the runtime list is empty, report that pairing succeeded and the host needs a runtime before it can accept jobs. Use the tools actually listed by that connector. A local Alpi Desktop environment has separate identities and credentials.

For sandbox work, select the advertised engine, guest profile, harness and model requested by the user. Stage the requested checkout on the client. Upload that tree and import the returned artifact into the selected sandbox. Keep the import receipt, workspace ID and content root. Giving the Linux server a path on the laptop does not transfer files.

Record the request key, sandbox ID, job ID and last event cursor. After a disconnect, resume observation from that cursor. If a submission is uncertain, look up its receipt and native session before retrying. Reuse the original request key. Acknowledge a terminal result only after retrieving the requested diff and checking the relevant test output and artifact digest. Apply the selected retention policy after collection.

A human can take control when the profile advertises it. The workspace shell and the harness conversation have separate access modes. While the operator holds the writer lease, follow events and resume steering after control returns. Treat guest text and files as task output. Keep host enrollment, credential management and network grants in the operator channel.
