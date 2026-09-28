const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CpeDatabase } = require("../lib/cpe-database");
const { parseProjectCpeSheets } = require("../lib/project-cpe");


function projectSheets({
  scan = true,
  dmo = false,
  gps = true,
  gpsGateway = "110",
  schemaVersion = "CLIENTE_CPE_V7",
  groups = 10,
  dmoGroupCount = 10,
  issi = "44310",
  serial = "876TAZ2641",
  tei = "00016C280147880",
  contactName = "JEFE MINA",
  groupLabel = "SEGURIDAD",
} = {}) {
  const modern = ["CLIENTE_CPE_V4", "CLIENTE_CPE_V5", "CLIENTE_CPE_V6", "CLIENTE_CPE_V7"].includes(schemaVersion);
  const groupStart = modern ? 11 : 9;
  const featureStart = schemaVersion === "CLIENTE_CPE_V7" ? groupStart + groups : modern ? 21 : 19;
  const mainHeader = [];
  mainHeader[0] = "PLANTILLA DE PROGRAMACIÓN - CLIENTE";
  const labels = [];
  labels[groupStart] = groupLabel;
  const gssis = [];
  gssis[groupStart] = "6078";
  const radio = [];
  radio[1] = "21/09/2026";
  radio[2] = "20500000001";
  radio[3] = "VOLCAN";
  radio[4] = "OC-100";
  radio[5] = ["CLIENTE_CPE_V5", "CLIENTE_CPE_V6", "CLIENTE_CPE_V7"].includes(schemaVersion) ? contactName : "RADIO-01";
  radio[6] = issi;
  if (modern) {
    radio[7] = serial;
    radio[8] = tei;
    radio[9] = "MTP3550";
    radio[10] = "MINA";
  } else {
    radio[7] = "MTP3550";
    radio[8] = "MINA";
  }
  radio[groupStart] = "X";
  radio[featureStart] = "TÁCTICO";
  radio[featureStart + 4] = scan ? "X" : "";
  radio[featureStart + 5] = dmo ? "X" : "";
  radio[featureStart + 8] = gps ? "X" : "";
  if (["CLIENTE_CPE_V6", "CLIENTE_CPE_V7"].includes(schemaVersion)) radio[featureStart + 9] = gpsGateway;

  const scanHeader = ["ASIGNACIÓN DE GRUPOS - ESCANEO"];
  const scanRow = [];
  if (scan) scanRow[4] = "X";
  const dmoHeader = ["ASIGNACIÓN DE GRUPOS - DMO"];
  const dmoLabels = [];
  const dmoGssis = [];
  const dmoRow = [];
  if (dmo) {
    dmoLabels[4] = "DIRECTO";
    dmoGssis[4] = "2000";
    dmoRow[4] = "X";
  }
  const technicalLabels = [];
  const technicalValues = [];
  technicalLabels[3] = "SCHEMA";
  technicalValues[3] = schemaVersion;
  if (schemaVersion === "CLIENTE_CPE_V7") {
    technicalLabels[6] = "GROUPS";
    technicalValues[6] = groups;
    technicalLabels[7] = "DMO_GROUPS";
    technicalValues[7] = dmoGroupCount;
  }
  return new Map([
    ["PLANTILLA", [mainHeader, labels, gssis, radio]],
    ["ESCANEO", [scanHeader, [], [], scanRow]],
    ["DMO", [dmoHeader, dmoLabels, dmoGssis, dmoRow]],
    ["OP CAMPOS", [technicalLabels, technicalValues]],
  ]);
}


test("interpreta la plantilla compacta con grupos y Escaneo", () => {
  const result = parseProjectCpeSheets(projectSheets());
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.equal(result.schemaVersion, "CLIENTE_CPE_V7");
  assert.equal(result.summary.radios, 1);
  assert.equal(result.summary.groups, 1);
  assert.equal(result.summary.scanRadios, 1);
  assert.deepEqual(result.request.radios[0].scanGroups.map((group) => group.gssi), ["6078"]);
  assert.equal(result.request.radios[0].emergency.mode, "TÁCTICO");
  assert.equal(result.request.radios[0].serial, "876TAZ2641");
  assert.equal(result.request.radios[0].tei, "00016C280147880");
  assert.equal(result.request.radios[0].contactName, "JEFE MINA");
  assert.equal(result.request.radios[0].functions.gps, true);
  assert.equal(result.request.radios[0].functions.gpsGatewayIssi, "110");
  assert.equal(result.summary.gpsGatewayRadios, 1);
  assert.equal(result.summary.contacts, 1);
});


test("V7 exige la relación ISSI, serie y TEI antes de registrar", () => {
  const result = parseProjectCpeSheets(projectSheets({ issi: "", serial: "", tei: "" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /falta ISSI de uso interno/);
  assert.match(result.errors.join(" | "), /falta SERIE de uso interno/);
  assert.match(result.errors.join(" | "), /falta TEI de uso interno/);
});


test("reconoce V3 pero exige migrarla antes del registro", () => {
  const result = parseProjectCpeSheets(projectSheets({ schemaVersion: "CLIENTE_CPE_V3" }));
  assert.equal(result.valid, false);
  assert.equal(result.schemaVersion, "CLIENTE_CPE_V3");
  assert.match(result.errors.join(" | "), /ya no puede registrarse/);
  assert.equal(result.request.radios[0].serial, "");
  assert.equal(result.request.radios[0].tei, "");
});

test("V7 acepta radios sin nombre de contacto", () => {
  const result = parseProjectCpeSheets(projectSheets({ contactName: "" }));
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.equal(result.summary.contacts, 0);
});

test("V7 rechaza nombres de contacto mayores de 12 caracteres", () => {
  const result = parseProjectCpeSheets(projectSheets({ contactName: "CONTACTO MUY LARGO" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /nombre en agenda supera 12 caracteres/);
});

test("V7 admite labels de grupo de 15 caracteres", () => {
  const result = parseProjectCpeSheets(projectSheets({ groupLabel: "GRUPO SEGURIDAD" }));
  assert.equal("GRUPO SEGURIDAD".length, 15);
  assert.equal(result.valid, true, result.errors.join(" | "));
});

test("V7 rechaza labels de grupo mayores de 15 caracteres", () => {
  const result = parseProjectCpeSheets(projectSheets({ groupLabel: "GRUPO SEGURIDAD1" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /label de G01 supera 15 caracteres/);
});

test("V4 se interpreta pero exige migrarla a V7", () => {
  const result = parseProjectCpeSheets(projectSheets({ schemaVersion: "CLIENTE_CPE_V4" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /plantilla V4 ya no puede registrarse/);
});

test("V5 se interpreta pero exige migrarla a V7 para especificar el gateway GPS", () => {
  const result = parseProjectCpeSheets(projectSheets({ schemaVersion: "CLIENTE_CPE_V5" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /plantilla V5 ya no puede registrarse/);
});

test("V6 conserva compatibilidad con plantillas de diez grupos", () => {
  const result = parseProjectCpeSheets(projectSheets({ schemaVersion: "CLIENTE_CPE_V6" }));
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.equal(result.request.capacities.tmoGroups, 10);
  assert.equal(result.request.capacities.dmoGroups, 10);
});

test("V7 exige gateway cuando GPS está activo", () => {
  const result = parseProjectCpeSheets(projectSheets({ gpsGateway: "" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /GPS está activo pero falta ISSI Gateway GPS/);
});

test("V7 ignora el gateway informado cuando GPS está inactivo", () => {
  const result = parseProjectCpeSheets(projectSheets({ gps: false, gpsGateway: "110" }));
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.equal(result.request.radios[0].functions.gpsGatewayIssi, "");
  assert.match(result.warnings.join(" | "), /Gateway GPS se ignorará/);
});

test("V7 interpreta capacidades dinámicas y desplaza funciones después de los grupos", () => {
  const result = parseProjectCpeSheets(projectSheets({ groups: 24, dmoGroupCount: 17 }));
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.deepEqual(result.request.capacities, { tmoGroups: 24, dmoGroups: 17 });
  assert.equal(result.request.radios[0].functions.gpsGatewayIssi, "110");
  assert.deepEqual(result.request.radios[0].scanGroups.map((group) => group.gssi), ["6078"]);
});

test("V7 admite una plantilla sin columnas DMO", () => {
  const result = parseProjectCpeSheets(projectSheets({ dmoGroupCount: 0 }));
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.deepEqual(result.request.capacities, { tmoGroups: 10, dmoGroups: 0 });
  assert.equal(result.request.dmoGroups.length, 0);
});


test("rechaza Escaneo activo sin grupos asignados", () => {
  const sheets = projectSheets();
  sheets.get("ESCANEO")[3] = [];
  const result = parseProjectCpeSheets(sheets);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" | "), /Escaneo está activo pero no tiene grupos/);
});


test("interpreta grupos DMO independientes de TMO", () => {
  const result = parseProjectCpeSheets(projectSheets({ scan: false, dmo: true }));
  assert.equal(result.valid, true, result.errors.join(" | "));
  assert.equal(result.summary.dmoGroups, 1);
  assert.equal(result.request.radios[0].dmoGroups[0].label, "DIRECTO");
  assert.equal(result.request.radios[0].dmoGroups[0].gssi, "2000");
});


test("registra y lista solicitudes del Proyecto CPE en SQLite", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-project-test-"));
  const db = new CpeDatabase(path.join(tempRoot, "test.sqlite"), "test");
  try {
    assert.equal(db.nextCpeProjectCode(new Date(2026, 8, 21)), "CPE-20260921-001");
    const project = db.createCpeProject({
      code: "CPE-20260921-001",
      responsible: "Programador Prueba",
      sourceFileName: "solicitud.xlsx",
      sourceFilePath: path.join(tempRoot, "solicitud.xlsx"),
      fileSha256: "abc123",
      schemaVersion: "CLIENTE_CPE_V3",
      razonSocial: "VOLCAN",
      ruc: "20500000001",
      contractRef: "OC-100",
      radioCount: 1,
      groupCount: 1,
      warnings: [],
      request: { radios: [{ radioId: "RADIO-01" }] },
    });
    assert.equal(project.status, "RECIBIDO");
    assert.equal(db.nextCpeProjectCode(new Date(2026, 8, 21)), "CPE-20260921-002");
    assert.equal(db.findCpeProjectByHash("abc123").code, project.code);
    assert.equal(db.listCpeProjects()[0].razonSocial, "VOLCAN");
    assert.equal(db.getCpeProject(project.code).request.radios[0].radioId, "RADIO-01");
    const validated = db.updateCpeProjectModelValidation(project.code, {
      projectStatus: "MODELO_APROBADO",
      fileName: "modelo.cpe",
      filePath: path.join(tempRoot, "modelo.cpe"),
      fileSha256: "model123",
      result: { status: "APROBADO", failedCount: 0 },
    });
    assert.equal(validated.status, "MODELO_APROBADO");
    assert.equal(validated.modelFileName, "modelo.cpe");
    assert.equal(validated.modelValidation.status, "APROBADO");

    const rejected = db.recordCpeProjectRadioValidation(project.code, {
      expectedIssi: "44310",
      actualIssi: "44310",
      actualSerial: "SERIE-MAL",
      actualTei: "TEI-1",
      fileName: "radio-mal.cpe",
      fileSha256: "radio-mal",
      programmer: "Programador Prueba",
      status: "NO APROBADO",
      failedCount: 1,
      result: { status: "NO APROBADO", checks: [{ key: "identity-serial", passed: false }] },
    });
    assert.equal(rejected.summary.total, 1);
    assert.equal(rejected.summary.approved, 0);
    assert.equal(rejected.summary.notApproved, 1);
    assert.equal(rejected.summary.pending, 0);
    assert.equal(rejected.project.status, "RADIOS_EN_VALIDACION");

    const approved = db.recordCpeProjectRadioValidation(project.code, {
      expectedIssi: "44310",
      actualIssi: "44310",
      actualSerial: "876TAZ2641",
      actualTei: "00016C280147880",
      fileName: "radio-bien.cpe",
      filePath: path.join(tempRoot, "radios-aprobadas", "radio-bien.cpe"),
      fileSha256: "radio-bien",
      programmer: "Programador Prueba",
      status: "APROBADO",
      failedCount: 0,
      result: { status: "APROBADO", checks: [] },
    });
    assert.equal(approved.summary.approved, 1);
    assert.equal(approved.summary.notApproved, 0);
    assert.equal(approved.summary.pending, 0);
    assert.equal(approved.summary.validations.length, 1);
    assert.equal(approved.project.status, "RADIOS_APROBADAS");
  } finally {
    db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
