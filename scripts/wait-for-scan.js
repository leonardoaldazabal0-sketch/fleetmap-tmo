const path = require("path");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : path.join(__dirname, "..", "data", "cpe-dashboard.sqlite");
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
let lastReported = -1;

function readStatus() {
  const run = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get();
  const totals = db.prepare(`
    SELECT COUNT(*) AS indexedFiles,
      COALESCE(SUM(groupCount), 0) AS storedGroups,
      COALESCE(SUM(CASE WHEN errorMessage<>'' THEN 1 ELSE 0 END), 0) AS errorFiles
    FROM scanned_files WHERE existsFlag=1
  `).get();
  return { run, ...totals };
}

function check() {
  const status = readStatus();
  if (!status.run) {
    console.error("No existe un escaneo para monitorear");
    db.close();
    process.exit(1);
  }

  if (status.run.foundCount !== lastReported || status.run.finishedAt) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...status }));
    lastReported = status.run.foundCount;
  }

  if (status.run.finishedAt) {
    db.close();
    process.exit(0);
  }
}

check();
setInterval(check, 30000);
