const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const databaseFile = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : runtimePaths.dataFile("cpe-dashboard.sqlite");
const db = new Database(databaseFile, { readonly: true });
const families = ["1315", "0865", "0405", "0232", "7472"];
const placeholders = families.map(() => "?").join(",");

try {
  const summary = db.prepare(`
    SELECT codeplug, COUNT(*) AS files, SUM(groupCount) AS groups,
      MIN(groupCount) AS minGroups, MAX(groupCount) AS maxGroups,
      ROUND(AVG(groupCount), 2) AS avgGroups,
      SUM(CASE WHEN groupCount=0 THEN 1 ELSE 0 END) AS zeroGroupFiles
    FROM scanned_files
    WHERE existsFlag=1 AND parserVersion='7' AND errorMessage=''
      AND codeplug IN (${placeholders})
    GROUP BY codeplug ORDER BY codeplug
  `).all(...families);

  const quality = db.prepare(`
    SELECT COUNT(*) AS rows,
      SUM(CASE WHEN t.gssi<1 OR t.gssi>999999 THEN 1 ELSE 0 END) AS absurdGssi,
      SUM(CASE WHEN TRIM(COALESCE(t.alias,''))='' THEN 1 ELSE 0 END) AS emptyAlias,
      SUM(CASE WHEN t.assignmentConfidence='medium' THEN 1 ELSE 0 END) AS mediumAssignment,
      SUM(CASE WHEN t.assignmentConfidence='high' THEN 1 ELSE 0 END) AS highAssignment
    FROM talkgroups t JOIN scanned_files f ON f.id=t.fileId
    WHERE f.existsFlag=1 AND f.parserVersion='7' AND f.errorMessage=''
      AND f.codeplug IN (${placeholders})
  `).get(...families);

  const duplicate = db.prepare(`
    SELECT COALESCE(SUM(copies-1),0) AS extraRows FROM (
      SELECT t.fileId, t.alias, t.gssi, COUNT(*) AS copies
      FROM talkgroups t JOIN scanned_files f ON f.id=t.fileId
      WHERE f.existsFlag=1 AND f.parserVersion='7' AND f.errorMessage=''
        AND f.codeplug IN (${placeholders})
      GROUP BY t.fileId, t.alias, t.gssi HAVING COUNT(*)>1
    )
  `).get(...families);

  console.log(JSON.stringify({
    databaseFile,
    parserVersion: "7",
    summary,
    quality: { ...quality, duplicateAliasGssiWithinFile: duplicate.extraRows },
  }, null, 2));
} finally {
  db.close();
}
