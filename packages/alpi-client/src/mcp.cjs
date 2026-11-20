'use strict';

// A small stdio MCP server for the authorized Alpi context. It deliberately
// exposes only the first implemented tool and delegates all credential and
// transport handling to the caller's authenticated getCapabilities function.

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_INFLIGHT = 8;
const MAX_OUTPUT_QUEUE = 64;

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = Object.freeze({ name: 'alpi', version: '0.1.0' });

const TOOL_NAME = 'alpi_capabilities';
const TOOL = Object.freeze({
  name: TOOL_NAME,
  description: 'Fetch the server capabilities for the authorized Alpi context.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function validId(id) {
  return (
    typeof id === 'string' ||
    (typeof id === 'number' && Number.isFinite(id))
  );
}

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolErrorText(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code === 'CREDENTIAL_EXPIRED') {
    return 'The client credential has expired.';
  }
  if (code === 'HTTP_STATUS') {
    const status = error && error.statusCode;
    if (status === 401) {
      return 'The server rejected the credential. The client may have been revoked.';
    }
    if (status === 403) {
      return 'The server denied access to capabilities.';
    }
    if (status === 429) {
      return 'The server rate limited the capabilities request.';
    }
    return 'The server rejected the capabilities request.';
  }
  if (code === 'CONNECTION_ERROR') {
    return 'Could not connect to the Alpi server.';
  }
  if (code === 'CONNECTION_CLOSED') {
    return 'The connection closed before capabilities were received.';
  }
  if (code === 'TIMEOUT') {
    return 'The capabilities request timed out.';
  }
  if (code === 'TLS_CERT_INVALID' || code === 'TLS_PIN_MISMATCH') {
    return 'TLS verification failed.';
  }
  if (code === 'INVALID_RESPONSE' ||
      code === 'SERVER_ID_MISMATCH' ||
      code === 'SERVER_RESPONSE_MISMATCH') {
    return 'The server returned an invalid capabilities response.';
  }
  if (code === 'REQUEST_TOO_LARGE' || code === 'RESPONSE_TOO_LARGE') {
    return 'The capabilities response is too large.';
  }
  return 'The capabilities request failed.';
}

function toolErrorResult(error) {
  return {
    content: [{ type: 'text', text: toolErrorText(error) }],
    isError: true,
  };
}

async function callTool(getCapabilities) {
  try {
    const capabilities = await getCapabilities();
    if (!isPlainObject(capabilities)) {
      return toolErrorResult(undefined);
    }
    const text = JSON.stringify(capabilities);
    if (typeof text !== 'string') {
      return toolErrorResult(undefined);
    }
    const result = {
      content: [{ type: 'text', text }],
      structuredContent: capabilities,
    };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_OUTPUT_BYTES) {
      return toolErrorResult({ code: 'RESPONSE_TOO_LARGE' });
    }
    return result;
  } catch (error) {
    return toolErrorResult(error);
  }
}

const TOOLS = new Map([
  [TOOL_NAME, { definition: TOOL, run: callTool }],
]);

async function runMcp(options) {
  if (!isPlainObject(options) ||
      typeof options.getCapabilities !== 'function' ||
      !options.input ||
      typeof options.input.on !== 'function' ||
      !options.output ||
      typeof options.output.write !== 'function') {
    throw new Error('Invalid MCP options.');
  }

  const getCapabilities = options.getCapabilities;
  const input = options.input;
  const output = options.output;

  let failed = false;
  let finished = false;
  let inputEnded = false;
  let inputPaused = false;
  let discarding = false;
  let buffer = Buffer.alloc(0);
  let inflight = 0;
  let pumping = false;
  let writing = false;
  let drainReject = null;
  let outQueue = [];
  const pending = new Map();

  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  function cleanup() {
    input.removeListener('data', onData);
    input.removeListener('end', onEnd);
    input.removeListener('close', onInputClose);
    input.removeListener('error', onInputError);
    output.removeListener('error', onOutputError);
    output.removeListener('close', onOutputClose);
  }

  function fail() {
    if (failed || finished) {
      return;
    }
    failed = true;
    finished = true;
    cleanup();
    if (drainReject) {
      const reject = drainReject;
      drainReject = null;
      reject(new Error('Output failed.'));
    }
    rejectDone(new Error('MCP stream failure.'));
  }

  function finish() {
    if (failed || finished) {
      return;
    }
    finished = true;
    cleanup();
    resolveDone();
  }

  function checkDone() {
    if (failed || finished) {
      return;
    }
    if (inputEnded &&
        buffer.length === 0 &&
        !discarding &&
        inflight === 0 &&
        outQueue.length === 0 &&
        !writing) {
      finish();
    }
  }

  function pauseInput() {
    if (inputPaused || inputEnded || failed) {
      return;
    }
    inputPaused = true;
    if (typeof input.pause === 'function') {
      input.pause();
    }
  }

  function resumeInput() {
    if (!inputPaused || inputEnded || failed) {
      return;
    }
    inputPaused = false;
    if (typeof input.resume === 'function') {
      input.resume();
    }
    pump();
  }

  function maybeResume() {
    if (inputPaused &&
        inflight < MAX_INFLIGHT &&
        outQueue.length < MAX_OUTPUT_QUEUE) {
      resumeInput();
      return;
    }
    // After EOF the input is no longer paused, but buffered complete frames
    // still need pumping once capacity frees up.
    if (inputEnded &&
        buffer.length > 0 &&
        inflight < MAX_INFLIGHT &&
        outQueue.length < MAX_OUTPUT_QUEUE) {
      pump();
    }
  }

  async function waitForDrain() {
    return new Promise((resolve, reject) => {
      function cleanupDrain() {
        output.removeListener('drain', onDrain);
        output.removeListener('error', onDrainError);
        output.removeListener('close', onDrainClose);
        if (drainReject === reject) {
          drainReject = null;
        }
      }
      function onDrain() {
        cleanupDrain();
        resolve();
      }
      function onDrainError() {
        cleanupDrain();
        reject(new Error('Output failed.'));
      }
      function onDrainClose() {
        cleanupDrain();
        reject(new Error('Output closed.'));
      }
      if (failed || output.destroyed || output.writableEnded) {
        reject(new Error('Output unavailable.'));
        return;
      }
      drainReject = reject;
      output.once('drain', onDrain);
      output.once('error', onDrainError);
      output.once('close', onDrainClose);
    });
  }

  async function drainOutput() {
    if (writing || failed) {
      return;
    }
    writing = true;
    try {
      while (outQueue.length > 0 && !failed) {
        const line = outQueue.shift();
        const ok = output.write(line);
        if (ok === false) {
          await waitForDrain();
        }
      }
    } catch {
      fail();
    } finally {
      writing = false;
      if (!failed) {
        maybeResume();
        checkDone();
      }
    }
  }

  function enqueue(message) {
    if (failed) {
      return;
    }
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      const id = message && validId(message.id) ? message.id : null;
      line = `${JSON.stringify(errorResponse(id, INTERNAL_ERROR, 'Internal error.'))}\n`;
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_OUTPUT_BYTES) {
      const id = message && validId(message.id) ? message.id : null;
      line = `${JSON.stringify(errorResponse(id, INTERNAL_ERROR, 'Response too large.'))}\n`;
    }
    outQueue.push(line);
    if (outQueue.length > MAX_OUTPUT_QUEUE) {
      pauseInput();
    }
    drainOutput();
  }

  function cancelRequest(params) {
    if (!isPlainObject(params) || !validId(params.requestId)) {
      return;
    }
    const entry = pending.get(params.requestId);
    if (entry) {
      entry.cancelled = true;
    }
  }

  function handleNotification(method, params) {
    if (method === 'notifications/cancelled' || method === 'cancelled') {
      cancelRequest(params);
    }
    // Initialized and all other notifications need no response.
  }

  function handleToolCall(id, params) {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      enqueue(errorResponse(id, INVALID_PARAMS, 'Invalid params.'));
      return;
    }
    const tool = TOOLS.get(params.name);
    if (!tool) {
      enqueue(errorResponse(id, INVALID_PARAMS, 'Unknown tool.'));
      return;
    }

    const args = params.arguments;
    if (args !== undefined && args !== null) {
      if (!isPlainObject(args) || Object.keys(args).length !== 0) {
        enqueue(errorResponse(id, INVALID_PARAMS, 'Invalid params.'));
        return;
      }
    }

    if (pending.has(id)) {
      enqueue(errorResponse(id, INVALID_REQUEST, 'Duplicate request id.'));
      return;
    }

    const entry = { cancelled: false };
    pending.set(id, entry);
    inflight += 1;

    Promise.resolve()
      .then(() => tool.run(getCapabilities))
      .then((result) => {
        if (!entry.cancelled && !failed) {
          enqueue(response(id, result));
        }
      })
      .catch(() => {
        if (!entry.cancelled && !failed) {
          enqueue(response(id, toolErrorResult(undefined)));
        }
      })
      .finally(() => {
        pending.delete(id);
        inflight -= 1;
        maybeResume();
        checkDone();
      });
  }

  function handleRequest(id, method, params) {
    if (method === 'initialize') {
      if (!isPlainObject(params) ||
          typeof params.protocolVersion !== 'string') {
        enqueue(errorResponse(id, INVALID_PARAMS, 'Invalid params.'));
        return;
      }
      // Echo a version we implement; otherwise offer our latest supported
      // version so newer clients can negotiate down.
      const negotiated = params.protocolVersion === PROTOCOL_VERSION
        ? params.protocolVersion
        : PROTOCOL_VERSION;
      enqueue(response(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Use alpi_capabilities to read the authorized context capabilities.',
      }));
      return;
    }

    if (method === 'ping') {
      enqueue(response(id, {}));
      return;
    }

    if (method === 'tools/list') {
      enqueue(response(id, {
        tools: Array.from(TOOLS.values(), (entry) => entry.definition),
      }));
      return;
    }

    if (method === 'tools/call') {
      handleToolCall(id, params);
      return;
    }

    enqueue(errorResponse(id, METHOD_NOT_FOUND, 'Method not found.'));
  }

  function handleMessage(message) {
    if (Array.isArray(message)) {
      enqueue(errorResponse(null, INVALID_REQUEST, 'Invalid request.'));
      return;
    }
    if (!isPlainObject(message)) {
      enqueue(errorResponse(null, INVALID_REQUEST, 'Invalid request.'));
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id : undefined;
    const idOk = !hasId || validId(id);

    if (message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string' ||
        !idOk) {
      const errorId = hasId && idOk ? id : null;
      enqueue(errorResponse(errorId, INVALID_REQUEST, 'Invalid request.'));
      return;
    }

    if (!hasId) {
      handleNotification(message.method, message.params);
      return;
    }

    handleRequest(id, message.method, message.params);
  }

  function processFrame(frame) {
    if (frame.length === 0) {
      return;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
    } catch {
      enqueue(errorResponse(null, PARSE_ERROR, 'Invalid UTF-8.'));
      return;
    }
    if (text.trim().length === 0) {
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      enqueue(errorResponse(null, PARSE_ERROR, 'Parse error.'));
      return;
    }
    handleMessage(message);
  }

  function pump() {
    if (pumping || failed || finished) {
      return;
    }
    pumping = true;
    try {
      while (!failed) {
        if (inflight >= MAX_INFLIGHT ||
            outQueue.length >= MAX_OUTPUT_QUEUE) {
          pauseInput();
          break;
        }

        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          if (buffer.length > MAX_INPUT_BYTES) {
            buffer = Buffer.alloc(0);
            discarding = true;
            enqueue(errorResponse(null, PARSE_ERROR, 'Message too large.'));
          }
          break;
        }

        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (frame.length > MAX_INPUT_BYTES) {
          enqueue(errorResponse(null, PARSE_ERROR, 'Message too large.'));
          continue;
        }
        processFrame(frame);
      }
    } finally {
      pumping = false;
    }
    if (!failed) {
      maybeResume();
      checkDone();
    }
  }

  function onData(chunk) {
    if (failed || inputEnded) {
      return;
    }
    let data;
    try {
      data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } catch {
      fail();
      return;
    }
    if (discarding) {
      const newline = data.indexOf(0x0a);
      if (newline === -1) {
        return;
      }
      discarding = false;
      data = data.subarray(newline + 1);
      if (data.length === 0) {
        return;
      }
    }
    buffer = buffer.length === 0
      ? data
      : Buffer.concat([buffer, data]);
    pump();
  }

  function onEnd() {
    if (inputEnded) {
      return;
    }
    inputEnded = true;
    if (failed) {
      return;
    }

    if (discarding) {
      discarding = false;
      buffer = Buffer.alloc(0);
    } else if (buffer.length > 0) {
      const trailing = buffer;
      buffer = Buffer.alloc(0);
      if (trailing.length > MAX_INPUT_BYTES) {
        enqueue(errorResponse(null, PARSE_ERROR, 'Message too large.'));
      } else {
        processFrame(trailing);
      }
    }

    pump();
    checkDone();
  }

  function onInputClose() {
    if (!inputEnded) {
      onEnd();
    }
  }

  function onInputError() {
    fail();
  }

  function onOutputError() {
    fail();
  }

  function onOutputClose() {
    if (!finished) {
      fail();
    }
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onInputClose);
  input.on('error', onInputError);
  output.on('error', onOutputError);
  output.on('close', onOutputClose);

  // A stream may already have ended or failed before the bridge attached.
  if (output.destroyed || output.writableEnded) {
    queueMicrotask(fail);
  } else if (input.readableEnded || input.destroyed) {
    queueMicrotask(onEnd);
  }

  return done;
}

module.exports = {
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  runMcp,
};
