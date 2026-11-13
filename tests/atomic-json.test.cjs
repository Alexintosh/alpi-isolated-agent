const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJson, writeJson } = require("../src/runtime/atomic-json.cjs");

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-json-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("roundtrip, newline finale e modalità 0600/0700", (t) => {
  const file = path.join(tempRoot(t), "state", "config.json");
  const value = { runs: 1, tags: ["a", "b"], nested: { ok: true } };
  writeJson(file, value);
  assert.deepEqual(readJson(file, {}), value);
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("fallback solo su ENOENT; JSON corrotto non mascherato", (t) => {
  const root = tempRoot(t);
  assert.deepEqual(readJson(path.join(root, "missing.json"), { fb: true }), { fb: true });
  const corrupt = path.join(root, "corrupt.json");
  fs.writeFileSync(corrupt, "{ non-json");
  assert.throws(() => readJson(corrupt, { fb: true }), SyntaxError);
});

test("symlink rifiutato, target e link invariati", (t) => {
  const root = tempRoot(t);
  const target = path.join(root, "target.json");
  fs.writeFileSync(target, '{"keep":1}\n');
  const link = path.join(root, "link.json");
  fs.symlinkSync(target, link);
  assert.throws(() => writeJson(link, { keep: 2 }), /symbolic link/);
  assert.equal(fs.readFileSync(target, "utf8"), '{"keep":1}\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("destinazione non regolare rifiutata senza residui temp", (t) => {
  const root = tempRoot(t);
  const dirPath = path.join(root, "dir.json");
  fs.mkdirSync(dirPath);
  assert.throws(() => writeJson(dirPath, { a: 1 }), /not a regular file/);
  assert.deepEqual(fs.readdirSync(root), ["dir.json"]);
});
