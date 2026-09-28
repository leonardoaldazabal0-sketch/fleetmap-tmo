const fs = require("node:fs");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");
const {
  BROADCAST_LAYOUTS,
  DMO_INDICATOR_OFFSETS,
  GPS_INDICATOR_OFFSETS,
  OTAP_INDICATOR_OFFSETS,
  OTAP_UNSUPPORTED_CPS_LENGTHS,
  SCAN_INDICATOR_OFFSETS,
  unavailableFeatures,
} = require("../lib/cpe-features");

const PARSER_VERSION = "21";
const CONTROLLED_LENGTHS = new Set(Object.keys(SCAN_INDICATOR_OFFSETS).map(Number));
const DIRECT_BROADCAST_DESTINATION_LENGTHS = new Set([1079232, 3021888]);
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

function booleanByte(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function requiredOffsets(cpsLength) {
  const broadcast = BROADCAST_LAYOUTS[cpsLength];
  return [
    SCAN_INDICATOR_OFFSETS[cpsLength],
    DMO_INDICATOR_OFFSETS[cpsLength],
    GPS_INDICATOR_OFFSETS[cpsLength],
    OTAP_INDICATOR_OFFSETS[cpsLength],
    broadcast?.indicatorOffset,
    broadcast?.priorityOffset,
    broadcast?.destinationPositionOffset == null ? null : broadcast.destinationPositionOffset + 3,
  ].filter(Number.isInteger);
}

function readUtf16(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString("utf16le").split("\0")[0].trim();
}

async function readDirectBroadcastDestination(handle, dataOffset, cpsLength, broadcast, destinationPosition) {
  if (!DIRECT_BROADCAST_DESTINATION_LENGTHS.has(cpsLength) || destinationPosition < 1) return null;
  const maxRecords = cpsLength === 1079232 ? 2000 : 10000;
  const tableLength = broadcast.mainRecordSize * maxRecords;
  const encrypted = await readExact(handle, tableLength, dataOffset + broadcast.mainOffset);
  const table = decryptCpsRange(encrypted, cpsLength, broadcast.mainOffset);
  const candidates = [];
  for (let index = 0; index < maxRecords; index += 1) {
    const base = index * broadcast.mainRecordSize;
    const state = table[base + broadcast.mainAliasBytes];
    const groupCode = table[base + broadcast.mainAliasBytes + 10];
    if (state !== 2 || groupCode !== 7) continue;
    const alias = readUtf16(table, base, broadcast.mainAliasBytes);
    const gssi = table.readUInt32LE(base + broadcast.mainAliasBytes + 4);
    if (!alias || gssi < 1 || gssi > 16777215) continue;
    candidates.push({ alias, gssi, groupInvisible: true, continuousTracking: true });
  }
  return candidates[destinationPosition - 1] || null;
}

async function readControlledIndicators(filePath, expectedSize, expectedMtimeMs) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (before.size !== expectedSize || before.mtimeMs !== expectedMtimeMs) return null;
    const maxIndicatorOffset = Math.max(...[...CONTROLLED_LENGTHS].flatMap(requiredOffsets));
    const prefix = await readExact(handle, Math.min(expectedSize, 16 + maxIndicatorOffset + 1), 0);
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
        if (!CONTROLLED_LENGTHS.has(sectionLength)) return null;
        const offsets = requiredOffsets(sectionLength);
        const firstOffset = Math.min(...offsets);
        const lastOffset = Math.max(...offsets);
        const encrypted = dataOffset + lastOffset < prefix.length
          ? prefix.subarray(dataOffset + firstOffset, dataOffset + lastOffset + 1)
          : await readExact(handle, lastOffset - firstOffset + 1, dataOffset + firstOffset);
        const values = decryptCpsRange(encrypted, sectionLength, firstOffset);
        const at = (offset) => offset == null ? null : values[offset - firstOffset];
        const uint32At = (offset) => offset == null ? 0 : values.readUInt32LE(offset - firstOffset);
        const broadcast = BROADCAST_LAYOUTS[sectionLength];
        const indicatorByte = at(broadcast?.indicatorOffset);
        const broadcastEnabled = indicatorByte == null
          ? null
          : indicatorByte === broadcast.activeIndicatorValue;
        const destinationPosition = uint32At(broadcast?.destinationPositionOffset);
        const broadcastDestination = broadcastEnabled === true
          ? await readDirectBroadcastDestination(handle, dataOffset, sectionLength, broadcast, destinationPosition)
          : null;
        const result = {
          cpsLength: sectionLength,
          scanEnabled: booleanByte(at(SCAN_INDICATOR_OFFSETS[sectionLength])),
          dmoEnabled: booleanByte(at(DMO_INDICATOR_OFFSETS[sectionLength])),
          gpsEnabled: booleanByte(at(GPS_INDICATOR_OFFSETS[sectionLength])),
          otapEnabled: OTAP_UNSUPPORTED_CPS_LENGTHS.has(sectionLength)
            ? false
            : booleanByte(at(OTAP_INDICATOR_OFFSETS[sectionLength])),
          broadcastEnabled,
          broadcastPriority: at(broadcast?.priorityOffset),
          broadcastDestination,
          fileSize: expectedSize,
          mtimeMs: expectedMtimeMs,
        };
        const after = await handle.stat();
        return after.size === before.size && after.mtimeMs === before.mtimeMs ? result : null;
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

function binaryState(enabled, name) {
  if (enabled === true) return "Activo";
  if (enabled === false) return "Inactivo";
  throw new Error(`Indicador ${name} no binario`);
}

function mergeIndicators(featuresValue, indicators) {
  const features = parseFeatures(featuresValue);
  features.scan = { ...(features.scan || { activeList: "", lists: [] }), state: binaryState(indicators.scanEnabled, "Escaneo") };
  features.dmo = { ...(features.dmo || { groups: [] }), state: binaryState(indicators.dmoEnabled, "DMO") };
  features.gps = { ...(features.gps || { destinationIssi: 0, carrier: "", protocol: "" }), state: binaryState(indicators.gpsEnabled, "GPS") };
  features.otap = { ...(features.otap || { targets: [] }), state: binaryState(indicators.otapEnabled, "OTAP") };

  const broadcast = { ...(features.broadcast || unavailableFeatures().broadcast) };
  broadcast.indicatorActive = indicators.broadcastEnabled;
  if (Number.isInteger(indicators.broadcastPriority)) {
    broadcast.announcementPriority = indicators.broadcastPriority;
  }
  if (DIRECT_BROADCAST_DESTINATION_LENGTHS.has(indicators.cpsLength)) {
    const destination = indicators.broadcastDestination;
    broadcast.destinationConfigured = Boolean(destination);
    broadcast.alias = destination?.alias || "";
    broadcast.gssi = Number(destination?.gssi || 0);
    broadcast.groupInvisible = destination?.groupInvisible ?? null;
    broadcast.continuousTracking = destination?.continuousTracking ?? null;
  }
  if (indicators.cpsLength === 1064192) {
    broadcast.destinationConfigured = false;
    broadcast.alias = "";
    broadcast.gssi = 0;
    broadcast.groupInvisible = null;
    broadcast.continuousTracking = null;
  }
  const destinationConfigured = broadcast.destinationConfigured === true && Number(broadcast.gssi || 0) > 0;
  const priority = Number(broadcast.announcementPriority);
  broadcast.state = indicators.broadcastEnabled === true && destinationConfigured
    ? priority === 10 ? "Solo escucha" : "Revisar"
    : "Inactivo";
  features.broadcast = broadcast;
  features.source = "cpe-layout-validated";
  return features;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const skipBackup = process.argv.includes("--skip-backup");
  const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
  const concurrency = concurrencyArg ? Number(concurrencyArg.split("=")[1]) : 48;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 128) {
    throw new Error("Concurrencia invalida");
  }
  const shardArg = process.argv.find((arg) => arg.startsWith("--shard="));
  const shardMatch = shardArg?.match(/^--shard=(\d+)\/(\d+)$/);
  if (shardArg && !shardMatch) throw new Error("Particion invalida");
  const shard = shardMatch ? { index: Number(shardMatch[1]), total: Number(shardMatch[2]) } : null;
  if (shard && (shard.total < 1 || shard.index < 0 || shard.index >= shard.total)) {
    throw new Error("Particion fuera de rango");
  }

  const databasePath = runtimePaths.dataFile("cpe-dashboard.sqlite");
  const database = new Database(databasePath, { fileMustExist: true, timeout: 10000 });
  database.pragma("busy_timeout = 10000");
  const sizes = [...new Set([...CONTROLLED_LENGTHS].flatMap(
    (length) => OBSERVED_WRAPPER_OVERHEADS.map((overhead) => length + overhead),
  ))];
  const rows = database.prepare(`
    SELECT id,path,size,mtimeMs,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND errorMessage='' AND size IN (${sizes.map(() => "?").join(",")})
      ${shard ? `AND (id % ${shard.total}) = ${shard.index}` : ""}
    ORDER BY id
  `).all(...sizes);
  const update = database.prepare(`
    UPDATE scanned_files
    SET featuresJson=?,lastParsedAt=?,parserVersion=?
    WHERE id=? AND size=? AND mtimeMs=?
  `);
  const writeBatch = database.transaction((items) => {
    for (const item of items) {
      update.run(item.featuresJson, item.parsedAt, PARSER_VERSION, item.id, item.size, item.mtimeMs);
    }
  });

  let backup = "";
  if (apply && !skipBackup) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    backup = runtimePaths.dataFile(`before-controlled-feature-indicators-${stamp}.sqlite`);
    await database.backup(backup);
  }

  const stats = { candidates: rows.length, supported: 0, updated: 0, skipped: 0, errors: 0, broadcastDestinationReads: 0, byCpsLength: {} };
  const failures = [];
  const pending = [];
  let rowIndex = 0;
  async function worker() {
    while (true) {
      const index = rowIndex++;
      if (index >= rows.length) return;
      const row = rows[index];
      try {
        const indicators = await readControlledIndicators(row.path, row.size, row.mtimeMs);
        if (!indicators) {
          stats.skipped += 1;
          continue;
        }
        const features = mergeIndicators(row.featuresJson, indicators);
        if (indicators.broadcastDestination) stats.broadcastDestinationReads += 1;
        stats.supported += 1;
        stats.byCpsLength[indicators.cpsLength] = (stats.byCpsLength[indicators.cpsLength] || 0) + 1;
        if (stats.supported % 1000 === 0) console.log(JSON.stringify(stats));
        if (apply) pending.push({
          id: row.id,
          size: row.size,
          mtimeMs: row.mtimeMs,
          featuresJson: JSON.stringify(features),
          parsedAt: new Date().toISOString(),
        });
        if (apply && pending.length >= 250) {
          const batch = pending.splice(0);
          writeBatch(batch);
          stats.updated += batch.length;
        }
      } catch (error) {
        stats.errors += 1;
        if (failures.length < 200) failures.push({ id: row.id, path: row.path, message: error.message });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, () => worker()));
    if (apply && pending.length) {
      const batch = pending.splice(0);
      writeBatch(batch);
      stats.updated += batch.length;
    }
    const shardSuffix = shard ? `-shard-${shard.index}-of-${shard.total}` : "";
    const report = runtimePaths.dataFile(apply
      ? `controlled-feature-indicators-update${shardSuffix}.json`
      : `controlled-feature-indicators-audit${shardSuffix}.json`);
    fs.writeFileSync(report, JSON.stringify({ stats, backup, failures, finishedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ stats, backup, report, failures: failures.length }));
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
