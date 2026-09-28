const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : runtimePaths.dataFile("cpe-dashboard.sqlite");
const centralRoot = path.win32.resolve(
  process.env.CPE_CENTRAL_ROOT || "\\\\192.168.7.252\\tic\\002 Programacion",
);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const count = (sql) => db.prepare(sql).get().value;
const currentFile = db.prepare(`
  SELECT path, lastParsedAt FROM scanned_files
  WHERE lastParsedAt<>'' ORDER BY lastParsedAt DESC LIMIT 1
`).get() || null;
console.log(JSON.stringify({
  databasePath,
  indexedFiles: count("SELECT COUNT(*) AS value FROM scanned_files WHERE existsFlag=1"),
  storedGroups: count(`
    SELECT COUNT(*) AS value
    FROM talkgroups AS t
    JOIN scanned_files AS f ON f.id=t.fileId
    WHERE f.existsFlag=1
  `),
  errorFiles: count("SELECT COUNT(*) AS value FROM scanned_files WHERE existsFlag=1 AND LENGTH(errorMessage)>0"),
  latestScan: db.prepare(
    "SELECT * FROM scan_runs WHERE rootPath=? ORDER BY id DESC LIMIT 1",
  ).get(centralRoot) || null,
  currentFile: currentFile?.path || "",
  currentFolder: currentFile?.path ? path.dirname(currentFile.path) : "",
  currentFileUpdatedAt: currentFile?.lastParsedAt || "",
  topErrors: db.prepare(`
    SELECT errorMessage, COUNT(*) AS count FROM scanned_files
    WHERE existsFlag=1 AND LENGTH(errorMessage)>0
    GROUP BY errorMessage ORDER BY count DESC LIMIT 5
  `).all(),
}, null, 2));
db.close();
