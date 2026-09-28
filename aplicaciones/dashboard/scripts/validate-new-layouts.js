const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
process.env.CPE_DB_FILE = databasePath;
const app = require(path.join(root, "server"));
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const discovery = JSON.parse(fs.readFileSync(runtimePaths.dataFile("cp-layout-discovery.json"), "utf8"));
const fileByPath = db.prepare("SELECT id FROM scanned_files WHERE path=?");
const groupsByFile = db.prepare("SELECT alias, gssi FROM talkgroups WHERE fileId=? AND alias<>'' AND gssi>0");

const results = [];
for (const family of discovery.report) {
  const samples = [];
  for (const sample of family.samples.filter((item) => item.matchCount >= 2).slice(0, 3)) {
    try {
      const extracted = app.extractCodeplugFile(sample.unsupportedPath);
      const knownFile = fileByPath.get(sample.supportedPath);
      const known = new Set((knownFile ? groupsByFile.all(knownFile.id) : [])
        .map((row) => `${row.alias}\u0001${row.gssi}`));
      const actual = new Set(extracted.rows.map((row) => `${row.alias}\u0001${row.gssi}`));
      let intersection = 0;
      for (const group of actual) if (known.has(group)) intersection += 1;
      samples.push({
        cpsSize: sample.cpsSize,
        extracted: actual.size,
        known: known.size,
        intersection,
        precision: actual.size ? Number((intersection / actual.size).toFixed(3)) : 0,
        recall: known.size ? Number((intersection / known.size).toFixed(3)) : 0,
      });
    } catch (error) {
      samples.push({ cpsSize: sample.cpsSize, error: error.message });
    }
  }
  if (samples.length) results.push({ codeplug: family.codeplug, files: family.files, samples });
}

console.log(JSON.stringify(results, null, 2));
db.close();
app.database.close();
