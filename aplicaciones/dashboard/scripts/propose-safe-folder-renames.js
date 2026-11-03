const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
const root = process.env.CPE_CLIENTS_2026_ROOT
  || "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2026";
const outputJson = runtimePaths.dataFile("safe-folder-rename-proposals-2026.json");
const outputCsv = runtimePaths.docFile("safe-folder-rename-proposals-2026.csv");

const canonicalSingleNames = new Set([
  "ADICION", "CAMBIO", "PROGRAMACION", "REPARACION", "REPOSICION",
  "PRESTAMO", "DESACTIVACION", "DESPUES", "ANTES", "CONTRATISTAS",
]);

function comparable(value) {
  return path.win32.resolve(String(value || "")).toLocaleUpperCase("es-PE");
}

function safeRename(name) {
  const original = String(name || "");
  let proposed = original;
  let type = "";
  let reason = "";

  if (/^MUNICPALIDAD\b/i.test(proposed)) {
    proposed = proposed.replace(/^MUNICPALIDAD\b/i, "MUNICIPALIDAD");
    type = "ERROR ORTOGRAFICO";
    reason = "Corrige MUNICPALIDAD por MUNICIPALIDAD";
  }

  if (/^FROM(?=\s|$)/i.test(proposed)) {
    proposed = proposed.replace(/^FROM/i, "FORM");
    type = "ERROR ORTOGRAFICO";
    reason = "Corrige FROM por FORM";
  }

  if (/^20\d{6}__[A-Za-z]{2,4}\}?$/.test(proposed)) {
    proposed = proposed.replace(/__(?=[A-Za-z]{2,4}\}?$)/, "_");
    type = "FORMATO FECHA";
    reason = "Elimina el guion bajo duplicado";
  }

  if (/^20\d{6}_[A-Za-z]{2,4}\}$/.test(proposed)) {
    proposed = proposed.slice(0, -1);
    type = "CARACTER SOBRANTE";
    reason = "Elimina la llave final de fecha/programador";
  }

  const withoutBrace = proposed.endsWith("}") ? proposed.slice(0, -1) : proposed;
  if (proposed.endsWith("}") && canonicalSingleNames.has(withoutBrace.toUpperCase())) {
    proposed = withoutBrace;
    type = "CARACTER SOBRANTE";
    reason = "Elimina la llave final del nombre canonico";
  }

  if (/^FORM(?:\s+\d+(?:-\d+)?)?$/i.test(proposed)) {
    const corrected = proposed.replace(/^form/i, "FORM");
    if (corrected !== proposed) {
      proposed = corrected;
      type = type || "MAYUSCULAS";
      reason = reason || "Normaliza el prefijo FORM";
    }
  }

  if (canonicalSingleNames.has(proposed.toUpperCase()) && proposed !== proposed.toUpperCase()) {
    proposed = proposed.toUpperCase();
    type = type || "MAYUSCULAS";
    reason = reason || "Normaliza el nombre canonico en mayusculas";
  }

  const dateMatch = proposed.match(/^(20\d{6})_([A-Za-z]{2,4})$/);
  if (dateMatch) {
    const corrected = `${dateMatch[1]}_${dateMatch[2].toUpperCase()}`;
    if (corrected !== proposed) {
      proposed = corrected;
      type = type || "MAYUSCULAS";
      reason = reason || "Normaliza las iniciales del programador";
    }
  }

  if (proposed === original) return null;
  return { proposed, type, reason };
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const indexedFiles = database.prepare(`
  SELECT id, path, size
  FROM scanned_files
  WHERE existsFlag=1 AND path LIKE ?
`).all(`${root}\\%`);
database.close();

const proposals = new Map();

function ensureProposal(currentPath, currentName, correction) {
  const key = comparable(currentPath);
  if (!proposals.has(key)) {
    proposals.set(key, {
      currentPath,
      currentName,
      proposedName: correction.proposed,
      proposedPath: path.join(path.dirname(currentPath), correction.proposed),
      type: correction.type,
      reason: correction.reason,
      fileIds: new Set(),
      bytes: 0,
      exampleFile: "",
      discoveredLive: false,
    });
  }
  return proposals.get(key);
}

for (const file of indexedFiles) {
  const relative = file.path.slice(root.length + 1);
  const segments = relative.split("\\");
  const directories = segments.slice(0, -1);
  for (let index = 0; index < directories.length; index += 1) {
    const correction = safeRename(directories[index]);
    if (!correction) continue;
    const currentPath = path.join(root, ...directories.slice(0, index + 1));
    const proposal = ensureProposal(currentPath, directories[index], correction);
    if (!proposal.fileIds.has(file.id)) {
      proposal.fileIds.add(file.id);
      proposal.bytes += Number(file.size || 0);
    }
    if (!proposal.exampleFile) proposal.exampleFile = file.path;
  }
}

function walkDirectories(currentPath) {
  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch (error) {
    return [{ path: currentPath, error: error.message }];
  }
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(currentPath, entry.name);
    const correction = safeRename(entry.name);
    if (correction) ensureProposal(childPath, entry.name, correction).discoveredLive = true;
    errors.push(...walkDirectories(childPath));
  }
  return errors;
}

const readErrors = walkDirectories(root);
const rows = [...proposals.values()].map((proposal) => {
  const sourceExists = fs.existsSync(proposal.currentPath);
  const caseOnly = proposal.currentName.toLocaleUpperCase("es-PE") === proposal.proposedName.toLocaleUpperCase("es-PE")
    && proposal.currentName !== proposal.proposedName;
  const sameComparablePath = comparable(proposal.currentPath) === comparable(proposal.proposedPath);
  const targetExists = fs.existsSync(proposal.proposedPath);
  let status = "PROPUESTO - PENDIENTE APROBACION";
  if (!sourceExists) status = "REVISAR - ORIGEN NO ENCONTRADO";
  else if (targetExists && !sameComparablePath) status = "BLOQUEADO - DESTINO YA EXISTE";
  else if (caseOnly) status = "PROPUESTO - REQUIERE NOMBRE TEMPORAL";

  return {
    order: 0,
    depth: proposal.currentPath.split("\\").length,
    type: proposal.type,
    currentPath: proposal.currentPath,
    currentName: proposal.currentName,
    proposedName: proposal.proposedName,
    proposedPath: proposal.proposedPath,
    indexedCpeFiles: proposal.fileIds.size,
    indexedBytes: proposal.bytes,
    sourceExists,
    targetExists,
    caseOnly,
    status,
    reason: proposal.reason,
    exampleFile: proposal.exampleFile,
    approved: "",
  };
}).sort((left, right) => right.depth - left.depth || left.currentPath.localeCompare(right.currentPath, "es"));

rows.forEach((row, index) => { row.order = index + 1; });

const payload = {
  version: "propuesta-1",
  generatedAt: new Date().toISOString(),
  root,
  executionStatus: "NO EJECUTADO - SOLO REPORTE",
  summary: {
    proposals: rows.length,
    affectedIndexedCpeFiles: new Set(rows.flatMap((row) => {
      const proposal = proposals.get(comparable(row.currentPath));
      return proposal ? [...proposal.fileIds] : [];
    })).size,
    caseOnly: rows.filter((row) => row.caseOnly).length,
    blockedByExistingTarget: rows.filter((row) => row.status.startsWith("BLOQUEADO")).length,
    missingSources: rows.filter((row) => !row.sourceExists).length,
    liveReadErrors: readErrors.length,
  },
  proposals: rows,
  liveReadErrors: readErrors,
};

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const headers = [
  "Orden", "Tipo", "RutaActual", "NombreActual", "NombrePropuesto", "RutaPropuesta",
  "ArchivosCPEIndexados", "BytesIndexados", "SoloMayusculas", "OrigenExiste",
  "DestinoExiste", "Estado", "Motivo", "EjemploArchivo", "Aprobado",
];
const csvRows = rows.map((row) => [
  row.order, row.type, row.currentPath, row.currentName, row.proposedName, row.proposedPath,
  row.indexedCpeFiles, row.indexedBytes, row.caseOnly ? "SI" : "NO",
  row.sourceExists ? "SI" : "NO", row.targetExists ? "SI" : "NO", row.status,
  row.reason, row.exampleFile, row.approved,
]);

fs.writeFileSync(outputJson, JSON.stringify(payload, null, 2), "utf8");
fs.writeFileSync(outputCsv, `\uFEFF${[headers, ...csvRows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`, "utf8");
console.log(JSON.stringify({ ...payload.summary, outputJson, outputCsv }, null, 2));
