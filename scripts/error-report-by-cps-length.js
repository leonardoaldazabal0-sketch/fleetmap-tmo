const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const databaseFile = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : path.join(root, "data", "cpe-dashboard.sqlite");
const outputFile = path.join(root, "data", "error-report-by-cps-length.json");
const db = new Database(databaseFile, { readonly: true });

function readCpsLength(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = Buffer.alloc(9);
    if (fs.readSync(fd, header, 0, 9, 0) !== 9 || header.subarray(0, 7).toString("ascii") !== "CPDFile") {
      throw new Error("Cabecera CPDFile invalida");
    }
    const sectionHeader = Buffer.alloc(7);
    let cursor = 9;
    while (cursor + 7 <= fileSize) {
      if (fs.readSync(fd, sectionHeader, 0, 7, cursor) !== 7) break;
      const name = sectionHeader.subarray(0, 3).toString("ascii");
      const length = sectionHeader.readInt32LE(3);
      if (length < 0 || cursor + 7 + length > fileSize) throw new Error(`Seccion ${name} invalida`);
      if (name === "CPS") return length;
      cursor += 7 + length;
    }
    throw new Error("Sin seccion CPS");
  } finally {
    fs.closeSync(fd);
  }
}

try {
  const files = db.prepare(`
    SELECT path, codeplug FROM scanned_files
    WHERE existsFlag=1 AND errorMessage<>'' ORDER BY codeplug, path
  `).all();
  const grouped = new Map();
  const byCodeplug = new Map();

  for (const file of files) {
    const codeplug = file.codeplug || "unknown";
    let cpsLength = null;
    let readError = "";
    try {
      cpsLength = readCpsLength(file.path);
    } catch (error) {
      readError = error.message;
    }
    const key = `${codeplug}|${cpsLength == null ? "unreadable" : cpsLength}|${readError}`;
    const item = grouped.get(key) || { codeplug, cpsLength, readError, count: 0 };
    item.count += 1;
    grouped.set(key, item);
    byCodeplug.set(codeplug, (byCodeplug.get(codeplug) || 0) + 1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    databaseFile,
    totalErrors: files.length,
    byCodeplug: [...byCodeplug].map(([codeplug, count]) => ({ codeplug, count })).sort((a, b) => b.count - a.count || a.codeplug.localeCompare(b.codeplug)),
    byCodeplugAndCpsLength: [...grouped.values()].sort((a, b) => b.count - a.count || a.codeplug.localeCompare(b.codeplug) || (a.cpsLength || 0) - (b.cpsLength || 0)),
  };
  fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputFile, totalErrors: report.totalErrors, byCodeplug: report.byCodeplug }, null, 2));
} finally {
  db.close();
}
