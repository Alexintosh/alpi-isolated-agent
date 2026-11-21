'use strict';

const fs = require('node:fs/promises');

// The PID is supplied by the process owner that spawned the verified Iron binary.
// Linux exposes the network namespace's listening sockets and the owning process's
// open descriptors separately. Both must identify the same loopback socket.
async function ownsLoopbackListener(pid, port) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0 ||
      !Number.isInteger(port) || port < 1 || port > 65535) return false;

  const proc = '/proc/' + pid;
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  try {
    const [ourNamespace, ownerNamespace, table] = await Promise.all([
      fs.readlink('/proc/self/ns/net'), fs.readlink(proc + '/ns/net'), fs.readFile(proc + '/net/tcp', 'utf8'),
    ]);
    if (ourNamespace !== ownerNamespace) return false;
    const local = '0100007F:' + portHex;
    const wildcard = '00000000:' + portHex;
    const listeners = table.trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
      .filter(row => row[3] === '0A' && (row[1] === local || row[1] === wildcard));
    if (listeners.length !== 1 || listeners[0][1] !== local || !/^[1-9][0-9]*$/.test(listeners[0][9])) return false;
    const socket = 'socket:[' + listeners[0][9] + ']';
    for (const fd of await fs.readdir(proc + '/fd')) {
      try {
        if (await fs.readlink(proc + '/fd/' + fd) === socket) return true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } catch {
    // A private procfs, exited process or inaccessible namespace cannot establish ownership.
  }
  return false;
}

module.exports = { ownsLoopbackListener };
