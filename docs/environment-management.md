# Environment management

Settings → Environment management applies only to the selected environment. The two WrapVM images retain separate VM identities and data. Lima remains separate too.

- **Restart VM** stops active jobs and boots the same owned VM with a fresh protected network. Workspace, Harness sessions, browser state and shares remain. Harness disconnects during this operation; select Connect afterward.
- **Recreate environment…** requires a native confirmation with Cancel selected by default and an Export files first alternative. It stops the VM, revokes its folder-share grants, clears its app-owned UI partition, and removes the owned instance through the stock engine. This permanently removes guest workspace, Harness sessions, browser state and system changes. The next explicit Connect creates a fresh guest using the same pinned image. No automatic rebuild or image fallback occurs.

Recreation preserves host files, exported files, imported image archives, resource limits, model/Git catalogs, app-managed credentials, and saved network rules **including the network mode**. For a clean network policy, review those settings separately. Shared host folder contents are never removed; add shares again explicitly after recreation. Other environments are unaffected.

Resolve interrupted transfer records in Files before recreating an environment. A corrupt transfer/share registry blocks recreation rather than discarding recovery information. Stop remains available.

## Interrupted operations

A durable `resetPending` flag is saved before stopping/removing the guest. The old ownership identity remains until absence is verified. While this flag is present, start, prepare, connect, restart and guest file operations are blocked. Settings offers recreation recovery with a new native confirmation; startup reconciliation never resumes deletion automatically. Stop and Quit still work. A failed stop retains network protection.

Deletion and revocation are not rollbackable. If cancellation or a crash occurs after deletion, the guest may already be gone, while the registry still reports incomplete recreation. Confirming recreation again checks absence, completes metadata cleanup, and assigns a fresh ownership identity. A different or unrecognized VM is refused.

## Stock commands and limits

- Lima 1.0.7: `limactl delete --tty=false <fixed-machine>` in the app's private `LIMA_HOME`. No force flag; stock requires Stopped. Only the matching creation reservation is retired after verified absence.
- smolvm 1.34.1: `smolvm machine delete --name <fixed-machine> --force` in the app's private HOME. Here force skips the CLI prompt; it can also stop a running VM, so the driver first verifies owned stopped/created state. No cascade or cache pruning is requested.

Both drivers independently verify ownership/configuration before deletion and inventory afterward. Neither stock CLI offers atomic ownership-conditional deletion. The app serializes its own operations; a trusted host process concurrently replacing/starting a private runtime resource between verification and deletion remains a limitation. Do not manipulate app-managed runtime directories with external engine commands while management is active. This is distinct from the untrusted guest threat boundary.

## Validation scope

Automated fixtures cover ownership refusal, stop/deletion failures, cancellation, old-identity retention, explicit retry, stale confirmation, shutdown during a pending native confirmation, selected-environment dispatch and renderer guards. Native dialogs, VM deletion and fresh-guest rebuild have not been exercised on user environments. No current user VM was restarted or erased for these tests. This feature is not M7 acceptance.
