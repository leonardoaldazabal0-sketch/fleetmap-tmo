const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const runtimePaths = require("../lib/runtime-paths");

const temporaryBase = process.env.CPE_TEST_TMP_DIR || path.join(runtimePaths.dir("temporales"), "pruebas");
fs.mkdirSync(temporaryBase, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryBase, "cpe-sqlite-integration-"));
process.env.CPE_DB_FILE = path.join(root, "data", "test.sqlite");
const app = require("../server");
const { backupCodeplugInfo, isBackupCodeplugFile } = require("../lib/cpe-file-filter");

test.after(() => {
  app.database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("crea un indice de cobertura para el estado general del dashboard", () => {
  const indexes = new Set(app.database.db.prepare("PRAGMA index_list(scanned_files)").all().map((index) => index.name));
  assert.ok(indexes.has("idx_scanned_files_status"));
  assert.ok(indexes.has("idx_scanned_files_issi_lookup"));
  assert.ok(indexes.has("idx_scanned_files_serial_lookup"));
  assert.ok(indexes.has("idx_scanned_files_tei_lookup"));
  const health = app.database.healthSummary();
  assert.equal(health.indexedFiles, health.correctFiles + health.corruptFiles + health.unsupportedFiles);
});

test("reconoce backups por nombre sin excluir CPE normales", () => {
  const backup = "121TAB1301_1511_9840_1500A01B00559B0B0200008072F80005.cpe";
  assert.equal(isBackupCodeplugFile(backup), true);
  assert.equal(isBackupCodeplugFile(backup.replace('.cpe', ' (1) (2).cpe')), true);
  assert.equal(isBackupCodeplugFile('857TKW6341_7374_281660080C19000000000000000002D0  2.0.cpe'), true);
  assert.equal(backupCodeplugInfo('857TKW6341_7374_281660080C19000000000000000002D0  2.0.cpe').codeplug, '7374');
  assert.equal(backupCodeplugInfo(backup).codeplug, "1511");
  assert.equal(isBackupCodeplugFile("SN[121TAB1301]_ISSI[9840]_CP[1511]_SW[R1].cpe"), false);
  assert.equal(isBackupCodeplugFile("CP1274_00_BASE.cpe"), false);
});

test('excluye mascaras MTM5400 de la consulta por ruta', () => {
  const { maskCodeplugInfo, isExcludedCodeplugFile } = require('../lib/cpe-file-filter');
  const scanRoot = path.join(root, 'masks');
  fs.mkdirSync(scanRoot, { recursive: true });
  for (const cp of ['7348', '7392', '7417', '7450', '7461']) {
    const name = `SN[999ABC9999]_ISSI[100]_CP[${cp}]_SW[R1].cpe`;
    assert.equal(maskCodeplugInfo(name).codeplug, cp);
    assert.equal(isExcludedCodeplugFile(`CP${cp}_GRUPOS_A.cpe`), true);
    fs.writeFileSync(path.join(scanRoot, name), Buffer.alloc(16));
  }
  assert.equal(maskCodeplugInfo('SN[REAL]_ISSI[7348]_CP[1726].cpe'), null);
  const result = app.scanPath(scanRoot);
  assert.equal(result.fileCount, 0);
  assert.deepEqual(result.errors, []);
});

test('nuevos layouts conservan solo indices de grupos asignados validos', () => {
  const { groupLayouts } = require('../lib/validated-september-layouts');
  for (const [length, layout] of Object.entries(groupLayouts)) {
    const cps = Buffer.alloc(Number(length));
    const {main,folder}=layout;
    Buffer.from('GUARDADO\0','utf16le').copy(cps,main.offset);
    cps.writeUInt32LE(100,main.offset+main.gssiOffset);
    Buffer.from('ASIGNADO\0','utf16le').copy(cps,main.offset+main.recordSize);
    cps.writeUInt32LE(9000,main.offset+main.recordSize+main.gssiOffset);
    cps[folder.offset]=1;cps.writeUInt16LE(2,folder.offset+2);
    cps[folder.offset+4]=1;cps.writeUInt16LE(main.maxRecords+1,folder.offset+6);
    cps[folder.offset+8]=99;cps.writeUInt16LE(1,folder.offset+10);
    const file=path.join(root,'new-layouts',`CPTEST_${length}.cpe`);
    writeCpe(file,cps);
    assert.deepEqual(app.extractCodeplugFile(file).rows.map(r=>[r.alias,r.gssi]),[['ASIGNADO',9000]],length);
  }
});

test("la interfaz principal expone Fleet Map y conserva referencias DOM validas", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const client = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = [...client.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  const missingIds = [...new Set(referencedIds.filter((id) => !htmlIds.has(id)))];
  assert.deepEqual(missingIds, []);
  assert.ok(html.indexOf('data-section="fleet"') < html.indexOf('data-section="index"'));
  assert.doesNotMatch(html, /data-section="health"/);
  assert.match(html, /data-section="diagnostic"[^>]*>[\s\S]*Salud y diagnóstico/);
  assert.doesNotMatch(html, /rootPathInput/);
  assert.match(html, /id="projectRadioFilesInput"[^>]*multiple/);
  assert.match(html, /id="projectRadioValidateButton"/);
  assert.match(client, /\/api\/cpe-projects\/radio-validation/);
  const healthStart = html.indexOf('id="diagnosticSection"');
  const healthEnd = html.indexOf('id="fleetSection"', healthStart);
  const healthSource = html.slice(healthStart, healthEnd);
  assert.match(healthSource, /id="healthOverall"/);
  assert.match(healthSource, /id="errorTypeList"/);
  assert.doesNotMatch(healthSource, /espacio (?:en|disponible)|versi[oó]n del parser/i);

  const downloadStart = client.indexOf("async function downloadExcel");
  const downloadEnd = client.indexOf("async function exportQuickExcel", downloadStart);
  const downloadSource = client.slice(downloadStart, downloadEnd);
  assert.match(downloadSource, /masterFileBase64/);
  assert.doesNotMatch(downloadSource, /fleetPayload\.(rows|history|missing|errors)/);
  assert.match(html, /id="quickMatrixContainer"/);
  assert.match(client, /fleet_map_ruta\.xlsx/);
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

  // Tabla DMO CP1315/CP1330 R36 validada con User Report.
  const dmoBase = 1649984;
  Buffer.from("GRUPO DMO\0", "utf16le").copy(cps, dmoBase);
  cps[dmoBase + 32] = 1;
  cps.writeUInt32LE(90101, dmoBase + 36);
  cps[2740] = 1;

  // Conserva el GSSI aunque el CPS lo muestre con validacion visual en rojo.
  cps[2708] = 1;
  cps.writeUInt32LE(1, 158364);
  cps.writeUInt32LE(10010043, 158372);
  Buffer.from("URGENCIA\0", "utf16le").copy(cps, 158376);

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
    scanned_files: ["id", "path", "fileName", "size", "mtimeMs", "existsFlag", "folderDate", "dateKey", "sourceFolder", "programmer", "serial", "tei", "issi", "codeplug", "software", "cpuId", "cpeVersion", "emergencySupported", "emergencyAddressType", "emergencyMode", "emergencyAlias", "emergencyGssi", "emergencyAttachment", "emergencyConfidence", "featuresJson", "groupCount", "lastParsedAt", "errorType", "errorMessage"],
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
  for (const sheet of [9, 10, 11, 12, 13]) assert.ok(files.has(`xl/worksheets/sheet${sheet}.xml`));
  assert.ok(files.has("xl/styles.xml"));
  const workbookXml = files.get("xl/workbook.xml").toString("utf8");
  assert.match(workbookXml, /<sheet name="Matriz Fleet Map" sheetId="1"/);
  assert.match(workbookXml, /Errores de Escaneo/);
  for (const name of ["Escaneo", "DMO", "Broadcast", "GPS", "OTAP"]) assert.match(workbookXml, new RegExp(`name="${name}"`));
});

test("exporta Matriz Fleet Map y Diccionario Grupos con formato comparativo", () => {
  const base = {
    cliente: "CLIENTE A",
    razonSocial: "RAZON SOCIAL A",
    ruc: "20123456789",
    unidad: "UNIDAD 1",
    programDate: "2026-07-14",
    tei: "TEI1",
    codeplug: "1330",
    software: "R1",
  };
  const rows = [
    { ...base, fileName: "A.cpe", serial: "A", issi: "100", folderRow: 1, gssi: 9000, alias: "C CONTROL" },
    { ...base, fileName: "A.cpe", serial: "A", issi: "100", folderRow: 4, gssi: 8388, alias: "C CONTROL" },
    { ...base, fileName: "B.cpe", serial: "B", issi: "200", folderRow: 3, gssi: 8388, alias: "C CONTROL" },
    { ...base, fileName: "C.cpe", serial: "C", issi: "300", folderRow: 5, gssi: 8388, alias: "OTRO ALIAS" },
  ];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const workbookXml = files.get("xl/workbook.xml").toString("utf8");
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const fleetXml = files.get("xl/worksheets/sheet2.xml").toString("utf8");
  const groupsByRadioXml = files.get("xl/worksheets/sheet3.xml").toString("utf8");
  const dictionaryXml = files.get("xl/worksheets/sheet4.xml").toString("utf8");

  assert.ok(workbookXml.indexOf("Matriz Fleet Map") < workbookXml.indexOf("Fleet Map"));
  assert.match(matrixXml, /xSplit="12" ySplit="2" topLeftCell="M3"/);
  assert.match(matrixXml, /<autoFilter ref="A2:S5"\/>/);
  assert.match(matrixXml, /<mergeCell ref="A1:Q1"\/>/);
  assert.match(matrixXml, /Razón social/);
  assert.match(matrixXml, /RAZON SOCIAL A/);
  assert.doesNotMatch(matrixXml, /CLIENTE A/);
  assert.match(matrixXml, /<c r="R1" s="1"><v>8388<\/v><\/c>/);
  assert.match(matrixXml, /<c r="S1" s="1"><v>9000<\/v><\/c>/);
  assert.ok(fleetXml.indexOf("<v>8388</v>") < fleetXml.indexOf("<v>9000</v>"));
  assert.match(groupsByRadioXml, /C CONTROL \(8388\), C CONTROL \(9000\)/);
  assert.match(matrixXml, /<c r="R2" s="2" t="inlineStr"><is><t xml:space="preserve">C CONTROL<\/t>/);
  assert.equal((matrixXml.match(/<t xml:space="preserve">X<\/t>/g) || []).length, 4);
  assert.match(dictionaryXml, /Cantidad de radios que lo tienen/);
  assert.match(dictionaryXml, /C CONTROL/);
  assert.doesNotMatch(dictionaryXml, /OTRO ALIAS/);
});

test("Fleet Map usa X para Escaneo y DMO activos y conserva sus detalles en hojas separadas", () => {
  const features = {
    source: "prueba",
    scan: {
      state: "Activo",
      activeList: "LISTA OPERATIVA",
      lists: [{ name: "LISTA OPERATIVA", groups: [{ alias: "GRUPO ESCANEO", gssi: 7001, priority: "Alto" }] }],
    },
    dmo: {
      state: "Activo",
      groups: [{ folder: "MODO DIRECTO", alias: "GRUPO DMO", gssi: 2000, frequency: "394.90000" }],
    },
    broadcast: { state: "Inactivo", alias: "", gssi: 0, canInitiate: false },
    gps: { state: "Activo", destinationIssi: 10066, carrier: "SDS", protocol: "LIP" },
    otap: { state: "Inactivo", targets: [] },
  };
  const rows = [{
    razonSocial: "CLIENTE",
    fileName: "radio.cpe",
    serial: "SERIE",
    issi: "44310",
    alias: "GRUPO TMO",
    gssi: 9000,
    statusText: "Programado",
    features,
  }];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const radiosXml = files.get("xl/worksheets/sheet3.xml").toString("utf8");
  const scanXml = files.get("xl/worksheets/sheet9.xml").toString("utf8");
  const dmoXml = files.get("xl/worksheets/sheet10.xml").toString("utf8");

  assert.match(matrixXml, /<c r="M3"[^>]*><is><t xml:space="preserve">X<\/t>/);
  assert.match(matrixXml, /<c r="N3"[^>]*><is><t xml:space="preserve">X<\/t>/);
  assert.match(radiosXml, /<c r="L2"[^>]*><is><t xml:space="preserve">X<\/t>/);
  assert.match(radiosXml, /<c r="M2"[^>]*><is><t xml:space="preserve">X<\/t>/);
  assert.match(scanXml, /LISTA OPERATIVA/);
  assert.match(scanXml, /GRUPO ESCANEO/);
  assert.match(dmoXml, /MODO DIRECTO/);
  assert.match(dmoXml, /GRUPO DMO/);
});

test("Fleet Map marca OTAP solo cuando el indicador esta activo y oculta ITSIs inactivas", () => {
  const featureSet = (state, target) => ({
    source: "prueba-otap",
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: { state: "Inactivo", alias: "", gssi: 0, canInitiate: false },
    gps: { state: "Inactivo", destinationIssi: 0 },
    otap: { state, targets: [{ mcc: 638, mnc: 99, issi: target }] },
  });
  const base = { razonSocial: "CLIENTE", alias: "GRUPO TMO", gssi: 9000, statusText: "Programado" };
  const rows = [
    { ...base, fileName: "activo.cpe", serial: "A", issi: "70001", features: featureSet("Activo", 110) },
    { ...base, fileName: "inactivo.cpe", serial: "B", issi: "70002", features: featureSet("Inactivo", 45061) },
  ];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const radiosXml = files.get("xl/worksheets/sheet3.xml").toString("utf8");
  const otapXml = files.get("xl/worksheets/sheet13.xml").toString("utf8");

  assert.match(matrixXml, /<c r="Q3"[^>]*><is><t xml:space="preserve">X<\/t>/);
  assert.doesNotMatch(matrixXml, /<c r="Q4"[^>]*>(?:(?!<\/c>)[\s\S])*X/);
  assert.match(radiosXml, /<c r="P2"[^>]*><is><t xml:space="preserve">X<\/t>/);
  assert.doesNotMatch(radiosXml, /<c r="P3"[^>]*>(?:(?!<\/c>)[\s\S])*X/);
  assert.match(otapXml, />110<\/v>/);
  assert.doesNotMatch(otapXml, /45061/);
  assert.match(otapXml, /Inactivo/);
});

test("Fleet Map oculta grupos DMO y gateway GPS cuando sus indicadores estan inactivos", () => {
  const features = {
    source: "prueba-indicadores",
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [{ folder: "DMO", alias: "NO MOSTRAR DMO", gssi: 2000 }] },
    broadcast: { state: "Inactivo", alias: "", gssi: 0, canInitiate: false },
    gps: { state: "Inactivo", destinationIssi: 10551, carrier: "SDS", protocol: "LIP" },
    otap: { state: "Inactivo", targets: [] },
  };
  const rows = [{
    razonSocial: "CLIENTE", fileName: "inactivo.cpe", serial: "A", issi: "45140",
    alias: "GRUPO TMO", gssi: 9000, statusText: "Programado", features,
  }];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const dmoXml = files.get("xl/worksheets/sheet10.xml").toString("utf8");
  const gpsXml = files.get("xl/worksheets/sheet12.xml").toString("utf8");

  assert.match(matrixXml, /Inactivo/);
  assert.doesNotMatch(matrixXml, /10551/);
  assert.doesNotMatch(dmoXml, /NO MOSTRAR DMO/);
  assert.doesNotMatch(dmoXml, />2000<\/v>/);
  assert.doesNotMatch(gpsXml, /10551/);
  assert.match(gpsXml, /Inactivo/);
});

test("Fleet Map no presenta estados GPS o DMO no verificados como configuraciones validas", () => {
  const features = {
    source: "estructura-antigua",
    scan: { state: "No disponible", lists: [] },
    dmo: { state: "Configurado; estado no verificado", groups: [{ alias: "NO MOSTRAR DMO", gssi: 2000 }] },
    broadcast: { state: "No disponible", alias: "", gssi: 0, canInitiate: false },
    gps: { state: "Configurado; estado no verificado", destinationIssi: 10551, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  };
  const rows = [{
    razonSocial: "CLIENTE", fileName: "antiguo.cpe", serial: "A", issi: "70003",
    alias: "GRUPO TMO", gssi: 9000, statusText: "Programado", features,
  }];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const dmoXml = files.get("xl/worksheets/sheet10.xml").toString("utf8");
  const gpsXml = files.get("xl/worksheets/sheet12.xml").toString("utf8");

  for (const xml of [matrixXml, dmoXml, gpsXml]) {
    assert.doesNotMatch(xml, /estado no verificado/i);
  }
  assert.match(matrixXml, /No disponible/);
  assert.match(dmoXml, /No disponible/);
  assert.match(gpsXml, /No disponible/);
  assert.doesNotMatch(dmoXml, /NO MOSTRAR DMO/);
  assert.doesNotMatch(gpsXml, /10551/);
});

test("Broadcast escucha requiere destino y solo revisa una prioridad incorrecta", () => {
  const broadcast = (values) => ({
    source: "user-report-exact",
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: values,
    gps: { state: "No disponible", destinationIssi: 0 },
    otap: { state: "No disponible", targets: [] },
  });
  const base = { razonSocial: "CLIENTE", alias: "GRUPO TMO", gssi: 9000, statusText: "Programado" };
  const rows = [
    { ...base, fileName: "escucha.cpe", serial: "A", issi: "56562", features: broadcast({
      state: "Solo escucha", alias: "SCR-BROADCAS", gssi: 9976, indicatorActive: true,
      destinationConfigured: true, announcementPriority: 10, announcementAlias: "BROADCAST",
      groupInvisible: true, continuousTracking: true,
    }) },
    { ...base, fileName: "revisar.cpe", serial: "B", issi: "35500", features: broadcast({
      state: "Revisar", alias: "SCR-BROADCAS", gssi: 9976, indicatorActive: true,
      destinationConfigured: true, announcementPriority: 5, announcementAlias: "BROADCAST",
      groupInvisible: true, continuousTracking: true,
    }) },
    { ...base, fileName: "habla.cpe", serial: "C", issi: "44310", features: broadcast({
      state: "Inactivo", alias: "", gssi: 0, indicatorActive: false,
      destinationConfigured: false, announcementPriority: 0, announcementAlias: "",
      groupInvisible: null, continuousTracking: null,
    }) },
    { ...base, fileName: "pendiente.cpe", serial: "D", issi: "99999", features: broadcast({
      state: "No disponible", alias: "", gssi: 0, indicatorActive: null,
      destinationConfigured: null, announcementPriority: null, announcementAlias: "",
      groupInvisible: null, continuousTracking: null,
    }) },
  ];
  const files = app.readZip(app.buildWorkbook({ rows, history: [], missing: [], errors: [] }));
  const matrixXml = files.get("xl/worksheets/sheet1.xml").toString("utf8");
  const broadcastXml = files.get("xl/worksheets/sheet11.xml").toString("utf8");

  assert.match(matrixXml, /<c r="O3"[^>]*><is><t xml:space="preserve">ESCUCHA — SCR-BROADCAS \(9976\)<\/t>/);
  assert.match(matrixXml, /<c r="O4"[^>]*><is><t xml:space="preserve">REVISAR<\/t>/);
  assert.match(matrixXml, /<c r="O5"[^>]*><is><t xml:space="preserve"><\/t>/);
  assert.match(matrixXml, /<c r="O6"[^>]*><is><t xml:space="preserve">PENDIENTE DE VALIDACIÓN<\/t>/);
  assert.match(broadcastXml, /Indicador llamada de anuncio/);
  assert.match(broadcastXml, /Grupo invisible/);
  assert.match(broadcastXml, /Rastreo continuo/);
  assert.match(broadcastXml, /Prioridad de anuncio 5; debe ser 10/);
  assert.doesNotMatch(matrixXml, /HABLA/);
});

test("la respuesta web compacta filas repetidas sin afectar funciones por radio", () => {
  const features = {
    scan: { state: "Activo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
  };
  const rows = Array.from({ length: 600 }, (_, index) => ({ issi: String(index), features }));
  const compact = app.buildFleetWebPayload({
    rows,
    history: [{ issi: "1", features }],
    files: [{ issi: "1", features }],
    matrix: { radios: [{ issi: "1", features }], groups: [] },
  });

  assert.equal(compact.totalRows, 600);
  assert.equal(compact.rows.length, 500);
  assert.equal("features" in compact.rows[0], false);
  assert.equal("features" in compact.history[0], false);
  assert.equal("features" in compact.files[0], false);
  assert.equal(compact.matrix.radios[0].features, features);
});

test("SQLite decodifica una sola vez las funciones compartidas por los grupos del radio", () => {
  const file = path.join(root, "shared-features.cpe");
  const features = {
    scan: { state: "Activo", lists: [] },
    dmo: { state: "Activo", groups: [] },
  };
  app.database.storeBatch([{
    path: file,
    size: 10,
    mtimeMs: Date.now(),
    codeplug: {
      fileName: path.basename(file),
      issi: "777",
      features,
      rows: [
        { alias: "UNO", gssi: 1 },
        { alias: "DOS", gssi: 2 },
      ],
    },
  }]);
  const hydrated = app.database.hydrateFile(app.database.getFile(file));
  assert.strictEqual(hydrated.rows[0].features, hydrated.rows[1].features);
  assert.strictEqual(hydrated.features, hydrated.rows[0].features);
});

test('CP1330 usa estructura exacta y archivos sin CP usan solo estructura no ambigua', () => {
  const cps = Buffer.alloc(2848576);
  const layout = app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE['1315'][cps.length];
  Buffer.from('EXACTO\0','utf16le').copy(cps,layout.main.offset);
  cps.writeUInt16LE(1,layout.main.offset+layout.assignment.activeU16Offset);
  cps.writeUInt32LE(8588,layout.main.offset+28);
  cps[layout.main.offset+42]=7;
  for(const name of ['SN[X]_CP[1330].cpe','PLANTILLA_SIN_CP.cpe']) {
    const file=path.join(root,'audit-layouts',name);
    writeCpe(file,cps);
    assert.deepEqual(app.extractCodeplugFile(file).rows.map(r=>r.gssi),[8588]);
  }
});

test('layouts antiguos rechazan indices fuera de tabla, GSSI cero y estados invalidos', () => {
  const cps=Buffer.alloc(1064192);
  const {main,folder}=app.LAYOUTS_BY_CPS_SIZE[cps.length];
  Buffer.from('VALIDO\0','utf16le').copy(cps,main.offset);
  cps.writeUInt32LE(8588,main.offset+main.gssiOffset);
  cps[folder.offset+folder.statusOffset]=1;
  cps.writeUInt16LE(1,folder.offset+folder.tgIndexOffset);
  cps[folder.offset+folder.recordSize+folder.statusOffset]=68;
  cps.writeUInt16LE(1,folder.offset+folder.recordSize+folder.tgIndexOffset);
  cps[folder.offset+2*folder.recordSize+folder.statusOffset]=1;
  cps.writeUInt16LE(main.maxRecords+1,folder.offset+2*folder.recordSize+folder.tgIndexOffset);
  const file=path.join(root,'audit-layouts','CP7492.cpe');
  writeCpe(file,cps);
  assert.deepEqual(app.extractCodeplugFile(file).rows.map(r=>r.gssi),[8588]);
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
  assert.deepEqual(first.matrix.groups.map((group) => group.gssi), [456789]);
  assert.equal(first.matrix.radios[0].emergencyGroup, "URGENCIA (10010043)");
  assert.equal(first.rows[0].features.dmo.state, "Activo");
  assert.deepEqual(first.rows[0].features.dmo.groups, [{ alias: "GRUPO DMO", gssi: 90101 }]);

  const second = app.scanPath(scanRoot);
  assert.equal(second.cache.analyzed, 0);
  assert.equal(second.cache.reused, 1);
  assert.equal(second.rows.length, 1);
  assert.equal(app.database.searchRadiosByFields({ issi: "34679" }, 25)[0].serial, "NEW");
  assert.equal(app.database.searchRadiosByFields({ serial: "new", tei: "t1" }, 25)[0].issi, "34679");
  assert.deepEqual(app.database.searchRadiosByFields({ issi: "34679", serial: "OTRO" }, 25), []);

  const unrelatedError = path.join(scanRoot, "SN[OTHER]_ISSI[99999]_CP[1059]_SW[R1].cpe");
  const relatedError = path.join(scanRoot, "SN[RELATED]_ISSI[34677]_CP[1059]_SW[R1].cpe");
  const historicalError = path.join(scanRoot, "SN[OLD]_ISSI[34679]_CP[1059]_SW[R1].cpe");
  writeCpe(unrelatedError, Buffer.alloc(1234));
  writeCpe(relatedError, Buffer.alloc(1234));
  writeCpe(historicalError, Buffer.alloc(1234));
  const errorsScanned = app.scanPath(scanRoot);
  assert.equal(errorsScanned.errors.length, 3);
  const erroredRadio = app.database.searchRadiosByFields({ issi: "34677" }, 25);
  assert.equal(erroredRadio.length, 1);
  assert.match(erroredRadio[0].errorMessage, /no soportado/i);

  const masterBase64 = app.buildTemplateWorkbook().toString("base64");
  const fleet = app.buildFleetMap(scanRoot, masterBase64);
  assert.equal(fleet.cache.analyzed, 0);
  assert.equal(fleet.cache.reused, 4);
  assert.equal(fleet.rows.length, 1);
  assert.equal(fleet.rows[0].issi, "34679");
  assert.equal(fleet.history[0].actual, "Actual");
  assert.equal(fleet.history[0].serial, "NEW");
  assert.equal(fleet.errors.length, 1);
  assert.match(fleet.errors[0].file, /SN\[RELATED\]_ISSI\[34677\]/);
  assert.doesNotMatch(fleet.errors[0].file, /ISSI\[99999\]/);
  assert.doesNotMatch(fleet.errors[0].file, /ISSI\[34679\]/);
  assert.deepEqual(fleet.matrix.groups.map((group) => [group.gssi, group.alias]), [[456789, "GRUPO CP1330"]]);
  assert.equal(fleet.matrix.radios[0].emergencyMode, "No táctico");
  assert.equal(fleet.matrix.radios[0].emergencyGssi, 10010043);
  assert.equal(fleet.matrix.radios[0].emergencyGroup, "URGENCIA (10010043)");
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
  fs.unlinkSync(historicalError);
  fs.appendFileSync(cpe, Buffer.from([0]));
  const modified = app.scanPath(scanRoot);
  assert.equal(modified.cache.analyzed, 1);
  assert.equal(modified.cache.reused, 0);
  assert.equal(modified.cache.removed, 3);

  fs.unlinkSync(cpe);
  const deleted = app.scanPath(scanRoot);
  assert.equal(deleted.cache.removed, 1);
  assert.equal(app.database.getFile(cpe).existsFlag, 0);
});

test("CP1274, CP7492 y CP7715 extraen grupos DMO y respetan el inicio de Escaneo", () => {
  const cases = [
    { cp: "1274", length: 3021888, indicator: 2736, offset: 1416328, records: 2000, alias: "YAULI 01", gssi: 5000 },
    { cp: "7492", length: 1064192, indicator: 2712, offset: 366940, records: 1024, alias: "DMO1", gssi: 2000 },
    { cp: "7715", length: 1079232, indicator: 2662, offset: 367896, records: 1024, alias: "COORPLANTDMO", gssi: 8388623 },
  ];

  for (const item of cases) {
    const cps = Buffer.alloc(item.length);
    Buffer.from(`${item.alias}\0`, "utf16le").copy(cps, item.offset);
    cps[item.offset + 24] = 1;
    cps.writeUInt32LE(item.gssi, item.offset + 28);
    cps[item.indicator] = 1;

    const scanOffset = item.offset + 52 * item.records;
    Buffer.from("Scan List1\0", "utf16le").copy(cps, scanOffset);
    cps[scanOffset + 24] = 1;
    cps[scanOffset + 25] = 1;
    cps.writeUInt16LE(5, scanOffset + 32);
    cps.writeUInt32LE(7001, scanOffset + 36);

    const file = path.join(root, `SN[DMO-${item.cp}]_ISSI[${item.cp}]_CP[${item.cp}].cpe`);
    writeCpe(file, cps);
    const features = app.extractCodeplugFile(file).features;
    assert.equal(features.dmo.state, "Activo");
    assert.deepEqual(features.dmo.groups, [{ alias: item.alias, gssi: item.gssi }]);
    assert.equal(features.scan.lists[0].name, "Scan List1");
    assert.equal(features.scan.lists[0].groups[0].gssi, 7001);
  }
});

test("CP1726 R65 extrae DMO y Escaneo desde sus tablas validadas", () => {
  const cps = Buffer.alloc(3222528);
  const dmoOffset = 1527692;
  const dmoRecord = dmoOffset + 125 * 64;
  Buffer.from("ISEG 001\0", "utf16le").copy(cps, dmoRecord);
  cps[dmoRecord + 32] = 1;
  cps.writeUInt32LE(2300, dmoRecord + 36);
  cps[2740] = 1;

  const scanOffset = dmoOffset + 64 * 2000;
  Buffer.from("Scan List1\0", "utf16le").copy(cps, scanOffset);
  cps[scanOffset + 24] = 1;
  cps[scanOffset + 25] = 1;
  cps.writeUInt16LE(5, scanOffset + 32);
  cps.writeUInt32LE(7001, scanOffset + 36);

  const file = path.join(root, "SN[DMO-1726-R65]_ISSI[45131]_CP[1726]_SW[R65.000.10076].cpe");
  writeCpe(file, cps);
  const features = app.extractCodeplugFile(file).features;
  assert.equal(features.dmo.state, "Activo");
  assert.deepEqual(features.dmo.groups, [{ alias: "ISEG 001", gssi: 2300 }]);
  assert.equal(features.scan.lists[0].name, "Scan List1");
  assert.equal(features.scan.lists[0].groups[0].gssi, 7001);
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
  assignmentCps[832628] = 1;
  assignmentCps.writeUInt16LE(1, 832628 + 2);
  const assignmentFile = path.join(root, "layouts", "SN[ASSIGN]_ISSI[652]_CP[0652]_SW[R1].cpe");
  writeCpe(assignmentFile, assignmentCps);

  const folder = app.extractCodeplugFile(folderFile);
  const assignment = app.extractCodeplugFile(assignmentFile);
  assert.deepEqual(folder.rows.map((row) => [row.alias, row.gssi]), [["GRUPO 0778", 778001]]);
  assert.deepEqual(assignment.rows.map((row) => [row.alias, row.gssi]), [["GRUPO 0652", 652001]]);
});

test("extrae grupos normales y BROADCAST de la variante CP1726 nueva", () => {
  const layout = app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE["1726"][3222528];
  assert.deepEqual(layout.assignment.activeValues, [2, 7]);
  const cps = Buffer.alloc(3222528);

  const normal = layout.main.offset;
  Buffer.from("OPERACIONES\0", "utf16le").copy(cps, normal);
  cps.writeUInt32LE(6208, normal + layout.main.gssiOffset);
  cps[normal + layout.assignment.stateOffset] = 2;
  cps.writeUInt16LE(2, normal + layout.assignment.positionOffset);

  const broadcast = normal + layout.main.recordSize;
  Buffer.from("BROADCAST\0", "utf16le").copy(cps, broadcast);
  cps.writeUInt32LE(7193, broadcast + layout.main.gssiOffset);
  cps[broadcast + layout.assignment.stateOffset] = 7;
  cps.writeUInt16LE(1, broadcast + layout.assignment.positionOffset);

  const unassigned = broadcast + layout.main.recordSize;
  Buffer.from("NO ASIGNADO\0", "utf16le").copy(cps, unassigned);
  cps.writeUInt32LE(9999, unassigned + layout.main.gssiOffset);

  const file = path.join(root, "layouts", "SN[1726]_ISSI[1726]_CP[1726]_SW[R1].cpe");
  writeCpe(file, cps);
  const extracted = app.extractCodeplugFile(file);
  assert.deepEqual(
    extracted.rows.map((row) => [row.alias, row.gssi, row.folderRow, row.assignmentConfidence]),
    [["BROADCAST", 7193, 1, "high"], ["OPERACIONES", 6208, 2, "high"]]
  );
});

test("extrae destino de emergencia táctico y no táctico de formatos validados", () => {
  assert.deepEqual(app.EMERGENCY_LAYOUTS_BY_CPS_SIZE[3222528], {
    modeOffset: 2708,
    addressTypeOffset: 159068,
    groupAddressValue: 1,
    gssiOffset: 159076,
    aliasOffset: 159080,
    aliasBytes: 32,
    confidence: "high",
  });
  for (const [cpsLengthText, layout] of Object.entries(app.EMERGENCY_LAYOUTS_BY_CPS_SIZE)) {
    const cpsLength = Number(cpsLengthText);
    const nonTactical = Buffer.alloc(cpsLength);
    nonTactical[layout.modeOffset] = 1;
    nonTactical.writeUInt32LE(layout.groupAddressValue, layout.addressTypeOffset);
    nonTactical.writeUInt32LE(8588, layout.gssiOffset);
    Buffer.from("EMERGENCIA\0", "utf16le").copy(nonTactical, layout.aliasOffset);
    if (layout.attachmentOffset != null) nonTactical.writeUInt32LE(1, layout.attachmentOffset);

    assert.deepEqual(app.extractEmergencyConfig(nonTactical), {
      emergencySupported: true,
      emergencyAddressType: "Grupo",
      emergencyMode: "No táctico",
      emergencyAlias: "EMERGENCIA",
      emergencyGssi: 8588,
      emergencyAttachment: layout.attachmentOffset != null,
      emergencyConfidence: layout.confidence,
    }, `no táctico CPS ${cpsLength}`);

    const tactical = Buffer.from(nonTactical);
    tactical[layout.modeOffset] = 0;
    assert.deepEqual(app.extractEmergencyConfig(tactical), {
      emergencySupported: true,
      emergencyAddressType: "Grupo",
      emergencyMode: "Táctico",
      emergencyAlias: "Grupo actual",
      emergencyGssi: 0,
      emergencyAttachment: layout.attachmentOffset != null,
      emergencyConfidence: layout.confidence,
    }, `táctico CPS ${cpsLength}`);
  }
});

test("conserva emergencia validada aunque la tabla de grupos aun no este soportada", () => {
  const scanRoot = path.join(root, "emergency-only");
  const layout = app.EMERGENCY_LAYOUTS_BY_CPS_SIZE[1855040];
  const cps = Buffer.alloc(1855040);
  cps[layout.modeOffset] = 1;
  cps.writeUInt32LE(1, layout.addressTypeOffset);
  cps.writeUInt32LE(8588, layout.gssiOffset);
  Buffer.from("EMERGENCIA\0", "utf16le").copy(cps, layout.aliasOffset);
  const file = path.join(scanRoot, "SN[EMERGENCY]_ISSI[34677]_CP[1059]_SW[R1].cpe");
  writeCpe(file, cps);

  const extracted = app.extractCodeplugFile(file);
  assert.deepEqual(extracted.rows, []);
  assert.equal(extracted.emergencyMode, "No táctico");
  assert.equal(extracted.emergencyGssi, 8588);

  const scan = app.scanPath(scanRoot);
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.rows.length, 1);
  assert.equal(scan.matrix.radios[0].emergencyGroup, "EMERGENCIA (8588)");
  assert.deepEqual(scan.matrix.radios[0].groupGssis, []);
  const fleet = app.buildFleetMap(scanRoot, app.buildTemplateWorkbook().toString("base64"));
  const radio = fleet.matrix.radios.find((item) => item.issi === "34677");
  assert.equal(radio.hasCodeplug, true);
  assert.equal(radio.emergencyMode, "No táctico");
  assert.equal(radio.emergencyGroup, "EMERGENCIA (8588)");
  assert.deepEqual(radio.groupGssis, []);
});

test("CP1315/1330 CPS2848576 conserva nombres completos y grupos invisibles sin confundir carpeta con estado", () => {
  const cps = Buffer.alloc(2848576);
  const layout = app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE["1315"][cps.length];
  const entries = [
    ["ALP-EMERG", 9901, 0, 1, 1],
    ["ALP-OPERAC", 9902, 1, 1, 9],
    ["ALP-BROADCAS", 9908, 2, 0, 3],
    ["ROM-OPERACIO", 6024, 1, 1, 4],
    ["ABCDEFGHIJKL", 9995, 1, 1, 256],
    ["INVALIDO", 9000, 3, 1, 6],
  ];
  entries.forEach(([alias, gssi, state, folder, position], index) => {
    const base = layout.main.offset + index * layout.main.recordSize;
    Buffer.from(alias, "utf16le").copy(cps, base);
    cps.writeUInt16LE(state, base + 24);
    cps.writeUInt16LE(folder, base + 26);
    cps.writeUInt32LE(gssi, base + 28);
    cps.writeUInt16LE(position, base + 42);
  });
  const emergency = app.EMERGENCY_LAYOUTS_BY_CPS_SIZE[cps.length];
  cps[emergency.modeOffset] = 1;
  cps.writeUInt32LE(1, emergency.addressTypeOffset);
  cps.writeUInt32LE(9901, emergency.gssiOffset);
  Buffer.from("ALP-EMERG", "utf16le").copy(cps, emergency.aliasOffset);
  cps.writeUInt32LE(1, emergency.attachmentOffset);
  for (const cp of ["1315", "1330", ""]) {
    const file = path.join(root, "report-44310", `SN[TEST]${cp ? `_CP[${cp}]` : ""}.cpe`);
    writeCpe(file, cps);
    const result = app.extractCodeplugFile(file);
    assert.deepEqual(result.rows.map(r => [r.alias, r.gssi, r.status, r.statusText, r.folderRow]).sort((a,b) => a[1]-b[1]), [
      ["ROM-OPERACIO", 6024, 1, "Programado", 4],
      ["ALP-OPERAC", 9902, 1, "Programado", 9],
      ["ALP-BROADCAS", 9908, 2, "Invisible", 3],
      ["ABCDEFGHIJKL", 9995, 1, "Programado", 256],
    ]);
    assert.equal(result.emergencyMode, "No táctico");
    assert.equal(result.emergencyGssi, 9901);
    assert.equal(result.emergencyAlias, "ALP-EMERG");
    assert.equal(result.emergencyAttachment, true);
    assert.equal(result.emergencyConfidence, "report-44310");
    app.database.storeBatch([{path: file, size: result.size, mtimeMs: result.modifiedTime, codeplug: result}]);
    const cached = app.database.getFile(file);
    assert.equal(cached.emergencyGssi, 9901);
    assert.equal(app.database.findTalkgroups.all(cached.id).find(r => r.gssi === 9908).statusText, "Invisible");
  }
});

test("reportes 55391 y 56562: carpetas reales, invisibles e indices mayores de 1000", () => {
  for (const size of [3159936,5263232]) {
    const layout = app.LAYOUTS_BY_CPS_SIZE[size];
    const cps = Buffer.alloc(size);
    for (const [slot,alias,gssi] of [[1,'GUARDADO',100],[2,'INVISIBLE',9000],[1001,'ALTO',6000]]) {
      const offset = layout.main.offset + (slot-1)*68;
      Buffer.from(alias,'utf16le').copy(cps,offset);
      cps.writeUInt32LE(gssi,offset+36);
    }
    const folder=layout.folder.offset;
    cps[folder]=2; cps.writeUInt16LE(2,folder+2);
    cps[folder+4]=1; cps.writeUInt16LE(1001,folder+6);
    cps[folder+8]=99; cps.writeUInt16LE(1,folder+10);
    cps[folder+12]=1; cps.writeUInt16LE(10001,folder+14);
    const file=path.join(root,'reports',`TEST_${size}.cpe`); writeCpe(file,cps);
    const actual=app.extractCodeplugFile(file);
    assert.deepEqual(actual.rows.map(r=>[r.gssi,r.statusText,r.folderRow]),[[9000,'Invisible',1],[6000,'Programado',2]]);
    assert.equal(actual.emergencySupported,false);
  }
});

test("Excel distingue ISSI privado y destino de grupo sin cambiar el dato persistido", () => {
  const workbook=app.buildWorkbook({rows:[{issi:'55391',serial:'TEST',fileName:'private.cpe',alias:'EMER-ANIMON',gssi:6012,statusText:'Programado',emergencyMode:'Llamada privada',emergencyAddressType:'Llamada privada',emergencyGssi:10213,emergencyAlias:'ALIAS VIEJO'}]});
  const files=app.readZip(workbook);
  const matrix=files.get('xl/worksheets/sheet1.xml').toString();
  assert.match(matrix,/ISSI 10213/);
  assert.match(matrix,/Destino emergencia/);
  assert.doesNotMatch(matrix,/ALIAS VIEJO/);
});

test("lote2 User Reports: indices, nombres completos, invisibles y grupos unicos", () => {
  const {groupLayouts}=require('../lib/validated-user-report-group-layouts');
  for(const [size,layout] of Object.entries(groupLayouts)) {
    const cps=Buffer.alloc(Number(size));
    const entries=[[1,'GUARDADO',1],[2,'ABCDEFGHIJKL',10010043],[layout.main.maxRecords,'FINAL',9000]];
    for(const [slot,alias,gssi] of entries){
      const base=layout.main.offset+(slot-1)*layout.main.recordSize;
      Buffer.from(alias,'utf16le').copy(cps,base);cps.writeUInt32LE(gssi,base+layout.main.gssiOffset);
    }
    const folder=layout.folder.offset;
    for(const [i,state,slot] of [[0,2,2],[1,2,2],[2,1,layout.main.maxRecords],[3,99,1],[4,1,layout.main.maxRecords+1]]){
      cps[folder+i*4]=state;cps.writeUInt16LE(slot,folder+i*4+2);
    }
    if(Number(size)===1045696){
      // Old CP0405 code scanned 10,000 entries although CPS has only 2,048.
      // It interpreted unrelated data around slot 5652 as a talkgroup.
      const outside=layout.main.offset+(5652-1)*layout.main.recordSize;
      Buffer.from('FALSO','utf16le').copy(cps,outside);
      cps.writeUInt16LE(1,outside+26);cps.writeUInt32LE(65547,outside+28);cps[outside+42]=1;
    }
    const file=path.join(root,'lote2',`CP${Number(size)===1045696?'0405':'TEST'}_${size}.cpe`);writeCpe(file,cps);
    const actual=app.extractCodeplugFile(file);
    assert.deepEqual(actual.rows.map(r=>[r.gssi,r.alias,r.statusText]),[[10010043,'ABCDEFGHIJKL','Invisible'],[9000,'FINAL','Programado']],size);
    assert.equal(actual.emergencySupported,false);
  }
  assert.equal(groupLayouts[4738944].main.offset,970624);
  assert.equal(groupLayouts[1045696].main.maxRecords,2048);
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
    ["0232", 945600, "medium"],
    ["7472", 613248, "high"],
  ];

  for (const [codeplug, cpsLength, confidence] of cases) {
    const layout = app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE[codeplug][cpsLength];
    const cps = Buffer.alloc(cpsLength);
    const alias = `X${codeplug}`;
    Buffer.from(`${alias}\0`, "utf16le").copy(cps, layout.main.offset);
    cps.writeUInt16LE(1, layout.main.offset + layout.assignment.activeU16Offset);
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
