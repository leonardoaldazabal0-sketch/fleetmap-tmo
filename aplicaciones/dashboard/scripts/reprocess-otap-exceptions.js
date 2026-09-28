const fs = require("node:fs");
const app = require("../server");

const wrapperSizes = [
  3021974, 3153053, 3144150, 3276566, 3346455, 4739862, 4870941,
  4860054, 4862549, 4862550, 4997270, 5066922, 5066967,
];

try {
  const rows = app.database.db.prepare(`
    SELECT id,path,size,mtimeMs,featuresJson
    FROM scanned_files
    WHERE existsFlag=1 AND COALESCE(errorMessage,'')=''
      AND size IN (${wrapperSizes.map(() => "?").join(",")})
  `).all(...wrapperSizes).filter((row) => {
    try { return JSON.parse(row.featuresJson || "{}").otap?.state === "No disponible"; }
    catch { return true; }
  });
  const batch = rows.map((row) => {
    const stat = fs.statSync(row.path);
    const codeplug = app.extractCodeplugFile(row.path);
    if (codeplug.features?.otap?.state === "No disponible") {
      throw new Error(`OTAP aun no soportado despues de releer ${row.path}`);
    }
    return { path: row.path, size: stat.size, mtimeMs: stat.mtimeMs, codeplug };
  });
  if (batch.length) app.database.storeBatch(batch);
  console.log(JSON.stringify({
    reprocessed: batch.length,
    rows: batch.map((item) => ({
      path: item.path,
      issi: item.codeplug.issi,
      codeplug: item.codeplug.codeplug,
      otap: item.codeplug.features.otap,
    })),
  }, null, 2));
} finally {
  app.database.close();
}
