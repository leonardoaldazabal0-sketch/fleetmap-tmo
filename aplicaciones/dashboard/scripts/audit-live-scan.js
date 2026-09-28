const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const run = database.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get();
const duplicates = database.prepare(`
  SELECT LOWER(path) AS pathKey, COUNT(*) AS count, GROUP_CONCAT(id) AS ids
  FROM scanned_files
  WHERE existsFlag=1
  GROUP BY LOWER(path)
  HAVING COUNT(*) > 1
  LIMIT 20
`).all();
const freshCount = database.prepare(`
  SELECT COUNT(*) AS count FROM scanned_files WHERE lastParsedAt>=?
`).get(run.startedAt).count;
const fresh = database.prepare(`
  SELECT id, path, lastParsedAt FROM scanned_files
  WHERE lastParsedAt>=? ORDER BY id DESC LIMIT 20
`).all(run.startedAt);
database.close();
console.log(JSON.stringify({ run, freshCount, duplicates, fresh }, null, 2));
