'use strict';

function parseInterfaces(devContents) {
  const interfaces = [];
  for (const line of devContents.split('\n')) {
    const match = /^\s*([^:\s]+):/.exec(line);
    if (!match) {
      continue;
    }
    if (match[1] === 'Inter-' || match[1] === 'face') {
      continue;
    }
    interfaces.push(match[1]);
  }
  return interfaces;
}

function parseIPv4Routes(routeContents) {
  const routes = [];
  const lines = routeContents.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const fields = lines[index].trim().split(/\s+/);
    if (fields.length < 8 || fields[0] === '') {
      continue;
    }
    routes.push({ iface: fields[0], destination: fields[1], mask: fields[7] });
  }
  return routes;
}

function parseIPv6Routes(routeContents) {
  const routes = [];
  for (const line of routeContents.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[0] === '') {
      continue;
    }
    routes.push({
      destination: fields[0],
      prefixLength: Number.parseInt(fields[1], 16),
      iface: fields[9],
      reject: (Number.parseInt(fields[8], 16) & 0x200) !== 0,
    });
  }
  return routes;
}

function assertLoopbackOnly(interfaces, ipv4Routes, ipv6Routes, fail) {
  if (interfaces.length !== 1 || interfaces[0] !== 'lo') {
    fail('worker_network_unsafe', 'The worker namespace exposes a non-loopback interface.');
  }
  for (const entry of ipv4Routes) {
    if (entry.iface !== 'lo') {
      fail('worker_network_unsafe', 'The worker namespace has a non-loopback route.');
    }
    const destination = Number.parseInt(entry.destination, 16);
    const mask = Number.parseInt(entry.mask, 16);
    if (!Number.isFinite(destination) || !Number.isFinite(mask)) {
      fail('worker_network_unsafe', 'The worker namespace route is not readable.');
    }
    if (mask === 0 || (destination & 0xff) !== 0x7f || mask !== 0xff) {
      fail('worker_network_unsafe', 'The worker namespace has a non-loopback route.');
    }
  }
  for (const entry of ipv6Routes) {
    if (entry.iface !== 'lo') {
      fail('worker_network_unsafe', 'The worker namespace has a non-loopback route.');
    }
    // Linux lists an unreachable default on lo even in a new isolated namespace.
    if (entry.reject) continue;
    if (entry.prefixLength === 0) {
      fail('worker_network_unsafe', 'The worker namespace has an IPv6 default route.');
    }
    const isLoopback = /^0{31}1$/.test(entry.destination) && entry.prefixLength === 128;
    const isMulticast = /^ff/.test(entry.destination);
    if (!isLoopback && !isMulticast) {
      fail('worker_network_unsafe', 'The worker namespace has a non-loopback IPv6 route.');
    }
  }
}

module.exports = { parseInterfaces, parseIPv4Routes, parseIPv6Routes, assertLoopbackOnly };
