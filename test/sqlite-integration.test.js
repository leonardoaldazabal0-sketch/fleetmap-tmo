const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-sqlite-integration-"));
process.env.CPE_DB_FILE = path.join(root, "data", "test.sqlite");
const app = require("../server");
const { backupCodeplugInfo, isBackupCodeplugFile } = require("../lib/cpe-file-filter");

test.after(() => app.database.close());

test("reconoce backups por nombre sin excluir CPE normales", () => {
  const backup = "121TAB1301_1511_9840_1500A01B00559B0B0200008072F80005.cpe";
  assert.equal(isBackupCodeplugFile(backup), true);
  assert.equal(backupCodeplugInfo(backup).codeplug, "1511");
  assert.equal(isBackupCodeplugFile("SN[121TAB1301]_ISSI[9840]_CP[1511]_SW[R1].cpe"), false);
  assert.equal(isBackupCodeplugFile("CP1274_00_BASE.cpe"), false);
});

test("la interfaz principal expone Fleet Map y conserva referencias DOM validas", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = [...client.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  const missingIds = [...new Set(referencedIds.filter((id) => !htmlIds.has(id)))];
  assert.deepEqual(missingIds, []);
  assert.ok(html.indexOf('data-section="fleet"') < html.indexOf('data-section="index"'));
  assert.doesNotMatch(html, /rootPathInput/);
});

function encryptDbf(plain) {
  const encrypted = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    const added = (plain[i] + ((plain.length - i) & 0xff)) & 0xff;
    encrypted[i] = added ^ ((i * 111) & 0xff);
  }
  return encrypted;
}

function createCp1330(filePath) {
  const cps = Buffer.alloc(4859968);
  const base = 969984;
  Buffer.from("GRUPO CP1330\0", "utf16le").copy(cps, base);
  cps.writeUInt32LE(456789, base + 36);
  cps[base + 42] = 2;
  cps.writeUInt16LE(1, base + 48);

  const encrypted = encryptDbf(cps);
  const header = Buffer.alloc(16);
  header.write("CPDFile", 0, "ascii");
  header[7] = 1;
  header[8] = 0;
  header.write("CPS", 9, "ascii");
  header.writeInt32LE(encrypted.length, 12);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, encrypted]));
}

function writeCpe(filePath, cps) {
  const encrypted = encryptDbf(cps);
  const header = Buffer.alloc(16);
  header.write("CPDFile", 0, "ascii");
  header[7] = 1;
  header[8] = 0;
  header.write("CPS", 9, "ascii");
  header.writeInt32LE(encrypted.length, 12);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, encrypted]));
}

test("importa el cache JSON una sola vez y conserva el respaldo", () => {
  const source = path.join(root, "legacy", "SN[OLD]_ISSI[111]_CP[1020]_SW[R0].cpe");
  const cacheFile = path.join(root, "legacy-cache.json");
  const payload = {
    entries: {
      legacy: {
        path: source,
        size: 10,
        modifiedTime: 123456,
        scannedAt: "2026-01-01T00:00:00.000Z",
        error: "",
        data: {
          path: source,
          fileName: path.basename(source),
          serial: "OLD",
          issi: "111",
          codeplug: "1020",
          software: "R0",
          rows: [{ folderRow: 1, slot: 1, alias: "LEGACY", gssi: 10, status: 1, statusText: "Programado" }],
        },
      },
    },
  };
  fs.writeFileSync(cacheFile, JSON.stringify(payload));

  const first = app.migrateLegacyJsonCache(cacheFile, "test_legacy_import");
  const second = app.migrateLegacyJsonCache(cacheFile, "test_legacy_import");
  assert.equal(first.imported, 1);
  assert.equal(second.alreadyImported, true);
  assert.equal(fs.existsSync(cacheFile), true);
  assert.equal(app.database.getFile(source).serial, "OLD");
});

test("crea el esquema requerido y exporta la hoja de errores", () => {
  const expected = {
    scanned_files: ["id", "path", "fileName", "size", "mtimeMs", "existsFlag", "folderDate", "dateKey", "sourceFolder", "programmer", "serial", "tei", "issi", "codeplug", "software", "cpuId", "cpeVersion", "groupCount", "lastParsedAt", "errorType", "errorMessage"],
    talkgroups: ["id", "fileId", "folderRow", "slot", "alias", "gssi", "status", "statusText", "codeplug", "software", "serial", "issi"],
    scan_runs: ["id", "rootPath", "startedAt", "finishedAt", "foundCount", "parsedCount", "cachedCount", "errorCount", "deletedCount"],
  };
  for (const [table, columns] of Object.entries(expected)) {
    const actual = app.database.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    for (const column of columns) assert.ok(actual.includes(column), `${table}.${column}`);
  }

  const workbook = app.buildWorkbook({
    rows: [],
    history: [],
    missing: [],
    errors: [{ file: "radio.cpe", errorType: "ParserError", message: "prueba" }],
  });
  const files = app.readZip(workbook);
  assert.ok(files.has("xl/worksheets/sheet8.xml"));
  assert.ok(files.has("xl/styles.xml"));
  assert.match(files.get("xl/workbook.xml").toString("utf8"), /<sheet name="Matriz Fleet Map" sheetId="1"/);
  assert.match(files.get("xl/workbook.xml").toString("utf8"), /Errores de Escaneo/);
});

test("exporta Matriz Fleet Map y Diccionario Grupos con formato comparativo", () => {
  const base = {
    cliente: "CLIENTE A",
    ruc: "20123456789",
    unidad: "UNIDAD 1",
    programDate: "2026-07-14",
    tei: "TEI1",
    codeplug: "1330",
    software: "R1",
  };
  const rows = [
    { ...base, fileName: "A.cpe", serial: "A", issi: "100", folderRow: 2, gssi: 8388, alias: "C CONTROL" },
    { ...base, fileName: "A.cpe", serial: "A", issi: "100", folderRow: 4, gssi: 9000, alias: "C CONTROL" },
    { ...base, fileName: "B.cpe", serial: "B", issi: "200", folderRow: 1, gssi: 8388, alias: "C CONTROL" },
    { ...base, fileName: "C.cpe", serial: "C", issi: "300", folderRow: 3, gssi: 8388, alias: "OTRO ALIAS" },
  ];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const workbookXml = files.get("xl/workbook.xml").toString("utf8");
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const dictionaryXml = files.get("xl/worksheets/sheet4.xml").toString("utf8");

  assert.ok(workbookXml.indexOf("Matriz Fleet Map") < workbookXml.indexOf("Fleet Map"));
  assert.match(matrixXml, /xSplit="10" ySplit="2" topLeftCell="K3"/);
  assert.match(matrixXml, /<autoFilter ref="A2:L5"\/>/);
  assert.match(matrixXml, /<mergeCell ref="A1:J1"\/>/);
  assert.match(matrixXml, /<c r="K1" s="1"><v>8388<\/v><\/c>/);
  assert.match(matrixXml, /<c r="L1" s="1"><v>9000<\/v><\/c>/);
  assert.match(matrixXml, /<c r="K2" s="2" t="inlineStr"><is><t>C CONTROL<\/t>/);
  assert.equal((matrixXml.match(/<t>X<\/t>/g) || []).length, 4);
  assert.match(dictionaryXml, /Cantidad de radios que lo tienen/);
  assert.match(dictionaryXml, /C CONTROL/);
  assert.doesNotMatch(dictionaryXml, /OTRO ALIAS/);
});

test("calcula la siguiente ejecucion exactamente a medianoche", () => {
  const now = new Date(2026, 6, 13, 23, 59, 30, 0);
  assert.equal(app.millisecondsUntilNextMidnight(now), 30_000);
});

test("CP 1330 se parsea una vez, se reutiliza y Fleet Map consulta SQLite", () => {
  const scanRoot = path.join(root, "2026-07-01_AB");
  const cpe = path.join(scanRoot, "SN[NEW]_TEI[T1]_ISSI[34679]_CP[1330]_SW[R13].cpe");
  createCp1330(cpe);

  const first = app.scanPath(scanRoot);
  assert.equal(first.cache.analyzed, 1);
  assert.equal(first.cache.reused, 0);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].alias, "GRUPO CP1330");
  assert.equal(first.rows[0].gssi, 456789);

  const second = app.scanPath(scanRoot);
  assert.equal(second.cache.analyzed, 0);
  assert.equal(second.cache.reused, 1);
  assert.equal(second.rows.length, 1);

  const unrelatedError = path.join(scanRoot, "SN[OTHER]_ISSI[99999]_CP[1059]_SW[R1].cpe");
  const relatedError = path.join(scanRoot, "SN[RELATED]_ISSI[34677]_CP[1059]_SW[R1].cpe");
  writeCpe(unrelatedError, Buffer.alloc(1234));
  writeCpe(relatedError, Buffer.alloc(1234));
  const errorsScanned = app.scanPath(scanRoot);
  assert.equal(errorsScanned.errors.length, 2);

  const masterBase64 = app.buildTemplateWorkbook().toString("base64");
  const fleet = app.buildFleetMap(scanRoot, masterBase64);
  assert.equal(fleet.cache.analyzed, 0);
  assert.equal(fleet.cache.reused, 3);
  assert.equal(fleet.rows.length, 1);
  assert.equal(fleet.rows[0].issi, "34679");
  assert.equal(fleet.history[0].actual, "Actual");
  assert.equal(fleet.history[0].serial, "NEW");
  assert.equal(fleet.errors.length, 1);
  assert.match(fleet.errors[0].file, /SN\[RELATED\]_ISSI\[34677\]/);
  assert.doesNotMatch(fleet.errors[0].file, /ISSI\[99999\]/);
  assert.deepEqual(fleet.matrix.groups.map((group) => [group.gssi, group.alias]), [[456789, "GRUPO CP1330"]]);
  assert.deepEqual(
    fleet.matrix.radios.map((radio) => [radio.issi, radio.hasCodeplug, radio.hasError, radio.groupGssis]),
    [["34679", true, false, ["456789"]], ["34677", false, true, []]]
  );
  const fleetWorkbook = app.readZip(app.buildWorkbook(fleet));
  const fleetMatrixXml = fleetWorkbook.get("xl/worksheets/sheet1.xml").toString("utf8");
  assert.match(fleetMatrixXml, /<v>456789<\/v>/);
  assert.match(fleetMatrixXml, /GRUPO CP1330/);

  fs.unlinkSync(unrelatedError);
  fs.unlinkSync(relatedError);
  fs.appendFileSync(cpe, Buffer.from([0]));
  const modified = app.scanPath(scanRoot);
  assert.equal(modified.cache.analyzed, 1);
  assert.equal(modified.cache.reused, 0);
  assert.equal(modified.cache.removed, 2);

  fs.unlinkSync(cpe);
  const deleted = app.scanPath(scanRoot);
  assert.equal(deleted.cache.removed, 1);
  assert.equal(app.database.getFile(cpe).existsFlag, 0);
});

test("extrae layouts validados de carpeta y asignacion", () => {
  const folderCps = Buffer.alloc(2535552);
  Buffer.from("GRUPO 0778\0", "utf16le").copy(folderCps, 751776);
  folderCps.writeUInt32LE(778001, 751776 + 28);
  folderCps[1311776] = 1;
  folderCps.writeUInt16LE(1, 1311776 + 2);
  const folderFile = path.join(root, "layouts", "SN[FOLDER]_ISSI[778]_CP[0778]_SW[R1].cpe");
  writeCpe(folderFile, folderCps);

  const assignmentCps = Buffer.alloc(1787008);
  Buffer.from("GRUPO 0652\0", "utf16le").copy(assignmentCps, 272628);
  assignmentCps.writeUInt32LE(652001, 272628 + 28);
  assignmentCps[272628 + 34] = 2;
  assignmentCps.writeUInt16LE(1, 272628 + 40);
  const assignmentFile = path.join(root, "layouts", "SN[ASSIGN]_ISSI[652]_CP[0652]_SW[R1].cpe");
  writeCpe(assignmentFile, assignmentCps);

  const folder = app.extractCodeplugFile(folderFile);
  const assignment = app.extractCodeplugFile(assignmentFile);
  assert.deepEqual(folder.rows.map((row) => [row.alias, row.gssi]), [["GRUPO 0778", 778001]]);
  assert.deepEqual(assignment.rows.map((row) => [row.alias, row.gssi]), [["GRUPO 0652", 652001]]);
});

test("extrae CP 1274 con asignacion embebida", () => {
  const layout = app.LAYOUTS_BY_CPS_SIZE[3021888];
  assert.equal(layout.main.offset, 816720);
  assert.equal(layout.main.gssiOffset, 28);
  assert.equal(layout.assignment.activeU16Offset, 26);
  assert.equal(layout.assignment.positionByteOffset, 42);

  const cps = Buffer.alloc(3021888);
  Buffer.from("CP1274 TEST\0", "utf16le").copy(cps, layout.main.offset);
  cps.writeUInt16LE(1, layout.main.offset + 26);
  cps.writeUInt32LE(1274001, layout.main.offset + 28);
  cps[layout.main.offset + 42] = 7;
  const file = path.join(root, "layouts", "SN[1274]_ISSI[1274]_CP[1274]_SW[R1].cpe");
  writeCpe(file, cps);
  const extracted = app.extractCodeplugFile(file);
  assert.deepEqual(extracted.rows.map((row) => [row.alias, row.gssi, row.folderRow]), [["CP1274 TEST", 1274001, 7]]);
});

test("selecciona layouts conservadores por CP y longitud CPS", () => {
  const cases = [
    ["1315", 2848576, "high"],
    ["0865", 2487104, "high"],
    ["0405", 1045696, "high"],
    ["0232", 945600, "medium"],
    ["7472", 613248, "high"],
  ];

  for (const [codeplug, cpsLength, confidence] of cases) {
    const layout = app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE[codeplug][cpsLength];
    const cps = Buffer.alloc(cpsLength);
    const alias = `X${codeplug}`;
    Buffer.from(`${alias}\0`, "utf16le").copy(cps, layout.main.offset);
    cps.writeUInt16LE(1, layout.main.offset + 26);
    cps.writeUInt32LE(Number(codeplug) * 100 + 1, layout.main.offset + 28);
    cps[layout.main.offset + 42] = 7;
    const file = path.join(root, "layouts", `SN[${codeplug}]_ISSI[${codeplug}]_CP[${codeplug}]_SW[R1].cpe`);
    writeCpe(file, cps);

    const extracted = app.extractCodeplugFile(file);
    assert.deepEqual(
      extracted.rows.map((row) => [row.alias, row.gssi, row.folderRow, row.assignmentConfidence]),
      [[alias, Number(codeplug) * 100 + 1, 7, confidence]]
    );
  }

  const layout = app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE["0232"][945600];
  const cps = Buffer.alloc(945600);
  Buffer.from("SIN POS\0", "utf16le").copy(cps, layout.main.offset);
  cps.writeUInt32LE(232999, layout.main.offset + 28);
  Buffer.from("SIN POS\0", "utf16le").copy(cps, layout.main.offset + layout.main.recordSize);
  cps.writeUInt32LE(232999, layout.main.offset + layout.main.recordSize + 28);
  const file = path.join(root, "layouts", "SN[FALLBACK]_ISSI[232]_CP[0232]_SW[R1].cpe");
  writeCpe(file, cps);
  const extracted = app.extractCodeplugFile(file);
  assert.deepEqual(
    extracted.rows.map((row) => [row.alias, row.gssi, row.folderRow, row.statusText, row.assignmentConfidence]),
    [["SIN POS", 232999, "", "Programado", "medium"]]
  );
});
