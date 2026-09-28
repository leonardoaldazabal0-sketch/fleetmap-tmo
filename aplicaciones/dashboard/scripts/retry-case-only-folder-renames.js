const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const backupsRoot = runtimePaths.dataFile("folder-rename-backups");
const execute = process.argv.includes("--execute");
const delayMs = Number(process.env.CPE_CASE_RENAME_DELAY_MS || 2500);

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function pathStartsWith(value, prefix) {
  return value === prefix || value.startsWith(`${prefix}\\`);
}

function replacePrefix(value, from, to) {
  return pathStartsWith(value, from) ? `${to}${value.slice(from.length)}` : value;
}

function comparable(value) {
  return path.win32.resolve(value).toLocaleUpperCase("es-PE");
}

function readActualName(candidate) {
  const parent = path.dirname(candidate);
  const wanted = path.basename(candidate).toLocaleUpperCase("es-PE");
  return fs.readdirSync(parent, { withFileTypes: true })
    .find((entry) => entry.name.toLocaleUpperCase("es-PE") === wanted)
    ?.name || "";
}

function writeState(filePath, state) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

const latestDirectory = fs.readdirSync(backupsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);
if (!latestDirectory) throw new Error("No existe una ejecucion de renombres");

const executionLogPath = path.join(backupsRoot, latestDirectory, "execution-and-rollback.json");
const originalState = JSON.parse(fs.readFileSync(executionLogPath, "utf8"));
if (originalState.status !== "COMPLETADO") throw new Error(`Ejecucion base no completada: ${originalState.status}`);

const operations = originalState.operations;
const pending = [];
for (let index = 0; index < operations.length; index += 1) {
  const operation = operations[index];
  if (!operation.caseOnly) continue;
  let finalPath = operation.proposedPath;
  for (let later = index + 1; later < operations.length; later += 1) {
    finalPath = replacePrefix(finalPath, operations[later].currentPath, operations[later].proposedPath);
  }
  const actualName = readActualName(finalPath);
  if (!actualName) throw new Error(`No se encontro la carpeta comparable: ${finalPath}`);
  if (actualName === operation.proposedName) continue;
  if (actualName !== operation.currentName) {
    throw new Error(`Nombre inesperado en ${finalPath}: ${actualName}`);
  }
  pending.push({ order: operation.order, finalPath, actualName, proposedName: operation.proposedName });
}

if (!execute) {
  console.log(JSON.stringify({ mode: "SIMULACION", pending: pending.length, delayMs, paths: pending }, null, 2));
  process.exit(0);
}

const retryState = {
  version: 1,
  startedAt: new Date().toISOString(),
  status: "INICIADO",
  delayMs,
  pendingCount: pending.length,
  completed: [],
  errors: [],
};
const retryLogPath = path.join(backupsRoot, latestDirectory, "case-only-retry.json");
writeState(retryLogPath, retryState);

for (let index = 0; index < pending.length; index += 1) {
  const item = pending[index];
  const parent = path.dirname(item.finalPath);
  const source = path.join(parent, item.actualName);
  const target = path.join(parent, item.proposedName);
  const temporaryName = `.fleetmap-case-${Date.now()}-${String(index + 1).padStart(3, "0")}`;
  const temporary = path.join(parent, temporaryName);
  try {
    if (fs.existsSync(temporary)) throw new Error(`Nombre temporal ocupado: ${temporary}`);
    fs.renameSync(source, temporary);
    const actualTemporary = readActualName(temporary);
    if (actualTemporary !== temporaryName) throw new Error(`No se confirmo el nombre temporal: ${temporary}`);
    wait(delayMs);
    fs.renameSync(temporary, target);
    wait(delayMs);
    const actualFinal = readActualName(target);
    if (actualFinal !== item.proposedName) {
      throw new Error(`El NAS conservo el nombre ${actualFinal || "NO ENCONTRADO"}`);
    }
    retryState.completed.push({ ...item, status: "OK", finishedAt: new Date().toISOString() });
  } catch (error) {
    if (fs.existsSync(temporary)) {
      try {
        fs.renameSync(temporary, source);
      } catch (restoreError) {
        retryState.errors.push({ ...item, error: error.message, restoreError: restoreError.message });
        writeState(retryLogPath, retryState);
        throw restoreError;
      }
    }
    retryState.errors.push({ ...item, error: error.message });
  }
  writeState(retryLogPath, retryState);
}

retryState.status = retryState.errors.length ? "COMPLETADO CON ERRORES" : "COMPLETADO";
retryState.finishedAt = new Date().toISOString();
writeState(retryLogPath, retryState);
console.log(JSON.stringify({
  status: retryState.status,
  normalized: retryState.completed.length,
  errors: retryState.errors,
  retryLogPath,
}, null, 2));
if (retryState.errors.length) process.exitCode = 1;
