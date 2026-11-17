// Trusted host orchestration service. It dispatches a fixed set of validated
// tool calls into the existing protected runtime. It owns no runtime, model
// catalog, credential or VM driver: those are injected by the main process.
// Guest output is untrusted data; task records are host intent metadata, never
// proof that guest work ran or succeeded.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { writeJson } = require("../runtime/atomic-json.cjs");
const { validateCall } = require("./tools.cjs");

const MAX_TASKS = 256;
const MAX_REQUESTS = 64;
// The caps above bound the journal; 8 MiB leaves room for the pretty-printed
// worst case (256 tasks with 64 requests each and maximum-length paths).
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

const TASK_STATES = new Set(["preparing", "submitted", "uncertain"]);
const REQUEST_STATES = new Set(["preparing", "submitted", "uncertain"]);
const TASK_KEYS = ["taskId", "environmentId", "sessionId", "cwd", "provider", "model",
  "ownershipToken", "createdAt", "updatedAt", "state", "requests"];
const REQUEST_KEYS = ["requestId", "fingerprint", "status", "createdAt", "updatedAt"];

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ENVIRONMENT = /^[a-z0-9-]+$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;

const MESSAGES = Object.freeze({
  invalid_arguments: "Invalid orchestration request.",
  unknown_tool: "Unknown orchestration tool.",
  unsupported: "This orchestration operation is not available yet.",
  busy: "Another orchestration operation is in progress.",
  closing: "The orchestration service is closing.",
  aborted: "The orchestration operation was cancelled.",
  runtime_unavailable: "The managed runtime is unavailable.",
  runtime_replaced: "The managed runtime was replaced during the operation.",
  model_catalog_unavailable: "The model catalog is unavailable.",
  model_not_configured: "The requested provider or model is not configured.",
  reasoning_effort_invalid: "The requested reasoning effort is not supported.",
  journal_unavailable: "The orchestration task journal is unavailable. Explicit recovery is required.",
  capacity: "The orchestration task journal capacity has been reached.",
  task_not_found: "The orchestration task was not found.",
  request_conflict: "The request ID was already used for a different request.",
  session_unusable: "The recorded session setup is not usable for this operation.",
  session_mismatch: "The guest returned a different session than requested.",
  ownership_mismatch: "The recorded task belongs to a different guest ownership identity.",
  guest_failed: "The guest operation failed.",
  operation_failed: "The orchestration operation failed.",
});

function fixed(code) {
  const error = new Error(MESSAGES[code]);
  error.code = code;
  return error;
}

function isServiceError(error) {
  return Boolean(error && typeof error.code === "string" && Object.hasOwn(MESSAGES, error.code));
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function text(value, maximum) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !CONTROL.test(value);
}

function timestamp(value) {
  return text(value, 64) && !Number.isNaN(Date.parse(value));
}

function now() {
  return new Date().toISOString();
}

function fingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

// Read the journal as a bounded regular file. O_NONBLOCK keeps a hostile FIFO
// from blocking, lstat rejects symlinks and other non-files, and the read loop
// stops one byte past the limit.
function readJournal(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) throw new Error("invalid journal file");
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NONBLOCK ?? 0)
    | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) throw new Error("invalid journal file");
    const buffer = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
    let total = 0;
    while (total <= MAX_JOURNAL_BYTES) {
      const read = fs.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
    }
    if (total > MAX_JOURNAL_BYTES) throw new Error("invalid journal file");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateRequest(value) {
  if (!exactKeys(value, REQUEST_KEYS)) throw new Error("invalid request record");
  if (!UUID.test(value.requestId) || !FINGERPRINT.test(value.fingerprint)
    || !REQUEST_STATES.has(value.status)
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)) {
    throw new Error("invalid request record");
  }
  return {
    requestId: value.requestId,
    fingerprint: value.fingerprint,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateTask(value) {
  const allowed = new Set([...TASK_KEYS, "reasoningEffort"]);
  if (!isPlainObject(value)
    || Object.keys(value).some(key => !allowed.has(key))
    || TASK_KEYS.some(key => !Object.hasOwn(value, key))) {
    throw new Error("invalid task record");
  }
  if (!UUID.test(value.taskId) || !UUID.test(value.sessionId)
    || !text(value.environmentId, 64) || !ENVIRONMENT.test(value.environmentId)
    || !text(value.cwd, 4096) || !value.cwd.startsWith("/")
    || !text(value.provider, 128) || !text(value.model, 256)
    || !text(value.ownershipToken, 256)
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt)
    || !TASK_STATES.has(value.state)
    || !Array.isArray(value.requests)
    || value.requests.length < 1 || value.requests.length > MAX_REQUESTS) {
    throw new Error("invalid task record");
  }
  if (value.reasoningEffort !== undefined && !text(value.reasoningEffort, 64)) {
    throw new Error("invalid task record");
  }
  const requests = value.requests.map(validateRequest);
  // A task is created by one delegate call whose requestId becomes its taskId.
  // Its first request state always mirrors the task setup state.
  if (requests[0].requestId !== value.taskId
    || requests[0].status !== value.state) {
    throw new Error("inconsistent task record");
  }
  return {
    taskId: value.taskId,
    environmentId: value.environmentId,
    sessionId: value.sessionId,
    cwd: value.cwd,
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    ownershipToken: value.ownershipToken,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    state: value.state,
    requests,
  };
}

function validateJournal(value) {
  if (!exactKeys(value, ["version", "tasks"]) || value.version !== 1
    || !Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) {
    throw new Error("invalid task journal");
  }
  const taskIds = new Set();
  const sessionIds = new Set();
  const requestIds = new Set();
  return value.tasks.map(item => {
    const task = validateTask(item);
    if (taskIds.has(task.taskId) || sessionIds.has(task.sessionId)) {
      throw new Error("duplicate task identity");
    }
    taskIds.add(task.taskId);
    sessionIds.add(task.sessionId);
    for (const request of task.requests) {
      if (requestIds.has(request.requestId)) throw new Error("duplicate request identity");
      requestIds.add(request.requestId);
    }
    return task;
  });
}

function normalizePreparing(tasks) {
  let changed = false;
  const stamp = now();
  const next = tasks.map(task => {
    const state = task.state === "preparing" ? "uncertain" : task.state;
    const requests = task.requests.map(request => request.status === "preparing"
      ? { ...request, status: "uncertain", updatedAt: stamp }
      : request);
    if (state !== task.state || requests.some((request, index) =>
      request.status !== task.requests[index].status)) {
      changed = true;
      return { ...task, state, updatedAt: stamp, requests };
    }
    return task;
  });
  return changed ? next : null;
}

function pickEnvironment(value) {
  if (!value) return null;
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    phase: value.phase,
    busy: value.busy,
    network: value.network,
    prepared: value.prepared,
  };
}

function taskReceipt(task) {
  return {
    taskId: task.taskId,
    environmentId: task.environmentId,
    sessionId: task.sessionId,
    state: task.state,
    provider: task.provider,
    model: task.model,
    ...(task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort }),
    requestId: task.requests[0].requestId,
    requestStatus: task.requests[0].status,
  };
}

function requestReceipt(task, request) {
  return {
    taskId: task.taskId,
    environmentId: task.environmentId,
    sessionId: task.sessionId,
    state: task.state,
    provider: task.provider,
    model: task.model,
    ...(task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort }),
    requestId: request.requestId,
    requestStatus: request.status,
  };
}

function taskView(task) {
  return {
    taskId: task.taskId,
    environmentId: task.environmentId,
    sessionId: task.sessionId,
    cwd: task.cwd,
    provider: task.provider,
    model: task.model,
    ...(task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort }),
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    requests: task.requests.map(request => ({
      requestId: request.requestId,
      status: request.status,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    })),
  };
}

class OrchestrationService {
  constructor({ stateRoot, getRuntime, getModels, runExclusive, guest } = {}) {
    if (typeof stateRoot !== "string" || !stateRoot
      || typeof getRuntime !== "function" || typeof getModels !== "function"
      || typeof runExclusive !== "function") {
      throw new Error("Invalid orchestration service dependencies.");
    }
    this.file = path.join(stateRoot, "orchestration-tasks.json");
    this.getRuntime = getRuntime;
    this.getModels = getModels;
    this.runExclusive = runExclusive;
    this.guest = guest ?? require("./guest.cjs");
    this.tasks = [];
    this.fault = false;
    this.busy = false;
    this.closed = false;
    this.controllers = new Set();
    this.loadJournal();
  }

  loadJournal() {
    let raw;
    try {
      raw = readJournal(this.file);
    } catch {
      this.fault = true;
      return;
    }
    if (raw === null) return;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      this.fault = true;
      return;
    }
    try {
      this.tasks = validateJournal(value);
    } catch {
      this.fault = true;
      return;
    }
    // An interrupted submission is uncertain, never replayed. Persist the
    // downgrade best effort; a failed write latches the journal fault.
    const normalized = normalizePreparing(this.tasks);
    if (normalized === null) return;
    this.tasks = normalized;
    try {
      writeJson(this.file, { version: 1, tasks: normalized });
    } catch {
      this.fault = true;
    }
  }

  runtime() {
    let runtime;
    try {
      runtime = this.getRuntime();
    } catch {
      throw fixed("runtime_unavailable");
    }
    if (!runtime || typeof runtime !== "object"
      || !runtime.coordinator || typeof runtime.coordinator !== "object") {
      throw fixed("runtime_unavailable");
    }
    return runtime;
  }

  assertActive(runtime, signal) {
    if (this.closed) throw fixed("closing");
    if (signal && signal.aborted) throw fixed("aborted");
    let current;
    try {
      current = this.getRuntime();
    } catch {
      throw fixed("runtime_unavailable");
    }
    if (current !== runtime) throw fixed("runtime_replaced");
  }

  async coordinatorCall(runtime, work) {
    try {
      return await work();
    } catch (error) {
      if (isServiceError(error)) throw error;
      if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
        throw fixed("aborted");
      }
      throw fixed("runtime_unavailable");
    }
  }

  async guestCall(work) {
    try {
      return await work();
    } catch (error) {
      if (isServiceError(error)) throw error;
      if (error && (error.name === "AbortError" || error.code === "ABORT_ERR"
        || error.code === "guest-aborted")) {
        throw fixed("aborted");
      }
      throw fixed("guest_failed");
    }
  }

  modelView() {
    let snapshot;
    try {
      snapshot = this.getModels();
    } catch {
      return { fault: true, selected: null, providers: [] };
    }
    if (!isPlainObject(snapshot) || snapshot.fault === true) {
      return { fault: true, selected: null, providers: [] };
    }
    const providers = Array.isArray(snapshot.providers)
      ? snapshot.providers.filter(provider => isPlainObject(provider) && text(provider.id, 128))
        .map(provider => ({
          id: provider.id,
          models: Array.isArray(provider.models)
            ? provider.models.filter(model => isPlainObject(model) && text(model.id, 256))
              .map(model => ({ id: model.id }))
            : [],
        }))
      : [];
    let selected = null;
    const candidate = snapshot.selected;
    if (isPlainObject(candidate) && text(candidate.provider, 128) && text(candidate.model, 256)) {
      const provider = providers.find(item => item.id === candidate.provider);
      const model = provider && provider.models.find(item => item.id === candidate.model);
      if (model) {
        selected = { provider: candidate.provider, model: candidate.model };
        const sourceProvider = snapshot.providers.find(item =>
          isPlainObject(item) && item.id === candidate.provider);
        const sourceModel = sourceProvider && Array.isArray(sourceProvider.models)
          ? sourceProvider.models.find(item => isPlainObject(item) && item.id === candidate.model)
          : undefined;
        if (sourceModel && text(candidate.reasoningEffort, 64)) {
          const efforts = sourceModel.reasoningEfforts;
          if (!isPlainObject(efforts) || Object.hasOwn(efforts, candidate.reasoningEffort)) {
            selected.reasoningEffort = candidate.reasoningEffort;
          }
        }
      }
    }
    return { fault: false, selected, providers };
  }

  requireModel(providerId, modelId, effort) {
    let snapshot;
    try {
      snapshot = this.getModels();
    } catch {
      throw fixed("model_catalog_unavailable");
    }
    if (!isPlainObject(snapshot) || snapshot.fault === true
      || !Array.isArray(snapshot.providers)) {
      throw fixed("model_catalog_unavailable");
    }
    const provider = snapshot.providers.find(item => isPlainObject(item) && item.id === providerId);
    const model = provider && Array.isArray(provider.models)
      ? provider.models.find(item => isPlainObject(item) && item.id === modelId)
      : undefined;
    if (!model) throw fixed("model_not_configured");
    if (effort !== undefined) {
      const efforts = model.reasoningEfforts;
      if (isPlainObject(efforts) && !Object.hasOwn(efforts, effort)) {
        throw fixed("reasoning_effort_invalid");
      }
    }
    return model;
  }

  status() {
    if (this.closed) throw fixed("closing");
    const runtime = this.runtime();
    let snapshot;
    try {
      snapshot = runtime.coordinator.snapshot();
    } catch {
      throw fixed("runtime_unavailable");
    }
    return {
      environments: Array.isArray(snapshot) ? snapshot.map(pickEnvironment) : [],
      models: this.modelView(),
    };
  }

  tasksSnapshot() {
    if (this.closed) throw fixed("closing");
    if (this.fault) return { fault: true, tasks: [] };
    return { fault: false, tasks: this.tasks.map(taskView) };
  }

  task(taskId) {
    return this.tasks.find(task => task.taskId === taskId);
  }

  findRequest(requestId) {
    for (const task of this.tasks) {
      const request = task.requests.find(item => item.requestId === requestId);
      if (request) return { task, request };
    }
    return null;
  }

  replaceTask(next) {
    return this.tasks.map(task => task.taskId === next.taskId ? next : task);
  }

  publish(nextTasks) {
    const next = { version: 1, tasks: nextTasks };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_JOURNAL_BYTES) {
      throw fixed("capacity");
    }
    try {
      writeJson(this.file, next);
    } catch {
      // A rename may have succeeded before a directory sync failed. Never
      // reset or rewrite the file; mutations stay blocked until restart.
      this.fault = true;
      throw fixed("journal_unavailable");
    }
    this.tasks = nextTasks;
  }

  commit(nextTasks, runtime, signal) {
    this.assertActive(runtime, signal);
    this.publish(nextTasks);
  }

  // Best-effort downgrade after an ambiguous RPC or abort. Never downgrade a
  // submitted request, never write after shutdown or runtime replacement.
  markUncertain(taskId, runtime) {
    if (this.fault || this.closed) return;
    try {
      let current;
      try { current = this.getRuntime(); } catch { return; }
      if (current !== runtime) return;
      const task = this.task(taskId);
      if (!task) return;
      const stamp = now();
      const state = task.state === "preparing" ? "uncertain" : task.state;
      const requests = task.requests.map(request => request.status === "preparing"
        ? { ...request, status: "uncertain", updatedAt: stamp }
        : request);
      if (state === task.state && requests.every((request, index) =>
        request.status === task.requests[index].status)) return;
      this.publish(this.replaceTask({ ...task, state, updatedAt: stamp, requests }));
    } catch {
      // The original safe error remains the outward result; the journal is
      // either latched faulted or the runtime was replaced.
    }
  }

  async dispatch(name, args, { signal } = {}) {
    if (this.closed) throw fixed("closing");
    let call;
    try {
      call = validateCall(name, args);
    } catch (error) {
      if (isServiceError(error)) throw error;
      throw fixed("invalid_arguments");
    }
    if (name === "alpi_status") return this.status();
    if (name === "alpi_tasks") return this.tasksSnapshot();
    if (name === "alpi_import" || name === "alpi_export") throw fixed("unsupported");
    if (signal !== undefined
      && (!signal || typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function")) {
      throw fixed("invalid_arguments");
    }
    if (this.busy) throw fixed("busy");

    this.busy = true;
    const controller = new AbortController();
    this.controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await this.runExclusive(() => this.execute(name, call, combined));
    } catch (error) {
      if (isServiceError(error)) throw error;
      if (error && (error.name === "AbortError" || error.code === "ABORT_ERR")) {
        throw fixed("aborted");
      }
      throw fixed("operation_failed");
    } finally {
      this.controllers.delete(controller);
      this.busy = false;
    }
  }

  async execute(name, args, signal) {
    switch (name) {
      case "alpi_start": return this.start(args, signal);
      case "alpi_stop": return this.stop(args, signal);
      case "alpi_exec": return this.exec(args, signal);
      case "alpi_delegate": return this.delegate(args, signal);
      case "alpi_send": return this.send(args, signal);
      case "alpi_wait": return this.wait(args, signal);
      case "alpi_cancel": return this.cancel(args, signal);
      default: throw fixed("unsupported");
    }
  }

  environmentFrom(snapshot, environmentId) {
    const list = Array.isArray(snapshot) ? snapshot : [];
    return pickEnvironment(list.find(item => item && item.id === environmentId));
  }

  async start(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    const snapshot = await this.coordinatorCall(runtime, () =>
      runtime.coordinator.start(args.environmentId, { signal }));
    this.assertActive(runtime, signal);
    return { environment: this.environmentFrom(snapshot, args.environmentId) };
  }

  async stop(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    const snapshot = await this.coordinatorCall(runtime, () =>
      runtime.coordinator.stop(args.environmentId, { signal }));
    this.assertActive(runtime, signal);
    return { environment: this.environmentFrom(snapshot, args.environmentId) };
  }

  async exec(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    return this.coordinatorCall(runtime, () =>
      runtime.coordinator.withRunning(args.environmentId, async (driver, options) => {
        this.assertActive(runtime, signal);
        const request = { command: args.command };
        if (args.cwd !== undefined) request.cwd = args.cwd;
        if (args.root !== undefined) request.root = args.root;
        if (args.timeoutMs !== undefined) request.timeoutMs = args.timeoutMs;
        const result = await this.guestCall(() => this.guest.executeGuest(
          driver,
          { ownershipToken: options.ownershipToken, signal: options.signal },
          request,
        ));
        this.assertActive(runtime, signal);
        return result;
      }, { signal }));
  }

  async delegate(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    if (this.fault) throw fixed("journal_unavailable");

    const digest = fingerprint(["delegate", args.environmentId, args.cwd, args.prompt,
      args.provider, args.model, args.reasoningEffort ?? null]);
    const existingTask = this.task(args.requestId);
    if (existingTask) {
      if (existingTask.requests[0].fingerprint !== digest) throw fixed("request_conflict");
      return taskReceipt(existingTask);
    }
    if (this.findRequest(args.requestId)) throw fixed("request_conflict");
    this.requireModel(args.provider, args.model, args.reasoningEffort);
    if (this.tasks.length >= MAX_TASKS) throw fixed("capacity");

    const sessionId = randomUUID();
    return this.coordinatorCall(runtime, () =>
      runtime.coordinator.withRunning(args.environmentId, async (driver, options) => {
        this.assertActive(runtime, signal);
        const ownershipToken = options.ownershipToken;
        if (!text(ownershipToken, 256)) throw fixed("runtime_unavailable");
        const stamp = now();
        const task = {
          taskId: args.requestId,
          environmentId: args.environmentId,
          sessionId,
          cwd: args.cwd,
          provider: args.provider,
          model: args.model,
          ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          ownershipToken,
          createdAt: stamp,
          updatedAt: stamp,
          state: "preparing",
          requests: [{
            requestId: args.requestId,
            fingerprint: digest,
            status: "preparing",
            createdAt: stamp,
            updatedAt: stamp,
          }],
        };
        // Record intent and identity before the first guest mutation.
        this.commit([...this.tasks, task], runtime, signal);

        this.assertActive(runtime, signal);
        const created = await this.guestCall(() => this.guest.harnessRpc(
          driver,
          { ownershipToken, signal: options.signal },
          "session/create",
          { cwd: args.cwd, sessionId },
        ));
        this.assertActive(runtime, signal);
        if (!isPlainObject(created) || created.sessionId !== sessionId) {
          this.markUncertain(task.taskId, runtime);
          throw fixed("session_mismatch");
        }

        this.assertActive(runtime, signal);
        await this.guestCall(() => this.guest.harnessRpc(
          driver,
          { ownershipToken, signal: options.signal },
          "session/selectModel",
          {
            sessionId,
            provider: args.provider,
            model: args.model,
            ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
          },
        ));
        this.assertActive(runtime, signal);

        await this.guestCall(() => this.guest.harnessRpc(
          driver,
          { ownershipToken, signal: options.signal },
          "session/prompt",
          {
            sessionId,
            requestId: args.requestId,
            mode: "queue",
            content: [{ type: "text", text: args.prompt }],
          },
        ));
        this.assertActive(runtime, signal);

        const submittedAt = now();
        const submitted = {
          ...task,
          state: "submitted",
          updatedAt: submittedAt,
          requests: [{ ...task.requests[0], status: "submitted", updatedAt: submittedAt }],
        };
        this.commit(this.replaceTask(submitted), runtime, signal);
        return taskReceipt(submitted);
      }, { signal }))
      .catch(error => {
        // An RPC failure or abort leaves the persisted preparing record. Record
        // uncertainty best effort; never resubmit on retry.
        const task = this.task(args.requestId);
        if (task && task.state === "preparing") this.markUncertain(task.taskId, runtime);
        throw error;
      });
  }

  async send(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    if (this.fault) throw fixed("journal_unavailable");
    const task = this.task(args.taskId);
    if (!task) throw fixed("task_not_found");

    const mode = args.mode ?? "queue";
    const digest = fingerprint(["send", args.taskId, args.prompt, mode]);
    const existing = this.findRequest(args.requestId);
    if (existing) {
      if (existing.task.taskId === args.taskId && existing.request.fingerprint === digest) {
        return requestReceipt(existing.task, existing.request);
      }
      throw fixed("request_conflict");
    }
    if (task.state !== "submitted") throw fixed("session_unusable");
    if (task.requests.length >= MAX_REQUESTS) throw fixed("capacity");

    return this.coordinatorCall(runtime, () =>
      runtime.coordinator.withRunning(task.environmentId, async (driver, options) => {
        this.assertActive(runtime, signal);
        if (options.ownershipToken !== task.ownershipToken) throw fixed("ownership_mismatch");
        const stamp = now();
        const request = {
          requestId: args.requestId,
          fingerprint: digest,
          status: "preparing",
          createdAt: stamp,
          updatedAt: stamp,
        };
        // Reserve the request identity before the prompt RPC.
        this.commit(this.replaceTask({
          ...task,
          updatedAt: stamp,
          requests: [...task.requests, request],
        }), runtime, signal);

        this.assertActive(runtime, signal);
        await this.guestCall(() => this.guest.harnessRpc(
          driver,
          { ownershipToken: task.ownershipToken, signal: options.signal },
          "session/prompt",
          {
            sessionId: task.sessionId,
            requestId: args.requestId,
            mode,
            content: [{ type: "text", text: args.prompt }],
          },
        ));
        this.assertActive(runtime, signal);

        const submittedAt = now();
        const submittedRequest = { ...request, status: "submitted", updatedAt: submittedAt };
        const submittedTask = {
          ...task,
          updatedAt: submittedAt,
          requests: [...task.requests, submittedRequest],
        };
        this.commit(this.replaceTask(submittedTask), runtime, signal);
        return requestReceipt(submittedTask, submittedRequest);
      }, { signal }))
      .catch(error => {
        const current = this.task(args.taskId);
        if (current) this.markUncertain(current.taskId, runtime);
        throw error;
      });
  }

  async wait(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    if (this.fault) throw fixed("journal_unavailable");
    const task = this.task(args.taskId);
    if (!task) throw fixed("task_not_found");
    if (task.state !== "submitted") throw fixed("session_unusable");
    const timeoutMs = args.timeoutMs ?? 1000;
    const maxMessages = args.maxMessages ?? 8;

    return this.coordinatorCall(runtime, () =>
      runtime.coordinator.withRunning(task.environmentId, async (driver, options) => {
        this.assertActive(runtime, signal);
        if (options.ownershipToken !== task.ownershipToken) throw fixed("ownership_mismatch");
        const rpcArgs = { sessionId: task.sessionId, timeoutMs, maxMessages };
        if (args.afterSeq !== undefined) rpcArgs.afterSeq = args.afterSeq;
        const value = await this.guestCall(() => this.guest.harnessRpc(
          driver,
          { ownershipToken: task.ownershipToken, signal: options.signal },
          "session/wait",
          rpcArgs,
        ));
        this.assertActive(runtime, signal);
        return { taskId: task.taskId, untrusted: true, value };
      }, { signal }));
  }

  async cancel(args, signal) {
    const runtime = this.runtime();
    this.assertActive(runtime, signal);
    if (this.fault) throw fixed("journal_unavailable");
    const task = this.task(args.taskId);
    if (!task) throw fixed("task_not_found");
    if (task.state !== "submitted") throw fixed("session_unusable");

    return this.coordinatorCall(runtime, () =>
      runtime.coordinator.withRunning(task.environmentId, async (driver, options) => {
        this.assertActive(runtime, signal);
        if (options.ownershipToken !== task.ownershipToken) throw fixed("ownership_mismatch");
        await this.guestCall(() => this.guest.harnessRpc(
          driver,
          { ownershipToken: task.ownershipToken, signal: options.signal },
          "session/cancel",
          { sessionId: task.sessionId },
        ));
        this.assertActive(runtime, signal);
        // Harness cancellation is cooperative; this is not proof that guest
        // processes terminated. alpi_stop is the verified whole-VM stop.
        return { taskId: task.taskId, acknowledged: true, cooperative: true };
      }, { signal }));
  }

  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
  }
}

module.exports = { OrchestrationService };
