const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
process.env.CPE_DB_FILE = databasePath;
const app = require(path.join(root, "server"));
const samplesDir = process.argv[2] || "F:\\CPE-TMO\\datos\\muestras\\familias-controladas";

const expected = {
  "CP1274_00_BASE.cpe": null,
  "CP1274_01_GRUPO_NUEVO.cpe": { alias: "PRUEBATMO_01", gssi: 7654321, status: 1 },
  "CP1274_02_ALIAS_CAMBIADO.cpe": { alias: "PRUEBATMO_02", gssi: 7654321, status: 1 },
  "CP1274_03_GSSI_CAMBIADO.cpe": { alias: "PRUEBATMO_01", gssi: 7654322, status: 1 },
  "CP1274_05_ESTADO_CAMBIADO.cpe": null,
};

const controlled = Object.entries(expected).map(([name, target]) => {
  const result = app.extractCodeplugFile(path.join(samplesDir, name));
  const found = target ? result.rows.find((row) => row.alias === target.alias && row.gssi === target.gssi) : null;
  return {
    name,
    groupCount: result.rows.length,
    expected: target,
    found: found ? { alias: found.alias, gssi: found.gssi, status: found.status, folderRow: found.folderRow, slot: found.slot } : null,
    ok: target ? Boolean(found && found.status === target.status) : !result.rows.some((row) => row.alias.startsWith("PRUEBATMO_")),
  };
});

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const candidates = db.prepare(`
  SELECT id, path AS unsupportedPath, serial, issi, dateKey, mtimeMs
  FROM scanned_files
  WHERE existsFlag=1 AND errorMessage<>'' AND codeplug='1274'
    AND size BETWEEN 3021900 AND 3022100
  ORDER BY id
  LIMIT 30
`).all();
const knownBySerial = db.prepare(`
  SELECT id AS knownId, path AS knownPath FROM scanned_files
  WHERE id<>? AND serial=? AND existsFlag=1 AND errorMessage='' AND groupCount>0
  ORDER BY ABS(COALESCE(dateKey,0)-?), ABS(mtimeMs-?) LIMIT 1
`);
const knownByIssi = db.prepare(`
  SELECT id AS knownId, path AS knownPath FROM scanned_files
  WHERE id<>? AND issi=? AND existsFlag=1 AND errorMessage='' AND groupCount>0
  ORDER BY ABS(COALESCE(dateKey,0)-?), ABS(mtimeMs-?) LIMIT 1
`);
const pairs = [];
for (const candidate of candidates) {
  const known = (candidate.serial && knownBySerial.get(candidate.id, candidate.serial, candidate.dateKey || 0, candidate.mtimeMs))
    || (candidate.issi && knownByIssi.get(candidate.id, candidate.issi, candidate.dateKey || 0, candidate.mtimeMs));
  if (known) pairs.push({ ...candidate, ...known });
  if (pairs.length >= 5) break;
}
const groups = db.prepare("SELECT alias,gssi FROM talkgroups WHERE fileId=? AND alias<>'' AND gssi>0");

const historical = [];
for (const pair of pairs) {
  try {
    if (!fs.existsSync(pair.unsupportedPath)) continue;
    const extracted = app.extractCodeplugFile(pair.unsupportedPath);
    const actual = new Set(extracted.rows.map((row) => `${row.alias}\u0001${row.gssi}`));
    const known = new Set(groups.all(pair.knownId).map((row) => `${row.alias}\u0001${row.gssi}`));
    let intersection = 0;
    for (const item of actual) if (known.has(item)) intersection += 1;
    historical.push({
      serial: pair.serial,
      issi: pair.issi,
      extracted: actual.size,
      known: known.size,
      intersection,
      precision: actual.size ? Number((intersection / actual.size).toFixed(3)) : 0,
      recall: known.size ? Number((intersection / known.size).toFixed(3)) : 0,
    });
  } catch (error) {
    historical.push({ serial: pair.serial, error: error.message });
  }
}

console.log(JSON.stringify({ controlled, historical }, null, 2));
db.close();
process.exit(0);
