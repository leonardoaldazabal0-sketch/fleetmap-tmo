const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const backupsRoot = runtimePaths.dataFile("folder-rename-backups");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");

function pathStartsWith(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}\\`);
}

function replacePrefix(value, from, to) {
  return pathStartsWith(value, from) ? `${to}${value.slice(from.length)}` : value;
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

const latestDirectory = fs.readdirSync(backupsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);
if (!latestDirectory) throw new Error("No existe ejecucion para reconciliar");

const backupDirectory = path.join(backupsRoot, latestDirectory);
const executionState = JSON.parse(fs.readFileSync(path.join(backupDirectory, "execution-and-rollback.json"), "utf8"));
const retryState = JSON.parse(fs.readFileSync(path.join(backupDirectory, "case-only-retry.json"), "utf8"));
const failedCaseOrders = new Set(retryState.errors.map((item) => Number(item.order)));
const successfulOperations = executionState.operations.filter(
  (operation) => !operation.caseOnly || !failedCaseOrders.has(Number(operation.order))
);

const originalDatabasePath = executionState.databaseBackupPath;
const originalDatabase = new Database(originalDatabasePath, { readonly: true, fileMustExist: true });
const originalRows = originalDatabase.prepare(`
  SELECT id, path FROM scanned_files ORDER BY id
`).all();
originalDatabase.close();

const currentDatabase = new Database(databasePath, { fileMustExist: true, timeout: 10000 });
currentDatabase.pragma("wal_checkpoint(TRUNCATE)");
const currentRows = new Map(currentDatabase.prepare("SELECT id, path FROM scanned_files").all().map((row) => [row.id, row.path]));
if (currentRows.size !== originalRows.length) {
  currentDatabase.close();
  throw new Error(`La cantidad de registros cambio durante la pausa: ${originalRows.length} -> ${currentRows.size}`);
}

const desiredRows = originalRows.map((row) => {
  let desiredPath = row.path;
  for (const operation of successfulOperations) {
    desiredPath = replacePrefix(desiredPath, operation.currentPath, operation.proposedPath);
  }
  return { id: row.id, desiredPath };
});
const ownerByPath = new Map();
for (const row of desiredRows) {
  if (ownerByPath.has(row.desiredPath) && ownerByPath.get(row.desiredPath) !== row.id) {
    currentDatabase.close();
    throw new Error(`Colision en la ruta reconciliada: ${row.desiredPath}`);
  }
  ownerByPath.set(row.desiredPath, row.id);
}

const changedRows = desiredRows.filter((row) => currentRows.get(row.id) !== row.desiredPath);
const reconciliationBackup = path.join(backupDirectory, "sqlite-before-case-reconciliation.sqlite");
fs.copyFileSync(databasePath, reconciliationBackup);

const update = currentDatabase.prepare(`
  UPDATE scanned_files
  SET path=@desiredPath, folderDate=@folderDate, dateKey=@dateKey,
    sourceFolder=@sourceFolder, programmer=@programmer
  WHERE id=@id
`);
const reconcile = currentDatabase.transaction(() => {
  for (const row of changedRows) {
    update.run({ id: row.id, desiredPath: row.desiredPath, ...parseFolderDate(row.desiredPath) });
  }
});
reconcile();
const integrity = currentDatabase.pragma("integrity_check", { simple: true });
const foreignKeyErrors = currentDatabase.pragma("foreign_key_check");
currentDatabase.pragma("wal_checkpoint(TRUNCATE)");
currentDatabase.close();

const result = {
  status: integrity === "ok" && foreignKeyErrors.length === 0 ? "RECONCILIADO" : "REVISAR",
  successfulStructuralRenames: successfulOperations.filter((operation) => !operation.caseOnly).length,
  successfulCaseOnlyRenames: successfulOperations.filter((operation) => operation.caseOnly).length,
  caseOnlyNamesKeptByNas: failedCaseOrders.size,
  databaseRowsReconciled: changedRows.length,
  sqliteIntegrity: integrity,
  sqliteForeignKeyErrors: foreignKeyErrors.length,
  reconciliationBackup,
};
fs.writeFileSync(
  path.join(backupDirectory, "database-reconciliation.json"),
  JSON.stringify(result, null, 2),
  "utf8"
);
console.log(JSON.stringify(result, null, 2));
if (result.status !== "RECONCILIADO") process.exitCode = 1;
