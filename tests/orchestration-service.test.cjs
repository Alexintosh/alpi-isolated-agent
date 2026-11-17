const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID, createHash } = require("node:crypto");
const { Writable } = require("node:stream");
const { OrchestrationService } = require("../src/orchestration/service.cjs");
const { FileTransfers } = require("../src/runtime/file-transfers.cjs");

const execFileAsync = promisify(execFile);
const JOURNAL = "orchestration-tasks.json";
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const uuid = () => randomUUID();
const fingerprint = parts => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function journalPath(harness) {
  return path.join(harness.root, JOURNAL);
}

function makeModels(overrides = {}) {
  return {
    fault: false,
    cleanupPending: false,
    selected: { provider: "p1", model: "m1" },
    providers: [{
      id: "p1",
      displayName: "Private Provider",
      api: "openai-completions",
      baseURL: "https://secret.example/v1",
      authMode: "bearer",
      credentialAvailable: true,
      availability: "available",
      models: [{
        id: "m1",
        name: "Model One",
        contextWindow: 1000,
        maxTokens: 100,
        reasoningEfforts: { low: "low", high: "high" },
      }],
    }],
    ...overrides,
  };
}

function makeRuntime({ token = "token-1", onStart, transfers, driver } = {}) {
  const calls = { start: [], stop: [], withRunning: [] };
  const environment = {
    id: "env-1",
    name: "Work",
    kind: "lima",
    phase: "running",
    busy: false,
    network: "ready",
    prepared: true,
    issue: "raw-issue-must-not-leak",
    networkStatus: { proxy: "http://raw-proxy-must-not-leak" },
  };
  const activeDriver = driver ?? { exec: async () => "" };
  const coordinator = {
    snapshot() { return [environment]; },
    async start(id) {
      calls.start.push(id);
      if (onStart) onStart();
      return [environment];
    },
    async stop(id) {
      calls.stop.push(id);
      return [environment];
    },
    async withRunning(id, operation, { signal } = {}) {
      calls.withRunning.push(id);
      return operation(activeDriver, { ownershipToken: token, signal });
    },
  };
  if (transfers && typeof transfers === "object" && !transfers.coordinator) {
    transfers.coordinator = coordinator;
  }
  return { coordinator, calls, environment, transfers };
}

// Realistic pinned-stock `session/wait` envelope: newest-first assistant message
// records under output, sampled state and a stopping reason. The service must
// consume it only through the adapter, never by parsing these fields itself.
function stockWait({ reason = "idle", cursor = 42, active = true, running = false,
  pendingInput = [], text = "assistant output", content, truncated = false } = {}) {
  return {
    reason,
    state: { cursor, active, running, queue: active ? [] : null, pendingInput },
    output: {
      records: content === null ? [] : [{
        type: "event",
        event: {
          type: "assistant/message",
          seq: cursor,
          time: 0,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: `m${cursor}`,
              role: "assistant",
              source: { kind: "model", provider: "p1", model: "m1" },
              content: content ?? [{ type: "text", text }],
            },
          },
        },
      }],
      truncated,
    },
  };
}

const STOCK_CAPABILITIES = Object.freeze({
  observation: true,
  pendingActionDetail: "kind-only",
  approvalResolution: false,
  cancellationRequest: true,
  rawObservation: true,
});

const NEUTRAL_RECEIPT = Object.freeze({
  requested: true,
  acknowledged: true,
  cooperative: true,
  processTermination: "unknown",
});

function neutralSnapshot(overrides = {}) {
  return {
    state: "waiting",
    live: true,
    cursor: 12,
    pendingActions: [{ kind: "question", detailAvailable: false, resolution: "guest-ui" }],
    assistantText: "neutral assistant text",
    truncated: { text: false, records: false },
    capabilities: { ...STOCK_CAPABILITIES },
    ...overrides,
  };
}

// A minimal backend-neutral adapter. It deliberately has no stock RPC names,
// record shapes or projection logic, so service success proves the seam does not
// branch on the stock implementation.
function fakeAdapter(overrides = {}) {
  const calls = { observe: [], observeRaw: [], requestCancel: [] };
  const adapter = {
    capabilities() {
      return overrides.capabilities ?? { ...STOCK_CAPABILITIES };
    },
    async observe(binding, request) {
      calls.observe.push({ binding, request });
      if (overrides.observe) return overrides.observe(binding, request);
      return neutralSnapshot();
    },
    async observeRaw(binding, request) {
      calls.observeRaw.push({ binding, request });
      if (overrides.observeRaw) return overrides.observeRaw(binding, request);
      return { backend: "fake", records: [] };
    },
    async requestCancel(binding) {
      calls.requestCancel.push(binding);
      if (overrides.requestCancel) return overrides.requestCancel(binding);
      return { ...NEUTRAL_RECEIPT };
    },
  };
  return { adapter, calls };
}


function makeGuest({ onCall, onExec, failAt, createResult, block, waitResult, cancelResult } = {}) {
  const calls = [];
  const guest = {
    calls,
    async executeGuest(driver, options, request) {
      calls.push({ kind: "exec", request, ownershipToken: options.ownershipToken });
      if (onExec) await onExec({ request });
      if (failAt === "exec") throw Object.assign(new Error("raw command output"), { code: "guest-command-failed" });
      return { stdout: "ok", stderr: "", exitCode: 0, signal: null, timedOut: false, truncated: false };
    },
    async harnessRpc(driver, options, method, args) {
      const call = { kind: "rpc", method, args, ownershipToken: options.ownershipToken };
      calls.push(call);
      if (onCall) await onCall(call);
      if (block && block.method === method) await block.promise;
      if (failAt === method) throw Object.assign(new Error("raw prompt secret"), { code: "guest-rpc-failed" });
      switch (method) {
        case "session/create": return createResult ?? { sessionId: args.sessionId };
        // Pinned stock Harness shapes. The service deliberately ignores these
        // values; the doubles mirror them so a future dependency on the shape
        // fails visibly here instead of only against a live guest.
        case "session/selectModel": return {
          selected: {
            provider: args.provider,
            model: args.model,
            ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          },
        };
        case "session/prompt": return { accepted: true };
        case "session/wait": return typeof waitResult === "function"
          ? waitResult(args) : (waitResult ?? stockWait());
        case "session/cancel": return cancelResult ?? { accepted: true };
        default: throw new Error("unexpected RPC");
      }
    },
  };
  return guest;
}

// Mirrors FileTransfers' active/plans/status lifecycle and visible preview /
// snapshot shapes. It acquires the coordinator queue internally, so a service
// that wrapped the transfer in another withRunning would show an extra call.
class FakeTransfers {
  constructor(options = {}) {
    this.calls = {
      prepareImport: [], prepareExport: [], execute: [], cancel: 0, recover: 0, withRunning: 0,
    };
    this.plans = new Map();
    this.active = undefined;
    this.activeTransferId = undefined;
    this.status = { state: "idle" };
    this.journalFault = options.journalFault === true;
    this.options = options;
    this.coordinator = options.coordinator;
  }

  snapshot() {
    return { ...this.status, fault: this.journalFault, interrupted: [] };
  }

  publish(patch) {
    this.status = { ...this.status, ...patch };
  }

  addUiPreview(id = "ui-preview") {
    const plan = {
      id, environmentId: "env-1", direction: "import", source: "/tmp/ui",
      destination: "/home/user/workspace/ui", contentRoot: "/home/user/workspace/ui/ui",
      collision: false, entries: 1, bytes: 1,
      expiresAt: Date.now() + 60000,
    };
    this.plans.set(id, plan);
    this.publish({ state: "preview", ...plan, transferredBytes: 0, transferredEntries: 0 });
    return plan;
  }

  prepareImport(environmentId, source, guestParent, name) {
    this.calls.prepareImport.push({ environmentId, source, guestParent, name });
    return this.prepare("import", { environmentId, source, guestParent, name });
  }

  prepareExport(environmentId, source, hostParent, name) {
    this.calls.prepareExport.push({ environmentId, source, hostParent, name });
    return this.prepare("export", { environmentId, source, hostParent, name });
  }

  async prepare(direction, args) {
    if (this.journalFault) throw new Error("raw transfer journal secret");
    if (this.active) throw new Error("A transfer is already in progress.");
    const controller = new AbortController();
    this.active = controller;
    this.plans.clear();
    this.publish({ state: "preparing" });
    try {
      if (this.coordinator) {
        this.calls.withRunning += 1;
        await this.coordinator.withRunning(args.environmentId, async () => {}, {});
      }
      if (this.options.prepareEntered) this.options.prepareEntered.resolve();
      if (this.options.prepareGate) await this.options.prepareGate.promise;
      if (this.options.prepareError) throw this.options.prepareError;
      if (controller.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const id = randomUUID();
      const destination = direction === "import"
        ? `${args.guestParent}/${args.name}`
        : `${args.hostParent}/${args.name}`;
      const sourceName = args.source.split(/[\\/]/).filter(Boolean).at(-1);
      const plan = {
        id,
        environmentId: args.environmentId,
        direction: this.options.previewDirection ?? direction,
        source: args.source,
        destination,
        // Mirrors the real manager: the verified source basename becomes one
        // child entry inside the destination container.
        ...(this.options.omitContentRoot
          ? {}
          : { contentRoot: this.options.contentRoot ?? `${destination}/${sourceName}` }),
        collision: this.options.collision === true,
        entries: this.options.entries ?? 2,
        bytes: this.options.bytes ?? 10,
        expiresAt: Date.now() + 600000,
      };
      this.plans.set(id, plan);
      this.publish({ state: "preview", ...plan, transferredBytes: 0, transferredEntries: 0 });
      if (this.options.onPreview) this.options.onPreview(plan, this);
      return { ...plan };
    } catch (error) {
      this.publish({ state: controller.signal.aborted ? "cancelled" : "error" });
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  async execute(id) {
    if (this.journalFault) throw new Error("raw transfer journal secret");
    const prepared = this.plans.get(id);
    this.plans.clear();
    if (this.active || !prepared || prepared.collision || prepared.expiresAt <= Date.now()) {
      throw new Error("raw preview secret");
    }
    const controller = new AbortController();
    this.active = controller;
    this.activeTransferId = id;
    this.calls.execute.push(id);
    this.publish({ state: "running", transferredBytes: 0, transferredEntries: 0, cleanupPending: false });
    try {
      if (this.coordinator) {
        this.calls.withRunning += 1;
        await this.coordinator.withRunning(prepared.environmentId, async () => {}, {});
      }
      if (this.options.executeEntered) this.options.executeEntered.resolve();
      if (this.options.executeGate) await this.options.executeGate.promise;
      if (this.options.executeError) throw this.options.executeError;
      if (this.options.onExecute) this.options.onExecute(prepared, this);
      if (controller.signal.aborted) this.publish({ state: "cancelled" });
      else if (this.options.executeState && this.options.executeState !== "complete") {
        this.publish({ state: this.options.executeState });
      } else {
        this.publish({
          state: "complete",
          transferredBytes: prepared.entries,
          transferredEntries: prepared.entries,
        });
      }
    } catch {
      this.publish({ state: controller.signal.aborted ? "cancelled" : "error" });
    } finally {
      this.active = undefined;
      this.activeTransferId = undefined;
    }
    return this.snapshot();
  }

  cancel() {
    this.calls.cancel += 1;
    this.plans.clear();
    this.active?.abort();
    if (!this.active) this.publish({ state: "cancelled" });
  }

  recover() {
    this.calls.recover += 1;
    throw new Error("orchestration must not recover, discard or forget transfer output");
  }
}

const CANARY = "canary-secret-must-not-leak";
function canaryError(code) {
  const error = new Error(CANARY);
  error.code = code;
  error.cause = new Error(CANARY);
  error.extra = { secret: CANARY };
  error.stack = `${CANARY}\n${error.stack}`;
  return error;
}
function assertSanitized(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  assert.equal(error.extra, undefined);
  assert.equal(error.message.includes(CANARY), false);
  assert.equal(String(error.stack).includes(CANARY), false);
  assert.equal(JSON.stringify(error).includes(CANARY), false);
}

function makeHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpi-orchestration-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { runtime: options.runtime ?? makeRuntime({
    ...options.runtimeOptions,
    transfers: options.transfers,
  }) };
  const models = options.models ?? makeModels();
  const guest = options.guest ?? makeGuest({
    ...options.guestOptions,
    onCall: options.guestOptions?.onCall
      ? context => options.guestOptions.onCall(context, state)
      : undefined,
    onExec: options.guestOptions?.onExec
      ? context => options.guestOptions.onExec(context, state)
      : undefined,
  });
  const runExclusive = options.runExclusive ?? (async work => work());
  const open = (overrides = {}) => new OrchestrationService({
    stateRoot: root,
    getRuntime: () => overrides.runtime ?? state.runtime,
    getModels: () => overrides.models ?? models,
    runExclusive: overrides.runExclusive ?? runExclusive,
    guest: overrides.guest ?? guest,
    createAdapter: overrides.createAdapter ?? options.createAdapter,
  });
  return { root, state, models, guest, service: open(), open };
}

function delegateArgs(requestId = uuid(), extra = {}) {
  return {
    environmentId: "env-1",
    cwd: "/home/user/workspace",
    prompt: "fix the bug",
    provider: "p1",
    model: "m1",
    requestId,
    ...extra,
  };
}

test("full delegation cycle is durable, idempotent and exposes no endpoint or credential", async t => {
  const h = makeHarness(t);
  const { service, guest } = h;

  const status = await service.dispatch("alpi_status", {});
  assert.deepEqual(status.environments, [{
    id: "env-1", name: "Work", kind: "lima", phase: "running",
    busy: false, network: "ready", prepared: true,
  }]);
  assert.deepEqual(status.models, {
    fault: false,
    selected: { provider: "p1", model: "m1" },
    providers: [{ id: "p1", models: [{ id: "m1" }] }],
  });
  const visibleStatus = JSON.stringify(status);
  for (const forbidden of ["secret.example", "bearer", "credential", "baseURL",
    "authMode", "Private Provider", "raw-issue", "networkStatus", "raw-proxy"]) {
    assert.equal(visibleStatus.includes(forbidden), false, forbidden);
  }

  const started = await service.dispatch("alpi_start", { environmentId: "env-1" });
  assert.equal(started.environment.id, "env-1");
  assert.deepEqual(h.state.runtime.calls.start, ["env-1"]);

  const executed = await service.dispatch("alpi_exec", {
    environmentId: "env-1", command: "echo hi", cwd: "/home/user/workspace",
  });
  assert.equal(executed.stdout, "ok");
  assert.deepEqual(guest.calls.at(-1).request, { command: "echo hi", cwd: "/home/user/workspace" });

  const requestId = uuid();
  const args = delegateArgs(requestId);
  const receipt = await service.dispatch("alpi_delegate", args);
  assert.equal(receipt.taskId, requestId);
  assert.equal(receipt.state, "submitted");
  assert.equal(receipt.requestStatus, "submitted");
  assert.equal(receipt.provider, "p1");
  assert.equal(receipt.model, "m1");
  assert.match(receipt.sessionId, /^[a-f0-9-]{36}$/);

  const rpc = guest.calls.filter(call => call.kind === "rpc");
  assert.deepEqual(rpc.map(call => call.method), ["session/create", "session/selectModel", "session/prompt"]);
  assert.deepEqual(rpc[0].args, { cwd: "/home/user/workspace", sessionId: receipt.sessionId });
  assert.deepEqual(rpc[1].args, { sessionId: receipt.sessionId, provider: "p1", model: "m1" });
  assert.deepEqual(rpc[2].args, {
    sessionId: receipt.sessionId,
    requestId,
    mode: "queue",
    content: [{ type: "text", text: "fix the bug" }],
  });

  const beforeDuplicate = guest.calls.length;
  const duplicate = await service.dispatch("alpi_delegate", args);
  assert.deepEqual(duplicate, receipt);
  assert.equal(guest.calls.length, beforeDuplicate);

  const sendId = uuid();
  const sent = await service.dispatch("alpi_send", {
    taskId: requestId, prompt: "follow up", requestId: sendId,
  });
  assert.equal(sent.requestStatus, "submitted");
  assert.equal(sent.requestId, sendId);
  assert.deepEqual(guest.calls.at(-1).args, {
    sessionId: receipt.sessionId,
    requestId: sendId,
    mode: "queue",
    content: [{ type: "text", text: "follow up" }],
  });

  const beforeSendDuplicate = guest.calls.length;
  const sentAgain = await service.dispatch("alpi_send", {
    taskId: requestId, prompt: "follow up", requestId: sendId,
  });
  assert.deepEqual(sentAgain, sent);
  assert.equal(guest.calls.length, beforeSendDuplicate);

  const waited = await service.dispatch("alpi_wait", { taskId: requestId });
  assert.deepEqual(waited, {
    taskId: requestId,
    untrusted: true,
    snapshot: {
      state: "idle",
      live: true,
      cursor: 42,
      pendingActions: [],
      assistantText: "assistant output",
      truncated: { text: false, records: false },
      capabilities: STOCK_CAPABILITIES,
    },
  });
  assert.equal(Object.hasOwn(waited.snapshot, "completed"), false);
  assert.deepEqual(guest.calls.at(-1).args, {
    sessionId: receipt.sessionId, maxMessages: 1, timeoutMs: 1000,
  });
  // Raw remains an explicit diagnostic compatibility envelope.
  const rawWait = await service.dispatch("alpi_wait", {
    taskId: requestId, format: "raw", timeoutMs: 5000, maxMessages: 4, afterSeq: 3,
  });
  assert.deepEqual(rawWait, { taskId: requestId, untrusted: true, value: stockWait() });
  assert.deepEqual(guest.calls.at(-1).args, {
    sessionId: receipt.sessionId, maxMessages: 4, timeoutMs: 5000, afterSeq: 3,
  });
  // The public numeric cursor maps to the adapter cursor in compact mode too.
  await service.dispatch("alpi_wait", { taskId: requestId, afterSeq: 7 });
  assert.deepEqual(guest.calls.at(-1).args, {
    sessionId: receipt.sessionId, maxMessages: 1, timeoutMs: 1000, afterSeq: 7,
  });

  const cancelled = await service.dispatch("alpi_cancel", { taskId: requestId });
  assert.deepEqual(cancelled, {
    taskId: requestId,
    requested: true,
    acknowledged: true,
    cooperative: true,
    processTermination: "unknown",
  });
  assert.deepEqual(guest.calls.at(-1).args, { sessionId: receipt.sessionId });

  const tasks = await service.dispatch("alpi_tasks", {});
  assert.equal(tasks.fault, false);
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.tasks[0].state, "submitted");
  assert.equal(tasks.tasks[0].requestCount, 2);
  assert.deepEqual(tasks.tasks[0].lastRequest, {
    requestId: sendId,
    status: "submitted",
    createdAt: tasks.tasks[0].lastRequest.createdAt,
    updatedAt: tasks.tasks[0].lastRequest.updatedAt,
  });
  assert.equal(Object.hasOwn(tasks.tasks[0], "requests"), false);
  assert.equal(Object.hasOwn(tasks.tasks[0], "cwd"), false);

  const stopped = await service.dispatch("alpi_stop", { environmentId: "env-1" });
  assert.equal(stopped.environment.id, "env-1");
  assert.deepEqual(h.state.runtime.calls.stop, ["env-1"]);

  const raw = fs.readFileSync(journalPath(h), "utf8");
  for (const forbidden of ["fix the bug", "follow up", "echo hi", "assistant output",
    "secret.example", "Bearer", "credential", "cookie"]) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
  assert.match(raw, /"ownershipToken": "token-1"/);
});

test("explicit reasoning effort and steer mode are forwarded without defaults", async t => {
  const h = makeHarness(t);
  const { service, guest } = h;

  const requestId = uuid();
  const receipt = await service.dispatch("alpi_delegate",
    delegateArgs(requestId, { reasoningEffort: "high" }));
  assert.equal(receipt.reasoningEffort, "high");
  const selected = guest.calls.find(call => call.method === "session/selectModel");
  assert.equal(selected.args.reasoningEffort, "high");

  const sendId = uuid();
  await service.dispatch("alpi_send", {
    taskId: requestId, prompt: "steer it", requestId: sendId, mode: "steer",
  });
  assert.equal(guest.calls.at(-1).args.mode, "steer");

  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(uuid(), { reasoningEffort: "max" })),
    error => error.code === "reasoning_effort_invalid",
  );
  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(uuid(), { model: "unknown" })),
    error => error.code === "model_not_configured",
  );
  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(uuid(), { provider: "unknown" })),
    error => error.code === "model_not_configured",
  );
  assert.equal(guest.calls.filter(call => call.method === "session/create").length, 1);
});

test("duplicate request IDs return receipts while conflicts never target another task", async t => {
  const h = makeHarness(t);
  const { service, guest } = h;

  const first = uuid();
  await service.dispatch("alpi_delegate", delegateArgs(first));
  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(first, { prompt: "different work" })),
    error => error.code === "request_conflict",
  );

  const second = uuid();
  await service.dispatch("alpi_delegate", delegateArgs(second, { prompt: "other task" }));

  const sendId = uuid();
  await service.dispatch("alpi_send", { taskId: second, prompt: "first follow-up", requestId: sendId });
  await assert.rejects(
    service.dispatch("alpi_send", { taskId: second, prompt: "changed follow-up", requestId: sendId }),
    error => error.code === "request_conflict",
  );
  await assert.rejects(
    service.dispatch("alpi_send", { taskId: first, prompt: "cross task", requestId: sendId }),
    error => error.code === "request_conflict",
  );

  const secondSend = uuid();
  await service.dispatch("alpi_send", { taskId: first, prompt: "another", requestId: secondSend });
  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(secondSend)),
    error => error.code === "request_conflict",
  );

  const before = guest.calls.length;
  const receipt = await service.dispatch("alpi_delegate", delegateArgs(first));
  assert.equal(receipt.state, "submitted");
  assert.equal(guest.calls.length, before);
});

test("catalog faults and missing models never fall back or replay a recorded request", async t => {
  const h = makeHarness(t);
  const { service, guest } = h;
  const requestId = uuid();
  const args = delegateArgs(requestId);
  await service.dispatch("alpi_delegate", args);

  h.models.fault = true;
  const status = await service.dispatch("alpi_status", {});
  assert.deepEqual(status.models, { fault: true, selected: null, providers: [] });

  const before = guest.calls.length;
  const duplicate = await service.dispatch("alpi_delegate", args);
  assert.equal(duplicate.state, "submitted");
  assert.equal(guest.calls.length, before);
  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(uuid())),
    error => error.code === "model_catalog_unavailable",
  );
});

test("interrupted create, model selection and prompt recover as uncertain without replay", async t => {
  for (const stage of ["session/create", "session/selectModel", "session/prompt"]) {
    const h = makeHarness(t, { guestOptions: { failAt: stage } });
    const requestId = uuid();
    const args = delegateArgs(requestId);
    await assert.rejects(
      h.service.dispatch("alpi_delegate", args),
      error => error.code === "guest_failed",
    );
    const tasks = await h.service.dispatch("alpi_tasks", {});
    assert.equal(tasks.tasks.length, 1, stage);
    assert.equal(tasks.tasks[0].state, "uncertain", stage);
    assert.equal(tasks.tasks[0].lastRequest.status, "uncertain", stage);

    const freshGuest = makeGuest();
    const restarted = h.open({ guest: freshGuest });
    const recovered = await restarted.dispatch("alpi_tasks", {});
    assert.equal(recovered.tasks[0].state, "uncertain", stage);
    const receipt = await restarted.dispatch("alpi_delegate", args);
    assert.equal(receipt.state, "uncertain", stage);
    assert.equal(receipt.requestStatus, "uncertain", stage);
    assert.equal(freshGuest.calls.length, 0, `${stage} must not replay`);
  }
});

test("a mismatched session create response is not adopted", async t => {
  const wrongSession = uuid();
  const h = makeHarness(t, { guestOptions: { createResult: { sessionId: wrongSession } } });
  const requestId = uuid();
  await assert.rejects(
    h.service.dispatch("alpi_delegate", delegateArgs(requestId)),
    error => error.code === "session_mismatch",
  );
  const tasks = await h.service.dispatch("alpi_tasks", {});
  assert.equal(tasks.tasks[0].state, "uncertain");
  assert.notEqual(tasks.tasks[0].sessionId, wrongSession);
  const rpc = h.guest.calls.filter(call => call.kind === "rpc");
  assert.deepEqual(rpc.map(call => call.method), ["session/create"]);

  // Recovery observation and cancellation target only the recorded requested
  // session; the mismatched returned identity is never adopted.
  const freshGuest = makeGuest();
  const restarted = h.open({ guest: freshGuest });
  await restarted.dispatch("alpi_wait", { taskId: requestId });
  await restarted.dispatch("alpi_cancel", { taskId: requestId });
  assert.deepEqual(freshGuest.calls.map(call => call.method), ["session/wait", "session/cancel"]);
  for (const call of freshGuest.calls) {
    assert.equal(call.args.sessionId, tasks.tasks[0].sessionId);
    assert.notEqual(call.args.sessionId, wrongSession);
  }
});

test("a persisted preparing record becomes uncertain on restart and is never replayed", async t => {
  const h = makeHarness(t);
  const requestId = uuid();
  const sessionId = uuid();
  const stamp = new Date().toISOString();
  const digest = fingerprint(["delegate", "env-1", "/home/user/workspace", "fix the bug", "p1", "m1", null]);
  fs.writeFileSync(journalPath(h), JSON.stringify({
    version: 1,
    tasks: [{
      taskId: requestId,
      environmentId: "env-1",
      sessionId,
      cwd: "/home/user/workspace",
      provider: "p1",
      model: "m1",
      ownershipToken: "token-1",
      createdAt: stamp,
      updatedAt: stamp,
      state: "preparing",
      requests: [{
        requestId, fingerprint: digest, status: "preparing", createdAt: stamp, updatedAt: stamp,
      }],
    }],
  }));

  const freshGuest = makeGuest();
  const service = h.open({ guest: freshGuest });
  const tasks = await service.dispatch("alpi_tasks", {});
  assert.equal(tasks.tasks[0].state, "uncertain");
  assert.equal(tasks.tasks[0].lastRequest.status, "uncertain");

  const receipt = await service.dispatch("alpi_delegate", delegateArgs(requestId));
  assert.equal(receipt.state, "uncertain");
  assert.equal(receipt.requestStatus, "uncertain");
  assert.equal(freshGuest.calls.length, 0);
});

test("a lost initial prompt response stays observable and cancellable after restart without replay", async t => {
  const h = makeHarness(t, { guestOptions: { failAt: "session/prompt" } });
  const requestId = uuid();
  const args = delegateArgs(requestId);
  // The guest accepts the prompt but the host loses the acknowledgement, so the
  // persisted record is uncertain rather than submitted.
  await assert.rejects(
    h.service.dispatch("alpi_delegate", args),
    error => error.code === "guest_failed",
  );
  const recorded = await h.service.dispatch("alpi_tasks", {});
  assert.equal(recorded.tasks.length, 1);
  assert.equal(recorded.tasks[0].state, "uncertain");
  assert.equal(recorded.tasks[0].lastRequest.status, "uncertain");
  const sessionId = recorded.tasks[0].sessionId;

  const freshGuest = makeGuest();
  const restarted = h.open({ guest: freshGuest });
  assert.equal((await restarted.dispatch("alpi_tasks", {})).tasks[0].state, "uncertain");

  // Reusing the original delegate ID returns the uncertain receipt and admits
  // no second create/select/prompt.
  const receipt = await restarted.dispatch("alpi_delegate", args);
  assert.equal(receipt.state, "uncertain");
  assert.equal(receipt.requestStatus, "uncertain");
  assert.equal(freshGuest.calls.length, 0);

  // Passive wait dispatches against only the recorded requested session ID.
  const waited = await restarted.dispatch("alpi_wait", { taskId: requestId });
  assert.deepEqual(waited, {
    taskId: requestId,
    untrusted: true,
    snapshot: {
      state: "idle",
      live: true,
      cursor: 42,
      pendingActions: [],
      assistantText: "assistant output",
      truncated: { text: false, records: false },
      capabilities: STOCK_CAPABILITIES,
    },
  });
  assert.deepEqual(freshGuest.calls.map(call => call.method), ["session/wait"]);
  assert.deepEqual(freshGuest.calls[0].args, {
    sessionId, maxMessages: 1, timeoutMs: 1000,
  });

  // Explicit cooperative cancel is allowed for the same recorded binding.
  const cancelled = await restarted.dispatch("alpi_cancel", { taskId: requestId });
  assert.deepEqual(cancelled, {
    taskId: requestId,
    requested: true,
    acknowledged: true,
    cooperative: true,
    processTermination: "unknown",
  });
  assert.deepEqual(freshGuest.calls.map(call => call.method), ["session/wait", "session/cancel"]);
  assert.deepEqual(freshGuest.calls[1].args, { sessionId });

  // Observation never promotes uncertainty, and new prompt admission stays
  // stricter than observation.
  const after = await restarted.dispatch("alpi_tasks", {});
  assert.equal(after.tasks[0].state, "uncertain");
  assert.equal(after.tasks[0].lastRequest.status, "uncertain");
  await assert.rejects(
    restarted.dispatch("alpi_send", {
      taskId: requestId, prompt: "new work", requestId: uuid(),
    }),
    error => error.code === "session_unusable",
  );
  assert.equal(freshGuest.calls.length, 2);

  // Ownership mismatch refuses before any further RPC.
  h.state.runtime = makeRuntime({ token: "different-owner" });
  await assert.rejects(
    restarted.dispatch("alpi_wait", { taskId: requestId }),
    error => error.code === "ownership_mismatch",
  );
  await assert.rejects(
    restarted.dispatch("alpi_cancel", { taskId: requestId }),
    error => error.code === "ownership_mismatch",
  );
  assert.equal(freshGuest.calls.length, 2);
});

test("a neutral fake adapter proves observation and cancel never depend on stock shapes", async t => {
  const { adapter, calls } = fakeAdapter();
  const factoryCalls = [];
  const h = makeHarness(t, {
    createAdapter: ({ rpc }) => {
      factoryCalls.push(typeof rpc);
      return adapter;
    },
  });
  const requestId = uuid();
  const receipt = await h.service.dispatch("alpi_delegate", delegateArgs(requestId));
  const afterDelegate = h.guest.calls.length;

  const waited = await h.service.dispatch("alpi_wait", { taskId: requestId, afterSeq: 5 });
  assert.deepEqual(waited, { taskId: requestId, untrusted: true, snapshot: neutralSnapshot() });
  assert.deepEqual(calls.observe, [{
    binding: { conversationId: receipt.sessionId },
    request: { timeoutMs: 1000, maxMessages: 1, cursor: 5 },
  }]);
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0], "function");
  // The service issues no stock wait RPC of its own.
  assert.equal(h.guest.calls.length, afterDelegate);

  // An unavailable cursor is omitted rather than sent as a sentinel.
  await h.service.dispatch("alpi_wait", { taskId: requestId });
  assert.equal(Object.hasOwn(calls.observe[1].request, "cursor"), false);
  assert.equal(calls.observe[1].request.maxMessages, 1);

  const raw = await h.service.dispatch("alpi_wait", { taskId: requestId, format: "raw" });
  assert.deepEqual(raw, {
    taskId: requestId, untrusted: true, value: { backend: "fake", records: [] },
  });
  assert.deepEqual(calls.observeRaw[0], {
    binding: { conversationId: receipt.sessionId },
    request: { timeoutMs: 1000, maxMessages: 8 },
  });

  const cancelled = await h.service.dispatch("alpi_cancel", { taskId: requestId });
  assert.deepEqual(cancelled, { taskId: requestId, ...NEUTRAL_RECEIPT });
  assert.deepEqual(calls.requestCancel, [{ conversationId: receipt.sessionId }]);
  assert.equal(h.guest.calls.length, afterDelegate);

  assert.throws(() => new OrchestrationService({
    stateRoot: h.root,
    getRuntime: () => h.state.runtime,
    getModels: () => makeModels(),
    runExclusive: async work => work(),
    createAdapter: "not-a-factory",
  }), /Invalid orchestration service dependencies/);
});

test("absent capabilities or methods fail unsupported before any optional call or RPC", async t => {
  const cases = [
    { name: "observation false", capabilities: () => ({ ...STOCK_CAPABILITIES, observation: false }) },
    { name: "rawObservation false", capabilities: () => ({ ...STOCK_CAPABILITIES, rawObservation: false }), format: "raw" },
    { name: "cancellationRequest false", capabilities: () => ({ ...STOCK_CAPABILITIES, cancellationRequest: false }), cancel: true },
    { name: "observe absent", capabilities: () => ({ ...STOCK_CAPABILITIES }), absent: "observe" },
    { name: "observeRaw absent", capabilities: () => ({ ...STOCK_CAPABILITIES }), format: "raw", absent: "observeRaw" },
    { name: "requestCancel absent", capabilities: () => ({ ...STOCK_CAPABILITIES }), cancel: true, absent: "requestCancel" },
  ];

  for (const entry of cases) {
    let touched = 0;
    const adapter = {
      capabilities: entry.capabilities,
      observe() { touched += 1; throw canaryError("guest_failed"); },
      observeRaw() { touched += 1; throw canaryError("guest_failed"); },
      requestCancel() { touched += 1; throw canaryError("guest_failed"); },
    };
    if (entry.absent) delete adapter[entry.absent];

    const h = makeHarness(t, { createAdapter: () => adapter });
    const requestId = uuid();
    await h.service.dispatch("alpi_delegate", delegateArgs(requestId));
    const before = h.guest.calls.length;
    const method = entry.cancel ? "alpi_cancel" : "alpi_wait";
    const args = entry.cancel
      ? { taskId: requestId }
      : { taskId: requestId, ...(entry.format === undefined ? {} : { format: entry.format }) };
    await assert.rejects(h.service.dispatch(method, args), error => {
      assertSanitized(error, "unsupported");
      return true;
    });
    assert.equal(touched, 0, entry.name);
    assert.equal(h.guest.calls.length, before, entry.name);
  }
});

test("malformed snapshots, receipts and adapter failures normalize to fixed codes", async t => {
  const waitCases = [
    { name: "short snapshot", observe: () => ({ state: "idle" }) },
    { name: "capability drift", observe: () => neutralSnapshot({
      capabilities: { ...STOCK_CAPABILITIES, approvalResolution: true },
    }) },
    { name: "duplicate pending kinds", observe: () => neutralSnapshot({
      pendingActions: [
        { kind: "approval", detailAvailable: false, resolution: "guest-ui" },
        { kind: "approval", detailAvailable: false, resolution: "guest-ui" },
      ],
    }) },
    { name: "unknown adapter error", observe: () => { throw canaryError("guest-rpc-failed"); } },
    { name: "canary guest failure", observe: () => { throw canaryError("guest_failed"); } },
    { name: "fixed unsupported", observe: () => { throw canaryError("unsupported"); } },
  ];
  for (const entry of waitCases) {
    const { adapter } = fakeAdapter({ observe: entry.observe });
    const h = makeHarness(t, { createAdapter: () => adapter });
    const requestId = uuid();
    await h.service.dispatch("alpi_delegate", delegateArgs(requestId));
    await assert.rejects(h.service.dispatch("alpi_wait", { taskId: requestId }), error => {
      assertSanitized(error, entry.name === "fixed unsupported" ? "unsupported" : "guest_failed");
      return true;
    });
  }

  const rawFailure = fakeAdapter({
    observeRaw: () => { throw canaryError("guest-rpc-failed"); },
  });
  const rawHarness = makeHarness(t, { createAdapter: () => rawFailure.adapter });
  const rawTask = uuid();
  await rawHarness.service.dispatch("alpi_delegate", delegateArgs(rawTask));
  await assert.rejects(
    rawHarness.service.dispatch("alpi_wait", { taskId: rawTask, format: "raw" }),
    error => { assertSanitized(error, "guest_failed"); return true; },
  );

  const cancelCases = [
    { name: "accepted-only ack", requestCancel: () => ({ accepted: true }) },
    { name: "unacknowledged", requestCancel: () => ({ ...NEUTRAL_RECEIPT, acknowledged: false }) },
    { name: "termination claim", requestCancel: () => ({ ...NEUTRAL_RECEIPT, processTermination: "terminated" }) },
    { name: "canary failure", requestCancel: () => { throw canaryError("guest-rpc-failed"); } },
  ];
  for (const entry of cancelCases) {
    const { adapter, calls } = fakeAdapter({ requestCancel: entry.requestCancel });
    const h = makeHarness(t, { createAdapter: () => adapter });
    const requestId = uuid();
    await h.service.dispatch("alpi_delegate", delegateArgs(requestId));
    await assert.rejects(h.service.dispatch("alpi_cancel", { taskId: requestId }), error => {
      assertSanitized(error, "guest_failed");
      return true;
    });
    assert.equal(calls.requestCancel.length, 1, entry.name);
  }

  // A failing capability probe or factory is sanitized, not mapped to a runtime
  // error, and never falls through to a stock RPC.
  const capabilityFailure = makeHarness(t, {
    createAdapter: () => ({
      capabilities() { throw canaryError("guest-rpc-failed"); },
      observe() { throw canaryError("guest_failed"); },
    }),
  });
  const capabilityTask = uuid();
  await capabilityFailure.service.dispatch("alpi_delegate", delegateArgs(capabilityTask));
  const beforeCapability = capabilityFailure.guest.calls.length;
  await assert.rejects(
    capabilityFailure.service.dispatch("alpi_wait", { taskId: capabilityTask }),
    error => { assertSanitized(error, "guest_failed"); return true; },
  );
  assert.equal(capabilityFailure.guest.calls.length, beforeCapability);

  const factoryFailure = makeHarness(t, {
    createAdapter: () => { throw canaryError("guest-rpc-failed"); },
  });
  const factoryTask = uuid();
  await factoryFailure.service.dispatch("alpi_delegate", delegateArgs(factoryTask));
  await assert.rejects(
    factoryFailure.service.dispatch("alpi_cancel", { taskId: factoryTask }),
    error => { assertSanitized(error, "guest_failed"); return true; },
  );
});

test("late adapter completion after abort or runtime replacement is never a success", async t => {
  const gate = deferred();
  const entered = deferred();
  const { adapter } = fakeAdapter({
    observe: async () => {
      entered.resolve();
      await gate.promise;
      return neutralSnapshot();
    },
  });
  const h = makeHarness(t, { createAdapter: () => adapter });
  const requestId = uuid();
  await h.service.dispatch("alpi_delegate", delegateArgs(requestId));
  const controller = new AbortController();
  const pending = h.service.dispatch("alpi_wait", { taskId: requestId }, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, error => error.code === "aborted");

  let replacedHarness;
  const replacement = fakeAdapter({
    observe: () => {
      replacedHarness.state.runtime = makeRuntime({ token: "token-2" });
      return neutralSnapshot();
    },
  });
  replacedHarness = makeHarness(t, { createAdapter: () => replacement.adapter });
  const replacedTask = uuid();
  await replacedHarness.service.dispatch("alpi_delegate", delegateArgs(replacedTask));
  await assert.rejects(
    replacedHarness.service.dispatch("alpi_wait", { taskId: replacedTask }),
    error => error.code === "runtime_replaced",
  );
});

test("compact suppresses reasoning, tool arguments and queue data while raw preserves them", async t => {
  const canaries = ["REASONING_CANARY", "TOOL_ARGS_CANARY", "QUEUE_CANARY"];
  const fixture = stockWait({
    content: [
      { type: "text", text: "visible" },
      { type: "reasoning", text: "REASONING_CANARY" },
      { type: "tool-call", id: "c1", name: "t", arguments: { TOOL_ARGS_CANARY: 1 } },
    ],
  });
  fixture.state.queue = [{ content: [{ type: "text", text: "QUEUE_CANARY" }] }];
  const h = makeHarness(t, { guestOptions: { waitResult: fixture } });
  const requestId = uuid();
  await h.service.dispatch("alpi_delegate", delegateArgs(requestId));

  const waited = await h.service.dispatch("alpi_wait", { taskId: requestId });
  assert.equal(waited.snapshot.assistantText, "visible");
  assert.equal(Object.hasOwn(waited.snapshot, "completed"), false);
  assert.equal(Object.hasOwn(waited.snapshot, "success"), false);
  const compact = JSON.stringify(waited);
  for (const canary of canaries) assert.equal(compact.includes(canary), false, canary);

  // Raw is unchanged backend data and remains explicitly untrusted.
  const raw = await h.service.dispatch("alpi_wait", { taskId: requestId, format: "raw" });
  assert.equal(raw.value, fixture);
  assert.equal(raw.untrusted, true);
  assert.equal(JSON.stringify(raw.value).includes("TOOL_ARGS_CANARY"), true);
});

test("compact observation surfaces kind-only approval handoff and empty or malformed states", async t => {
  const approval = makeHarness(t, {
    guestOptions: {
      waitResult: stockWait({
        reason: "input-required", running: true, pendingInput: ["approval"], text: null,
      }),
    },
  });
  const approvalTask = uuid();
  await approval.service.dispatch("alpi_delegate", delegateArgs(approvalTask));
  const waiting = await approval.service.dispatch("alpi_wait", { taskId: approvalTask });
  assert.equal(waiting.snapshot.state, "waiting");
  assert.deepEqual(waiting.snapshot.pendingActions, [
    { kind: "approval", detailAvailable: false, resolution: "guest-ui" },
  ]);
  assert.equal(waiting.snapshot.assistantText, "");
  assert.equal(Object.hasOwn(waiting.snapshot, "actionId"), false);
  assert.equal(Object.hasOwn(waiting.snapshot, "success"), false);

  const empty = makeHarness(t, { guestOptions: { waitResult: stockWait({ text: null }) } });
  const emptyTask = uuid();
  await empty.service.dispatch("alpi_delegate", delegateArgs(emptyTask));
  const emptyWait = await empty.service.dispatch("alpi_wait", { taskId: emptyTask });
  assert.equal(emptyWait.snapshot.state, "idle");
  assert.equal(emptyWait.snapshot.assistantText, "");
  assert.deepEqual(emptyWait.snapshot.pendingActions, []);

  const malformed = makeHarness(t, { guestOptions: { waitResult: {} } });
  const malformedTask = uuid();
  await malformed.service.dispatch("alpi_delegate", delegateArgs(malformedTask));
  const unknown = await malformed.service.dispatch("alpi_wait", { taskId: malformedTask });
  assert.equal(unknown.snapshot.state, "unknown");
  assert.equal(unknown.snapshot.live, null);
  assert.equal(unknown.snapshot.cursor, null);
  assert.equal(unknown.snapshot.assistantText, "");
  assert.deepEqual(unknown.snapshot.pendingActions, []);
});

test("uncertain observation against a missing session returns a fixed safe error", async t => {
  const h = makeHarness(t, { guestOptions: { failAt: "session/create" } });
  const requestId = uuid();
  await assert.rejects(
    h.service.dispatch("alpi_delegate", delegateArgs(requestId)),
    error => error.code === "guest_failed",
  );

  const restarted = h.open({
    guest: {
      async executeGuest() { throw canaryError("guest_failed"); },
      async harnessRpc() { throw canaryError("guest-rpc-rejected"); },
    },
  });
  await assert.rejects(
    restarted.dispatch("alpi_wait", { taskId: requestId }),
    error => { assertSanitized(error, "guest_failed"); return true; },
  );
  await assert.rejects(
    restarted.dispatch("alpi_cancel", { taskId: requestId }),
    error => { assertSanitized(error, "guest_failed"); return true; },
  );
  const tasks = await restarted.dispatch("alpi_tasks", {});
  assert.equal(tasks.tasks[0].state, "uncertain");
  assert.equal(tasks.tasks[0].lastRequest.status, "uncertain");
});

test("invalid metadata is rejected before reservation and never poisons a populated journal", async t => {
  const h = makeHarness(t);
  const validId = uuid();
  await h.service.dispatch("alpi_delegate", delegateArgs(validId));
  const beforeJournal = fs.readFileSync(journalPath(h));
  const beforeTasks = (await h.service.dispatch("alpi_tasks", {})).tasks;

  // Reopen with the actual guest adapter and a synthetic driver that counts
  // every mutation attempt.
  const guest = require("../src/orchestration/guest.cjs");
  const driverCalls = [];
  const runtime = makeRuntime({
    driver: {
      async exec(...args) { driverCalls.push(args); return ""; },
    },
  });
  h.state.runtime = runtime;
  const service = h.open({ guest });
  const recovered = await service.dispatch("alpi_tasks", {});
  assert.equal(recovered.fault, false);
  assert.equal(recovered.tasks.length, 1);
  assert.equal(recovered.tasks[0].taskId, validId);

  // The shared schema accepts these control characters, but the real guest
  // adapter and the journal loader reject them.
  for (const cwd of [
    "/home/user/workspace/line\nbreak",
    "/home/user/workspace/tab\tbreak",
    "/home/user/workspace/del\x7fbreak",
  ]) {
    await assert.rejects(
      service.dispatch("alpi_delegate", delegateArgs(uuid(), { cwd })),
      error => error.code === "invalid_arguments",
      cwd,
    );
  }
  await assert.rejects(
    service.dispatch("alpi_delegate", delegateArgs(uuid(), { reasoningEffort: "high\n" })),
    error => error.code === "invalid_arguments",
  );

  // Nothing reached the runtime, guest or driver, and the existing journal is
  // byte-preserved with its prior task still recoverable.
  assert.equal(runtime.calls.withRunning.length, 0);
  assert.equal(driverCalls.length, 0);
  assert.deepEqual(fs.readFileSync(journalPath(h)), beforeJournal);
  assert.deepEqual((await service.dispatch("alpi_tasks", {})).tasks, beforeTasks);

  const reopened = h.open({ guest });
  const after = await reopened.dispatch("alpi_tasks", {});
  assert.equal(after.fault, false);
  assert.equal(after.tasks.length, 1);
  assert.equal(after.tasks[0].taskId, validId);
});

test("a failed journal write latches a fault, preserves the file and leaves stop/exec usable", async t => {
  const h = makeHarness(t);
  const target = path.join(h.root, "journal-target.json");
  fs.writeFileSync(target, JSON.stringify({ version: 1, tasks: [] }));
  fs.symlinkSync(target, journalPath(h));

  await assert.rejects(
    h.service.dispatch("alpi_delegate", delegateArgs()),
    error => error.code === "journal_unavailable",
  );
  const tasks = await h.service.dispatch("alpi_tasks", {});
  assert.deepEqual(tasks, { fault: true, tasks: [] });
  assert.equal(fs.lstatSync(journalPath(h)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify({ version: 1, tasks: [] }));

  await assert.rejects(
    h.service.dispatch("alpi_delegate", delegateArgs()),
    error => error.code === "journal_unavailable",
  );
  const stopped = await h.service.dispatch("alpi_stop", { environmentId: "env-1" });
  assert.equal(stopped.environment.id, "env-1");
  await h.service.dispatch("alpi_exec", { environmentId: "env-1", command: "true" });
  assert.deepEqual(h.state.runtime.calls.stop, ["env-1"]);
  assert.equal((await h.service.dispatch("alpi_status", {})).environments.length, 1);
});

test("a failure after atomic publication still latches and preserves the published intent", async t => {
  const h = makeHarness(t);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    realRename(from, to);
    throw Object.assign(new Error("raw disk secret"), { code: "EIO" });
  };
  try {
    await assert.rejects(
      h.service.dispatch("alpi_delegate", delegateArgs()),
      error => error.code === "journal_unavailable",
    );
  } finally {
    fs.renameSync = realRename;
  }

  const raw = fs.readFileSync(journalPath(h), "utf8");
  assert.match(raw, /"state": "preparing"/);
  const tasks = await h.service.dispatch("alpi_tasks", {});
  assert.deepEqual(tasks, { fault: true, tasks: [] });
  await assert.rejects(
    h.service.dispatch("alpi_delegate", delegateArgs()),
    error => error.code === "journal_unavailable",
  );

  const restarted = h.open({ guest: makeGuest() });
  const recovered = await restarted.dispatch("alpi_tasks", {});
  assert.equal(recovered.tasks[0].state, "uncertain");
});

test("corrupt, symlinked, FIFO and oversize journals latch without blocking verified controls", async t => {
  const corrupt = makeHarness(t);
  fs.writeFileSync(journalPath(corrupt), "{not-json-secret");
  const corruptService = corrupt.open({ guest: makeGuest() });
  assert.deepEqual(await corruptService.dispatch("alpi_tasks", {}), { fault: true, tasks: [] });
  await corruptService.dispatch("alpi_stop", { environmentId: "env-1" });
  await corruptService.dispatch("alpi_exec", { environmentId: "env-1", command: "true" });

  const linked = makeHarness(t);
  const target = path.join(linked.root, "valid.json");
  fs.writeFileSync(target, JSON.stringify({ version: 1, tasks: [] }));
  fs.symlinkSync(target, journalPath(linked));
  const linkedService = linked.open({ guest: makeGuest() });
  assert.deepEqual(await linkedService.dispatch("alpi_tasks", {}), { fault: true, tasks: [] });

  const fifo = makeHarness(t);
  try {
    await execFileAsync("mkfifo", [journalPath(fifo)]);
  } catch {
    t.diagnostic("mkfifo is unavailable; FIFO journal case skipped");
  }
  if (fs.existsSync(journalPath(fifo))) {
    const fifoService = fifo.open({ guest: makeGuest() });
    assert.deepEqual(await fifoService.dispatch("alpi_tasks", {}), { fault: true, tasks: [] });
  }

  const oversized = makeHarness(t);
  fs.writeFileSync(journalPath(oversized), Buffer.alloc(MAX_JOURNAL_BYTES + 1, 120));
  const oversizedService = oversized.open({ guest: makeGuest() });
  assert.deepEqual(await oversizedService.dispatch("alpi_tasks", {}), { fault: true, tasks: [] });
});

test("task and request capacity errors are explicit and never delete history", async t => {
  const tasksHarness = makeHarness(t);
  const ids = [];
  for (let index = 0; index < 256; index += 1) {
    const requestId = uuid();
    ids.push(requestId);
    await tasksHarness.service.dispatch("alpi_delegate",
      delegateArgs(requestId, { prompt: `task ${index}` }));
  }
  await assert.rejects(
    tasksHarness.service.dispatch("alpi_delegate", delegateArgs(uuid(), { prompt: "overflow" })),
    error => error.code === "capacity",
  );
  const kept = await tasksHarness.service.dispatch("alpi_tasks", {});
  assert.equal(kept.tasks.length, 256);
  assert.equal(kept.tasks[0].taskId, ids[0]);

  const requestsHarness = makeHarness(t);
  const taskId = uuid();
  await requestsHarness.service.dispatch("alpi_delegate", delegateArgs(taskId));
  for (let index = 0; index < 63; index += 1) {
    await requestsHarness.service.dispatch("alpi_send", {
      taskId, prompt: `follow ${index}`, requestId: uuid(),
    });
  }
  await assert.rejects(
    requestsHarness.service.dispatch("alpi_send", {
      taskId, prompt: "overflow", requestId: uuid(),
    }),
    error => error.code === "capacity",
  );
  const task = (await requestsHarness.service.dispatch("alpi_tasks", {})).tasks[0];
  assert.equal(task.requestCount, 64);
  assert.equal(task.lastRequest.status, "submitted");
});

test("wrong ownership and runtime replacement reject before any guest mutation or success write", async t => {
  const h = makeHarness(t);
  const requestId = uuid();
  await h.service.dispatch("alpi_delegate", delegateArgs(requestId));

  h.state.runtime = makeRuntime({ token: "different-owner" });
  const before = h.guest.calls.length;
  await assert.rejects(
    h.service.dispatch("alpi_send", { taskId: requestId, prompt: "nope", requestId: uuid() }),
    error => error.code === "ownership_mismatch",
  );
  await assert.rejects(
    h.service.dispatch("alpi_wait", { taskId: requestId }),
    error => error.code === "ownership_mismatch",
  );
  await assert.rejects(
    h.service.dispatch("alpi_cancel", { taskId: requestId }),
    error => error.code === "ownership_mismatch",
  );
  assert.equal(h.guest.calls.length, before);

  const swapped = makeHarness(t, {
    guestOptions: {
      onCall: ({ method }, state) => {
        if (method === "session/prompt") state.runtime = makeRuntime({ token: "token-2" });
      },
    },
  });
  const swapRequest = uuid();
  await assert.rejects(
    swapped.service.dispatch("alpi_delegate", delegateArgs(swapRequest)),
    error => error.code === "runtime_replaced",
  );
  const pending = await swapped.service.dispatch("alpi_tasks", {});
  assert.equal(pending.tasks[0].state, "preparing");
  const restarted = swapped.open({ guest: makeGuest() });
  assert.equal((await restarted.dispatch("alpi_tasks", {})).tasks[0].state, "uncertain");

  const execSwap = makeHarness(t, {
    guestOptions: {
      onExec: (context, state) => { state.runtime = makeRuntime({ token: "token-2" }); },
    },
  });
  await assert.rejects(
    execSwap.service.dispatch("alpi_exec", { environmentId: "env-1", command: "true" }),
    error => error.code === "runtime_replaced",
  );

  let startHarness;
  startHarness = makeHarness(t, {
    runtimeOptions: { onStart: () => { startHarness.state.runtime = makeRuntime({ token: "token-2" }); } },
  });
  await assert.rejects(
    startHarness.service.dispatch("alpi_start", { environmentId: "env-1" }),
    error => error.code === "runtime_replaced",
  );
});

test("caller abort and close reject late success without recording a submitted request", async t => {
  const abortGate = deferred();
  const abortEntered = deferred();
  const abortHarness = makeHarness(t, {
    guestOptions: {
      block: { method: "session/prompt", promise: abortGate.promise },
      onCall: ({ method }) => { if (method === "session/prompt") abortEntered.resolve(); },
    },
  });
  const controller = new AbortController();
  const requestId = uuid();
  const pending = abortHarness.service.dispatch("alpi_delegate", delegateArgs(requestId),
    { signal: controller.signal });
  await abortEntered.promise;
  controller.abort();
  abortGate.resolve();
  await assert.rejects(pending, error => error.code === "aborted");
  const abortedTasks = await abortHarness.service.dispatch("alpi_tasks", {});
  assert.equal(abortedTasks.tasks[0].state, "uncertain");
  assert.equal(abortedTasks.tasks[0].lastRequest.status, "uncertain");
  const restarted = abortHarness.open({ guest: makeGuest() });
  assert.equal((await restarted.dispatch("alpi_tasks", {})).tasks[0].state, "uncertain");

  const closeGate = deferred();
  const closeEntered = deferred();
  const closeHarness = makeHarness(t, {
    guestOptions: {
      block: { method: "session/prompt", promise: closeGate.promise },
      onCall: ({ method }) => { if (method === "session/prompt") closeEntered.resolve(); },
    },
  });
  const closing = closeHarness.service.dispatch("alpi_delegate", delegateArgs(uuid()));
  await closeEntered.promise;
  await closeHarness.service.close();
  closeGate.resolve();
  await assert.rejects(closing, error => error.code === "closing");
  await assert.rejects(
    closeHarness.service.dispatch("alpi_status", {}),
    error => error.code === "closing",
  );
  await assert.rejects(
    closeHarness.service.dispatch("alpi_tasks", {}),
    error => error.code === "closing",
  );
});

test("admission is fail-fast while status and tasks reads remain available", async t => {
  const gate = deferred();
  const entered = deferred();
  const h = makeHarness(t, {
    guestOptions: {
      block: { method: "session/prompt", promise: gate.promise },
      onCall: ({ method }) => { if (method === "session/prompt") entered.resolve(); },
    },
  });
  const pending = h.service.dispatch("alpi_delegate", delegateArgs());
  await entered.promise;

  await assert.rejects(
    h.service.dispatch("alpi_exec", { environmentId: "env-1", command: "true" }),
    error => error.code === "busy",
  );
  assert.equal((await h.service.dispatch("alpi_status", {})).environments.length, 1);
  const tasks = await h.service.dispatch("alpi_tasks", {});
  assert.equal(tasks.tasks[0].state, "preparing");

  gate.resolve();
  await pending;
  await h.service.dispatch("alpi_exec", { environmentId: "env-1", command: "true" });
});

test("imports and exports are validated and reject unknown tools", async t => {
  const h = makeHarness(t);
  await assert.rejects(
    h.service.dispatch("alpi_import", {
      environmentId: "env-1", source: "/tmp/source", guestParent: "/home/user/workspace", name: "copy",
    }),
    error => error.code === "runtime_unavailable",
  );
  await assert.rejects(
    h.service.dispatch("alpi_export", {
      environmentId: "env-1", source: "/home/user/workspace/copy", hostParent: "/tmp", name: "copy",
    }),
    error => error.code === "runtime_unavailable",
  );
  await assert.rejects(
    h.service.dispatch("alpi_missing", {}),
    error => error.code === "unknown_tool",
  );
  await assert.rejects(
    h.service.dispatch("alpi_status", { extra: true }),
    error => error.code === "invalid_arguments",
  );
  await assert.rejects(
    h.service.dispatch("alpi_import", {
      environmentId: "env-1", source: "/tmp/source", guestParent: "/home/user/workspace",
    }),
    error => error.code === "invalid_arguments",
  );
  await assert.rejects(
    h.service.dispatch("alpi_export", {
      environmentId: "env-1", source: "/home/user/workspace/copy", name: "copy",
    }),
    error => error.code === "invalid_arguments",
  );
  assert.deepEqual(h.state.runtime.calls.start, []);
  assert.equal(h.guest.calls.length, 0);
});

function importArgs(overrides = {}) {
  return {
    environmentId: "env-1",
    source: "/tmp/source",
    guestParent: "/home/user/workspace",
    name: "copy",
    ...overrides,
  };
}

function exportArgs(overrides = {}) {
  return {
    environmentId: "env-1",
    source: "/home/user/workspace/copy",
    hostParent: "/tmp/host",
    name: "copy",
    ...overrides,
  };
}

// The real FileTransfers manager and journal are exercised below. Only the VM
// driver and the local/remote byte channels are synthetic; plan, journal,
// ownership and commit/discard transitions are the production implementation.
function transferJournalRecord(overrides = {}) {
  return {
    id: uuid(),
    environmentId: "env-1",
    direction: "import",
    destination: "/home/user/workspace/interrupted",
    transaction: "b".repeat(64),
    ownershipToken: uuid(),
    phase: "receiving",
    createdAt: Date.now(),
    ...overrides,
  };
}

function seedTransferJournal(h, records) {
  fs.writeFileSync(path.join(h.root, "file-transfers.json"),
    JSON.stringify({ version: 1, operations: records }));
}

function transferJournal(h) {
  return JSON.parse(fs.readFileSync(path.join(h.root, "file-transfers.json"), "utf8"));
}

function syntheticChannel(chunks) {
  const input = new Writable({
    write(chunk, encoding, callback) { callback(); },
  });
  const output = (async function* () {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
  return { input, output, done: Promise.resolve(), stop() {} };
}

function transferDriver({ exec, putFile } = {}) {
  return {
    launch: "synthetic-launch",
    async exec() { return "no"; },
    async putFile() {},
    async requireOwned() {},
    ...(exec ? { exec } : {}),
    ...(putFile ? { putFile } : {}),
  };
}

function makeRealTransfers(h, { token = uuid(), driver = transferDriver() } = {}) {
  const runtime = makeRuntime({ token, driver });
  const transfers = new FileTransfers({
    coordinator: runtime.coordinator,
    stateRoot: h.root,
    runtimeRoot: path.join(h.root, "runtime"),
    home: path.join(h.root, "home"),
    python: "/usr/bin/python3",
    helper: path.join(__dirname, "..", "src", "runtime", "file-stream.py"),
    protectedPaths: [],
  });
  runtime.transfers = transfers;
  h.state.runtime = runtime;
  return { runtime, transfers, token, driver };
}

function transferSource(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "alpi-transfer-source-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "file.txt"), "hello");
  return directory;
}

function scanSummary(entries = 1, bytes = 5) {
  return syntheticChannel([JSON.stringify({ type: "summary", entries, bytes })]);
}

test("successful import and export return only verified receipt metadata", async t => {
  const importFake = new FakeTransfers({ entries: 3, bytes: 42 });
  const importHarness = makeHarness(t, { transfers: importFake });
  const imported = await importHarness.service.dispatch("alpi_import", importArgs());
  assert.deepEqual(importFake.calls.prepareImport, [{
    environmentId: "env-1", source: "/tmp/source",
    guestParent: "/home/user/workspace", name: "copy",
  }]);
  assert.equal(importFake.calls.execute.length, 1);
  assert.deepEqual(imported, {
    direction: "import",
    destination: "/home/user/workspace/copy",
    contentRoot: "/home/user/workspace/copy/source",
    state: "complete",
    entries: 3,
    bytes: 42,
  });
  assert.deepEqual(Object.keys(imported).sort(),
    ["bytes", "contentRoot", "destination", "direction", "entries", "state"]);
  assert.equal(importFake.plans.size, 0);
  assert.equal(importFake.active, undefined);
  // FileTransfers acquires the coordinator queue itself for prepare and execute.
  // The service must not add a third withRunning wrapper around the operation.
  assert.equal(importFake.calls.withRunning, 2);
  assert.equal(importHarness.state.runtime.calls.withRunning.length, 2);

  const exportFake = new FakeTransfers({ entries: 1, bytes: 5 });
  const exportHarness = makeHarness(t, { transfers: exportFake });
  const exported = await exportHarness.service.dispatch("alpi_export", exportArgs());
  assert.deepEqual(exportFake.calls.prepareExport, [{
    environmentId: "env-1", source: "/home/user/workspace/copy",
    hostParent: "/tmp/host", name: "copy",
  }]);
  assert.equal(exportFake.calls.execute.length, 1);
  assert.deepEqual(exported, {
    direction: "export",
    destination: "/tmp/host/copy",
    contentRoot: "/tmp/host/copy/copy",
    state: "complete",
    entries: 1,
    bytes: 5,
    untrusted: true,
  });
  assert.equal(exportFake.plans.size, 0);
  assert.equal(exportFake.active, undefined);
});

test("transfer collisions and non-complete snapshots are never receipts", async t => {
  const collisionFake = new FakeTransfers({ collision: true });
  const collisionHarness = makeHarness(t, { transfers: collisionFake });
  await assert.rejects(
    collisionHarness.service.dispatch("alpi_import", importArgs()),
    error => error.code === "transfer_collision",
  );
  assert.equal(collisionFake.calls.execute.length, 0);
  assert.equal(collisionFake.calls.cancel, 1);
  assert.equal(collisionFake.plans.size, 0);

  for (const [state, code] of [["error", "operation_failed"],
    ["running", "operation_failed"], ["cancelled", "aborted"]]) {
    const fake = new FakeTransfers({ executeState: state });
    const harness = makeHarness(t, { transfers: fake });
    await assert.rejects(
      harness.service.dispatch("alpi_import", importArgs()),
      error => error.code === code,
      state,
    );
    assert.equal(fake.calls.execute.length, 1, state);
    assert.equal(fake.plans.size, 0, state);
    assert.equal(fake.active, undefined, state);
  }
});

test("an existing UI preview, active transfer or busy state is never cleared or cancelled", async t => {
  const previewFake = new FakeTransfers();
  const previewPlan = previewFake.addUiPreview("ui-preview");
  const previewHarness = makeHarness(t, { transfers: previewFake });
  await assert.rejects(
    previewHarness.service.dispatch("alpi_import", importArgs()),
    error => error.code === "busy",
  );
  assert.equal(previewFake.calls.prepareImport.length, 0);
  assert.equal(previewFake.calls.cancel, 0);
  assert.equal(previewFake.plans.get(previewPlan.id), previewPlan);
  assert.equal(previewFake.status.state, "preview");

  const activeFake = new FakeTransfers();
  const activeController = new AbortController();
  activeFake.active = activeController;
  const activeHarness = makeHarness(t, { transfers: activeFake });
  await assert.rejects(
    activeHarness.service.dispatch("alpi_export", exportArgs()),
    error => error.code === "busy",
  );
  assert.equal(activeFake.active, activeController);
  assert.equal(activeFake.calls.prepareExport.length, 0);
  assert.equal(activeFake.calls.cancel, 0);

  const runningFake = new FakeTransfers();
  runningFake.status = { state: "running" };
  const runningHarness = makeHarness(t, { transfers: runningFake });
  await assert.rejects(
    runningHarness.service.dispatch("alpi_import", importArgs()),
    error => error.code === "busy",
  );
  assert.equal(runningFake.calls.prepareImport.length, 0);
  assert.equal(runningFake.calls.cancel, 0);
});

test("a pre-aborted transfer never prepares or cancels anything", async t => {
  const fake = new FakeTransfers();
  const h = makeHarness(t, { transfers: fake });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal }),
    error => error.code === "aborted",
  );
  assert.equal(fake.calls.prepareImport.length, 0);
  assert.equal(fake.calls.prepareExport.length, 0);
  assert.equal(fake.calls.execute.length, 0);
  assert.equal(fake.calls.cancel, 0);
  assert.equal(fake.plans.size, 0);
});

test("abort during preview cleans only the owned preview", async t => {
  const gate = deferred();
  const entered = deferred();
  const fake = new FakeTransfers({ prepareGate: gate.promise, prepareEntered: entered });
  const h = makeHarness(t, { transfers: fake });
  const controller = new AbortController();
  const pending = h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, error => error.code === "aborted");
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.calls.execute.length, 0);
  assert.equal(fake.plans.size, 0);
  assert.equal(fake.active, undefined);
});

test("abort during execute cancels the owned operation and never reports success", async t => {
  const gate = deferred();
  const entered = deferred();
  const fake = new FakeTransfers({ executeGate: gate.promise, executeEntered: entered });
  const h = makeHarness(t, { transfers: fake });
  const controller = new AbortController();
  const pending = h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, error => error.code === "aborted");
  assert.equal(fake.calls.execute.length, 1);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.plans.size, 0);
  assert.equal(fake.active, undefined);
});

test("a failing cancellation is sanitized and never turns an abort into success", async t => {
  const gate = deferred();
  const entered = deferred();
  const fake = new FakeTransfers({ executeGate: gate.promise, executeEntered: entered });
  fake.cancel = () => {
    fake.calls.cancel += 1;
    throw canaryError("operation_failed");
  };
  const h = makeHarness(t, { transfers: fake });
  const controller = new AbortController();
  const pending = h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, error => {
    assertSanitized(error, "aborted");
    return true;
  });
  assert.equal(fake.calls.execute.length, 1);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.active, undefined);
});

test("abort between preview and execute releases the owned preview", async t => {
  let controller;
  const fake = new FakeTransfers({ onPreview: () => controller.abort() });
  const h = makeHarness(t, { transfers: fake });
  controller = new AbortController();
  await assert.rejects(
    h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal }),
    error => error.code === "aborted",
  );
  assert.equal(fake.calls.execute.length, 0);
  assert.equal(fake.calls.cancel, 1);
  assert.equal(fake.plans.size, 0);
  assert.equal(fake.active, undefined);
});

test("caller cancellation stays authoritative over a typed failure that races it", async t => {
  const gate = deferred();
  const entered = deferred();
  const fake = new FakeTransfers({
    prepareGate: gate.promise,
    prepareEntered: entered,
    prepareError: canaryError("transfer_path_refused"),
  });
  const h = makeHarness(t, { transfers: fake });
  const controller = new AbortController();
  const pending = h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, error => {
    assertSanitized(error, "aborted");
    return true;
  });
  assert.equal(fake.calls.execute.length, 0);
  assert.equal(fake.plans.size, 0);
  assert.equal(fake.active, undefined);
});

test("a late abort after settle does not cancel a later UI preview", async t => {
  const fake = new FakeTransfers();
  const h = makeHarness(t, { transfers: fake });
  const controller = new AbortController();
  await h.service.dispatch("alpi_import", importArgs(), { signal: controller.signal });
  const cancelBefore = fake.calls.cancel;
  const uiPlan = fake.addUiPreview("later-ui-preview");
  controller.abort();
  await Promise.resolve();
  assert.equal(fake.calls.cancel, cancelBefore);
  assert.equal(fake.plans.has(uiPlan.id), true);
  assert.equal(fake.status.state, "preview");
});

test("runtime replacement after preview releases the old preview and never executes on the replacement", async t => {
  const replacement = new FakeTransfers();
  let h;
  const oldFake = new FakeTransfers({
    onPreview: () => { h.state.runtime = makeRuntime({ token: "token-2", transfers: replacement }); },
  });
  h = makeHarness(t, { transfers: oldFake });
  await assert.rejects(
    h.service.dispatch("alpi_import", importArgs()),
    error => error.code === "runtime_replaced",
  );
  assert.equal(oldFake.calls.execute.length, 0);
  assert.equal(oldFake.calls.cancel, 1);
  assert.equal(oldFake.plans.size, 0);
  assert.equal(oldFake.active, undefined);
  assert.equal(replacement.calls.prepareImport.length, 0);
  assert.equal(replacement.calls.execute.length, 0);
});

test("runtime replacement after execute rejects stale success without touching the replacement", async t => {
  const replacement = new FakeTransfers();
  let h;
  const fake = new FakeTransfers({
    onExecute: () => { h.state.runtime = makeRuntime({ token: "token-2", transfers: replacement }); },
  });
  h = makeHarness(t, { transfers: fake });
  await assert.rejects(
    h.service.dispatch("alpi_import", importArgs()),
    error => error.code === "runtime_replaced",
  );
  assert.equal(fake.calls.execute.length, 1);
  assert.equal(fake.status.state, "complete");
  assert.equal(replacement.calls.execute.length, 0);
  assert.equal(replacement.calls.cancel, 0);
});

test("transfer failures are rebuilt as fixed safe errors and never recover or discard output", async t => {
  const fake = new FakeTransfers();
  const h = makeHarness(t, { transfers: fake });
  fake.execute = async () => {
    fake.plans.clear();
    throw canaryError("operation_failed");
  };
  await assert.rejects(
    h.service.dispatch("alpi_export", exportArgs()),
    error => {
      assertSanitized(error, "operation_failed");
      return true;
    },
  );
  // The service never invokes recover/discard/forget; the transfer journal keeps
  // any partial output for explicit user recovery.
  assert.equal(fake.calls.recover, 0);
  assert.equal(fake.calls.cancel, 0);
  assert.equal(fake.plans.size, 0);
});

test("a task journal fault does not block transfers, while a transfer journal fault does", async t => {
  const healthy = new FakeTransfers();
  const healthyHarness = makeHarness(t, { transfers: healthy });
  fs.writeFileSync(journalPath(healthyHarness), "{corrupt-task-journal-secret");
  const faultedTasks = healthyHarness.open({ guest: makeGuest() });
  const receipt = await faultedTasks.dispatch("alpi_import", importArgs());
  assert.equal(receipt.state, "complete");
  assert.equal(healthy.calls.prepareImport.length, 1);
  assert.deepEqual(await faultedTasks.dispatch("alpi_tasks", {}), { fault: true, tasks: [] });

  const broken = new FakeTransfers({ journalFault: true });
  const brokenHarness = makeHarness(t, { transfers: broken });
  await assert.rejects(
    brokenHarness.service.dispatch("alpi_export", exportArgs()),
    error => error.code === "transfer_unavailable",
  );
  assert.equal(broken.calls.prepareExport.length, 0);
  assert.equal(broken.calls.execute.length, 0);
  assert.equal(broken.calls.cancel, 0);
});

test("the real transfer journal refuses capacity without discarding interrupted records", async t => {
  const h = makeHarness(t);
  const records = Array.from({ length: 100 }, () => transferJournalRecord());
  seedTransferJournal(h, records);
  const source = transferSource(t);
  const { transfers } = makeRealTransfers(h);
  transfers.local = mode => {
    if (mode !== "scan") throw new Error("unexpected local mode");
    return scanSummary();
  };

  const before = fs.readFileSync(path.join(h.root, "file-transfers.json"));
  await assert.rejects(
    h.open().dispatch("alpi_import", importArgs({ source })),
    error => error.code === "operation_failed",
  );
  assert.deepEqual(fs.readFileSync(path.join(h.root, "file-transfers.json")), before);
  assert.equal(transferJournal(h).operations.length, 100);
  assert.equal(transfers.plans.size, 0);
  assert.equal(transfers.active, undefined);
});

test("a late abort during preview preserves an older interrupted transfer record", async t => {
  const h = makeHarness(t);
  const older = transferJournalRecord();
  seedTransferJournal(h, [older]);
  const source = transferSource(t);
  const controller = new AbortController();
  const { transfers } = makeRealTransfers(h, {
    driver: transferDriver({ exec: async () => { controller.abort(); return "no"; } }),
  });
  transfers.local = mode => {
    if (mode !== "scan") throw new Error("unexpected local mode");
    return scanSummary();
  };

  const before = fs.readFileSync(path.join(h.root, "file-transfers.json"));
  await assert.rejects(
    h.open().dispatch("alpi_import", importArgs({ source }), { signal: controller.signal }),
    error => error.code === "aborted",
  );
  assert.deepEqual(fs.readFileSync(path.join(h.root, "file-transfers.json")), before);
  const journal = transferJournal(h);
  assert.equal(journal.operations.length, 1);
  assert.equal(journal.operations[0].id, older.id);
  assert.equal(transfers.plans.size, 0);
  assert.equal(transfers.active, undefined);
  assert.equal(transfers.status.state, "cancelled");
});

test("the real transfer execute/commit returns a receipt and removes only its own journal record", async t => {
  const h = makeHarness(t);
  const older = transferJournalRecord();
  seedTransferJournal(h, [older]);
  const source = transferSource(t);
  const { transfers } = makeRealTransfers(h);
  transfers.local = mode => {
    if (mode === "scan") return scanSummary();
    if (mode === "send") return syntheticChannel(["hello"]);
    throw new Error("unexpected local mode");
  };
  transfers.remote = (driver, mode, target, options, plan) => {
    if (mode === "receive") {
      return syntheticChannel([
        `${JSON.stringify({ type: "complete", entries: plan.entries, bytes: plan.bytes })}\n`,
      ]);
    }
    if (mode === "commit") return syntheticChannel([JSON.stringify({ type: "committed" })]);
    throw new Error("unexpected remote mode");
  };

  const receipt = await h.open().dispatch("alpi_import", importArgs({ source }));
  assert.deepEqual(receipt, {
    direction: "import",
    destination: "/home/user/workspace/copy",
    contentRoot: `/home/user/workspace/copy/${path.basename(source)}`,
    state: "complete",
    entries: 1,
    bytes: 5,
  });
  const journal = transferJournal(h);
  assert.equal(journal.operations.length, 1);
  assert.equal(journal.operations[0].id, older.id);
  assert.equal(transfers.plans.size, 0);
  assert.equal(transfers.active, undefined);
  assert.equal(transfers.status.state, "complete");
});

test("malformed preview metadata is refused with no receipt, execute or stale plan", async t => {
  const cases = [
    { omitContentRoot: true },
    { contentRoot: "/home/user/workspace/copy" },
    { contentRoot: "/home/user/workspace/copy/nested/child" },
    { contentRoot: "/home/user/workspace/copy/../escape" },
    { contentRoot: "/home/user/workspace/other/child" },
    { contentRoot: "/home/user/workspace/copy/" },
    { contentRoot: "/home/user/workspace/copy/." },
    { contentRoot: "/home/user/workspace/copy/.." },
    { contentRoot: "/home/user/workspace/copy/a\\b" },
    { contentRoot: "/home/user/workspace/copy/bad\u0001name" },
    { contentRoot: 42 },
  ];
  for (const options of cases) {
    const fake = new FakeTransfers(options);
    const h = makeHarness(t, { transfers: fake });
    await assert.rejects(
      h.service.dispatch("alpi_import", importArgs()),
      error => error.code === "transfer_preview_failed",
      JSON.stringify(options),
    );
    assert.equal(fake.calls.execute.length, 0, JSON.stringify(options));
    assert.equal(fake.calls.cancel, 1, JSON.stringify(options));
    assert.equal(fake.plans.size, 0, JSON.stringify(options));
    assert.equal(fake.active, undefined, JSON.stringify(options));
  }

  const exportFake = new FakeTransfers({ contentRoot: "/tmp/host/copy/nested/copy" });
  const exportHarness = makeHarness(t, { transfers: exportFake });
  await assert.rejects(
    exportHarness.service.dispatch("alpi_export", exportArgs()),
    error => error.code === "transfer_preview_failed",
  );
  assert.equal(exportFake.calls.execute.length, 0);
  assert.equal(exportFake.plans.size, 0);

  // A preview that claims the other direction is refused, not turned into a
  // receipt with the wrong untrusted/guest semantics.
  const wrongDirection = new FakeTransfers({ previewDirection: "export" });
  const wrongHarness = makeHarness(t, { transfers: wrongDirection });
  await assert.rejects(
    wrongHarness.service.dispatch("alpi_import", importArgs()),
    error => error.code === "transfer_preview_failed",
  );
  assert.equal(wrongDirection.calls.execute.length, 0);
  assert.equal(wrongDirection.plans.size, 0);
});

test("typed transfer failures are rebuilt as fresh fixed errors, unknown codes are not", async t => {
  for (const code of ["transfer_path_refused", "transfer_collision", "transfer_preview_failed"]) {
    const fake = new FakeTransfers();
    const h = makeHarness(t, { transfers: fake });
    fake.execute = async () => { fake.plans.clear(); throw canaryError(code); };
    await assert.rejects(
      h.service.dispatch("alpi_export", exportArgs()),
      error => { assertSanitized(error, code); return true; },
      code,
    );
    assert.equal(fake.calls.recover, 0, code);
    assert.equal(fake.plans.size, 0, code);
  }

  // An arbitrary dependency-supplied code is never promoted to a safe category.
  const fake = new FakeTransfers();
  const h = makeHarness(t, { transfers: fake });
  fake.execute = async () => { fake.plans.clear(); throw canaryError("transfer_unknown_guess"); };
  await assert.rejects(
    h.service.dispatch("alpi_export", exportArgs()),
    error => { assertSanitized(error, "operation_failed"); return true; },
  );
});

test("the real manager reports a directory export contentRoot inside the host container", async t => {
  const h = makeHarness(t);
  const hostParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "alpi-transfer-export-")));
  t.after(() => fs.rmSync(hostParent, { recursive: true, force: true }));
  const { transfers } = makeRealTransfers(h);
  transfers.local = mode => {
    if (mode === "receive") {
      return syntheticChannel([
        `${JSON.stringify({ type: "complete", entries: 2, bytes: 9 })}\n`,
      ]);
    }
    if (mode === "commit") return syntheticChannel([JSON.stringify({ type: "committed" })]);
    throw new Error("unexpected local mode");
  };
  transfers.remote = (driver, mode, target, options, plan) => {
    if (mode === "scan") return scanSummary(2, 9);
    if (mode === "send") return syntheticChannel([]);
    throw new Error("unexpected remote mode");
  };

  const receipt = await h.open().dispatch("alpi_export",
    exportArgs({ source: "/home/user/workspace/my project", hostParent }));
  assert.deepEqual(receipt, {
    direction: "export",
    destination: path.join(hostParent, "copy"),
    contentRoot: path.join(hostParent, "copy", "my project"),
    state: "complete",
    entries: 2,
    bytes: 9,
    untrusted: true,
  });
  assert.equal(transfers.plans.size, 0);
  assert.equal(transfers.active, undefined);
});

test("the real manager refuses protected import sources as transfer_path_refused", async t => {
  const h = makeHarness(t);
  const { transfers } = makeRealTransfers(h);
  const protectedSource = path.join(h.root, "private-source");
  fs.mkdirSync(protectedSource);
  await assert.rejects(
    h.open().dispatch("alpi_import", importArgs({ source: protectedSource })),
    error => { assertSanitized(error, "transfer_path_refused"); return true; },
  );
  assert.equal(transfers.plans.size, 0);
  assert.equal(transfers.active, undefined);
  assert.equal(transfers.calls?.execute?.length ?? 0, 0);
});

test("cancelling a real transfer execute yields no receipt and keeps only older journal records", async t => {
  const h = makeHarness(t);
  const older = transferJournalRecord();
  seedTransferJournal(h, [older]);
  const source = transferSource(t);
  const { transfers } = makeRealTransfers(h);
  const gate = deferred();
  const entered = deferred();
  transfers.local = mode => {
    if (mode === "scan") return scanSummary();
    if (mode === "send") return syntheticChannel(["hello"]);
    if (mode === "discard") return syntheticChannel([JSON.stringify({ type: "discarded" })]);
    throw new Error("unexpected local mode");
  };
  transfers.remote = (driver, mode, target, options, plan) => {
    if (mode === "receive") {
      entered.resolve();
      const channel = syntheticChannel([]);
      channel.output = (async function* () {
        await gate.promise;
        yield Buffer.from(`${JSON.stringify({ type: "complete", entries: plan.entries, bytes: plan.bytes })}\n`);
      })();
      return channel;
    }
    if (mode === "discard") return syntheticChannel([JSON.stringify({ type: "discarded" })]);
    throw new Error("unexpected remote mode");
  };

  const controller = new AbortController();
  const pending = h.open().dispatch("alpi_import", importArgs({ source }), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, error => error.code === "aborted");
  const journal = transferJournal(h);
  assert.equal(journal.operations.length, 1);
  assert.equal(journal.operations[0].id, older.id);
  assert.equal(transfers.plans.size, 0);
  assert.equal(transfers.active, undefined);
  assert.equal(transfers.status.state, "cancelled");
});

test("known dependency errors are rebuilt as fresh safe errors", async t => {
  const guestHarness = makeHarness(t, {
    guest: {
      async executeGuest() { throw canaryError("guest_failed"); },
      async harnessRpc() { throw canaryError("guest_failed"); },
    },
  });
  await assert.rejects(
    guestHarness.service.dispatch("alpi_exec", { environmentId: "env-1", command: "true" }),
    error => { assertSanitized(error, "guest_failed"); return true; },
  );

  const runtime = makeRuntime();
  runtime.coordinator.start = async () => { throw canaryError("runtime_unavailable"); };
  const coordinatorHarness = makeHarness(t, { runtime });
  await assert.rejects(
    coordinatorHarness.service.dispatch("alpi_start", { environmentId: "env-1" }),
    error => { assertSanitized(error, "runtime_unavailable"); return true; },
  );

  const exclusiveHarness = makeHarness(t, {
    runExclusive: async () => { throw canaryError("operation_failed"); },
  });
  await assert.rejects(
    exclusiveHarness.service.dispatch("alpi_exec", { environmentId: "env-1", command: "true" }),
    error => { assertSanitized(error, "operation_failed"); return true; },
  );

  const validationHarness = makeHarness(t);
  await assert.rejects(
    validationHarness.service.dispatch("alpi_status", { extra: true }),
    error => { assertSanitized(error, "invalid_arguments"); return true; },
  );
});

test("a maximum-capacity journal yields a bounded summary with every task handle", async t => {
  const h = makeHarness(t);
  const stamp = "2026-01-01T00:00:00.000Z";
  const cwd = `/${"a".repeat(4095)}`;
  const provider = "p".repeat(128);
  const model = "m".repeat(256);
  const ownershipToken = "t".repeat(256);
  const environmentId = "e".repeat(64);
  const digest = "a".repeat(64);
  const hex = value => value.toString(16).padStart(12, "0");
  const taskId = index => `00000001-0000-4000-8000-${hex(index)}`;
  const sessionId = index => `00000002-0000-4000-8000-${hex(index)}`;
  const requestId = index => `00000003-0000-4000-8000-${hex(index)}`;

  const tasks = [];
  for (let index = 0; index < 256; index += 1) {
    const requests = [];
    for (let offset = 0; offset < 64; offset += 1) {
      requests.push({
        requestId: offset === 0 ? taskId(index) : requestId(index * 64 + offset),
        fingerprint: digest,
        status: "submitted",
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    tasks.push({
      taskId: taskId(index),
      environmentId,
      sessionId: sessionId(index),
      cwd,
      provider,
      model,
      ownershipToken,
      createdAt: stamp,
      updatedAt: stamp,
      state: "submitted",
      requests,
    });
  }
  fs.writeFileSync(journalPath(h), JSON.stringify({ version: 1, tasks }));
  assert.ok(fs.statSync(journalPath(h)).size < MAX_JOURNAL_BYTES);

  const service = h.open({ guest: makeGuest() });
  const summary = await service.dispatch("alpi_tasks", {});
  assert.equal(summary.fault, false);
  assert.equal(summary.tasks.length, 256);

  const serialized = JSON.stringify(summary);
  // 256 tasks with one latest-request pointer each is roughly 200 KiB of JSON;
  // a 512 KiB bound leaves comfortable headroom below the 2 MiB transport and
  // 4 MiB MCP double-escape limits even at the 8 MiB journal cap.
  assert.ok(Buffer.byteLength(serialized, "utf8") < 512 * 1024);
  assert.equal(serialized.includes(cwd), false);
  assert.equal(serialized.includes(ownershipToken), false);
  assert.equal(serialized.includes(digest), false);

  const handles = new Set(summary.tasks.map(task => task.taskId));
  for (let index = 0; index < 256; index += 1) {
    assert.equal(handles.has(taskId(index)), true, `missing task ${index}`);
  }
  for (const task of summary.tasks) {
    assert.equal(task.requestCount, 64);
    assert.equal(Object.hasOwn(task, "cwd"), false);
    assert.equal(Object.hasOwn(task, "requests"), false);
    assert.equal(Object.hasOwn(task, "ownershipToken"), false);
    assert.equal(typeof task.lastRequest.requestId, "string");
    assert.equal(task.lastRequest.status, "submitted");
  }
  assert.equal(summary.tasks[0].lastRequest.requestId, requestId(63));
  assert.equal(summary.tasks[255].lastRequest.requestId, requestId(255 * 64 + 63));
});
