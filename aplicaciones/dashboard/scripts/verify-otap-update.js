const assert = require("node:assert/strict");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");

const wrapperSizes = [
  3021974, 3153053, 3144150, 3276566, 3346455, 4739862, 4870941,
  4860054, 4862549, 4862550, 4997270, 5066922, 5066967,
];
const db = new Database(runtimePaths.dataFile("cpe-dashboard.sqlite"), { readonly: true, fileMustExist: true });
function cpsLength(filePath) {
  const fileSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  try {
    let cursor = 9;
    const header = Buffer.alloc(7);
    while (cursor + 7 <= fileSize) {
      if (fs.readSync(fd, header, 0, 7, cursor) !== 7) throw new Error("CPE truncado");
      const name = header.subarray(0, 3).toString("ascii");
      const size = header.readInt32LE(3);
      if (name === "CPS") return size;
      cursor += 7 + size;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}
try {
  const rows = db.prepare(`
    SELECT id,path,issi,codeplug,software,size,mtimeMs,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
      AND size IN (${wrapperSizes.map(() => "?").join(",")})
  `).all(...wrapperSizes);
  const totals = { candidates: rows.length, configured: 0, empty: 0, notAvailable: 0, byCodeplug: {} };
  const notAvailable = [];
  for (const row of rows) {
    let features = {};
    try { features = JSON.parse(row.featuresJson || "{}"); } catch {}
    const otap = features.otap || {};
    const key = row.codeplug || "sin-CP";
    const family = totals.byCodeplug[key] || { total: 0, configured: 0, empty: 0, notAvailable: 0 };
    totals.byCodeplug[key] = family;
    totals.candidates += 0;
    family.total += 1;
    if (otap.state === "No disponible" || !otap.state) {
      totals.notAvailable += 1;
      family.notAvailable += 1;
      const actual = fs.statSync(row.path);
      notAvailable.push({
        id: row.id,
        size: row.size,
        actualSize: actual.size,
        indexedMtimeMs: row.mtimeMs,
        actualMtimeMs: actual.mtimeMs,
        cpsLength: cpsLength(row.path),
        codeplug: row.codeplug,
        path: row.path,
      });
    } else if (Array.isArray(otap.targets) && otap.targets.length) {
      totals.configured += 1;
      family.configured += 1;
    } else {
      totals.empty += 1;
      family.empty += 1;
    }
  }

  const radio36120 = db.prepare(`
    SELECT id,path,codeplug,software,featuresJson
    FROM scanned_files WHERE existsFlag=1 AND issi='36120'
    ORDER BY dateKey DESC,mtimeMs DESC,id DESC
  `).all().map((row) => ({
    id: row.id,
    path: row.path,
    codeplug: row.codeplug,
    software: row.software,
    otap: JSON.parse(row.featuresJson || "{}").otap,
  }));
  const corrected36120 = radio36120.find((row) => row.codeplug === "1330");
  assert.ok(corrected36120, "No se encontro el CPE CP1330 de la ISSI 36120");
  assert.deepEqual(corrected36120.otap.targets.map((target) => target.issi), [110, 210]);
  assert.equal(corrected36120.otap.state, "Configurado; estado no verificado");
  assert.equal(totals.notAvailable, 0, "Quedaron CPE de estructuras OTAP validadas como No disponible");
  console.log(JSON.stringify({ totals, notAvailable, radio36120 }, null, 2));
} finally {
  db.close();
}
