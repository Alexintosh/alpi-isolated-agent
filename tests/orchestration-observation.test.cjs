// Focused O1 checks for the harness-neutral observation contract and the stock
// adapter projection. Fixtures are synthetic, literal stock-shaped values taken
// from the pinned 0.2.2-rc.2 source shapes recorded in R0 research. No live VM,
// model, transcript or credential access is involved.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { validateObservation, validateCancellation } = require("../src/orchestration/observation.cjs");
const { createHarnessAdapter } = require("../src/orchestration/harness-adapter.cjs");

const CAPABILITIES = {
  observation: true,
  pendingActionDetail: "kind-only",
  approvalResolution: false,
  cancellationRequest: true,
  rawObservation: true,
};

const SNAPSHOT_KEYS = ["assistantText", "capabilities", "cursor", "live",
  "pendingActions", "state", "truncated"];

function messageRecord({ seq, content, stream }) {
  return {
    type: "event",
    event: {
      type: "assistant/message",
      seq,
      time: 0,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: `m${seq}`,
          role: "assistant",
          source: { kind: "model", provider: "p", model: "m" },
          content,
        },
        ...(stream === undefined ? {} : { stream }),
      },
    },
  };
}

function runningWait() {
  return {
    reason: "timeout",
    state: {
      cursor: 42,
      active: true,
      running: true,
      queue: [{ content: [{ type: "text", text: "QUEUE_CANARY" }] }],
      pendingInput: [],
    },
    output: {
      records: [messageRecord({
        seq: 41,
        content: [
          { type: "text", text: "partial" },
          { type: "reasoning", text: "REASONING_CANARY" },
        ],
        stream: [{ type: "tool-call-chunks", index: 0, id: "c1", name: "t", args: ['{"TOOL_ARGS_CANARY":1}'] }],
      })],
      truncated: false,
    },
  };
}

function idleWait({ cursor = 50, active = true, text = "done", truncated = false } = {}) {
  return {
    reason: "idle",
    state: { cursor, active, running: false, queue: active ? [] : null, pendingInput: [] },
    output: {
      records: [messageRecord({ seq: cursor, content: [{ type: "text", text }] })],
      truncated,
    },
  };
}

function pendingWait(kinds) {
  return {
    reason: "input-required",
    state: { cursor: 30, active: true, running: true, queue: [], pendingInput: kinds },
    output: { records: [], truncated: false },
  };
}

function adapterReturning(value) {
  const calls = [];
  const adapter = createHarnessAdapter({
    rpc: async (method, args) => {
      calls.push({ method, args });
      return typeof value === "function" ? value(method, args) : value;
    },
  });
  return { adapter, calls };
}

function adapterThrowing(error) {
  const calls = [];
  const adapter = createHarnessAdapter({
    rpc: async (method, args) => {
      calls.push({ method, args });
      throw error;
    },
  });
  return { adapter, calls };
}

async function rejectsFixed(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code);
    assert.equal(typeof error.message, "string");
    return true;
  });
}

test("capabilities report the frozen stock support matrix as a fresh object", () => {
  const adapter = createHarnessAdapter({ rpc: async () => ({}) });
  const first = adapter.capabilities();
  assert.deepEqual(first, CAPABILITIES);
  const second = adapter.capabilities();
  assert.notEqual(first, second);
  first.rawObservation = false;
  assert.equal(adapter.capabilities().rawObservation, true);
});

test("running observation projects state, bounded text and cursor without leaking payloads", async () => {
  const { adapter, calls } = adapterReturning(runningWait());
  const snapshot = await adapter.observe({ conversationId: "session-1" }, {});

  assert.deepEqual(snapshot, {
    state: "running",
    live: true,
    cursor: 42,
    pendingActions: [],
    assistantText: "partial",
    truncated: { text: false, records: false },
    capabilities: CAPABILITIES,
  });
  assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal("completed" in snapshot, false);
  assert.equal("success" in snapshot, false);

  const serialized = JSON.stringify(snapshot);
  for (const canary of ["QUEUE_CANARY", "REASONING_CANARY", "TOOL_ARGS_CANARY"]) {
    assert.equal(serialized.includes(canary), false, canary);
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "session/wait");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["maxMessages", "sessionId"]);
  assert.equal(calls[0].args.maxMessages, 1);
});

test("idle is observed quiescence, not success, for live and cold sessions", async () => {
  const live = await adapterReturning(idleWait()).adapter.observe({ conversationId: "s" }, {});
  assert.equal(live.state, "idle");
  assert.equal(live.live, true);
  assert.equal(live.assistantText, "done");
  assert.equal("completed" in live, false);

  const cold = await adapterReturning(idleWait({ cursor: 9, active: false, text: "" }))
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(cold.state, "idle");
  assert.equal(cold.live, false);
  assert.equal(cold.cursor, 9);
  assert.equal(cold.assistantText, "");
  assert.equal("success" in cold, false);
});

test("pending approval and question surface kind-only guest-UI handoff", async () => {
  const approval = await adapterReturning(pendingWait(["approval"]))
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(approval.state, "waiting");
  assert.equal(approval.live, true);
  assert.deepEqual(approval.pendingActions, [
    { kind: "approval", detailAvailable: false, resolution: "guest-ui" },
  ]);
  assert.equal(approval.assistantText, "");

  const question = await adapterReturning(pendingWait(["question"]))
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(question.state, "waiting");
  assert.deepEqual(question.pendingActions, [
    { kind: "question", detailAvailable: false, resolution: "guest-ui" },
  ]);
});

test("unknown pending kinds map to other, are deduplicated and capped at three", async () => {
  const snapshot = await adapterReturning(pendingWait(["approval", "approval", "mystery"]))
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(snapshot.state, "waiting");
  assert.deepEqual(snapshot.pendingActions.map(action => action.kind), ["approval", "other"]);

  const capped = await adapterReturning(pendingWait(["approval", "question", "other", "mystery"]))
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(capped.pendingActions.length, 3);
  assert.deepEqual(capped.pendingActions.map(action => action.kind),
    ["approval", "question", "other"]);
});

test("malformed and unknown stock states map to explicit unknown and null", async () => {
  const malformed = [
    null,
    undefined,
    {},
    { reason: "idle" },
    { reason: "surprise", state: { cursor: 5, active: true, running: false, pendingInput: [] } },
    { reason: "idle", state: { cursor: -1, active: "yes", running: "no", pendingInput: [] } },
    { reason: "idle", state: { cursor: 1.5, active: true, running: false, pendingInput: null } },
    { reason: "idle", state: [], output: { records: [], truncated: false } },
    { reason: "input-required", state: { cursor: 8, active: true, running: true, pendingInput: [] } },
    { reason: "timeout", state: { cursor: 8, active: true, running: true, pendingInput: [123] } },
  ];
  for (const value of malformed) {
    const snapshot = await adapterReturning(value).adapter.observe({ conversationId: "s" }, {});
    assert.equal(snapshot.state, "unknown");
    assert.deepEqual(snapshot.pendingActions, []);
    assert.equal(snapshot.assistantText, "");
    assert.equal("completed" in snapshot, false);
  }

  const unknownReason = await adapterReturning(malformed[4])
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(unknownReason.live, true);
  assert.equal(unknownReason.cursor, 5);

  const invalidNumbers = await adapterReturning(malformed[5])
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(invalidNumbers.cursor, null);
  assert.equal(invalidNumbers.live, null);

  const partialNumbers = await adapterReturning(malformed[6])
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(partialNumbers.state, "unknown");
  assert.equal(partialNumbers.cursor, null);
  assert.equal(partialNumbers.live, true);
});

test("unknown record types, blocks and stream/queue trees are skipped, not traversed", async () => {
  const fixture = {
    reason: "idle",
    state: { cursor: 60, active: true, running: false, queue: [], pendingInput: [] },
    output: {
      records: [
        {
          type: "event",
          event: {
            type: "tool/call",
            seq: 60,
            time: 0,
            data: { arguments: { CANARY: "TOOL_RECORD_CANARY" } },
          },
        },
        {
          type: "event",
          event: {
            type: "assistant/attempt",
            seq: 59,
            time: 0,
            data: { stream: [{ args: ["ATTEMPT_CANARY"] }] },
          },
        },
        {
          type: "event",
          event: {
            type: "mystery/event",
            seq: 58,
            time: 0,
            ignorable: true,
            data: { payload: { nested: { deep: { CANARY: "EVENT_CANARY" } } } },
          },
        },
        messageRecord({
          seq: 57,
          content: [
            { type: "text", text: "visible" },
            { type: "tool-call", id: "c9", name: "t", arguments: { CANARY: "BLOCK_ARGS_CANARY" } },
            { type: "image", data: "BLOCK_IMAGE_CANARY" },
            { type: "mystery-block", payload: { nested: { CANARY: "BLOCK_CANARY" } } },
          ],
          stream: [{ args: ["MESSAGE_STREAM_CANARY"] }],
        }),
      ],
      truncated: false,
    },
  };

  const snapshot = await adapterReturning(fixture)
    .adapter.observe({ conversationId: "s" }, { maxMessages: 4 });
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.assistantText, "visible");
  assert.equal(snapshot.truncated.text, false);
  assert.equal(snapshot.truncated.records, false);

  const serialized = JSON.stringify(snapshot);
  for (const canary of ["TOOL_RECORD_CANARY", "ATTEMPT_CANARY", "EVENT_CANARY",
    "BLOCK_ARGS_CANARY", "BLOCK_IMAGE_CANARY", "BLOCK_CANARY", "MESSAGE_STREAM_CANARY"]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
});

test("deeply nested unknown payloads are never read, even through throwing getters", async () => {
  const fixture = {
    reason: "idle",
    state: { cursor: 3, active: true, running: false, pendingInput: [] },
    output: {
      records: [
        {
          type: "event",
          event: {
            type: "assistant/message",
            seq: 3,
            time: 0,
            data: {
              turn: 1,
              step: 1,
              message: {
                id: "m3",
                role: "assistant",
                content: [
                  { type: "text", text: "safe" },
                  {
                    type: "mystery-block",
                    payload: {
                      get explode() { throw new Error("block payload traversed"); },
                    },
                  },
                ],
              },
              stream: [{
                get explode() { throw new Error("stream traversed"); },
              }],
            },
          },
        },
      ],
      truncated: false,
    },
  };

  const snapshot = await adapterReturning(fixture)
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.assistantText, "safe");
});

test("empty output is a valid observation with empty text", async () => {
  const snapshot = await adapterReturning({
    reason: "idle",
    state: { cursor: 7, active: true, running: false, queue: [], pendingInput: [] },
    output: { records: [], truncated: false },
  }).adapter.observe({ conversationId: "s" }, {});
  assert.equal(snapshot.assistantText, "");
  assert.equal(snapshot.truncated.text, false);
  assert.equal(snapshot.truncated.records, false);
  assert.equal(snapshot.state, "idle");
});

test("assistant text is assembled newest record first and in log order", async () => {
  const fixture = {
    reason: "idle",
    state: { cursor: 20, active: true, running: false, pendingInput: [] },
    output: {
      records: [
        messageRecord({ seq: 20, content: [{ type: "text", text: "newer-a" }, { type: "text", text: "newer-b" }] }),
        messageRecord({ seq: 19, content: [{ type: "text", text: "older" }] }),
      ],
      truncated: false,
    },
  };
  const snapshot = await adapterReturning(fixture)
    .adapter.observe({ conversationId: "s" }, { maxMessages: 2 });
  assert.equal(snapshot.assistantText, "newer-a\nnewer-b\nolder");
});

test("cursor is omitted for null and -1 and sent as the exclusive lower bound", async () => {
  const fixture = idleWait({ cursor: 10, text: "first" });
  const { adapter, calls } = adapterReturning(fixture);

  const omitted = await adapter.observe({ conversationId: "s" }, {});
  assert.equal(Object.hasOwn(calls[0].args, "afterSeq"), false);
  assert.equal(omitted.cursor, 10);

  const nullCursor = await adapter.observe({ conversationId: "s" }, { cursor: null });
  assert.equal(Object.hasOwn(calls[1].args, "afterSeq"), false);

  const sentinel = await adapter.observe({ conversationId: "s" }, { cursor: -1 });
  assert.equal(Object.hasOwn(calls[2].args, "afterSeq"), false);

  await adapter.observe({ conversationId: "s" }, { cursor: 0 });
  assert.equal(calls[3].args.afterSeq, 0);

  await adapter.observe({ conversationId: "s" }, { cursor: 10 });
  assert.equal(calls[4].args.afterSeq, 10);
});

test("repeated cursors are idempotent and source truncation is disclosed", async () => {
  const first = idleWait({ cursor: 10, text: "same" });
  const newer = {
    reason: "idle",
    state: { cursor: 12, active: true, running: false, pendingInput: [] },
    output: {
      records: [messageRecord({ seq: 12, content: [{ type: "text", text: "new" }] })],
      truncated: false,
    },
  };
  const { adapter, calls } = adapterReturning((method, args) => {
    if (args.afterSeq === 10) return newer;
    return first;
  });

  const a = await adapter.observe({ conversationId: "s" }, { cursor: 5 });
  const b = await adapter.observe({ conversationId: "s" }, { cursor: 5 });
  assert.equal(a.assistantText, "same");
  assert.equal(b.assistantText, "same");
  assert.deepEqual(a, b);

  const advanced = await adapter.observe({ conversationId: "s" }, { cursor: 10 });
  assert.equal(advanced.assistantText, "new");
  assert.equal(advanced.cursor, 12);

  const truncated = await adapterReturning(idleWait({ truncated: true }))
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(truncated.truncated.records, true);
  assert.equal(truncated.truncated.text, false);
  assert.equal(calls.length, 3);
});

test("request options and bindings are validated defensively with fixed errors", async () => {
  const { adapter } = adapterReturning(idleWait());

  for (const cursor of [-2, 1.5, Number.MAX_SAFE_INTEGER + 1, "5", true]) {
    await rejectsFixed(adapter.observe({ conversationId: "s" }, { cursor }), "invalid_arguments");
  }
  for (const timeoutMs of [0, 20001, 1.5, "1000", null]) {
    await rejectsFixed(adapter.observe({ conversationId: "s" }, { timeoutMs }), "invalid_arguments");
  }
  for (const maxMessages of [0, 33, 1.5, "1", null]) {
    await rejectsFixed(adapter.observe({ conversationId: "s" }, { maxMessages }), "invalid_arguments");
  }
  await rejectsFixed(adapter.observe({ conversationId: "s" }, { format: "raw" }), "invalid_arguments");
  await rejectsFixed(adapter.observe({ conversationId: "s" }, null), "invalid_arguments");

  for (const binding of [null, undefined, {}, { conversationId: "" },
    { conversationId: "s", extra: true }, { conversationId: 5 },
    { conversationId: "bad\u0000id" }]) {
    await rejectsFixed(adapter.observe(binding, {}), "invalid_arguments");
  }

  assert.throws(() => createHarnessAdapter({}), error => error.code === "invalid_arguments");
  assert.throws(() => createHarnessAdapter({ rpc: 1 }), error => error.code === "invalid_arguments");
  assert.throws(() => createHarnessAdapter(null), error => error.code === "invalid_arguments");
  assert.throws(() => createHarnessAdapter(), error => error.code === "invalid_arguments");
});

test("Unicode text truncates on code-point boundaries within the byte cap", async () => {
  const cjk = await adapterReturning({
    reason: "idle",
    state: { cursor: 1, active: true, running: false, pendingInput: [] },
    output: {
      records: [messageRecord({ seq: 1, content: [{ type: "text", text: "漢".repeat(10000) }] })],
      truncated: false,
    },
  }).adapter.observe({ conversationId: "s" }, {});

  assert.equal(cjk.truncated.text, true);
  assert.ok(Buffer.byteLength(cjk.assistantText, "utf8") <= 16384);
  assert.equal(Buffer.from(cjk.assistantText, "utf8").toString("utf8"), cjk.assistantText);
  assert.equal(cjk.assistantText.includes("\uFFFD"), false);
  assert.equal(cjk.assistantText, "漢".repeat(5461));

  const emoji = await adapterReturning({
    reason: "idle",
    state: { cursor: 1, active: true, running: false, pendingInput: [] },
    output: {
      records: [messageRecord({ seq: 1, content: [{ type: "text", text: "😀".repeat(5000) }] })],
      truncated: false,
    },
  }).adapter.observe({ conversationId: "s" }, {});

  assert.equal(emoji.truncated.text, true);
  assert.equal(Buffer.byteLength(emoji.assistantText, "utf8"), 16384);
  assert.equal(emoji.assistantText, "😀".repeat(4096));
});

test("record and content-block iteration bounds mark truncation", async () => {
  const manyRecords = {
    reason: "idle",
    state: { cursor: 100, active: true, running: false, pendingInput: [] },
    output: {
      records: Array.from({ length: 100 }, (_, index) => messageRecord({
        seq: 100 - index,
        content: [{ type: "text", text: "x" }],
      })),
      truncated: false,
    },
  };
  const recordBound = await adapterReturning(manyRecords)
    .adapter.observe({ conversationId: "s" }, { maxMessages: 2 });
  assert.equal(recordBound.assistantText, "x\nx");
  assert.equal(recordBound.truncated.records, true);
  assert.equal(recordBound.truncated.text, false);

  const manyBlocks = {
    reason: "idle",
    state: { cursor: 1, active: true, running: false, pendingInput: [] },
    output: {
      records: [messageRecord({
        seq: 1,
        content: Array.from({ length: 100 }, () => ({ type: "text", text: "a" })),
      })],
      truncated: false,
    },
  };
  const blockBound = await adapterReturning(manyBlocks)
    .adapter.observe({ conversationId: "s" }, {});
  assert.equal(blockBound.truncated.text, true);
  assert.equal(blockBound.assistantText.split("\n").length, 64);
});

test("raw observation is explicit and preserves the supplied payload unchanged", async () => {
  const fixture = runningWait();
  const { adapter, calls } = adapterReturning(fixture);

  const raw = await adapter.observeRaw({ conversationId: "s" }, {});
  assert.equal(raw, fixture);
  assert.equal(calls[0].args.maxMessages, 8);

  await adapter.observeRaw({ conversationId: "s" }, { maxMessages: 32, cursor: 4, timeoutMs: 20000 });
  assert.equal(calls[1].args.maxMessages, 32);
  assert.equal(calls[1].args.afterSeq, 4);
  assert.equal(calls[1].args.timeoutMs, 20000);

  await rejectsFixed(adapter.observeRaw({ conversationId: "s" }, { maxMessages: 33 }), "invalid_arguments");
  await rejectsFixed(adapter.observeRaw({ conversationId: "s" }, { timeoutMs: 20001 }), "invalid_arguments");
});

test("cancellation requires an actual accepted acknowledgment", async () => {
  const accepted = await adapterReturning({ accepted: true })
    .adapter.requestCancel({ conversationId: "s" });
  assert.deepEqual(accepted, {
    requested: true,
    acknowledged: true,
    cooperative: true,
    processTermination: "unknown",
  });
  assert.equal("turnEnded" in accepted, false);
  assert.equal("terminated" in accepted, false);

  for (const ack of [{ accepted: false }, { accepted: "true" }, {}, null, [], true, undefined]) {
    const { adapter } = adapterReturning(ack);
    await rejectsFixed(adapter.requestCancel({ conversationId: "s" }), "guest_failed");
  }

  const { adapter: cancelAdapter, calls } = adapterReturning({ accepted: true });
  await cancelAdapter.requestCancel({ conversationId: "s" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "session/cancel");
  assert.deepEqual(calls[0].args, { sessionId: "s" });

  await rejectsFixed(cancelAdapter.requestCancel({}), "invalid_arguments");
});

test("a later observation after cancel never claims an end or a success", async () => {
  const responses = [{ accepted: true }, runningWait(), idleWait()];
  let index = 0;
  const adapter = createHarnessAdapter({
    rpc: async () => responses[index++],
  });

  const receipt = await adapter.requestCancel({ conversationId: "s" });
  assert.equal(receipt.acknowledged, true);

  const running = await adapter.observe({ conversationId: "s" }, {});
  assert.equal(running.state, "running");
  assert.equal("completed" in running, false);
  assert.equal("turnEnded" in running, false);

  const quiescent = await adapter.observe({ conversationId: "s" }, {});
  assert.equal(quiescent.state, "idle");
  assert.equal("completed" in quiescent, false);
  assert.equal("success" in quiescent, false);
});

test("dependency failures are rebuilt as fixed errors without reflection", async () => {
  const secret = "DEPENDENCY_CANARY_42";
  const failure = new Error(`boom ${secret}`);
  failure.code = "guest-rpc-rejected";
  failure.cause = new Error(secret);
  failure.stack = `stack ${secret}`;
  failure.extra = secret;

  const { adapter } = adapterThrowing(failure);
  await assert.rejects(adapter.observe({ conversationId: "s" }, {}), error => {
    assert.equal(error.code, "guest_failed");
    assert.equal(error.message, "The guest operation failed.");
    assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes(secret), false);
    assert.equal(String(error).includes(secret), false);
    return true;
  });

  await assert.rejects(adapterThrowing(Object.assign(new Error(secret), { code: "guest-rpc-oversize" }))
    .adapter.observe({ conversationId: "s" }, {}), error => {
    assert.equal(error.code, "guest_failed");
    assert.equal(String(error).includes(secret), false);
    return true;
  });

  const hostile = new Error("hostile");
  Object.defineProperty(hostile, "code", {
    get() { throw new Error(secret); },
  });
  await rejectsFixed(adapterThrowing(hostile).adapter.observe({ conversationId: "s" }, {}), "guest_failed");

  await rejectsFixed(adapterThrowing(secret).adapter.observe({ conversationId: "s" }, {}), "guest_failed");

  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  await rejectsFixed(adapterThrowing(aborted).adapter.observe({ conversationId: "s" }, {}), "aborted");

  await rejectsFixed(adapterThrowing(Object.assign(new Error("x"), { code: "guest-aborted" }))
    .adapter.requestCancel({ conversationId: "s" }), "aborted");

  await rejectsFixed(adapterThrowing(Object.assign(new Error("x"), { code: "ABORT_ERR" }))
    .adapter.observeRaw({ conversationId: "s" }, {}), "aborted");
});

test("compact observation makes exactly one wait call and never falls back", async () => {
  const { adapter, calls } = adapterThrowing(Object.assign(new Error("nope"), { code: "guest-rpc-oversize" }));
  await rejectsFixed(adapter.observe({ conversationId: "s" }, { cursor: 3, maxMessages: 2 }), "guest_failed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "session/wait");
  assert.deepEqual(Object.keys(calls[0].args).sort(), ["afterSeq", "maxMessages", "sessionId"]);
});

test("neutral observation validator returns fresh picked objects and rejects drift", () => {
  const valid = {
    state: "waiting",
    live: true,
    cursor: 4,
    pendingActions: [{ kind: "approval", detailAvailable: false, resolution: "guest-ui" }],
    assistantText: "text",
    truncated: { text: false, records: true },
    capabilities: CAPABILITIES,
  };

  const picked = validateObservation(valid);
  assert.deepEqual(picked, valid);
  assert.notEqual(picked, valid);
  assert.notEqual(picked.pendingActions, valid.pendingActions);
  assert.notEqual(picked.pendingActions[0], valid.pendingActions[0]);
  assert.notEqual(picked.truncated, valid.truncated);
  assert.notEqual(picked.capabilities, valid.capabilities);

  valid.state = "idle";
  valid.assistantText = "changed";
  assert.equal(picked.state, "waiting");
  assert.equal(picked.assistantText, "text");

  const rejected = [
    null,
    {},
    { ...valid, extra: true },
    { ...valid, state: "done" },
    { ...valid, live: "true" },
    { ...valid, cursor: -1 },
    { ...valid, cursor: 1.5 },
    { ...valid, assistantText: "a".repeat(16385) },
    { ...valid, assistantText: "\uD800" },
    { ...valid, truncated: { text: false } },
    { ...valid, truncated: { text: "no", records: false } },
    { ...valid, pendingActions: [{ kind: "approval", detailAvailable: true, resolution: "guest-ui" }] },
    { ...valid, pendingActions: [{ kind: "approval", detailAvailable: false, resolution: "host" }] },
    { ...valid, pendingActions: [{ kind: "approve", detailAvailable: false, resolution: "guest-ui" }] },
    { ...valid, pendingActions: [
      { kind: "approval", detailAvailable: false, resolution: "guest-ui" },
      { kind: "approval", detailAvailable: false, resolution: "guest-ui" },
    ] },
    { ...valid, pendingActions: Array.from({ length: 4 }, () => ({
      kind: "other", detailAvailable: false, resolution: "guest-ui",
    })) },
    { ...valid, capabilities: { ...CAPABILITIES, observation: false } },
    { ...valid, capabilities: { ...CAPABILITIES, pendingActionDetail: "full" } },
    { ...valid, capabilities: { ...CAPABILITIES, approvalResolution: true } },
    { ...valid, capabilities: { ...CAPABILITIES, rawObservation: "yes" } },
    { ...valid, capabilities: { ...CAPABILITIES, extra: true } },
  ];
  for (const value of rejected) {
    assert.throws(() => validateObservation(value), error => error.code === "guest_failed");
  }

  assert.equal(validateObservation({ ...valid, assistantText: "a".repeat(16384) }).assistantText.length, 16384);
  const capabilityVariant = validateObservation({
    ...valid,
    capabilities: { ...CAPABILITIES, cancellationRequest: false, rawObservation: false },
  });
  assert.equal(capabilityVariant.capabilities.cancellationRequest, false);
  assert.equal(capabilityVariant.capabilities.rawObservation, false);
});

test("neutral cancellation validator accepts only the fixed receipt", () => {
  const receipt = {
    requested: true,
    acknowledged: true,
    cooperative: true,
    processTermination: "unknown",
  };
  const picked = validateCancellation(receipt);
  assert.deepEqual(picked, receipt);
  assert.notEqual(picked, receipt);
  receipt.requested = false;
  assert.equal(picked.requested, true);

  for (const value of [
    null,
    {},
    { ...picked, requested: false },
    { ...picked, acknowledged: false },
    { ...picked, cooperative: false },
    { ...picked, processTermination: "terminated" },
    { ...picked, extra: true },
    { ...picked, turnEnded: true },
  ]) {
    assert.throws(() => validateCancellation(value), error => error.code === "guest_failed");
  }
});

test("a capability-absent fake adapter reports unsupported without a stock shape branch", () => {
  const unsupported = () => {
    const error = new Error("This orchestration operation is not available yet.");
    error.code = "unsupported";
    return error;
  };
  const fake = {
    capabilities: () => ({
      observation: false,
      pendingActionDetail: false,
      approvalResolution: false,
      cancellationRequest: false,
      rawObservation: false,
    }),
    observe() { throw unsupported(); },
    observeRaw() { throw unsupported(); },
    requestCancel() { throw unsupported(); },
  };

  const capabilities = fake.capabilities();
  assert.equal(capabilities.observation, false);
  assert.equal(capabilities.rawObservation, false);
  for (const method of ["observe", "observeRaw", "requestCancel"]) {
    assert.throws(() => fake[method]({ conversationId: "s" }, {}), error => {
      assert.equal(error.code, "unsupported");
      return true;
    });
  }

  // The neutral contract already tolerates capability variation, so a future
  // backend can adopt it without a stock-shape branch.
  const snapshot = validateObservation({
    state: "unknown",
    live: null,
    cursor: null,
    pendingActions: [],
    assistantText: "",
    truncated: { text: false, records: false },
    capabilities: {
      observation: true,
      pendingActionDetail: "kind-only",
      approvalResolution: false,
      cancellationRequest: false,
      rawObservation: false,
    },
  });
  assert.equal(snapshot.capabilities.rawObservation, false);
});

test("the neutral contract module contains no stock method or record names", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "orchestration", "observation.cjs"),
    "utf8",
  );
  for (const forbidden of ["session/", "assistant/message", "pendingInput",
    "deepseek", "rpc("]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
