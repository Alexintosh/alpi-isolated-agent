'use strict';

// Paired job workflow tools advertised by the stdio MCP bridge. Each tool is a
// thin, bounded projection of one shared packaged route: the client library
// owns identity, pinning and validation, the server owns admission and
// authorization, and this module only shapes arguments and maps failures to
// short, safe tool messages. Nothing here interprets guest or server payload
// data; every result is untrusted output for the caller.

// JSON-Schema patterns compile without flags, so case-insensitivity is
// spelled out in the source: the server route regex accepts both cases and
// local validation must not fail closed on uppercase UUIDs.
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i;
const ENGINE_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_PAYLOAD_JSON_BYTES = 16 * 1024;
// The shared events route bounds its page to 100 events; advertising a
// larger client maximum would silently do nothing beyond the server bound.
const MAX_EVENT_PAGE = 100;

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

function createJobWorkTools(client) {
  if (!client || typeof client.requestResource !== 'function') {
    throw new Error('Invalid job work tool client.');
  }
  const tools = new Map();
  for (const definition of JOB_TOOL_DEFINITIONS) {
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
          if (definition.name === 'alpi_job_submit') {
            const body = { requestId: input.requestId, engine: input.engine };
            if (input.payload !== undefined) body.payload = input.payload;
            return result(await client.requestResource(
              'submitJob', { sandboxId: input.sandboxId }, body));
          }
          if (definition.name === 'alpi_job_get') {
            return result(await client.requestResource('getJob', { jobId: input.jobId }));
          }
          if (definition.name === 'alpi_job_events') {
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
          }
          return result(await client.requestResource(
            'lookupJob', {}, { requestId: input.requestId }));
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

