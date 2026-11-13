// Presentation only: imported endpoints add context, never authorization.
function pendingGroups(policy, providers = []) {
  const groups = new Map();
  for (const event of policy?.events ?? []) {
    if (event.status !== 'pending') continue;
    const key = JSON.stringify([event.environmentId, event.scheme, event.host, event.port, event.method]);
    let group = groups.get(key);
    if (!group) {
      const inference = providers.filter(provider => {
        try {
          const url = new URL(provider.baseURL);
          return url.hostname === event.host && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === event.port &&
            (event.scheme === 'connect' || url.protocol === event.scheme + ':');
        } catch { return false; }
      }).map(provider => ({ id: provider.id, name: provider.displayName ?? provider.id }));
      group = { key, environmentId: event.environmentId, scheme: event.scheme, host: event.host, port: event.port,
        method: event.method, ids: [], count: 0, expiresAt: event.expiresAt, inference };
      groups.set(key, group);
    }
    group.ids.push(event.id); group.count++;
    group.expiresAt = Math.min(group.expiresAt, event.expiresAt);
  }
  return [...groups.values()];
}
module.exports = { pendingGroups };
