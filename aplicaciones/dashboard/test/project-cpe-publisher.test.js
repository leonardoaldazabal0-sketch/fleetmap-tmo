const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CpeDatabase } = require("../lib/cpe-database");
const { ProjectCpePublisher } = require("../lib/project-cpe-publisher");
const { GoogleDriveClient } = require("../lib/google-drive-client");

test("prepara y publica una entrega idempotente en el NAS", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-publisher-"));
  const projectsRoot = path.join(root, "projects");
  const projectRoot = path.join(projectsRoot, "CPE-20260923-001");
  const configRoot = path.join(root, "config");
  const nasRoot = path.join(root, "nas");
  const driveRoot = path.join(root, "drive");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  fs.mkdirSync(driveRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, "publicacion.json"), JSON.stringify({
    nas: { enabled: true, root: nasRoot },
    googleDrive: { enabled: true, desktopRoot: driveRoot },
  }));
  const requestFile = path.join(projectRoot, "solicitud-cliente.xlsx");
  const modelFile = path.join(projectRoot, "modelo.cpe");
  const radioFile = path.join(projectRoot, "radio.cpe");
  fs.writeFileSync(requestFile, "solicitud");
  fs.writeFileSync(modelFile, "modelo");
  fs.writeFileSync(radioFile, "radio");

  const database = new CpeDatabase(path.join(root, "db.sqlite"), "test");
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  database.createCpeProject({
    code: "CPE-20260923-001",
    responsible: "Programador",
    sourceFileName: "cliente.xlsx",
    sourceFilePath: requestFile,
    fileSha256: "solicitud-sha",
    schemaVersion: "CLIENTE_CPE_V7",
    razonSocial: "Cliente",
    radioCount: 1,
    groupCount: 1,
    request: { radios: [{ issi: "10001" }] },
  });
  database.updateCpeProjectPublicationRoute("CPE-20260923-001", {
    clientPath: path.join("PRIVADAS", "CLIENTE"),
    formNumber: "1394",
    programmingDate: "2026-09-23",
    programmerInitials: "LA",
  });
  database.updateCpeProjectModelValidation("CPE-20260923-001", {
    projectStatus: "MODELO_APROBADO",
    fileName: "modelo.cpe",
    filePath: modelFile,
    fileSha256: "modelo-sha",
    result: { status: "APROBADO" },
  });
  database.recordCpeProjectRadioValidation("CPE-20260923-001", {
    expectedIssi: "10001",
    actualIssi: "10001",
    fileName: "radio.cpe",
    filePath: radioFile,
    fileSha256: "radio-sha",
    programmer: "Programador",
    status: "APROBADO",
    result: { status: "APROBADO", actual: { issi: "10001" } },
  });

  const publisher = new ProjectCpePublisher({
    database,
    projectsRoot,
    deliveriesRoot: path.join(root, "deliveries"),
    configDirectory: configRoot,
  });
  const first = await publisher.publish("CPE-20260923-001");
  const second = await publisher.publish("CPE-20260923-001");
  assert.equal(first.deliveryId, second.deliveryId);
  assert.equal(first.nas.alreadyPublished, false);
  assert.equal(second.nas.alreadyPublished, true);
  assert.equal(first.drive.mode, "DRIVE_DESKTOP");
  assert.equal(first.drive.alreadyPublished, false);
  assert.equal(second.drive.alreadyPublished, true);
  assert.equal(fs.existsSync(path.join(first.drive.path, "MANIFIESTO-CPE-20260923-001.json")), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(first.nas.path, "MANIFIESTO-CPE-20260923-001.json"), "utf8"));
  assert.equal(manifest.projectCode, "CPE-20260923-001");
  assert.equal(manifest.radios, 1);
  assert.equal(manifest.files.length, 3);
  assert.match(first.nas.path, /Plantillas x Clientes 2026.*FORM 1394.*20260923_LA.*DESPUES$/);
});

test("Drive permanece pendiente mientras falta la cuenta de servicio", () => {
  const client = new GoogleDriveClient({ folderId: "carpeta", credentialsFile: path.join(os.tmpdir(), "no-existe-cpe.json") });
  const status = client.status();
  assert.equal(status.configured, false);
  assert.match(status.error, /cuenta de servicio/i);
});
