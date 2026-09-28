const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

const result = {
  integrity: db.pragma("integrity_check"),
  totals: db.prepare(`
    SELECT
      COUNT(*) AS indexedFiles,
      SUM(CASE WHEN existsFlag=1 THEN 1 ELSE 0 END) AS existingFiles,
      SUM(CASE WHEN existsFlag=1 AND errorMessage<>'' THEN 1 ELSE 0 END) AS errorFiles,
      SUM(CASE WHEN existsFlag=1 AND errorMessage='' THEN 1 ELSE 0 END) AS validFiles,
      SUM(CASE WHEN existsFlag=1 THEN groupCount ELSE 0 END) AS storedGroups
    FROM scanned_files
  `).get(),
  runs: db.prepare("SELECT * FROM scan_runs ORDER BY id").all(),
  errors: db.prepare(`
    SELECT COALESCE(NULLIF(codeplug,''), '(desconocido)') AS codeplug,
           errorMessage, COUNT(*) AS count
    FROM scanned_files
    WHERE existsFlag=1 AND errorMessage<>''
    GROUP BY codeplug, errorMessage
    ORDER BY count DESC
    LIMIT 40
  `).all(),
};

console.log(JSON.stringify(result, null, 2));
db.close();
