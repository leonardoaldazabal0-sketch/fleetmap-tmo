const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");

process.env.CPE_DB_FILE = path.join(os.tmpdir(), `cpe-feature-parser-${process.pid}.sqlite`);
const app = require("../server");

const livePath = runtimePaths.dataFile("cpe-dashboard.sqlite");
const live = new Database(livePath, { timeout: 10000 });
live.pragma("busy_timeout = 10000");

function supportedTotalSizes() {
  const cpsSizes = new Set(Object.keys(app.LAYOUTS_BY_CPS_SIZE).map(Number));
  for (const variants of Object.values(app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE)) {
    for (const size of Object.keys(variants)) cpsSizes.add(Number(size));
  }
  return [...cpsSizes].flatMap((size) => [size + 86, size + 87, size + 131165]);
}

function run() {
  const columns = new Set(live.prepare("PRAGMA table_info(scanned_files)").all().map((column) => column.name));
  if (!columns.has("featuresJson")) throw new Error("Reinicia primero el dashboard para aplicar la migracion featuresJson");
  const sizes = [...new Set(supportedTotalSizes())];
  const rows = live.prepare(`
    SELECT id,path,size,mtimeMs,issi,serial,codeplug
    FROM scanned_files
    WHERE existsFlag=1 AND errorMessage='' AND COALESCE(featuresJson,'')=''
      AND size IN (${sizes.map(() => "?").join(",")})
    ORDER BY dateKey DESC,mtimeMs DESC,id
  `).all(...sizes);
  const update = live.prepare("UPDATE scanned_files SET featuresJson=?, lastParsedAt=? WHERE id=? AND size=? AND mtimeMs=?");
  const writeBatch = live.transaction((batch) => {
    for (const item of batch) update.run(JSON.stringify(item.features), item.parsedAt, item.id, item.size, item.mtimeMs);
  });
  const stats = { candidates: rows.length, updated: 0, skipped: 0, errors: 0, bySource: {} };
  const failures = [];
  let batch = [];
  for (const row of rows) {
    try {
      const before = fs.statSync(row.path);
      if (before.size !== row.size || before.mtimeMs !== row.mtimeMs) {
        stats.skipped += 1;
        continue;
      }
      const codeplug = app.extractCodeplugFile(row.path);
      const after = fs.statSync(row.path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        stats.skipped += 1;
        continue;
      }
      if (!codeplug.features?.source) {
        stats.skipped += 1;
        continue;
      }
      batch.push({ id: row.id, size: row.size, mtimeMs: row.mtimeMs, features: codeplug.features, parsedAt: new Date().toISOString() });
      const source = codeplug.features.source;
      stats.bySource[source] = (stats.bySource[source] || 0) + 1;
      if (batch.length >= 100) {
        writeBatch(batch);
        stats.updated += batch.length;
        batch = [];
        console.log(JSON.stringify(stats));
      }
    } catch (error) {
      stats.errors += 1;
      failures.push({ id: row.id, path: row.path, message: error.message });
    }
  }
  if (batch.length) {
    writeBatch(batch);
    stats.updated += batch.length;
  }
  const result = { stats, failures, finishedAt: new Date().toISOString() };
  console.log(JSON.stringify(result));
  return result;
}

try {
  run();
} finally {
  live.close();
  app.database.close();
  try { fs.rmSync(process.env.CPE_DB_FILE, { force: true }); } catch {}
}
