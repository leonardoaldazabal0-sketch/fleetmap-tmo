const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : path.join(__dirname, "..", "data", "cpe-dashboard.sqlite");
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

function readSectionSizes(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(9);
    if (fs.readSync(fd, header, 0, 9, 0) !== 9 || header.subarray(0, 7).toString("ascii") !== "CPDFile") {
      return { error: "Cabecera CPE invalida" };
    }
    const sections = {};
    let cursor = 9;
    const sectionHeader = Buffer.alloc(7);
    const fileSize = fs.fstatSync(fd).size;
    while (cursor + 7 <= fileSize) {
      if (fs.readSync(fd, sectionHeader, 0, 7, cursor) !== 7) break;
      const name = sectionHeader.subarray(0, 3).toString("ascii");
      const size = sectionHeader.readInt32LE(3);
      if (size < 0 || cursor + 7 + size > fileSize) break;
      sections[name] = size;
      cursor += 7 + size;
    }
    return sections;
  } catch (error) {
    return { error: error.message };
  } finally {
    fs.closeSync(fd);
  }
}

const families = db.prepare(`
  SELECT COALESCE(NULLIF(codeplug, ''), '(desconocido)') AS codeplug,
    COUNT(*) AS files, COUNT(DISTINCT size) AS containerSizes,
    MIN(path) AS samplePath
  FROM scanned_files
  WHERE existsFlag=1 AND errorMessage<>''
  GROUP BY COALESCE(NULLIF(codeplug, ''), '(desconocido)')
  ORDER BY files DESC
`).all();

const successful = db.prepare(`
  SELECT serial, issi FROM scanned_files WHERE existsFlag=1 AND errorMessage=''
`).all();
const knownSerials = new Set(successful.map((row) => row.serial).filter(Boolean));
const knownIssis = new Set(successful.map((row) => row.issi).filter(Boolean));
const errorIdentities = db.prepare(`
  SELECT COALESCE(NULLIF(codeplug, ''), '(desconocido)') AS codeplug, serial, issi
  FROM scanned_files WHERE existsFlag=1 AND errorMessage<>''
`).all();
const pairedMap = new Map();
for (const row of errorIdentities) {
  if ((row.serial && knownSerials.has(row.serial)) || (row.issi && knownIssis.has(row.issi))) {
    pairedMap.set(row.codeplug, (pairedMap.get(row.codeplug) || 0) + 1);
  }
}

const sizeSamples = db.prepare(`
  SELECT size, COUNT(*) AS files, MIN(path) AS samplePath
  FROM scanned_files
  WHERE existsFlag=1 AND errorMessage<>'' AND COALESCE(NULLIF(codeplug, ''), '(desconocido)')=?
  GROUP BY size ORDER BY files DESC LIMIT 5
`);

const report = families.map((family) => ({
  ...family,
  filesWithKnownRadio: pairedMap.get(family.codeplug) || 0,
  variants: sizeSamples.all(family.codeplug).map((variant) => ({
    ...variant,
    sections: readSectionSizes(variant.samplePath),
  })),
}));

const payload = { databasePath, generatedAt: new Date().toISOString(), familyCount: report.length, families: report };
const outputPath = path.join(__dirname, "..", "data", "cp-error-analysis.json");
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({
  outputPath,
  familyCount: report.length,
  topFamilies: report.slice(0, 20).map((family) => ({
    codeplug: family.codeplug,
    files: family.files,
    filesWithKnownRadio: family.filesWithKnownRadio,
    cpsSizes: family.variants.map((variant) => variant.sections.CPS).filter(Boolean),
  })),
}, null, 2));
db.close();
