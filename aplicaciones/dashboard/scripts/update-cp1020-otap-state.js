const fs = require("node:fs");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");
const { OTAP_INDICATOR_OFFSETS, unavailableFeatures } = require("../lib/cpe-features");

const CPS_LENGTH = 2728576;
const CORRECT_OFFSET = OTAP_INDICATOR_OFFSETS[CPS_LENGTH];
const PREVIOUS_OFFSET = 3152;
const WRAPPER_OVERHEADS = [42, 84, 85, 86, 87, 131165];

function decryptByte(value, cpsLength, offset) {
  let decrypted = value ^ ((offset * 111) & 0xff);
  decrypted = (decrypted - ((cpsLength - offset) & 0xff)) & 0xff;
  return decrypted;
}

function booleanIndicator(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

async function readIndicatorState(filePath, expectedSize, expectedMtimeMs) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size !== expectedSize || stat.mtimeMs !== expectedMtimeMs) {
      return { stale: true };
    }
    const prefix = Buffer.alloc(Math.min(expectedSize, 4096));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead !== prefix.length) throw new Error("Archivo CPE truncado");
    if (prefix.subarray(0, 7).toString("ascii") !== "CPDFile") {
      throw new Error("No parece un archivo CPE Motorola");
    }

    let cursor = 9;
    while (cursor + 7 <= prefix.length) {
      const name = prefix.subarray(cursor, cursor + 3).toString("ascii");
      const sectionLength = prefix.readInt32LE(cursor + 3);
      const dataOffset = cursor + 7;
      if (sectionLength < 0 || dataOffset + sectionLength > expectedSize) {
        throw new Error(`Seccion ${name} con tamano invalido`);
      }
      if (name === "CPS") {
        if (sectionLength !== CPS_LENGTH) return { unsupported: true, cpsLength: sectionLength };
        if (dataOffset + PREVIOUS_OFFSET >= prefix.length) {
          throw new Error("Prefijo insuficiente para leer el indicador OTAP");
        }
        const currentValue = decryptByte(prefix[dataOffset + CORRECT_OFFSET], sectionLength, CORRECT_OFFSET);
        const previousValue = decryptByte(prefix[dataOffset + PREVIOUS_OFFSET], sectionLength, PREVIOUS_OFFSET);
        return {
          cpsLength: sectionLength,
          enabled: booleanIndicator(currentValue),
          previousEnabled: booleanIndicator(previousValue),
          currentValue,
          previousValue,
        };
      }
      if (dataOffset + sectionLength > prefix.length) break;
      cursor = dataOffset + sectionLength;
    }
    throw new Error("No se encontro la seccion CPS");
  } finally {
    await handle.close();
  }
}

function parseFeatures(value) {
  try {
    return value ? JSON.parse(value) : unavailableFeatures();
  } catch {
    return unavailableFeatures();
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const skipBackup = process.argv.includes("--skip-backup");
  const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
  const concurrency = concurrencyArg ? Number(concurrencyArg.split("=")[1]) : 96;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) {
    throw new Error("La concurrencia debe ser un entero entre 1 y 256");
  }

  const dbPath = runtimePaths.dataFile("cpe-dashboard.sqlite");
  const db = new Database(dbPath, { fileMustExist: true, timeout: 10000 });
  db.pragma("busy_timeout = 10000");
  const wrapperSizes = WRAPPER_OVERHEADS.map((overhead) => CPS_LENGTH + overhead);
  const rows = db.prepare(`
    SELECT id,path,size,mtimeMs,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
      AND size IN (${wrapperSizes.map(() => "?").join(",")})
    ORDER BY path
  `).all(...wrapperSizes);
  const update = db.prepare(`
    UPDATE scanned_files SET featuresJson=?,lastParsedAt=?
    WHERE id=? AND size=? AND mtimeMs=?
  `);
  const writeBatch = db.transaction((batch) => {
    for (const item of batch) update.run(item.featuresJson, item.parsedAt, item.id, item.size, item.mtimeMs);
  });

  let backup = "";
  if (apply && !skipBackup) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    backup = runtimePaths.dataFile(`before-cp1020-otap-${stamp}.sqlite`);
    await db.backup(backup);
  }

  const stats = {
    candidates: rows.length,
    supported: 0,
    updated: 0,
    stale: 0,
    unsupported: 0,
    errors: 0,
    active: 0,
    inactive: 0,
    ambiguous: 0,
    unchanged: 0,
    differsFromPreviousOffset: 0,
    previousActiveNowInactive: 0,
    previousInactiveNowActive: 0,
  };
  const failures = [];
  const pending = [];
  let rowIndex = 0;

  async function worker() {
    while (true) {
      const index = rowIndex;
      rowIndex += 1;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        const result = await readIndicatorState(row.path, row.size, row.mtimeMs);
        if (result.stale) {
          stats.stale += 1;
          continue;
        }
        if (result.unsupported) {
          stats.unsupported += 1;
          continue;
        }
        stats.supported += 1;
        if (result.enabled === true) stats.active += 1;
        else if (result.enabled === false) stats.inactive += 1;
        else stats.ambiguous += 1;
        if (result.enabled !== result.previousEnabled) {
          stats.differsFromPreviousOffset += 1;
          if (result.previousEnabled === true && result.enabled === false) stats.previousActiveNowInactive += 1;
          if (result.previousEnabled === false && result.enabled === true) stats.previousInactiveNowActive += 1;
        }

        const features = parseFeatures(row.featuresJson);
        const nextState = result.enabled === true ? "Activo" : result.enabled === false ? "Inactivo" : "No disponible";
        if (features.otap?.state === nextState) {
          stats.unchanged += 1;
          continue;
        }
        features.otap = {
          ...(features.otap || { targets: [] }),
          state: nextState,
        };
        pending.push({
          id: row.id,
          size: row.size,
          mtimeMs: row.mtimeMs,
          parsedAt: new Date().toISOString(),
          featuresJson: JSON.stringify(features),
        });
        if (apply && pending.length >= 250) {
          const batch = pending.splice(0);
          writeBatch(batch);
          stats.updated += batch.length;
        }
      } catch (error) {
        stats.errors += 1;
        if (failures.length < 100) failures.push({ id: row.id, path: row.path, message: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, () => worker()));
  if (apply && pending.length) {
    const batch = pending.splice(0);
    writeBatch(batch);
    stats.updated += batch.length;
  }

  const report = runtimePaths.dataFile(apply
    ? "cp1020-otap-update-report.json"
    : "cp1020-otap-audit-report.json");
  fs.writeFileSync(report, JSON.stringify({ stats, backup, failures, finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ stats, backup, report, failures: failures.length }));
  db.close();
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
