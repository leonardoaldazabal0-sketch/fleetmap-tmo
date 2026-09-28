const fs = require("node:fs");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");
const {
  OTAP_INDICATOR_OFFSETS,
  OTAP_TABLES,
  unavailableFeatures,
} = require("../lib/cpe-features");

const SUPPORTED_CPS_LENGTHS = new Set([
  ...Object.keys(OTAP_TABLES).map(Number),
  ...Object.keys(OTAP_INDICATOR_OFFSETS).map(Number),
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

async function readOtapStateFromCpe(filePath) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (stat.size < 16) throw new Error("Archivo demasiado pequeno");
    const preamble = await readExact(handle, 9, 0);
    if (preamble.subarray(0, 7).toString("ascii") !== "CPDFile") {
      throw new Error("No parece un archivo CPE Motorola");
    }
    let cursor = 9;
    while (cursor + 7 <= stat.size) {
      const header = await readExact(handle, 7, cursor);
      const name = header.subarray(0, 3).toString("ascii");
      const cpsLength = header.readInt32LE(3);
      const dataOffset = cursor + 7;
      if (cpsLength < 0 || dataOffset + cpsLength > stat.size) {
        throw new Error(`Seccion ${name} con tamano invalido`);
      }
      if (name === "CPS") {
        const indicatorOffset = OTAP_INDICATOR_OFFSETS[cpsLength];
        if (indicatorOffset == null) return null;
        let enabled = null;
        const encryptedIndicator = await readExact(handle, 1, dataOffset + indicatorOffset);
        const indicator = decryptCpsRange(encryptedIndicator, cpsLength, indicatorOffset)[0];
        if (indicator === 1) enabled = true;
        else if (indicator === 0) enabled = false;
        return {
          cpsLength,
          enabled,
          fileSize: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      cursor = dataOffset + cpsLength;
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
  const onlyUnavailable = process.argv.includes("--only-unavailable");
  const skipBackup = process.argv.includes("--skip-backup");
  const shardArg = process.argv.find((arg) => arg.startsWith("--shard="));
  const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
  const requestedConcurrency = concurrencyArg ? Number(concurrencyArg.split("=")[1]) : null;
  if (concurrencyArg && (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 512)) {
    throw new Error(`Concurrencia invalida: ${concurrencyArg.split("=")[1]}`);
  }
  const shardMatch = shardArg?.match(/^--shard=(\d+)\/(\d+)$/);
  if (shardArg && !shardMatch) throw new Error(`Particion invalida: ${shardArg}`);
  const shard = shardMatch
    ? { index: Number(shardMatch[1]), total: Number(shardMatch[2]) }
    : null;
  if (shard && (shard.total < 1 || shard.index < 0 || shard.index >= shard.total)) {
    throw new Error(`Particion fuera de rango: ${shardArg}`);
  }
  const requestedLengthArg = process.argv.find((arg) => arg.startsWith("--cps-length="));
  const requestedCpsLength = requestedLengthArg ? Number(requestedLengthArg.split("=")[1]) : null;
  if (requestedLengthArg && !SUPPORTED_CPS_LENGTHS.has(requestedCpsLength)) {
    throw new Error(`Longitud CPS OTAP no soportada: ${requestedLengthArg.split("=")[1]}`);
  }
  const selectedCpsLengths = requestedCpsLength == null
    ? [...SUPPORTED_CPS_LENGTHS]
    : [requestedCpsLength];
  const dbPath = runtimePaths.dataFile("cpe-dashboard.sqlite");
  const db = new Database(dbPath, { fileMustExist: true, timeout: 10000 });
  db.pragma("busy_timeout = 10000");
  const wrapperSizes = [...new Set(selectedCpsLengths.flatMap(
    (length) => OBSERVED_WRAPPER_OVERHEADS.map((overhead) => length + overhead),
  ))];
  const cpsLengthsBySize = new Map();
  for (const cpsLength of selectedCpsLengths) {
    for (const overhead of OBSERVED_WRAPPER_OVERHEADS) {
      const size = cpsLength + overhead;
      if (!cpsLengthsBySize.has(size)) cpsLengthsBySize.set(size, []);
      cpsLengthsBySize.get(size).push(cpsLength);
    }
  }
  const rows = db.prepare(`
    SELECT id,path,size,mtimeMs,issi,codeplug,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND errorMessage='' AND size IN (${wrapperSizes.map(() => "?").join(",")})
      ${onlyUnavailable ? "AND json_extract(featuresJson, '$.otap.state') = 'No disponible'" : ""}
      ${shard ? `AND (id % ${shard.total}) = ${shard.index}` : ""}
    ORDER BY path
  `).all(...wrapperSizes);
  const update = db.prepare(`
    UPDATE scanned_files SET featuresJson=?,lastParsedAt=?
    WHERE id=? AND size=? AND mtimeMs=?
  `);
  const writeBatch = db.transaction((batch) => {
    for (const item of batch) {
      update.run(item.featuresJson, item.parsedAt, item.id, item.size, item.mtimeMs);
    }
  });
  const stats = {
    candidates: rows.length,
    supported: 0,
    active: 0,
    inactive: 0,
    unavailable: 0,
    withTargets: 0,
    empty: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    byCpsLength: {},
  };
  const failures = [];
  const pending = [];
  let backup = "";
  if (apply && !skipBackup) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    backup = runtimePaths.dataFile(`before-otap-audit-${stamp}.sqlite`);
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
      const candidateLengths = cpsLengthsBySize.get(row.size) || [];
      if (candidateLengths.length !== 1) {
        stats.skipped += 1;
        continue;
      }
      const cpsLength = candidateLengths[0];
      const result = OTAP_INDICATOR_OFFSETS[cpsLength] == null
        ? { cpsLength, enabled: null, fileSize: row.size, mtimeMs: row.mtimeMs }
        : await readOtapStateFromCpe(row.path);
      if (!result) {
        stats.skipped += 1;
        continue;
      }
      if (result.fileSize !== row.size || result.mtimeMs !== row.mtimeMs) {
        stats.skipped += 1;
        continue;
      }
      stats.supported += 1;
      stats.byCpsLength[result.cpsLength] = (stats.byCpsLength[result.cpsLength] || 0) + 1;
      if (result.enabled === true) stats.active += 1;
      else if (result.enabled === false) stats.inactive += 1;
      else stats.unavailable += 1;
      const features = parseFeatures(row.featuresJson);
      const targets = Array.isArray(features.otap?.targets) ? features.otap.targets : [];
      if (targets.length) stats.withTargets += 1;
      else stats.empty += 1;
      features.otap = {
        state: result.enabled === true ? "Activo" : result.enabled === false ? "Inactivo" : "No disponible",
        targets,
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
        writeBatch(pending.splice(0));
        stats.updated += 250;
      }
      if (stats.supported % 1000 === 0) console.log(JSON.stringify(stats));
    } catch (error) {
      stats.errors += 1;
      if (failures.length < 100) failures.push({ id: row.id, path: row.path, message: error.message });
    }
   }
  }
  const concurrency = Math.min(
    requestedConcurrency || (requestedCpsLength == null ? 32 : 128),
    rows.length || 1,
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (apply && pending.length) {
    stats.updated += pending.length;
    writeBatch(pending.splice(0));
  }
  const shardSuffix = shard ? `-shard-${shard.index}-of-${shard.total}` : "";
  const report = runtimePaths.dataFile(apply
    ? `otap-update-report${shardSuffix}.json`
    : `otap-audit-report${shardSuffix}.json`);
  fs.writeFileSync(report, JSON.stringify({ stats, backup, failures, finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ stats, backup, report, failures: failures.length }));
  db.close();
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
