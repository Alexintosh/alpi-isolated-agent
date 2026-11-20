'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');

async function kvmDevice() {
  if (process.platform !== 'linux') return 'unsupported-platform';
  let fd;
  try {
    fd = await fs.open('/dev/kvm', constants.O_RDWR | constants.O_NOFOLLOW);
    return (await fd.stat()).isCharacterDevice() ? 'accessible' : 'unexpected-file-type';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission-denied';
    throw error;
  } finally {
    await fd?.close();
  }
}

async function inspectHost(directory) {
  const [disk, kvm, systemd, netns] = await Promise.all([
    fs.statfs(directory, { bigint: true }),
    kvmDevice(),
    fs.stat('/run/systemd/system').then(s => s.isDirectory(), () => false),
    fs.readlink('/proc/self/ns/net').then(s => s.startsWith('net:['), () => false),
  ]);
  return {
    platform: process.platform,
    architecture: process.arch,
    kernel: os.release(),
    node: process.versions.node,
    cpuCount: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    availableDiskBytes: (disk.bavail * disk.bsize).toString(),
    systemd,
    networkNamespaceVisible: netns,
    kvm,
  };
}

module.exports = { inspectHost };
