'use strict';

const { openWorkStore } = require('./work-store.cjs');

const maxEventPageBytes = 48 * 1024;

function publicJob(job) {
  const { jobId, project, workspaceId, sessionUuid, disposition, createdAt, updatedAt } = job;
  return { jobId, project, workspaceId, sessionUuid, disposition, createdAt, updatedAt };
}

function publicEvents(page, after) {
  const events = [];
  let bytes = 0;
  for (const event of page.events) {
    const { type, seq, jobId, createdAt, data } = event;
    const item = { type, seq, jobId, createdAt };
    // Only the normalized text emitted by the job adapter is part of the public event contract.
    if (typeof data?.text === 'string') {
      item.untrustedText = data.text.slice(0, 2048);
      item.truncated = item.untrustedText.length !== data.text.length;
    }
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > maxEventPageBytes) break;
    events.push(item);
    bytes += size;
  }
  return { events, nextSeq: events.at(-1)?.seq ?? (page.events.length ? after : page.nextSeq),
    firstSeq: page.firstSeq, lastSeq: page.lastSeq, gap: page.gap, reset: page.reset };
}

function openHostResources({ stateDir, limits, services = {} }) {
  const store = openWorkStore(stateDir, { limits });
  return {
    async execute(request) {
      const { name, principal, params } = request;
      switch (name) {
        case 'listSandboxes':
          return { sandboxes: store.listSandboxes(principal) };
        case 'getSandbox':
          return store.getSandbox(principal, params.sandboxId);
        case 'getJob':
          return publicJob(store.getJob(principal, params.jobId));
        case 'getEvents': {
          const after = Number(params.after);
          return publicEvents(store.pollJobEvents(principal, { jobId: params.jobId, afterSeq: after }), after);
        }
        default:
          if (Object.hasOwn(services, name)) return services[name](request, store);
          throw Object.assign(new Error('Requested service unavailable.'),
            { code: name === 'createSandbox' ? 'profile_unavailable' : 'service_unavailable' });
      }
    },
    close() { store.close(); },
  };
}

module.exports = { openHostResources };
