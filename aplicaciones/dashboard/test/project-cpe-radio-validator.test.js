const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProjectCpeRadio } = require("../lib/project-cpe-radio-validator");

function feature(state, values = {}) {
  return { state, ...values };
}

function project() {
  return {
    request: {
      radios: [{
        issi: "37019",
        serial: "123TZV1065",
        tei: "00016C130607100",
        contactName: "",
        groups: [{ label: "OPERACIONES", gssi: "7210" }],
        emergency: { mode: "NO TÁCTICO", gssi: "7226" },
        functions: {
          scan: false,
          dmo: true,
          broadcastListen: false,
          gps: true,
          gpsGatewayIssi: "10030",
          otap: true,
        },
        scanGroups: [],
        dmoGroups: [{ label: "GRUPO DMO", gssi: "90101" }],
      }],
    },
  };
}

function programmedRadio(overrides = {}) {
  return {
    issi: "37019",
    serial: "123TZV1065",
    tei: "00016C130607100",
    codeplug: "1330",
    software: "R36",
    rows: [{ alias: "OPERACIONES", gssi: 7210 }],
    emergencyMode: "No táctico",
    emergencyGssi: 7226,
    features: {
      scan: feature("Inactivo", { lists: [] }),
      dmo: feature("Activo", { groups: [{ alias: "GRUPO DMO", gssi: 90101 }] }),
      broadcast: feature("Inactivo"),
      gps: feature("Activo", { destinationIssi: 10030 }),
      otap: feature("Activo", { targets: [] }),
    },
    agenda: { supported: true, count: 0, contacts: [] },
    ...overrides,
  };
}

test("aprueba una radio programada con identidad y configuración exactas", () => {
  const result = validateProjectCpeRadio(project(), programmedRadio());
  assert.equal(result.status, "APROBADO");
  assert.equal(result.expectedIssi, "37019");
  assert.equal(result.failedCount, 0);
});

test("ubica por serie una radio con ISSI incorrecto y muestra la diferencia", () => {
  const result = validateProjectCpeRadio(project(), programmedRadio({ issi: "99999" }));
  assert.equal(result.status, "NO APROBADO");
  assert.equal(result.matchedBy, "SERIE");
  assert.equal(result.checks.find((check) => check.key === "identity-issi").passed, false);
});

test("rechaza un CPE que no pertenece al proyecto", () => {
  const result = validateProjectCpeRadio(project(), programmedRadio({ issi: "99999", serial: "OTRA", tei: "OTRO" }));
  assert.equal(result.status, "NO APROBADO");
  assert.equal(result.expectedIssi, "");
  assert.match(result.checks[0].detail, /ISSI, serie ni TEI/);
});
