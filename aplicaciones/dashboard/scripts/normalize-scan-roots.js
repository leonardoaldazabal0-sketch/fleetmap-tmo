const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
const centralRoot = process.env.CPE_CENTRAL_ROOT || "\\\\192.168.7.252\\tic\\002 Programacion";
const db = new Database(databasePath);
const result = db.prepare(`
  UPDATE scan_runs
  SET rootPath=?
  WHERE rootPath LIKE '%[reprocess-unsupported-codeplugs-v%'
`).run(centralRoot);
console.log(JSON.stringify({ updatedRuns: result.changes, centralRoot }));
db.close();
