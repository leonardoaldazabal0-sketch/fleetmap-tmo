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

const latestDirectory = fs.readdirSync(backupsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);
if (!latestDirectory) throw new Error("No existe respaldo de renombres");

const logPath = path.join(backupsRoot, latestDirectory, "execution-and-rollback.json");
const state = JSON.parse(fs.readFileSync(logPath, "utf8"));
if (state.status !== "COMPLETADO") throw new Error(`La ejecucion no esta completa: ${state.status}`);

const operations = state.operations;
const retryLogPath = path.join(backupsRoot, latestDirectory, "case-only-retry.json");
const failedCaseOrders = fs.existsSync(retryLogPath)
  ? new Set(JSON.parse(fs.readFileSync(retryLogPath, "utf8")).errors.map((item) => Number(item.order)))
  : new Set();
const successfulOperations = operations.filter(
  (operation) => !operation.caseOnly || !failedCaseOrders.has(Number(operation.order))
);
const liveErrors = [];
for (let index = 0; index < operations.length; index += 1) {
  const operation = operations[index];
  const operationSucceeded = !operation.caseOnly || !failedCaseOrders.has(Number(operation.order));
  let finalPath = operationSucceeded ? operation.proposedPath : operation.currentPath;
  for (let later = index + 1; later < operations.length; later += 1) {
    if (!operations[later].caseOnly || !failedCaseOrders.has(Number(operations[later].order))) {
      finalPath = replacePrefix(finalPath, operations[later].currentPath, operations[later].proposedPath);
    }
  }
  if (!fs.existsSync(finalPath)) {
    liveErrors.push({ order: operation.order, finalPath, error: "Destino final no encontrado" });
    continue;
  }
  const actualName = fs.readdirSync(path.dirname(finalPath), { withFileTypes: true })
    .find((entry) => entry.name.toLocaleUpperCase("es-PE") === path.basename(finalPath).toLocaleUpperCase("es-PE"))
    ?.name;
  const expectedName = operationSucceeded ? operation.proposedName : operation.currentName;
  if (actualName !== expectedName) {
    liveErrors.push({ order: operation.order, finalPath, error: `Nombre real: ${actualName || "NO ENCONTRADO"}` });
  }
  if (JSON.stringify(operation.before) !== JSON.stringify(operation.after)) {
    liveErrors.push({ order: operation.order, finalPath, error: "Conteos antes/despues distintos" });
  }
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const integrity = database.pragma("integrity_check", { simple: true });
const foreignKeyErrors = database.pragma("foreign_key_check");
const indexedFiles = database.prepare("SELECT COUNT(*) AS count FROM scanned_files WHERE existsFlag=1").get().count;
const storedGroups = database.prepare("SELECT COALESCE(SUM(groupCount),0) AS count FROM scanned_files WHERE existsFlag=1").get().count;
const currentPaths = new Map(database.prepare("SELECT id, path FROM scanned_files").all().map((row) => [row.id, row.path]));
database.close();

const originalDatabase = new Database(state.databaseBackupPath, { readonly: true, fileMustExist: true });
const originalPaths = originalDatabase.prepare("SELECT id, path FROM scanned_files").all();
originalDatabase.close();
let databasePathMismatches = 0;
for (const row of originalPaths) {
  let expectedPath = row.path;
  for (const operation of successfulOperations) {
    expectedPath = replacePrefix(expectedPath, operation.currentPath, operation.proposedPath);
  }
  if (currentPaths.get(row.id) !== expectedPath) databasePathMismatches += 1;
}

const result = {
  status: liveErrors.length === 0 && integrity === "ok" && foreignKeyErrors.length === 0 && databasePathMismatches === 0
    ? "VALIDADO"
    : "REVISAR",
  executionStatus: state.status,
  renamedFolders: operations.length,
  skippedObsoletePaths: state.skipped.length,
  verifiedFolderContents: operations.filter((operation) => JSON.stringify(operation.before) === JSON.stringify(operation.after)).length,
  liveErrors,
  successfulStructuralRenames: successfulOperations.filter((operation) => !operation.caseOnly).length,
  successfulCaseOnlyRenames: successfulOperations.filter((operation) => operation.caseOnly).length,
  caseOnlyNamesKeptByNas: failedCaseOrders.size,
  sqliteIntegrity: integrity,
  sqliteForeignKeyErrors: foreignKeyErrors.length,
  databasePathMismatches,
  indexedFiles,
  storedGroups,
  databaseBackup: state.databaseBackupPath,
  rollbackLog: logPath,
};
console.log(JSON.stringify(result, null, 2));
if (result.status !== "VALIDADO") process.exitCode = 1;
