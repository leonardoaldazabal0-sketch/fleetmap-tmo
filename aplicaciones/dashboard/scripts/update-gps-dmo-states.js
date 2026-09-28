const fs = require("node:fs");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");
const {
  DMO_INDICATOR_OFFSETS,
  GPS_INDICATOR_OFFSETS,
  unavailableFeatures,
} = require("../lib/cpe-features");

const SUPPORTED_CPS_LENGTHS = new Set([
  ...Object.keys(DMO_INDICATOR_OFFSETS).map(Number),
  ...Object.keys(GPS_INDICATOR_OFFSETS).map(Number),
]);
const OBSERVED_WRAPPER_OVERHEADS = [42, 84, 85, 86, 87, 131165];

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let cursor = 0;
  while (cursor < length) {
    const { bytesRead } = await handle.read(buffer, cursor, length - cursor, position + cursor);
    if (!bytesRead) throw new Error("Archivo CPE truncado");
    cursor += bytesRead;
  }
  return buffer;
}

function decryptCpsRange(encrypted, cpsLength, cpsOffset) {
  const decrypted = Buffer.from(encrypted);
  for (let local = 0; local < decrypted.length; local += 1) {
    const index = cpsOffset + local;
    let value = decrypted[local];
    value ^= (index * 111) & 0xff;
    value = (value - ((cpsLength - index) & 0xff)) & 0xff;
    decrypted[local] = value;
  }
  return decrypted;
}

function booleanIndicator(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

async function readGpsDmoState(filePath, expectedSize, expectedMtimeMs) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const lastIndicatorOffset = Math.max(
      ...Object.values(DMO_INDICATOR_OFFSETS),
      ...Object.values(GPS_INDICATOR_OFFSETS),
    );
    const prefix = await readExact(handle, Math.min(expectedSize, 16 + lastIndicatorOffset + 1), 0);
    if (prefix.subarray(0, 7).toString("ascii") !== "CPDFile") {
      throw new Error("No parece un archivo CPE Motorola");
    }
    let cursor = 9;
    while (cursor + 7 <= prefix.length) {
      const header = prefix.subarray(cursor, cursor + 7);
      const name = header.subarray(0, 3).toString("ascii");
      const sectionLength = header.readInt32LE(3);
      const dataOffset = cursor + 7;
      if (sectionLength < 0 || dataOffset + sectionLength > expectedSize) {
        throw new Error(`Seccion ${name} con tamano invalido`);
      }
      if (name === "CPS") {
        if (!SUPPORTED_CPS_LENGTHS.has(sectionLength)) return null;
        const dmoOffset = DMO_INDICATOR_OFFSETS[sectionLength];
        const gpsOffset = GPS_INDICATOR_OFFSETS[sectionLength];
        const firstOffset = Math.min(dmoOffset, gpsOffset);
        const lastOffset = Math.max(dmoOffset, gpsOffset);
        const encrypted = dataOffset + lastOffset < prefix.length
          ? prefix.subarray(dataOffset + firstOffset, dataOffset + lastOffset + 1)
          : await readExact(handle, lastOffset - firstOffset + 1, dataOffset + firstOffset);
        const values = decryptCpsRange(encrypted, sectionLength, firstOffset);
        return {
          cpsLength: sectionLength,
          dmoEnabled: booleanIndicator(values[dmoOffset - firstOffset]),
          gpsEnabled: booleanIndicator(values[gpsOffset - firstOffset]),
          fileSize: expectedSize,
          mtimeMs: expectedMtimeMs,
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
  const onlyUnverified = process.argv.includes("--only-unverified");
  const shardArg = process.argv.find((arg) => arg.startsWith("--shard="));
  const shardMatch = shardArg?.match(/^--shard=(\d+)\/(\d+)$/);
  if (shardArg && !shardMatch) throw new Error(`Particion invalida: ${shardArg}`);
  const shard = shardMatch ? { index: Number(shardMatch[1]), total: Number(shardMatch[2]) } : null;
  if (shard && (shard.total < 1 || shard.index < 0 || shard.index >= shard.total)) {
    throw new Error(`Particion fuera de rango: ${shardArg}`);
  }
  const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
  const requestedConcurrency = concurrencyArg ? Number(concurrencyArg.split("=")[1]) : 48;
  if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 256) {
    throw new Error(`Concurrencia invalida: ${requestedConcurrency}`);
  }

  const dbPath = runtimePaths.dataFile("cpe-dashboard.sqlite");
  const db = new Database(dbPath, { fileMustExist: true, timeout: 10000 });
  db.pragma("busy_timeout = 10000");
  const wrapperSizes = [...new Set([...SUPPORTED_CPS_LENGTHS].flatMap(
    (length) => OBSERVED_WRAPPER_OVERHEADS.map((overhead) => length + overhead),
  ))];
  const rows = db.prepare(`
    SELECT id,path,size,mtimeMs,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND errorMessage='' AND size IN (${wrapperSizes.map(() => "?").join(",")})
      ${onlyUnverified ? `AND CASE WHEN json_valid(featuresJson) THEN
        (COALESCE(json_extract(featuresJson, '$.dmo.state'), '') NOT IN ('Activo','Inactivo')
         OR COALESCE(json_extract(featuresJson, '$.gps.state'), '') NOT IN ('Activo','Inactivo'))
        ELSE 1 END` : ""}
      ${shard ? `AND (id % ${shard.total}) = ${shard.index}` : ""}
    ORDER BY path
  `).all(...wrapperSizes);
  const update = db.prepare(`
    UPDATE scanned_files SET featuresJson=?,lastParsedAt=?
    WHERE id=? AND size=? AND mtimeMs=?
  `);
  const writeBatch = db.transaction((batch) => {
    for (const item of batch) update.run(item.featuresJson, item.parsedAt, item.id, item.size, item.mtimeMs);
  });
  const stats = {
    candidates: rows.length,
    supported: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    dmo: { active: 0, inactive: 0, unavailable: 0 },
    gps: { active: 0, inactive: 0, unavailable: 0 },
    byCpsLength: {},
  };
  const failures = [];
  const pending = [];
  let backup = "";
  if (apply && !skipBackup) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    backup = runtimePaths.dataFile(`before-gps-dmo-update-${stamp}.sqlite`);
    await db.backup(backup);
  }

  let rowIndex = 0;
  async function worker() {
    while (true) {
      const index = rowIndex;
      rowIndex += 1;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        const result = await readGpsDmoState(row.path, row.size, row.mtimeMs);
        if (!result || result.fileSize !== row.size || result.mtimeMs !== row.mtimeMs) {
          stats.skipped += 1;
          continue;
        }
        stats.supported += 1;
        stats.byCpsLength[result.cpsLength] = (stats.byCpsLength[result.cpsLength] || 0) + 1;
        for (const [name, enabled] of [["dmo", result.dmoEnabled], ["gps", result.gpsEnabled]]) {
          if (enabled === true) stats[name].active += 1;
          else if (enabled === false) stats[name].inactive += 1;
          else stats[name].unavailable += 1;
        }
        const features = parseFeatures(row.featuresJson);
        features.dmo = {
          ...(features.dmo || { groups: [] }),
          state: result.dmoEnabled === true ? "Activo" : result.dmoEnabled === false ? "Inactivo" : "No disponible",
        };
        features.gps = {
          ...(features.gps || { destinationIssi: 0, carrier: "", protocol: "" }),
          state: result.gpsEnabled === true ? "Activo" : result.gpsEnabled === false ? "Inactivo" : "No disponible",
        };
        if (!features.source) features.source = "cpe-layout-validated";
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
        if (stats.supported % 2000 === 0) console.log(JSON.stringify(stats));
      } catch (error) {
        stats.errors += 1;
        if (failures.length < 100) failures.push({ id: row.id, path: row.path, message: error.message });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(requestedConcurrency, rows.length || 1) }, () => worker()));
  if (apply && pending.length) {
    const batch = pending.splice(0);
    writeBatch(batch);
    stats.updated += batch.length;
  }
  const shardSuffix = shard ? `-shard-${shard.index}-of-${shard.total}` : "";
  const report = runtimePaths.dataFile(apply
    ? `gps-dmo-update-report${shardSuffix}.json`
    : `gps-dmo-audit-report${shardSuffix}.json`);
  fs.writeFileSync(report, JSON.stringify({ stats, backup, failures, finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ stats, backup, report, failures: failures.length }));
  db.close();
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
