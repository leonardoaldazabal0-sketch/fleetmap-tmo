const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(rootPath, filePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(filePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class CpeCache {
  constructor(filePath, parserVersion) {
    this.filePath = path.resolve(filePath);
    this.parserVersion = String(parserVersion);
    this.entries = {};
    this.dirty = false;
    this.warning = "";
    this.load();
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;

    try {
      const payload = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (payload.schemaVersion !== SCHEMA_VERSION || typeof payload.entries !== "object") {
        this.warning = "La cache anterior tenia un formato incompatible y se reinicio";
        this.dirty = true;
        return;
      }
      this.entries = payload.entries || {};
    } catch (error) {
      this.warning = `No se pudo leer la cache anterior; se reconstruira (${error.message})`;
      this.dirty = true;
    }
  }

  lookup(filePath, stat) {
    const entry = this.entries[pathKey(filePath)];
    if (!entry) return null;
    if (entry.parserVersion !== this.parserVersion) return null;
    if (entry.size !== stat.size || entry.modifiedTime !== stat.mtimeMs) return null;
    return entry;
  }

  store(filePath, stat, data, errorMessage = "") {
    const resolved = path.resolve(filePath);
    this.entries[pathKey(resolved)] = {
      path: resolved,
      size: stat.size,
      modifiedTime: stat.mtimeMs,
      modifiedAt: stat.mtime.toISOString(),
      parserVersion: this.parserVersion,
      scannedAt: new Date().toISOString(),
      error: errorMessage || "",
      data: errorMessage ? null : data,
    };
    this.dirty = true;
  }

  pruneMissing(rootPath, existingFiles) {
    let stat;
    try {
      stat = fs.statSync(rootPath);
    } catch {
      return 0;
    }
    if (!stat.isDirectory()) return 0;

    const existing = new Set(existingFiles.map(pathKey));
    let removed = 0;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry?.path && isPathInside(rootPath, entry.path) && !existing.has(key)) {
        delete this.entries[key];
        removed += 1;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  save() {
    if (!this.dirty) return false;

    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      parserVersion: this.parserVersion,
      updatedAt: new Date().toISOString(),
      entries: this.entries,
    };

    fs.writeFileSync(temporary, JSON.stringify(payload), "utf8");
    try {
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      if (!fs.existsSync(this.filePath)) throw error;
      fs.copyFileSync(temporary, this.filePath);
      fs.unlinkSync(temporary);
    }
    this.dirty = false;
    this.warning = "";
    return true;
  }
}

module.exports = { CpeCache, pathKey };
