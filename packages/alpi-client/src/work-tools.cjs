'use strict';

const { createHash } = require('node:crypto');

// Paired job workflow tools advertised by the stdio MCP bridge. Each tool is a
// thin, bounded projection of one shared packaged route: the client library
// owns identity, pinning and validation, the server owns admission and
// authorization, and this module only shapes arguments and maps failures to
// short, safe tool messages. Nothing here interprets guest or server payload
// data; every result is untrusted output for the caller.

// ---- Validation constants ----
// Hand-rolled, dependency-free bounds following the packaged server
// routes without importing server code, with a deliberately tighter
// 16 KiB local payload cap that fails closed before the server's 64 KiB bounds.

// JSON-Schema patterns compile without flags, so case-insensitivity is
// spelled out in the source: the server route regex accepts both cases
// (job-service.cjs uses the same shape with the /i flag) and local
// validation must not fail closed on uppercase UUIDs.
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i;

// Engine identifiers use the server's own ENGINE_ID_PATTERN
// (job-service.cjs), so a locally rejected engine can never be admitted.
const ENGINE_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

// Job payloads travel inside the submit request body, bounded as a whole
// by the resource POST route's inline 64 * 1024 limit (daemon.cjs), then
// by the work store's 64 KiB payload bound (MAX_JSON_BYTES in work-store.cjs).
// The daemon's MAX_BODY_BYTES = 8192 applies only to pairing enrollment.
// The deliberately tighter 16 KiB local cap bounds serialization before
// any round trip; the server remains the admission authority.
const MAX_PAYLOAD_JSON_BYTES = 16 * 1024;

// The shared events route takes no caller limit: it pages at most
// DEFAULT_POLL_LIMIT = 100 events (work-store.cjs), so a larger client
// maximum would silently do nothing beyond the server bound.
const MAX_EVENT_PAGE = 100;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_PAGE = 8;

const uuidField = (description) => ({
  type: 'string', description: description + ' At most 36 UTF-8 bytes.',
  minLength: 36, maxLength: 36, pattern: UUID_PATTERN.source,
});

const JOB_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'alpi_job_submit',
    description:
      'Submit one job to a sandbox in the paired project on an explicit engine. ' +
      'Reusing requestId never resubmits uncertain work: a replay with the same ' +
      'request key returns the existing job receipt.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        sandboxId: uuidField('Sandbox identifier from the paired project.'),
        engine: {
          type: 'string',
          description: 'Explicit engine identifier required by the server.',
          minLength: 2, maxLength: 64, pattern: ENGINE_PATTERN.source,
        },
        requestId: uuidField('Caller-generated UUID for this submission.'),
        payload: {
          type: 'object',
          description: 'Bounded job payload for the engine. At most 16384 UTF-8 bytes as JSON.',
        },
      }),
      required: ['sandboxId', 'engine', 'requestId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'alpi_job_get',
    description: 'Read one job receipt in the paired project by job ID.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ jobId: uuidField('Job identifier.') }),
      required: ['jobId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'alpi_job_events',
    description:
      'Read a bounded page of ordered job events after an exclusive cursor. ' +
      'Pass the returned nextSeq as after on the next read; when limit trims ' +
      'the server page, nextSeq tracks the last returned event so resuming ' +
      'skips nothing. Reset or gap flags mean the cursor no longer matches ' +
      'the retained stream.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        jobId: uuidField('Job identifier.'),
        after: {
          type: 'integer',
          description: 'Exclusive observation cursor from a previous read. Defaults to 0.',
          minimum: 0,
        },
        limit: {
          type: 'integer',
          description: 'Maximum events in the page. Defaults to the server page bound.',
          minimum: 1, maximum: MAX_EVENT_PAGE,
        },
      }),
      required: ['jobId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'alpi_job_outputs',
    description:
      'Retrieve job output bytes from GET /v1/jobs/:jobId/outputs and the artifact routes. ' +
      'Returns untrusted base64 data with verified sha256 and totalLength. ' +
      'At most 8 artifacts and 32768 decoded bytes per page. Resume at nextOffset when truncated.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        jobId: uuidField('Job identifier.'),
        offset: { type: 'integer', description: 'Output list offset. Defaults to 0.', minimum: 0 },
        limit: { type: 'integer', description: 'Maximum artifacts. Defaults to 4.',
          minimum: 1, maximum: MAX_OUTPUT_PAGE },
      }),
      required: ['jobId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'alpi_job_lookup',
    description:
      'Resolve one job by its original submission request key after a lost reply. ' +
      'This is the reconnect receipt source; never submit again with a new key ' +
      'before looking up the original one.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ requestId: uuidField('Original submission request key.') }),
      required: ['requestId'],
      additionalProperties: false,
    }),
  }),
]);

// Failures map to a small fixed vocabulary. Upstream bodies never reach tool
// output; a validated shared route code is the only server detail retained.
function toolFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code === 'CREDENTIAL_EXPIRED') {
    return 'The client credential has expired.';
  }
  if (code === 'HTTP_STATUS') {
    const status = error && error.statusCode;
    const resourceCode = error && typeof error.resourceCode === 'string' &&
      RESOURCE_CODES.has(error.resourceCode) ? error.resourceCode : undefined;
    if (status === 401) {
      return 'The server rejected the credential. The client may have been revoked.';
    }
    if (status === 403) {
      return 'The server denied access to this job operation.';
    }
    if (status === 429) {
      return 'The server rate limited or refused admission for capacity.';
    }
    if (resourceCode !== undefined) {
      return 'The server refused the job request (' + resourceCode + ').';
    }
    return 'The server rejected the job request.';
  }
  if (code === 'CONNECTION_ERROR') {
    return 'Could not connect to the Alpi server.';
  }
  if (code === 'CONNECTION_CLOSED') {
    return 'The connection closed before the job response was received.';
  }
  if (code === 'TIMEOUT') {
    return 'The job request timed out.';
  }
  if (code === 'TLS_CERT_INVALID' || code === 'TLS_PIN_MISMATCH') {
    return 'TLS verification failed.';
  }
  if (code === 'INVALID_RESPONSE' ||
      code === 'SERVER_ID_MISMATCH' ||
      code === 'SERVER_RESPONSE_MISMATCH') {
    return 'The server returned an invalid response.';
  }
  return 'The job request failed.';
}

const RESOURCE_CODES = new Set([
  'invalid_input', 'forbidden', 'not_found', 'lease_held', 'lease_missing',
  'lease_stale', 'lease_expired', 'generation_conflict', 'invalid_transition',
  'idempotency_conflict', 'engine_identity_conflict', 'exec_cancelled',
  'queue_full', 'engine_unavailable', 'engine_unqualified', 'network_unavailable',
  'engine_unsupported', 'engine_uncertain', 'operation_timeout', 'exec_uncertain',
  'exec_failed', 'journal_busy', 'service_closed', 'writer_fenced',
  'export_required', 'payload_too_large', 'quota_exceeded', 'conflict',
  'not_ready', 'incomplete', 'digest_mismatch', 'artifact_failed',
  'upload_expired', 'chunk_limit', 'profile_unavailable', 'model_unavailable',
  'unavailable_engine', 'runtime_unavailable', 'service_unavailable',
  'store_busy', 'store_unavailable',
]);

function invalidArguments() {
  const error = new Error('Invalid job tool arguments.');
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

function validate(args, definition) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw invalidArguments();
  }
  const schema = definition.inputSchema;
  if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) {
    throw invalidArguments();
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) throw invalidArguments();
  }
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (field.type === 'string') {
      if (typeof value !== 'string' ||
          value.length < field.minLength ||
          value.length > field.maxLength ||
          !new RegExp(field.pattern).test(value)) {
        throw invalidArguments();
      }
      out[key] = value;
      continue;
    }
    if (field.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < field.minimum ||
          value > (field.maximum ?? Number.MAX_SAFE_INTEGER)) {
        throw invalidArguments();
      }
      out[key] = value;
      continue;
    }
    if (field.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidArguments();
      }
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        throw invalidArguments();
      }
      if (typeof json !== 'string' ||
          Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_JSON_BYTES) {
        throw invalidArguments();
      }
      out[key] = value;
      continue;
    }
    throw invalidArguments();
  }
  return out;
}

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error) {
  return {
    content: [{ type: 'text', text: toolFailure(error) }],
    isError: true,
  };
}

function invalidResponse() {
  return Object.assign(new Error('Invalid job output response.'), { code: 'INVALID_RESPONSE' });
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameUuid = (a, b) => typeof a === 'string' && UUID_PATTERN.test(a) && a.toLowerCase() === b.toLowerCase();

async function jobOutputs(client, input) {
  const page = await client.requestResource('getJobArtifacts', { jobId: input.jobId });
  if (!page || !Array.isArray(page.artifacts) || page.count !== page.artifacts.length) throw invalidResponse();
  const artifacts = [];
  const offset = Math.min(input.offset ?? 0, page.count);
  let bytesReturned = 0;
  for (const row of page.artifacts.slice(offset, offset + (input.limit ?? 4))) {
    if (!row || !sameUuid(row.jobId, input.jobId) ||
        typeof row.artifactId !== 'string' || !UUID_PATTERN.test(row.artifactId) ||
        typeof row.label !== 'string' || !row.label.length || row.label.length > 128 ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(row.label) ||
        !Number.isSafeInteger(row.totalLength) || row.totalLength < 1 || row.totalLength > MAX_OUTPUT_BYTES ||
        !isDigest(row.sha256) || !Number.isSafeInteger(row.recordedAt) || row.recordedAt < 0) throw invalidResponse();
    if (bytesReturned + row.totalLength > MAX_OUTPUT_BYTES) break;
    const params = { artifactId: row.artifactId };
    const metadata = await client.requestResource('getArtifact', params);
    if (!metadata || !sameUuid(metadata.artifactId, row.artifactId) || metadata.state !== 'published' ||
        metadata.sha256 !== row.sha256 || metadata.totalLength !== row.totalLength) throw invalidResponse();
    const parts = [];
    let cursor = 0;
    while (cursor < row.totalLength) {
      const chunk = await client.requestResource('readChunk', { ...params, offset: String(cursor) });
      if (!chunk || !sameUuid(chunk.artifactId, row.artifactId) || chunk.offset !== cursor ||
          !Number.isSafeInteger(chunk.length) || chunk.length < 1 || cursor + chunk.length > row.totalLength ||
          !isDigest(chunk.sha256) || typeof chunk.data !== 'string' || !chunk.data.length ||
          chunk.data.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4 || chunk.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)) throw invalidResponse();
      const bytes = Buffer.from(chunk.data, 'base64');
      if (bytes.length !== chunk.length || bytes.toString('base64') !== chunk.data ||
          digest(bytes) !== chunk.sha256) throw invalidResponse();
      parts.push(bytes);
      cursor += bytes.length;
    }
    const bytes = Buffer.concat(parts, cursor);
    if (digest(bytes) !== row.sha256) throw invalidResponse();
    artifacts.push({ jobId: row.jobId, artifactId: row.artifactId, label: row.label,
      totalLength: bytes.length, sha256: row.sha256, recordedAt: row.recordedAt,
      encoding: 'base64', data: bytes.toString('base64') });
    bytesReturned += bytes.length;
  }
  const nextOffset = offset + artifacts.length;
  return result({ jobId: input.jobId, artifacts, count: page.count,
    nextOffset, truncated: nextOffset < page.count });
}

// One projection per advertised tool, keyed by tool name. Each handler is
// a thin, stateless shaping of one shared client route: input is already
// validated, results are the server's own projection, and the run wrapper
// below maps failures. Nothing here interprets guest or server payload
// data.
const JOB_TOOL_HANDLERS = Object.freeze({
  alpi_job_submit: async (client, input) => {
    const body = { requestId: input.requestId, engine: input.engine };
    if (input.payload !== undefined) body.payload = input.payload;
    return result(await client.requestResource(
      'submitJob', { sandboxId: input.sandboxId }, body));
  },
  alpi_job_get: async (client, input) =>
    result(await client.requestResource('getJob', { jobId: input.jobId })),
  alpi_job_events: async (client, input) => {
    const page = await client.requestResource('getEvents', {
      jobId: input.jobId, after: String(input.after ?? 0),
    });
    if (input.limit !== undefined && page && Array.isArray(page.events) &&
        page.events.length > input.limit) {
      const events = page.events.slice(0, input.limit);
      // The shared route's nextSeq tracks its own full page. The
      // trimmed result must resume from the last event it actually
      // returned, or a caller following nextSeq would silently skip
      // the trimmed tail. firstSeq, lastSeq, gap and reset describe
      // the retained stream, which the trim does not change.
      return result({
        ...page,
        events,
        nextSeq: events[events.length - 1].seq,
      });
    }
    return result(page);
  },
  alpi_job_lookup: async (client, input) =>
    result(await client.requestResource('lookupJob', {}, { requestId: input.requestId })),
  alpi_job_outputs: jobOutputs,
});

function createJobWorkTools(client) {
  if (!client || typeof client.requestResource !== 'function') {
    throw new Error('Invalid job work tool client.');
  }
  const tools = new Map();
  for (const definition of JOB_TOOL_DEFINITIONS) {
    const handler = JOB_TOOL_HANDLERS[definition.name];
    if (!handler) throw new Error('Missing job work tool handler.');
    tools.set(definition.name, {
      definition,
      run: async (args) => {
        let input;
        try {
          input = validate(args, definition);
        } catch {
          return {
            content: [{ type: 'text', text: 'Invalid job tool arguments.' }],
            isError: true,
          };
        }
        try {
          return await handler(client, input);
        } catch (error) {
          return failure(error);
        }
      },
    });
  }
  return tools;
}

module.exports = {
  createJobWorkTools,
};
