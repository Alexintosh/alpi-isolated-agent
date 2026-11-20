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

module.exports = { canCall, matchResource, resourceRequest };
