const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");

const db = new Database(runtimePaths.dataFile("cpe-dashboard.sqlite"), { readonly: true, fileMustExist: true });
try {
  const rows = db.prepare(`
    SELECT issi,codeplug,featuresJson FROM scanned_files
    WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
      AND size IN (5066922,5066964,5066965,5066966,5066967,5198045,
                   5263274,5263316,5263317,5263318,5263319,5394397)
  `).all();
  const totals = { total: rows.length, listening: 0, inactive: 0, review: 0, notAvailable: 0 };
  for (const row of rows) {
    const state = JSON.parse(row.featuresJson || "{}").broadcast?.state || "No disponible";
    if (state === "Solo escucha") totals.listening += 1;
    else if (state === "Inactivo") totals.inactive += 1;
    else if (state === "Revisar") totals.review += 1;
    else totals.notAvailable += 1;
  }
  assert.equal(totals.notAvailable, 0);
  const radio = db.prepare(`
    SELECT path,codeplug,software,featuresJson FROM scanned_files
    WHERE existsFlag=1 AND issi='58383'
    ORDER BY dateKey DESC,mtimeMs DESC,id DESC LIMIT 1
  `).get();
  assert.ok(radio, "ISSI 58383 ausente");
  const broadcast = JSON.parse(radio.featuresJson).broadcast;
  assert.deepEqual(broadcast, {
    state: "Solo escucha",
    alias: "ROM-BROADCAS",
    gssi: 6078,
    canInitiate: false,
    indicatorActive: true,
    destinationConfigured: true,
    announcementPriority: 10,
    announcementAlias: "BROADCAST",
    groupInvisible: true,
    continuousTracking: true,
  });
  const remainingByStructure = db.prepare(`
    SELECT codeplug,size,COUNT(*) AS total
    FROM scanned_files
    WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
      AND COALESCE(json_extract(featuresJson,'$.broadcast.state'),'No disponible')='No disponible'
    GROUP BY codeplug,size ORDER BY total DESC
  `).all();
  console.log(JSON.stringify({
    totals,
    radio: { path: radio.path, codeplug: radio.codeplug, software: radio.software, broadcast },
    remainingNotAvailable: remainingByStructure.reduce((sum, item) => sum + item.total, 0),
    remainingByStructure: remainingByStructure.slice(0, 40),
  }, null, 2));
} finally {
  db.close();
}
