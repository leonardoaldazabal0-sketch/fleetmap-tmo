const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const reportPath = runtimePaths.dataFile("safe-folder-rename-proposals-2026.json");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
const execute = process.argv.includes("--execute");
const expectedRoot = process.env.CPE_CLIENTS_2026_ROOT
  || "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2026";

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function comparable(value) {
  return path.win32.resolve(String(value || "")).toLocaleUpperCase("es-PE");
}

function isWithinRoot(candidate, root) {
  const value = comparable(candidate);
  const boundary = `${comparable(root)}\\`;
  return value.startsWith(boundary) && value !== comparable(root);
}

function pathStartsWith(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}\\`);
}

function replacePrefix(value, from, to) {
  if (!pathStartsWith(value, from)) return value;
  return `${to}${value.slice(from.length)}`;
}

function actualEntryName(candidate) {
  const parent = path.dirname(candidate);
  const wanted = path.basename(candidate).toLocaleUpperCase("es-PE");
  const entry = fs.readdirSync(parent, { withFileTypes: true })
    .find((item) => item.name.toLocaleUpperCase("es-PE") === wanted);
  return entry?.name || "";
}

function countTree(root) {
  const result = { directories: 0, files: 0, cpeFiles: 0, bytes: 0 };
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result.directories += 1;
        pending.push(fullPath);
      } else if (entry.isFile()) {
        result.files += 1;
        if (entry.name.toLowerCase().endsWith(".cpe")) result.cpeFiles += 1;
        result.bytes += fs.statSync(fullPath).size;
      }
    }
  }
  return result;
}

function parseFolderDate(filePath) {
  const parts = path.win32.resolve(filePath).split(/[\\/]+/);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    const match = part.match(/(20\d{2})[.\-_ ]?([01]\d)[.\-_ ]?([0-3]\d)(?:[_\- ]?([A-Za-z]{1,6}))?/);
    if (!match) continue;
    return {
      folderDate: `${match[1]}-${match[2]}-${match[3]}`,
      dateKey: Number(`${match[1]}${match[2]}${match[3]}`),
      programmer: match[4] || "",
      sourceFolder: part,
    };
  }
  return { folderDate: "", dateKey: 0, programmer: "", sourceFolder: "" };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeState(filePath, state) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function renameCaseAware(from, to, token) {
  const caseOnly = comparable(from) === comparable(to) && from !== to;
  if (!caseOnly) {
    fs.renameSync(from, to);
    return "direct";
  }
  const temporary = path.join(path.dirname(from), `.fleetmap-rename-${token}`);
  if (fs.existsSync(temporary)) throw new Error(`Nombre temporal ocupado: ${temporary}`);
  fs.renameSync(from, temporary);
  try {
    fs.renameSync(temporary, to);
  } catch (error) {
    fs.renameSync(temporary, from);
    throw error;
  }
  return "case-only-via-temporary";
}

function rollbackFilesystem(performed, state) {
  const failures = [];
  for (let index = performed.length - 1; index >= 0; index -= 1) {
    const operation = performed[index];
    try {
      renameCaseAware(operation.proposedPath, operation.currentPath, `rollback-${state.runId}-${index}`);
      operation.rollback = "OK";
    } catch (error) {
      operation.rollback = `ERROR: ${error.message}`;
      failures.push({ path: operation.proposedPath, error: error.message });
    }
    writeState(state.logPath, state);
  }
  return failures;
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const root = path.win32.resolve(report.root);
if (comparable(root) !== comparable(expectedRoot)) {
  throw new Error(`La raiz del reporte no coincide con la raiz autorizada: ${root}`);
}
if (!fs.statSync(root).isDirectory()) throw new Error(`La raiz no es accesible: ${root}`);

const candidates = report.proposals
  .slice()
  .sort((left, right) => right.depth - left.depth || left.order - right.order);
const accepted = [];
const skipped = [];

for (const proposal of candidates) {
  const currentPath = path.win32.resolve(proposal.currentPath);
  const proposedPath = path.win32.resolve(proposal.proposedPath);
  if (!isWithinRoot(currentPath, root) || !isWithinRoot(proposedPath, root)) {
    throw new Error(`Propuesta fuera de la raiz autorizada: ${currentPath}`);
  }
  if (path.dirname(currentPath) !== path.dirname(proposedPath)) {
    throw new Error(`La propuesta intenta mover entre carpetas: ${currentPath}`);
  }
  if (path.basename(proposedPath) !== proposal.proposedName) {
    throw new Error(`Nombre propuesto inconsistente: ${proposedPath}`);
  }
  let actualName = "";
  try {
    actualName = actualEntryName(currentPath);
  } catch (error) {
    skipped.push({ ...proposal, liveStatus: `OMITIDO: ${error.message}` });
    continue;
  }
  if (!actualName) {
    skipped.push({ ...proposal, liveStatus: "OMITIDO: origen no encontrado" });
    continue;
  }
  if (actualName !== proposal.currentName) {
    throw new Error(`El nombre real cambio desde el reporte: ${currentPath} (real: ${actualName})`);
  }
  if (!fs.statSync(currentPath).isDirectory()) throw new Error(`El origen no es carpeta: ${currentPath}`);
  const caseOnly = comparable(currentPath) === comparable(proposedPath) && currentPath !== proposedPath;
  if (!caseOnly && fs.existsSync(proposedPath)) {
    throw new Error(`El destino ya existe: ${proposedPath}`);
  }
  accepted.push({
    order: proposal.order,
    type: proposal.type,
    reason: proposal.reason,
    currentPath,
    proposedPath,
    currentName: proposal.currentName,
    proposedName: proposal.proposedName,
    caseOnly,
  });
}

const database = new Database(databasePath, { readonly: !execute, fileMustExist: true, timeout: 10000 });
const indexedRows = database.prepare(`
  SELECT id, path, folderDate, dateKey, sourceFolder, programmer
  FROM scanned_files
`).all();
const transformedRows = indexedRows.map((row) => {
  let nextPath = row.path;
  for (const operation of accepted) {
    nextPath = replacePrefix(nextPath, operation.currentPath, operation.proposedPath);
  }
  return { ...row, nextPath };
});
const finalPathOwners = new Map();
for (const row of transformedRows) {
  const key = row.nextPath;
  if (finalPathOwners.has(key) && finalPathOwners.get(key) !== row.id) {
    throw new Error(`Colision SQLite al transformar la ruta: ${key}`);
  }
  finalPathOwners.set(key, row.id);
}
const changedRows = transformedRows.filter((row) => row.nextPath !== row.path);
const runRows = database.prepare("SELECT id, rootPath FROM scan_runs").all();
const transformedRuns = runRows.map((row) => {
  let nextRootPath = row.rootPath;
  for (const operation of accepted) {
    nextRootPath = replacePrefix(nextRootPath, operation.currentPath, operation.proposedPath);
  }
  return { ...row, nextRootPath };
}).filter((row) => row.nextRootPath !== row.rootPath);

if (!execute) {
  database.close();
  console.log(JSON.stringify({
    mode: "SIMULACION",
    root,
    accepted: accepted.length,
    skipped: skipped.length,
    skippedPaths: skipped.map((item) => item.currentPath),
    indexedPathsToUpdate: changedRows.length,
    scanRunsToUpdate: transformedRuns.length,
    collisions: 0,
  }, null, 2));
  process.exit(0);
}

const runId = stamp();
const backupDirectory = runtimePaths.dataFile("folder-rename-backups", runId);
fs.mkdirSync(backupDirectory, { recursive: true });
const state = {
  version: 1,
  runId,
  startedAt: new Date().toISOString(),
  mode: "EJECUCION",
  root,
  reportPath,
  databasePath,
  status: "INICIADO",
  acceptedCount: accepted.length,
  skipped,
  indexedPathsToUpdate: changedRows.length,
  scanRunsToUpdate: transformedRuns.length,
  operations: [],
};
state.logPath = path.join(backupDirectory, "execution-and-rollback.json");
const databaseBackupPath = path.join(backupDirectory, path.basename(databasePath));

database.pragma("wal_checkpoint(TRUNCATE)");
database.close();
fs.copyFileSync(databasePath, databaseBackupPath);
state.databaseBackupPath = databaseBackupPath;
state.databaseBackupSha256 = sha256(databaseBackupPath);
writeState(state.logPath, state);

try {
  for (let index = 0; index < accepted.length; index += 1) {
    const operation = { ...accepted[index], startedAt: new Date().toISOString() };
    operation.before = countTree(operation.currentPath);
    operation.method = renameCaseAware(
      operation.currentPath,
      operation.proposedPath,
      `${runId}-${String(index + 1).padStart(3, "0")}`
    );
    operation.after = countTree(operation.proposedPath);
    if (JSON.stringify(operation.before) !== JSON.stringify(operation.after)) {
      throw new Error(`La verificacion de contenido no coincide: ${operation.proposedPath}`);
    }
    operation.finishedAt = new Date().toISOString();
    operation.status = "RENOMBRADO";
    state.operations.push(operation);
    writeState(state.logPath, state);
  }

  const writableDatabase = new Database(databasePath, { fileMustExist: true, timeout: 10000 });
  writableDatabase.pragma("journal_mode = WAL");
  writableDatabase.pragma("foreign_keys = ON");
  const updateFile = writableDatabase.prepare(`
    UPDATE scanned_files
    SET path=@nextPath, folderDate=@folderDate, dateKey=@dateKey,
      sourceFolder=@sourceFolder, programmer=@programmer
    WHERE id=@id
  `);
  const updateRun = writableDatabase.prepare("UPDATE scan_runs SET rootPath=? WHERE id=?");
  const updateDatabase = writableDatabase.transaction(() => {
    for (const row of changedRows) {
      updateFile.run({ id: row.id, nextPath: row.nextPath, ...parseFolderDate(row.nextPath) });
    }
    for (const row of transformedRuns) updateRun.run(row.nextRootPath, row.id);
  });
  try {
    updateDatabase();
    writableDatabase.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    writableDatabase.close();
  }

  state.status = "COMPLETADO";
  state.finishedAt = new Date().toISOString();
  state.databaseAfterSha256 = sha256(databasePath);
  writeState(state.logPath, state);
  console.log(JSON.stringify({
    status: state.status,
    renamed: state.operations.length,
    skipped: skipped.length,
    indexedPathsUpdated: changedRows.length,
    scanRunsUpdated: transformedRuns.length,
    backupDirectory,
    rollbackLog: state.logPath,
  }, null, 2));
} catch (error) {
  state.status = "ERROR - INICIANDO REVERSA";
  state.error = error.message;
  writeState(state.logPath, state);
  const rollbackFailures = rollbackFilesystem(state.operations, state);
  if (!rollbackFailures.length) {
    fs.copyFileSync(databaseBackupPath, databasePath);
    state.status = "ERROR - REVERSA COMPLETADA";
  } else {
    state.status = "ERROR - REVERSA INCOMPLETA";
    state.rollbackFailures = rollbackFailures;
  }
  state.finishedAt = new Date().toISOString();
  writeState(state.logPath, state);
  throw error;
}
