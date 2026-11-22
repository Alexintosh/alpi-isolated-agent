'use strict';

// This table is shipped in both control packages. Only the server assigns a principal.
const operations = [
  ['listSandboxes', 'GET', 'sandboxes', 'observer'],
  ['createSandbox', 'POST', 'sandboxes', 'runner'],
  ['getSandbox', 'GET', 'sandboxes/:sandboxId', 'observer'],
  ['startSandbox', 'POST', 'sandboxes/:sandboxId/start', 'runner'],
  ['stopSandbox', 'POST', 'sandboxes/:sandboxId/stop', 'runner'],
  ['deleteSandbox', 'POST', 'sandboxes/:sandboxId/delete', 'operator'],
  ['deleteSandbox', 'DELETE', 'sandboxes/:sandboxId', 'operator'],
  ['exec', 'POST', 'sandboxes/:sandboxId/exec', 'runner'],
  ['submitJob', 'POST', 'sandboxes/:sandboxId/jobs', 'runner'],
  ['getJob', 'GET', 'jobs/:jobId', 'observer'],
  ['getEvents', 'GET', 'jobs/:jobId/events/:after', 'observer'],
  ['sendMessage', 'POST', 'jobs/:jobId/messages', 'runner'],
  ['cancelJob', 'POST', 'jobs/:jobId/cancel', 'runner'],
  ['beginUpload', 'POST', 'artifacts', 'runner'],
  ['appendChunk', 'POST', 'artifacts/:artifactId/chunks', 'runner'],
  ['finishUpload', 'POST', 'artifacts/:artifactId/finish', 'runner'],
  ['getArtifact', 'GET', 'artifacts/:artifactId', 'observer'],
  ['readChunk', 'GET', 'artifacts/:artifactId/chunks/:offset', 'runner'],
  ['acknowledge', 'POST', 'artifacts/:artifactId/acknowledge', 'runner'],
  ['importArtifact', 'POST', 'sandboxes/:sandboxId/imports', 'runner'],
  ['exportArtifact', 'POST', 'sandboxes/:sandboxId/exports', 'runner'],
  ['issueTicket', 'POST', 'sandboxes/:sandboxId/terminal-tickets', 'operator'],
].map(([name, method, path, role]) => Object.freeze({ name, method, parts: Object.freeze(path.split('/')), role }));

const resourceStatus = Object.freeze({
  invalid_input: 400, forbidden: 403, not_found: 404,
  lease_held: 409, lease_missing: 409, lease_stale: 409, lease_expired: 409,
  generation_conflict: 409, invalid_transition: 409, idempotency_conflict: 409,
  engine_identity_conflict: 409, exec_cancelled: 409, queue_full: 429,
  engine_unavailable: 503, engine_unqualified: 503, network_unavailable: 503,
  engine_unsupported: 422, engine_uncertain: 503, operation_timeout: 504, exec_uncertain: 504,
  exec_failed: 502, journal_busy: 503, service_closed: 503,
  writer_fenced: 423,
  export_required: 409, payload_too_large: 413, quota_exceeded: 429,
  invalid_size: 400, invalid_digest: 400, invalid_chunk: 400, invalid_offset: 400,
  offset_mismatch: 409, conflict: 409, not_ready: 409, incomplete: 409,
  digest_mismatch: 422, artifact_failed: 409, upload_expired: 410, chunk_limit: 413,
  profile_unavailable: 503, model_unavailable: 503, unavailable_engine: 503,
  runtime_unavailable: 503, service_unavailable: 503, store_busy: 503, store_unavailable: 503,
});

function matchesResourceError(code, status) {
  return typeof code === 'string' && Object.hasOwn(resourceStatus, code) && resourceStatus[code] === status;
}

const roles = Object.freeze({ observer: 1, runner: 2, operator: 3 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validPart(key, value) {
  if (key === 'after' || key === 'offset') {
    return typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value));
  }
  return typeof value === 'string' && uuid.test(value);
}

function canCall(role, minimum) {
  return Object.hasOwn(roles, role) && Object.hasOwn(roles, minimum) && roles[role] >= roles[minimum];
}

function matchResource(method, rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/v1/')) return null;
  // The pinned transport uses path segments. Also accept the documented HTTP cursor.
  const query = /^(\/v1\/jobs\/[0-9a-f-]+\/events)(?:\?after=([0-9]+))?$/i.exec(rawPath);
  const path = query ? query[1] + '/' + (query[2] ?? '0') : rawPath;
  const parts = path.slice(4).split('/');
  const allow = [];
  for (const route of operations) {
    if (parts.length !== route.parts.length) continue;
    const params = {};
    const matches = route.parts.every((part, index) => {
      if (!part.startsWith(':')) return part === parts[index];
      const key = part.slice(1);
      if (!validPart(key, parts[index])) return false;
      params[key] = parts[index];
      return true;
    });
    if (!matches) continue;
    if (route.method === method) return { name: route.name, role: route.role, params };
    allow.push(route.method);
  }
  return allow.length ? { allow } : null;
}

function resourceRequest(name, params = {}) {
  const route = operations.find(entry => entry.name === name);
  if (!route || !params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Invalid resource request.');
  const keys = route.parts.filter(part => part.startsWith(':')).map(part => part.slice(1));
  if (Object.keys(params).length !== keys.length || keys.some(key => !Object.hasOwn(params, key) || !validPart(key, params[key]))) {
    throw new TypeError('Invalid resource identifiers.');
  }
  return { method: route.method, path: '/v1/' + route.parts.map(part => part.startsWith(':') ? params[part.slice(1)] : part).join('/') };
}

module.exports = { canCall, matchResource, resourceRequest, resourceStatus, matchesResourceError };
