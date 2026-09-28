const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
process.env.CPE_DB_FILE = databasePath;
const app = require(path.join(root, "server"));

const variants = [
  {
    cpsSize: 4739776,
    file: "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2024\\AGUAYTIA\\20241003_LA\\DESPUES\\SN[123TXX0082]_TEI[00016C130476600]_ISSI[34408]_CP[1274]_SW[R36.000.9645]_USB110.cpe",
    mainOffset: 971328,
    expectedCount: 4,
    expected: [["PG_OPER", 8771, 2], ["SEG.F", 8772, 4], ["PF_OPER", 8773, 1], ["LIBRE", 8774, 3]],
  },
  {
    cpsSize: 2849984,
    file: "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2024\\APM\\20240514_LA\\DESPUES\\SN[938TPJ0043]_TEI[000148230436670]_ISSI[81679]_CP[1274]_SW[R27.000.9645]_USB10_1.cpe",
    mainOffset: 816200,
    expectedCount: 60,
    expected: [["Canal Base", 8173, 58], ["Safety", 8169, 7], ["TECH EMER", 9039, 9], ["GENERALCARGO", 9127, 3]],
  },
  {
    cpsSize: 3021888,
    file: "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2024\\ATU\\20240229_GO\\despues\\SN[767TXT0633]_TEI[00016C230317900]_ISSI[78023]_CP[1274]_SW[R55.000.9645]_USB5.cpe",
    mainOffset: 816720,
    expectedCount: 17,
    expected: [["SEGURIDAD", 8441, 23], ["MANTENIMIENT", 8442, 15], ["GTU", 8443, 13], ["SEG METROPOL", 8444, 21]],
  },
];

function decodeUtf16(buffer) {
  let end = 0;
  while (end + 1 < buffer.length && (buffer[end] !== 0 || buffer[end + 1] !== 0)) end += 2;
  return buffer.subarray(0, end).toString("utf16le").trim();
}

function proposedRows(cps, mainOffset) {
  const rows = [];
  for (let slot = 1; slot <= 10000; slot += 1) {
    const base = mainOffset + (slot - 1) * 56;
    if (base + 56 > cps.length) break;
    const alias = decodeUtf16(cps.subarray(base, base + 24));
    const active = cps.readUInt16LE(base + 26);
    const gssi = cps.readUInt32LE(base + 28);
    const folderRow = cps[base + 42];
    if (active === 1 && folderRow > 0 && alias && gssi > 0) rows.push({ slot, folderRow, alias, gssi });
  }
  return rows.sort((a, b) => a.folderRow - b.folderRow || a.slot - b.slot);
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const findFile = db.prepare("SELECT id,groupCount,errorMessage FROM scanned_files WHERE path=?");
const findGroups = db.prepare("SELECT alias,gssi,folderRow,slot,status FROM talkgroups WHERE fileId=? ORDER BY folderRow,slot");
const report = [];

for (const variant of variants) {
  const parsed = app.parseCpeSections(variant.file);
  const proposed = proposedRows(parsed.sections.CPS, variant.mainOffset);
  const expectedMatches = variant.expected.map(([alias, gssi, folderRow]) => proposed.some((row) => row.alias === alias && row.gssi === gssi && row.folderRow === folderRow));
  const indexed = findFile.get(path.resolve(variant.file));
  const stored = indexed ? findGroups.all(indexed.id) : [];
  let current = null;
  try {
    const extracted = app.extractCodeplugFile(variant.file);
    current = { count: extracted.rows.length, first: extracted.rows.slice(0, 8).map(({ alias, gssi, folderRow, slot, status }) => ({ alias, gssi, folderRow, slot, status })) };
  } catch (error) {
    current = { error: error.message };
  }
  report.push({
    cpsSize: parsed.sections.CPS.length,
    expectedCpsSize: variant.cpsSize,
    proposedCount: proposed.length,
    expectedCount: variant.expectedCount,
    expectedMatches,
    proposedFirst: proposed.slice(0, 8),
    indexed: indexed || null,
    storedFirst: stored.slice(0, 8),
    currentParser: current,
  });
}

console.log(JSON.stringify(report, null, 2));
db.close();
process.exit(0);
