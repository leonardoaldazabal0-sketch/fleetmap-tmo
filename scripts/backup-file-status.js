const path = require("path");
const Database = require("better-sqlite3");
const { backupCodeplugInfo } = require("../lib/cpe-file-filter");

const databasePath = process.env.CPE_DB_FILE || path.join(__dirname, "..", "data", "cpe-dashboard.sqlite");
const db = new Database(databasePath);
const rows = db.prepare("SELECT id,fileName,errorMessage,groupCount FROM scanned_files WHERE existsFlag=1").all();
const matches = [];
const byCodeplug = new Map();
for (const row of rows) {
  const info = backupCodeplugInfo(row.fileName);
  if (!info) continue;
  matches.push(row);
  const current = byCodeplug.get(info.codeplug) || { codeplug: info.codeplug, files: 0, errors: 0, groups: 0 };
  current.files += 1;
  current.errors += row.errorMessage ? 1 : 0;
  current.groups += Number(row.groupCount || 0);
  byCodeplug.set(info.codeplug, current);
}

let deactivated = 0;
if (process.argv.includes("--deactivate") && matches.length) {
  const update = db.prepare("UPDATE scanned_files SET existsFlag=0 WHERE id=?");
  const transaction = db.transaction((items) => {
    for (const item of items) deactivated += update.run(item.id).changes;
  });
  transaction(matches);
}

console.log(JSON.stringify({
  matchingFiles: matches.length,
  matchingErrors: matches.filter((row) => row.errorMessage).length,
  matchingGroups: matches.reduce((sum, row) => sum + Number(row.groupCount || 0), 0),
  deactivated,
  families: [...byCodeplug.values()].sort((a, b) => b.files - a.files || a.codeplug.localeCompare(b.codeplug)),
}, null, 2));
db.close();
