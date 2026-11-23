#!/usr/bin/env node
'use strict';

const {
  ContextError,
  openStore,
  parseInviteEnvelope,
  readInviteFile,
  readProtectedStdin,
  validateContextName,
} = require('../src/context.cjs');
const { ClientError, createClient, pairClient } = require('../src/client.cjs');
const { createJobWorkTools } = require('../src/work-tools.cjs');

const USAGE = `Usage: alpi <command> [options]

Commands:
  alpi pair --name NAME [--invite-file FILE]
      Exchange an invitation and save an encrypted context under NAME.
      NAME must be 1-64 lowercase characters [a-z0-9._-], must not contain
      ".." and must not end with a dot.
      Without --invite-file, protected JSON is read from piped stdin.
      Interactive terminals are refused so the invitation is never echoed.

  alpi capabilities --context NAME
      Fetch and print the server capabilities for a stored context.

  alpi mcp --context NAME
      Run the stdio MCP bridge for a stored context.

  alpi --help
      Show this help.

Environment:
  ALPI_CONFIG_DIR         Private configuration directory. Defaults to
                          $XDG_CONFIG_HOME/alpi or the platform user config
                          directory (macOS: ~/Library/Application Support/alpi).
  ALPI_CONTEXT_KEY_FILE   Absolute path to a separate owner-only regular file
                          containing exactly 32 random bytes. The file must be
                          outside ALPI_CONFIG_DIR and is never created,
                          discovered or prompted for automatically.
                          Example:
                            head -c 32 /dev/urandom > ~/.config/alpi.key
                            chmod 600 ~/.config/alpi.key

Invitation envelope:
  {"origin":"https://...","serverId":"<uuid>","fingerprint":"<sha256>",
   "invitation":"<base64url token>","expiresAt":<integer Unix ms>}

Safety:
  Invitations and credentials are never accepted on the command line.
  Pairing pins the TLS certificate, compares the advertised server identity
  with the invitation before sending the invitation, and validates all server
  responses. Existing contexts are never overwritten.
  A local reservation prevents two pairs from racing on the same NAME. If a
  pairing is interrupted after the exchange request, the reservation is kept:
  do not retry that invitation. Check the server client list, revoke any newly
  created client, remove the reservation file only when no alpi process is
  pairing, then issue a fresh invitation.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function parseOptions(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      throw new UsageError('help requested');
    }
    if (!arg.startsWith('--') || !allowed.includes(arg)) {
      throw new UsageError('unknown option');
    }
    if (Object.prototype.hasOwnProperty.call(options, arg)) {
      throw new UsageError('duplicate option');
    }
    if (i + 1 >= args.length) {
      throw new UsageError(`missing value for ${arg}`);
    }
    const value = args[i + 1];
    if (value.length === 0 || value.startsWith('--')) {
      throw new UsageError(`missing value for ${arg}`);
    }
    options[arg] = value;
    i += 1;
  }
  return options;
}

function requireOption(options, name) {
  if (!Object.prototype.hasOwnProperty.call(options, name)) {
    throw new UsageError(`missing required option: ${name}`);
  }
  return options[name];
}

function safeMessage(error) {
  if (error instanceof UsageError) {
    return error.message;
  }
  if (error instanceof ContextError || error instanceof ClientError) {
    return error.message;
  }
  return 'Unexpected failure.';
}

function writeStdout(text) {
  process.stdout.write(text);
}

function writeStderr(text) {
  process.stderr.write(text);
}

async function runPair(args) {
  const options = parseOptions(args, ['--name', '--invite-file']);
  const name = requireOption(options, '--name');
  validateContextName(name);

  let raw;
  if (Object.prototype.hasOwnProperty.call(options, '--invite-file')) {
    raw = readInviteFile(options['--invite-file']);
  } else {
    raw = readProtectedStdin();
  }
  const envelope = parseInviteEnvelope(raw, { now: Date.now() });

  const store = openStore();
  try {
    const result = await pairClient({ envelope, name, store });
    const expires = new Date(result.expiresAt).toISOString();
    writeStdout([
      `Paired context ${result.name}.`,
      `Server ID: ${result.serverId}`,
      `Client ID: ${result.clientId}`,
      `Project: ${result.project}`,
      `Role: ${result.role}`,
      `Credential expires: ${expires} (${result.expiresAt})`,
      '',
    ].join('\n'));

    if (!result.reservationRemoved) {
      writeStderr(
        `Warning: the pairing reservation at ${result.reservationPath} ` +
        'could not be removed. Remove it only when no alpi process is pairing.\n',
      );
    }
  } finally {
    store.close();
  }
}

async function runCapabilities(args) {
  const options = parseOptions(args, ['--context']);
  const contextName = requireOption(options, '--context');
  validateContextName(contextName);

  const store = openStore();
  try {
    const context = store.get(contextName);
    if (!context) {
      throw new ContextError('CONTEXT_NOT_FOUND', 'Context not found.');
    }
    const client = createClient(context);
    const capabilities = await client.getCapabilities();
    writeStdout(`${JSON.stringify(capabilities, null, 2)}\n`);
  } finally {
    store.close();
  }
}

async function runMcp(args) {
  const options = parseOptions(args, ['--context']);
  const contextName = requireOption(options, '--context');
  validateContextName(contextName);

  const store = openStore();
  try {
    const context = store.get(contextName);
    if (!context) {
      throw new ContextError('CONTEXT_NOT_FOUND', 'Context not found.');
    }
    const client = createClient(context);

    let mcp;
    try {
      // The MCP bridge is optional and loaded only for this command.
      mcp = require('../src/mcp.cjs');
    } catch (error) {
      if (error && error.code === 'MODULE_NOT_FOUND' &&
          /mcp\.cjs/.test(String(error.message))) {
        throw new ContextError(
          'MCP_UNAVAILABLE',
          'MCP support is unavailable.',
        );
      }
      throw new ContextError('MCP_UNAVAILABLE', 'MCP support failed to load.');
    }
    if (!mcp || typeof mcp.runMcp !== 'function') {
      throw new ContextError('MCP_UNAVAILABLE', 'MCP support is unavailable.');
    }

    try {
      await mcp.runMcp({
        getCapabilities: () => client.getCapabilities(),
        listSandboxes: () => client.requestResource('listSandboxes'),
        workTools: createJobWorkTools(client),
        input: process.stdin,
        output: process.stdout,
      });
    } catch {
      throw new ContextError('MCP_FAILED', 'MCP bridge failed.');
    }
  } finally {
    store.close();
  }
}

async function main(argv) {
  if (argv.length === 0) {
    writeStderr(USAGE);
    return 2;
  }

  const command = argv[0];
  if (command === '--help' || command === '-h' || command === 'help' ||
      argv.includes('--help')) {
    writeStdout(USAGE);
    return 0;
  }

  try {
    if (command === 'pair') {
      await runPair(argv.slice(1));
      return 0;
    }
    if (command === 'capabilities') {
      await runCapabilities(argv.slice(1));
      return 0;
    }
    if (command === 'mcp') {
      await runMcp(argv.slice(1));
      return 0;
    }
    throw new UsageError('unknown command');
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message !== 'help requested') {
        writeStderr(`alpi: ${error.message}\n\n${USAGE}`);
      } else {
        writeStdout(USAGE);
      }
      return error.message === 'help requested' ? 0 : 2;
    }
    let message = safeMessage(error);
    if (error && typeof error.reservationPath === 'string' &&
        !message.includes(error.reservationPath)) {
      message += ` Reservation file: ${error.reservationPath}.`;
    }
    writeStderr(`alpi: ${message}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch(() => {
  writeStderr('alpi: Unexpected failure.\n');
  process.exitCode = 1;
});
