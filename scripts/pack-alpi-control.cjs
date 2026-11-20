#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

// The repo checkout shares audited modules with Desktop. The released package
// must be self-contained even after the checkout and build directory disappear.
async function pack(name, output) {
  if (!['alpi-server', 'alpi-client'].includes(name)) throw new Error('Choose alpi-server or alpi-client.');
  const source = path.join(root, 'packages', name);
  const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const build = await fs.mkdtemp(path.join(os.tmpdir(), 'alpi-control-pack-'));
  const destination = path.resolve(output);
  try {
    for (const file of new Set(['package.json', 'package-lock.json', ...metadata.files])) {
      await fs.cp(path.join(source, file), path.join(build, file), { recursive: true, dereference: true });
    }
    await fs.mkdir(destination, { recursive: true });
    const { stdout } = await run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', destination], {
      cwd: build,
      env: { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter) },
    });
    return JSON.parse(stdout);
  } finally {
    await fs.rm(build, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [name, output, ...unexpected] = process.argv.slice(2);
  if (!name || !output || unexpected.length) {
    process.stderr.write('Usage: node scripts/pack-alpi-control.cjs <alpi-server|alpi-client> <output-directory>\n');
    process.exitCode = 2;
  } else {
    pack(name, output).then(result => console.log(JSON.stringify(result))).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
