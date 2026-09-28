const assert = require("node:assert/strict");
const test = require("node:test");

const { validateProjectCpeModel } = require("../lib/project-cpe-model-validator");

function fixture() {
  const radio = {
    issi: "37019",
    contactName: "RADIO MINA",
    groups: [
      { label: "SEGURIDAD", gssi: "7210" },
      { label: "SMA", gssi: "7290" },
    ],
    emergency: { mode: "NO TÁCTICO", gssi: "7226" },
    functions: {
      scan: false,
      dmo: false,
      broadcastListen: false,
      broadcastGssi: "",
      gps: true,
      gpsGatewayIssi: "10030",
      otap: true,
    },
    scanGroups: [],
    dmoGroups: [],
  };
  return {
    project: { request: { radios: [radio, { ...radio, issi: "37020", contactName: "RADIO DOS" }] } },
    model: {
      rows: [
        { alias: "seguridad", gssi: 7210 },
        { alias: "SMA", gssi: 7290 },
      ],
      emergencyMode: "No táctico",
      emergencyGssi: 7226,
      features: {
        scan: { state: "Inactivo", lists: [] },
        dmo: { state: "Inactivo", groups: [] },
        broadcast: { state: "Inactivo", gssi: 0 },
        gps: { state: "Activo", destinationIssi: 10030 },
        otap: { state: "Activo", targets: [110] },
      },
      agenda: {
        supported: true,
        count: 2,
        contacts: [
          { name: "RADIO MINA", issi: "37019" },
          { name: "RADIO DOS", issi: "37020" },
        ],
      },
    },
  };
}

test("aprueba un CPE modelo que coincide con el perfil solicitado", () => {
  const { project, model } = fixture();
  const result = validateProjectCpeModel(project, model);
  assert.equal(result.status, "APROBADO");
  assert.equal(result.profileCount, 1);
  assert.deepEqual(result.appliesToIssis, ["37019", "37020"]);
  assert.equal(result.failedCount, 0);
});

test("rechaza grupos adicionales, labels diferentes y funciones incorrectas", () => {
  const { project, model } = fixture();
  model.rows[1].alias = "CSMA";
  model.rows.push({ alias: "EXTRA", gssi: 9999 });
  model.features.dmo.state = "Activo";
  const result = validateProjectCpeModel(project, model);
  assert.equal(result.status, "NO APROBADO");
  assert.ok(result.failedCount >= 2);
  assert.match(result.checks.find((check) => check.key === "groups").detail, /Labels diferentes/);
  assert.equal(result.checks.find((check) => check.key === "dmo").passed, false);
});

test("selecciona el perfil compatible cuando un proyecto tiene configuraciones distintas", () => {
  const { project, model } = fixture();
  project.request.radios[1] = {
    ...project.request.radios[1],
    groups: [{ label: "OTRO", gssi: "8000" }],
  };
  const result = validateProjectCpeModel(project, model);
  assert.equal(result.status, "APROBADO");
  assert.equal(result.profileCount, 2);
  assert.deepEqual(result.appliesToIssis, ["37019"]);
});
