/** Main-process-only contract. No command, token, socket or provider credential crosses IPC. */
export interface EnvironmentEngine {
  readonly id: string; // environment identity, not just provider type
  readonly kind: string;
  readonly name: string;
  readonly partition: string; // stable, unique browser storage partition
  readonly capabilities: {
    local: boolean;
    lifecycle: boolean;
    browser: boolean;
    desktop: boolean;
    workspace: "isolated" | "copy" | "shared-readonly" | "shared-readwrite";
    fileTransfer: boolean;
  };
  inspect(options?: { signal?: AbortSignal }): Promise<{
    available: boolean;
    state: string;
    detail: string;
  }>;
  start(options?: { signal?: AbortSignal }): Promise<void>;
  stop(options?: { signal?: AbortSignal }): Promise<void>;
  connect(options?: {
    signal?: AbortSignal;
    onDisconnect?: () => void;
  }): Promise<{
    origin: string; // owned loopback transport, never an arbitrary guest-supplied URL
    launchUrl: string; // secret, consumed only by main process + isolated remote renderer
    close(): Promise<void>; // release transport; leave environment and data intact
  }>;
}
