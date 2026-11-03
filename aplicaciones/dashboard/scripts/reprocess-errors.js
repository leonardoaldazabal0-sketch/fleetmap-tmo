const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const app = require(path.join(root, "server"));
const {
  database,
  EMERGENCY_LAYOUTS_BY_CPS_SIZE,
  extractCodeplugFile,
  LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE,
  LAYOUTS_BY_CPS_SIZE,
} = app;

const BATCH_SIZE = 200;
const RUN_ROOT = process.env.CPE_CENTRAL_ROOT || "\\\\192.168.7.252\\tic\\002 Programacion";
const codeplugArgument = process.argv.find((value) => value.startsWith("--codeplug="));
const forceCodeplugArgument = process.argv.find((value) => value.startsWith("--force-codeplug="));
const fileSizeArgument = process.argv.find((value) => value.startsWith("--file-size="));
const missingEmergency = process.argv.includes("--missing-emergency");
const requestedCodeplug = forceCodeplugArgument
  ? forceCodeplugArgument.slice("--force-codeplug=".length).trim()
  : (codeplugArgument ? codeplugArgument.slice("--codeplug=".length).trim() : "");
const forceCodeplug = Boolean(forceCodeplugArgument);
const requestedFileSize = fileSizeArgument
  ? Number(fileSizeArgument.slice("--file-size=".length).trim())
  : 0;
const supportedEmergencyCpsSizes = Object.keys(EMERGENCY_LAYOUTS_BY_CPS_SIZE).map(Number);

function mayContainSupportedEmergencyCps(row) {
  return supportedEmergencyCpsSizes.some((cpsSize) => {
    const wrapperBytes = Number(row.size) - cpsSize;
    return wrapperBytes >= 7 && wrapperBytes <= 512;
  });
}

function readCpsSize(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(9);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.subarray(0, 7).toString("ascii") !== "CPDFile") {
      throw new Error("No parece un archivo CPE Motorola");
    }

    const sectionHeader = Buffer.alloc(7);
    let cursor = 9;
    const size = fs.fstatSync(fd).size;
    while (cursor + sectionHeader.length <= size) {
      if (fs.readSync(fd, sectionHeader, 0, sectionHeader.length, cursor) !== sectionHeader.length) break;
      const name = sectionHeader.subarray(0, 3).toString("ascii");
      const sectionSize = sectionHeader.readInt32LE(3);
      if (sectionSize < 0 || cursor + 7 + sectionSize > size) throw new Error(`Seccion ${name} con tamano invalido`);
      if (name === "CPS") return sectionSize;
      cursor += 7 + sectionSize;
    }
    throw new Error("El CPE no contiene seccion CPS");
  } finally {
    fs.closeSync(fd);
  }
}

function metadataFromRow(row) {
  return {
    fileName: row.fileName,
    serial: row.serial || "",
    tei: row.tei || "",
    issi: row.issi || "",
    codeplug: row.codeplug || "",
    software: row.software || "",
    cpuId: row.cpuId || "",
    cpeVersion: row.cpeVersion || "",
    date: row.folderDate || "",
    dateKey: row.dateKey || 0,
    sourceFolder: row.sourceFolder || "",
    programmer: row.programmer || "",
  };
}

async function main() {
  if (fileSizeArgument && (!Number.isSafeInteger(requestedFileSize) || requestedFileSize <= 0)) {
    throw new Error("--file-size debe contener un tamano de archivo valido");
  }
  const candidates = requestedFileSize
    ? database.db.prepare(`
        SELECT * FROM scanned_files
        WHERE existsFlag=1 AND size=?
        ORDER BY id
      `).all(requestedFileSize)
    : missingEmergency
    ? database.db.prepare(`
        SELECT * FROM scanned_files
        WHERE existsFlag=1 AND errorMessage='' AND emergencySupported=0
        ORDER BY id
      `).all().filter(mayContainSupportedEmergencyCps)
    : forceCodeplug
    ? database.db.prepare(`
        SELECT * FROM scanned_files
        WHERE existsFlag=1 AND codeplug=?
        ORDER BY id
      `).all(requestedCodeplug)
    : requestedCodeplug
    ? database.db.prepare(`
        SELECT * FROM scanned_files
        WHERE existsFlag=1 AND errorMessage<>'' AND codeplug=?
        ORDER BY id
      `).all(requestedCodeplug)
    : database.db.prepare(`
        SELECT * FROM scanned_files
        WHERE existsFlag=1 AND errorMessage<>''
        ORDER BY id
      `).all();
  const maintenanceRoot = missingEmergency
    ? `${RUN_ROOT} [emergencia pendiente]`
    : `${RUN_ROOT} [reproceso de errores]`;
  const runId = database.startScan(maintenanceRoot);
  const pending = [];
  const missingFileIds = [];
  const stats = { discovered: candidates.length, analyzed: 0, reused: 0, errorCount: 0, removed: 0 };
  let eligible = 0;

  const flush = () => {
    if (!pending.length) return;
    database.storeBatch(pending.splice(0));
    database.updateScan(runId, stats);
  };

  try {
    for (const row of candidates) {
      let cpsSize;
      try {
        cpsSize = readCpsSize(row.path);
      } catch (error) {
        if (error?.code === "ENOENT") {
          missingFileIds.push(row.id);
          stats.removed += 1;
        }
        stats.reused += 1;
        continue;
      }
      const familyLayout = LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE[row.codeplug]?.[cpsSize];
      const emergencyLayout = EMERGENCY_LAYOUTS_BY_CPS_SIZE[cpsSize];
      if (!familyLayout && !LAYOUTS_BY_CPS_SIZE[cpsSize] && !emergencyLayout) {
        stats.reused += 1;
        continue;
      }

      eligible += 1;
      const meta = metadataFromRow(row);
      try {
        const stat = fs.statSync(row.path);
        const codeplug = extractCodeplugFile(row.path);
        pending.push({ path: row.path, size: stat.size, mtimeMs: stat.mtimeMs, meta, codeplug });
        stats.analyzed += 1;
      } catch (error) {
        pending.push({ path: row.path, size: row.size, mtimeMs: row.mtimeMs, meta, error });
        stats.analyzed += 1;
        stats.errorCount += 1;
      }

      if (pending.length >= BATCH_SIZE) flush();
      if (eligible % 1000 === 0) process.stderr.write(`Reprocesados ${eligible}\n`);
    }
    flush();
    database.markDeleted(missingFileIds);
    database.finishScan(runId, stats);
    console.log(JSON.stringify({ requestedCodeplug: requestedCodeplug || null, requestedFileSize: requestedFileSize || null, forceCodeplug, missingEmergency, candidates: candidates.length, eligible, corrected: stats.analyzed - stats.errorCount, stillFailing: stats.errorCount, missingFilesRemoved: missingFileIds.length, unsupported: stats.reused - missingFileIds.length }, null, 2));
  } catch (error) {
    flush();
    database.finishScan(runId, stats);
    throw error;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
