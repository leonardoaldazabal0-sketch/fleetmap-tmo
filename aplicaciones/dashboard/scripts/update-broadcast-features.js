const fs = require("node:fs");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");
const { BROADCAST_LAYOUTS, buildBroadcastFeature, unavailableFeatures } = require("../lib/cpe-features");

const WRAPPER_OVERHEADS = [42, 84, 85, 86, 87, 131165];

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
    decrypted[local] = (value - ((cpsLength - index) & 0xff)) & 0xff;
  }
  return decrypted;
}

function readUtf16(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString("utf16le").split("\0")[0].trim();
}

async function readBroadcastFromCpe(filePath, expectedStat, resolveDestinations) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = expectedStat;
    const preamble = await readExact(handle, 9, 0);
    if (preamble.subarray(0, 7).toString("ascii") !== "CPDFile") throw new Error("CPE Motorola invalido");
    let cursor = 9;
    while (cursor + 7 <= stat.size) {
      const header = await readExact(handle, 7, cursor);
      const name = header.subarray(0, 3).toString("ascii");
      const cpsLength = header.readInt32LE(3);
      const dataOffset = cursor + 7;
      if (cpsLength < 0 || dataOffset + cpsLength > stat.size) throw new Error(`Seccion ${name} invalida`);
      if (name === "CPS") {
        const layout = BROADCAST_LAYOUTS[cpsLength];
        if (!layout) return null;
        const offsets = [
          layout.indicatorOffset,
          layout.destinationPositionOffset,
          layout.priorityOffset,
          layout.announcementAliasOffset,
        ].filter((offset) => offset != null);
        const rangeOffset = Math.min(...offsets);
        const rangeEnd = Math.max(
          layout.announcementAliasOffset + layout.announcementAliasBytes,
          layout.priorityOffset + 1,
          layout.indicatorOffset == null ? 0 : layout.indicatorOffset + 1,
          layout.destinationPositionOffset == null ? 0 : layout.destinationPositionOffset + 4,
        );
        const decoded = decryptCpsRange(
          await readExact(handle, rangeEnd - rangeOffset, dataOffset + rangeOffset),
          cpsLength,
          rangeOffset,
        );
        const relative = (offset) => offset - rangeOffset;
        const destinationPosition = layout.destinationPositionOffset == null
          ? 0
          : decoded.readUInt32LE(relative(layout.destinationPositionOffset));
        const candidates = (destinationPosition > 0 || layout.allowUniqueContinuousGroup)
          ? resolveDestinations(destinationPosition)
          : [];

        async function groupValues(group) {
          if (!group || Number(group.slot) < 1) return { groupCode: null, mainState: null };
          const stateOffset = layout.mainOffset
            + (Number(group.slot) - 1) * layout.mainRecordSize
            + layout.mainAliasBytes;
          const encrypted = await readExact(handle, 11, dataOffset + stateOffset);
          const values = decryptCpsRange(encrypted, cpsLength, stateOffset);
          return { mainState: values[0], groupCode: values[10] };
        }

        let destination = candidates.find((group) => Number(group.folderRow) === destinationPosition) || null;
        let { groupCode, mainState } = await groupValues(destination);
        const directValid = destination
          && groupCode === 7
          && (destination.status === 2 || destination.statusText === "Invisible" || mainState === 2);
        if (!directValid && (destinationPosition > 0 || layout.allowUniqueContinuousGroup)) {
          const valid = [];
          for (const group of candidates) {
            const values = await groupValues(group);
            if (values.groupCode === 7
              && (group.status === 2 || group.statusText === "Invisible" || values.mainState === 2)) {
              valid.push({ group, ...values });
            }
          }
          if (valid.length === 1) {
            destination = valid[0].group;
            groupCode = valid[0].groupCode;
            mainState = valid[0].mainState;
          }
        }
        return {
          cpsLength,
          fileSize: stat.size,
          mtimeMs: stat.mtimeMs,
          feature: buildBroadcastFeature({
            indicatorByte: layout.indicatorOffset == null ? null : decoded[relative(layout.indicatorOffset)],
            activeIndicatorValue: layout.activeIndicatorValue,
            destination,
            groupCode,
            mainState,
            destinationPosition,
            announcementPriority: decoded[relative(layout.priorityOffset)],
            announcementAlias: readUtf16(decoded, relative(layout.announcementAliasOffset), layout.announcementAliasBytes),
            inferIndicatorFromConfig: layout.inferIndicatorFromConfig,
            inferInactiveWhenBlank: layout.inferInactiveWhenBlank,
          }),
        };
      }
      cursor = dataOffset + cpsLength;
    }
    throw new Error("Seccion CPS ausente");
  } finally {
    await handle.close();
  }
}

function parseFeatures(value) {
  try { return value ? JSON.parse(value) : unavailableFeatures(); }
  catch { return unavailableFeatures(); }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const latestOnly = process.argv.includes("--latest");
  const pendingOnly = process.argv.includes("--pending");
  const db = new Database(runtimePaths.dataFile("cpe-dashboard.sqlite"), { fileMustExist: true, timeout: 10000 });
  db.pragma("busy_timeout = 10000");
  const wrapperSizes = [...new Set(Object.keys(BROADCAST_LAYOUTS).map(Number)
    .flatMap((length) => WRAPPER_OVERHEADS.map((overhead) => length + overhead)))];
  const latestClause = latestOnly ? `
      AND id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY issi ORDER BY dateKey DESC,mtimeMs DESC,id DESC
          ) AS position
          FROM scanned_files
          WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
        ) WHERE position=1
      )` : "";
  const pendingClause = pendingOnly
    ? "AND COALESCE(json_extract(featuresJson,'$.broadcast.state'),'No disponible')='No disponible'"
    : "";
  const rows = db.prepare(`
    SELECT id,path,size,mtimeMs,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
      AND size IN (${wrapperSizes.map(() => "?").join(",")})
      ${latestClause}
      ${pendingClause}
    ORDER BY path
  `).all(...wrapperSizes);
  const findDestinations = db.prepare(`
    SELECT folderRow,slot,alias,gssi,status,statusText
    FROM talkgroups
    WHERE fileId=? AND (
      folderRow=?
      OR status=2
      OR INSTR(UPPER(alias),'BROADCA')>0
    )
    ORDER BY slot
  `);
  const update = db.prepare(`
    UPDATE scanned_files SET featuresJson=?,lastParsedAt=?
    WHERE id=? AND size=? AND mtimeMs=?
  `);
  const writeBatch = db.transaction((batch) => {
    for (const item of batch) update.run(item.featuresJson, item.parsedAt, item.id, item.size, item.mtimeMs);
  });
  let backup = "";
  if (apply) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    backup = runtimePaths.dataFile(`before-broadcast-layout-${stamp}.sqlite`);
    await db.backup(backup);
  }
  const stats = { candidates: rows.length, supported: 0, listening: 0, inactive: 0, review: 0, updated: 0, skipped: 0, errors: 0, byCpsLength: {} };
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
        const result = await readBroadcastFromCpe(
          row.path,
          { size: row.size, mtimeMs: row.mtimeMs },
          (position) => findDestinations.all(row.id, position),
        );
        if (!result || result.fileSize !== row.size || result.mtimeMs !== row.mtimeMs) {
          stats.skipped += 1;
          continue;
        }
        stats.supported += 1;
        stats.byCpsLength[result.cpsLength] = (stats.byCpsLength[result.cpsLength] || 0) + 1;
        if (result.feature.state === "Solo escucha") stats.listening += 1;
        else if (result.feature.state === "Inactivo") stats.inactive += 1;
        else stats.review += 1;
        const features = parseFeatures(row.featuresJson);
        if (features.source !== "user-report-exact") features.broadcast = result.feature;
        if (!features.source) features.source = "cpe-layout-validated";
        pending.push({ id: row.id, size: row.size, mtimeMs: row.mtimeMs, parsedAt: new Date().toISOString(), featuresJson: JSON.stringify(features) });
        if (apply && pending.length >= 250) {
          const count = pending.length;
          writeBatch(pending.splice(0));
          stats.updated += count;
        }
        if (stats.supported % 1000 === 0) console.log(JSON.stringify(stats));
      } catch (error) {
        stats.errors += 1;
        if (failures.length < 100) failures.push({ id: row.id, path: row.path, message: error.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, rows.length || 1) }, () => worker()));
  if (apply && pending.length) {
    stats.updated += pending.length;
    writeBatch(pending.splice(0));
  }
  const report = runtimePaths.dataFile(apply ? "broadcast-update-report.json" : "broadcast-audit-report.json");
  fs.writeFileSync(report, JSON.stringify({ stats, backup, failures, finishedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ stats, backup, report, failures: failures.length }));
  db.close();
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
