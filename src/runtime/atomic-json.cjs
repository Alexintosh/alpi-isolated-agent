// Persistenza JSON atomica per lo stato runtime, solo built-in di Node.
// Il valore non viene mai stampato: nessun contenuto o segreto nei log.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DIR_MODE = 0o700;
const TEMP_MODE = 0o600;
// fsync di directory: tentato solo su macOS, best effort altrove.
const SYNC_DIR = process.platform === "darwin";

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    // ENOENT: file mai scritto, valore di fallback. Altri errori propagano.
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
  // JSON corrotto: SyntaxError propagato, mai mascherato dal fallback.
  return JSON.parse(raw);
}

function writeJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

  // Destinazione esistente: mai seguire symlink o scrivere su non-file.
  const st = statIfPresent(file);
  if (st?.isSymbolicLink())
    throw new Error("The destination is a symbolic link and will not be followed.");
  if (st && !st.isFile())
    throw new Error("The destination is not a regular file.");

  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined)
    throw new Error("The value cannot be serialized as JSON.");
  const content = serialized + "\n";
  // Temp random esclusivo 0600 nella stessa directory del target.
  const temp = path.join(
    dir,
    `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );

  let fd = null;
  try {
    fd = fs.openSync(temp, "wx", TEMP_MODE);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file); // Sostituzione atomica.
    if (SYNC_DIR) syncDir(dir);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(temp); } catch {} // Nessun residuo temp.
    throw err;
  }
}

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return null; // Nuovo file: consentito.
    throw err;
  }
}

function syncDir(dir) {
  let dfd;
  try {
    dfd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(dfd);
  } catch (error) {
    // Ignore only an explicit unsupported-directory-fsync result, never disk errors.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
  } finally {
    if (dfd !== undefined) fs.closeSync(dfd);
  }
}

module.exports = { readJson, writeJson };
