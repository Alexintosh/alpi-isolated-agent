'use strict';
const { Buffer } = require('node:buffer');

// Fixed English errors. Never echo caller-supplied values into a message.
const METADATA_ERROR = 'Invalid secret metadata.';
const NAME_ERROR = 'Invalid secret name.';
const ENVIRONMENT_ERROR = 'Unknown secret environment.';
const AUTH_TYPE_ERROR = 'Invalid secret auth type.';
const ORIGIN_ERROR = 'Invalid secret origin.';
const PATH_ERROR = 'Invalid secret path.';
const METHODS_ERROR = 'Invalid secret methods.';
const HEADER_ERROR = 'Invalid secret header.';
const USERNAME_ERROR = 'Invalid secret username.';
const VALUE_ERROR = 'Invalid secret value.';

const AUTH_TYPES = new Set(['bearer', 'api-key', 'basic']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_NAME = 80;
const MAX_PATH = 1024;
const MAX_HEADER = 64;
const MAX_USERNAME = 256;
const MAX_VALUE_BYTES = 8192;
// Characters that can never appear in an HTTPS origin: whitespace, backslash
// (the URL parser rewrites it as a slash), wildcards, userinfo '@', percent
// escapes (which normalize away dot segments and encoded separators), query and
// fragment delimiters (even when they are empty), and control characters.
const ORIGIN_FORBIDDEN = /[\s\\*%@?#\x00-\x1f\x7f]/;
// Valid DNS name / IPv4 literal, lowercased by the URL parser: labels of
// [a-z0-9-] that neither start nor end with a hyphen, optional trailing dot.
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/;
const IPV6_HOST = /^\[[0-9a-f:.]+(?:%[0-9a-z]+)?\]$/;
const PATH_CHARSET = /^[A-Za-z0-9_./~-]+$/;
const HEADER_CHARSET = /^x-[a-z0-9-]+$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validateName(value) {
  if (typeof value !== 'string') throw new Error(NAME_ERROR);
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME || CONTROL.test(value)) throw new Error(NAME_ERROR);
  return name;
}

function validateEnvironment(value, environmentIds) {
  if (!Array.isArray(environmentIds) || typeof value !== 'string' || !environmentIds.includes(value)) throw new Error(ENVIRONMENT_ERROR);
  return value;
}

function validateAuthType(value) {
  if (typeof value !== 'string' || !AUTH_TYPES.has(value)) throw new Error(AUTH_TYPE_ERROR);
  return value;
}

function validHostname(host) {
  if (host.length === 0 || host.length > 253) return false;
  if (host.startsWith('[')) return IPV6_HOST.test(host);
  return HOSTNAME.test(host) && host.replace(/\.$/, '').split('.').every(label => label.length <= 63);
}

function validateOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || ORIGIN_FORBIDDEN.test(value) || !value.startsWith('https://')) throw new Error(ORIGIN_ERROR);
  // After the authority, only a single optional trailing '/' may appear. The
  // URL parser silently drops empty delimiters and normalizes dot segments, so
  // the raw remainder is checked too.
  const rest = value.slice('https://'.length);
  const slash = rest.indexOf('/');
  if (!rest || (slash !== -1 && (slash === 0 || slash !== rest.length - 1))) throw new Error(ORIGIN_ERROR);
  let url;
  try { url = new URL(value); } catch { throw new Error(ORIGIN_ERROR); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || !validHostname(url.hostname)) throw new Error(ORIGIN_ERROR);
  return url.origin;
}

function validatePathPrefix(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH || value[0] !== '/' ||
      value[value.length - 1] !== '/' || value.includes('//') || !PATH_CHARSET.test(value)) throw new Error(PATH_ERROR);
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') throw new Error(PATH_ERROR);
  }
  return value;
}

function validateMethods(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(METHODS_ERROR);
  if (value.some(method => typeof method !== 'string' || !ALLOWED_METHODS.has(method))) throw new Error(METHODS_ERROR);
  if (new Set(value).size !== value.length) throw new Error(METHODS_ERROR);
  return value.slice();
}

function validateHeaderName(value) {
  if (typeof value !== 'string') throw new Error(HEADER_ERROR);
  value = value.toLowerCase();
  if (value.length === 0 || value.length > MAX_HEADER || !HEADER_CHARSET.test(value)) throw new Error(HEADER_ERROR);
  // Reserved host namespaces: the guest must never spoof bridge-owned headers.
  if (value.startsWith('x-isolated-') || value.startsWith('x-alpi-')) throw new Error(HEADER_ERROR);
  return value;
}

function validateUsername(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_USERNAME ||
      !PRINTABLE_ASCII.test(value) || value.includes(':')) throw new Error(USERNAME_ERROR);
  return value;
}

// Sanitized, detached secret metadata. All other input fields (id,
// credentialRef, value, ...) are dropped and never surface in output or errors.
function validateSecretMetadata(input, environmentIds) {
  if (!record(input)) throw new Error(METADATA_ERROR);
  const name = validateName(input.name);
  const environmentId = validateEnvironment(input.environmentId, environmentIds);
  const authType = validateAuthType(input.authType);
  const origin = validateOrigin(input.origin);
  const pathPrefix = validatePathPrefix(input.pathPrefix);
  const methods = validateMethods(input.methods);
  const headerName = authType === 'api-key' ? validateHeaderName(input.headerName) : '';
  const username = authType === 'basic' ? validateUsername(input.username) : '';
  return { name, environmentId, authType, origin, pathPrefix, methods, headerName, username };
}

// Plain secret values are bounded printable ASCII (whitespace preserved).
function validateSecretValue(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES ||
      !PRINTABLE_ASCII.test(value)) throw new Error(VALUE_ERROR);
  return value;
}

module.exports = { validateSecretMetadata, validateSecretValue };
