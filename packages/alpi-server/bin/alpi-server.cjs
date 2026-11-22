#!/usr/bin/env node
'use strict';

const HELP = `Usage:
  alpi-server --help
  alpi-server doctor --host [--state-dir DIR]
  alpi-server doctor --runtime --state-dir DIR
  alpi-server runtime install --engine boxlite --state-dir DIR [--profile NAME] [--profiles FILE]
  alpi-server runtime rollback --state-dir DIR
  alpi-server runtime list --state-dir DIR
  alpi-server profiles list --config FILE --project PROJECT
  alpi-server serve --state-dir DIR [--listen HOST] [--port PORT] [--origin URL] [--profiles FILE]
  alpi-server pair issue --state-dir DIR --project PROJECT --role ROLE
                         [--expires 5m] [--origin URL]
  alpi-server clients list --state-dir DIR
  alpi-server clients revoke CLIENT_ID --state-dir DIR

Commands:
  serve              Start the HTTPS API and the private administration socket.
                     Defaults: --listen 127.0.0.1 --port 7443.
  pair issue         Issue a single-use invitation and print one JSON envelope
                     containing origin, serverId, fingerprint, invitation and
                     expiresAt. Invitations expire after at most 5m.
  clients list       List enrolled clients from the private administration socket.
  clients revoke     Revoke one client by ID.

Options:
  --state-dir DIR    Private state directory (mode 0700) containing the pairing
                     database, TLS identity and administration socket.
  --listen HOST      HTTPS listen address. Default 127.0.0.1.
  --port PORT        HTTPS listen port, 0 selects an ephemeral port. Default 7443.
  --origin URL       Explicit reachable HTTPS origin advertised in the pairing
                     envelope. Must use https and contain no credentials, path,
                     query or fragment.
  --expires DURATION Invitation lifetime, for example 30s, 5m or 1h. Maximum 5m.
  --help, -h         Show this help.

The administration socket is a Unix socket at <state-dir>/admin.sock with mode
0600. Only local operator commands use it; it is never exposed over the network.
Invitation secrets are printed only by "pair issue" and are never written to
logs or passed as command-line arguments.`;

class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

function parseOptions(args, allowed) {
  const values = Object.create(null);
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (argument.startsWith('--')) {
      let name = argument.slice(2);
      let value;
      const equals = name.indexOf('=');
      if (equals >= 0) {
        value = name.slice(equals + 1);
        name = name.slice(0, equals);
      }
      if (!allowed.has(name)) {
        throw new CliUsageError(`Unknown option --${name}.`);
      }
      if (value === undefined) {
        if (index + 1 >= args.length) {
          throw new CliUsageError(`Missing value for --${name}.`);
        }
        value = args[index + 1];
        index += 1;
      }
      if (Object.hasOwn(values, name)) {
        throw new CliUsageError(`Duplicate option --${name}.`);
      }
      values[name] = value;
      continue;
    }
    if (argument.startsWith('-') && argument !== '-') {
      throw new CliUsageError(`Unknown option ${argument}.`);
    }
    positionals.push(argument);
  }

  return { values, positionals };
}

function requireValue(values, name) {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliUsageError(`Missing required option --${name}.`);
  }
  return value;
}

function parsePort(value) {
  if (value === undefined) {
    return 7443;
  }
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError('--port must be an integer from 0 to 65535.');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new CliUsageError('--port must be an integer from 0 to 65535.');
  }
  return port;
}

function parseExpires(value) {
  if (value === undefined) {
    return 5 * 60 * 1000;
  }
  const match = /^(\d+)(ms|s|m|h)$/i.exec(value);
  if (!match) {
    throw new CliUsageError(
      '--expires must be a duration such as 30s, 5m or 1h.'
    );
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const milliseconds = amount * multipliers[unit];
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > 5 * 60 * 1000
  ) {
    throw new CliUsageError('--expires must be greater than 0 and at most 5m.');
  }
  return milliseconds;
}

function printHelp() {
  process.stdout.write(`${HELP}\n`);
}

async function runServe(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(['state-dir', 'listen', 'port', 'origin', 'profiles'])
  );
  if (positionals.length > 0) {
    throw new CliUsageError('serve accepts no positional arguments.');
  }

  const stateDir = requireValue(values, 'state-dir');
  const listenHost = values.listen === undefined ? '127.0.0.1' : values.listen;
  const port = parsePort(values.port);
  const origin = values.origin;

  const { startServer } = require('../src/daemon.cjs');
  const { listRuntimes } = require('../src/runtime-installer.cjs');
  const { loadHostProfiles } = require('../src/profile-catalog.cjs');
  const catalog = await loadHostProfiles(values.profiles);
  const { openHostResources } = require('../src/host-resources.cjs');
  const server = await startServer({
    openResources: openHostResources,
    runtimeInventory: async principal => {
      const { runtimes } = await listRuntimes({ stateDir });
      const configured = catalog.forProject(principal.project);
      return runtimes.map(record => ({ ...record, configuredProfiles: record.active ?
        configured.filter(profile => profile.engine === record.engine) : [] }));
    },
    stateDir,
    listenHost,
    port,
    origin,
  });

  process.stderr.write(`alpi-server listening on ${server.origin}\n`);

  // The server keeps the process alive through its listeners. Signal handlers
  // installed by the daemon close those listeners and allow a clean exit.
  await new Promise(() => {});
}

async function runPairIssue(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(['state-dir', 'project', 'role', 'expires', 'origin'])
  );
  if (positionals.length > 0) {
    throw new CliUsageError('pair issue accepts no positional arguments.');
  }

  const stateDir = requireValue(values, 'state-dir');
  const project = requireValue(values, 'project');
  const role = requireValue(values, 'role');
  const expiresMs = parseExpires(values.expires);

  if (!new Set(['observer', 'runner', 'operator']).has(role)) {
    throw new CliUsageError(
      '--role must be observer, runner or operator.'
    );
  }
  if (project.length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(project)) {
    throw new CliUsageError('--project is invalid.');
  }

  const { issuePairing } = require('../src/admin-client.cjs');
  const envelope = await issuePairing({
    stateDir,
    project,
    role,
    expiresMs,
    origin: values.origin,
  });

  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

async function runClientsList(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(['state-dir'])
  );
  if (positionals.length > 0) {
    throw new CliUsageError('clients list accepts no positional arguments.');
  }

  const stateDir = requireValue(values, 'state-dir');
  const { listClients } = require('../src/admin-client.cjs');
  const result = await listClients({ stateDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runClientsRevoke(args) {
  const { values, positionals } = parseOptions(
    args,
    new Set(['state-dir'])
  );
  if (positionals.length !== 1) {
    throw new CliUsageError('clients revoke requires exactly one CLIENT_ID.');
  }

  const stateDir = requireValue(values, 'state-dir');
  const { revokeClient } = require('../src/admin-client.cjs');
  const result = await revokeClient({
    stateDir,
    clientId: positionals[0],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runRuntime(action, args) {
  const allowed = action === 'install' ? ['state-dir', 'engine', 'profile', 'profiles'] : ['state-dir'];
  const { values, positionals } = parseOptions(args, new Set(allowed));
  if (positionals.length) throw new CliUsageError('Unexpected runtime argument.');
  const stateDir = requireValue(values, 'state-dir');
  const installer = require('../src/runtime-installer.cjs');
  let result;
  if (action === 'install') {
    const engine = requireValue(values, 'engine');
    if (engine !== 'boxlite') throw new CliUsageError('The available runtime package is boxlite.');
    if (values.profiles && !values.profile) throw new CliUsageError('--profiles requires a named --profile.');
    let profile;
    if (values.profile) {
      const { loadHostProfiles } = require('../src/profile-catalog.cjs');
      profile = (await loadHostProfiles(values.profiles)).installedProfile(engine, values.profile);
    }
    // Preparation, including the required callback and any explicitly requested
    // image, runs against this exact candidate. Selection is committed once,
    // after all of it succeeds and a final cancellation check passes.
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      const callback = require('../src/network/callback-install.cjs');
      const images = require('../src/profile-image.cjs');
      // Core admission covers the candidate and a first callback install.
      // Pinned-image admission is separate: it is bounded by the profile's
      // declared image preparation footprint (never the guest disk limit),
      // credits a verified image cache, and runs inside ensureImage before
      // any pull once the candidate set is known.
      const additionalBytes = await callback.callbackAdmissionBytes(stateDir);
      const prepared = await installer.prepareRuntime({
        stateDir,
        engine,
        signal: controller.signal,
        additionalBytes,
      });
      const { digest } = await callback.ensureIronCallback(stateDir, {
        signal: controller.signal,
      });
      let image;
      if (profile) {
        image = await images.ensureImage({
          stateDir,
          profile,
          set: prepared.set,
          signal: controller.signal,
        });
      }
      controller.signal.throwIfAborted();
      result = await installer.commitRuntimeSelection({
        stateDir,
        set: prepared.set,
        signal: controller.signal,
      });
      result.ironCallback = { digest };
      if (image) result.profile = image;
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
  } else if (action === 'rollback') {
    result = await installer.rollbackRuntime({ stateDir });
  } else {
    result = await installer.listRuntimes({ stateDir });
    if (action === 'doctor') {
      result.verification = 'no-active-runtime';
      if (result.active) {
        await installer.verifyRuntime({ stateDir, set: result.active.id });
        result.verification = 'files-verified';
        result.kvm = (await require('../src/host-doctor.cjs').inspectHost(stateDir)).kvm;
      }
    }
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}

function safeErrorMessage(error) {
  if (!error || typeof error.message !== 'string') {
    return 'Command failed.';
  }
  const safeNames = new Set([
    'CliUsageError',
    'AdminClientError',
    'DaemonError',
    'IdentityError',
    'PairingStoreError',
  ]);
  if (error.name === 'ProfileError' && error.code === 'profile_unavailable') return 'Profile unavailable. Configure a pinned image in the host profile catalog.';
  if (error.name === 'RuntimeInstallerError' && error.code === 'insufficient_disk_space') {
    return 'Insufficient free space for runtime installation; no selection was changed.';
  }
  if (error.name === 'RuntimeInstallerError' && /^[a-z_]{1,64}$/.test(error.code)) {
    return 'Runtime operation failed (' + error.code + ').';
  }
  if (safeNames.has(error.name)) {
    return error.message;
  }
  return 'Command failed.';
}

async function main(argv) {
  if (
    argv.length === 0 ||
    argv.includes('--help') ||
    argv.includes('-h')
  ) {
    printHelp();
    return;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === 'profiles' && rest[0] === 'list') {
    const { values, positionals } = parseOptions(rest.slice(1), new Set(['config', 'project']));
    if (positionals.length) throw new CliUsageError('Unexpected profiles argument.');
    const { readProfileCatalog } = require('../src/profile-catalog.cjs');
    const catalog = await readProfileCatalog(requireValue(values, 'config'));
    process.stdout.write(JSON.stringify(catalog.forProject(requireValue(values, 'project'))) + '\n');
    return;
  }
  if (command === 'doctor' && rest[0] === '--host') {
    const { values, positionals } = parseOptions(rest.slice(1), new Set(['state-dir']));
    if (positionals.length) throw new CliUsageError('doctor --host accepts no positional arguments.');
    const { inspectHost } = require('../src/host-doctor.cjs');
    const report = await inspectHost(values['state-dir'] ?? process.cwd());
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }

  if (command === 'doctor' && rest[0] === '--runtime') {
    return runRuntime('doctor', rest.slice(1));
  }
  if (command === 'runtime') {
    if (!['install', 'rollback', 'list'].includes(rest[0])) {
      throw new CliUsageError('Expected runtime install, list or rollback.');
    }
    return runRuntime(rest[0], rest.slice(1));
  }
  if (command === 'serve') {
    await runServe(rest);
    return;
  }

  if (command === 'pair') {
    if (rest[0] !== 'issue') {
      throw new CliUsageError('Expected "pair issue".');
    }
    await runPairIssue(rest.slice(1));
    return;
  }

  if (command === 'clients') {
    if (rest[0] === 'list') {
      await runClientsList(rest.slice(1));
      return;
    }
    if (rest[0] === 'revoke') {
      await runClientsRevoke(rest.slice(1));
      return;
    }
    throw new CliUsageError('Expected "clients list" or "clients revoke".');
  }

  throw new CliUsageError(`Unknown command "${command}".`);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof CliUsageError) {
    process.stderr.write(`alpi-server: ${error.message}\n`);
    process.stderr.write("Try 'alpi-server --help' for usage.\n");
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`alpi-server: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
