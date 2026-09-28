const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { GoogleDriveClient } = require("./google-drive-client");

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function safeName(value, fallback) {
  const cleaned = path.basename(String(value || fallback)).replace(/[^A-Za-z0-9._\-\[\]() ]+/g, "_").slice(-180);
  return cleaned || fallback;
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function loadPublicationConfig(configDirectory) {
  const filePath = path.join(path.resolve(configDirectory), "publicacion.json");
  const config = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  const drive = config.googleDrive || {};
  return {
    filePath,
    nas: { enabled: config.nas?.enabled !== false, root: String(config.nas?.root || "") },
    googleDrive: {
      enabled: drive.enabled !== false,
      folderId: String(drive.folderId || ""),
      credentialsFile: path.resolve(configDirectory, String(drive.serviceAccountFile || "service-account.json")),
    },
    field: {
      centralUrl: String(config.field?.centralUrl || "").replace(/\/$/, ""),
      syncIntervalSeconds: Math.max(15, Number(config.field?.syncIntervalSeconds || 60)),
    },
  };
}

class ProjectCpePublisher {
  constructor(options) {
    this.database = options.database;
    this.projectsRoot = path.resolve(options.projectsRoot);
    this.deliveriesRoot = path.resolve(options.deliveriesRoot);
    this.config = loadPublicationConfig(options.configDirectory);
  }

  status() {
    const driveClient = new GoogleDriveClient(this.config.googleDrive);
    const drive = this.config.googleDrive.enabled
      ? driveClient.status()
      : { configured: false, disabled: true, error: "Google Drive esta deshabilitado" };
    return {
      nas: {
        enabled: this.config.nas.enabled,
        configured: this.config.nas.enabled && Boolean(this.config.nas.root),
        root: this.config.nas.root,
      },
      googleDrive: { enabled: this.config.googleDrive.enabled, ...drive },
      field: this.config.field,
    };
  }

  collect(projectCode) {
    const project = this.database.getCpeProject(projectCode);
    if (!project) throw new Error(`No existe el proyecto ${projectCode}`);
    const summary = this.database.cpeProjectRadioValidationSummary(projectCode);
    if (!summary.allApproved) throw new Error("La entrega no puede publicarse hasta aprobar todas las radios");
    const approved = summary.validations.filter((item) => item.status === "APROBADO" && item.expectedIssi);
    const inputs = [
      { category: "Solicitud", name: "solicitud-cliente.xlsx", path: project.sourceFilePath, issi: "" },
      { category: "Modelo", name: safeName(project.modelFileName, "modelo.cpe"), path: project.modelFilePath, issi: "" },
      ...approved.map((item) => ({
        category: "Radios",
        name: `${item.expectedIssi}-${safeName(item.fileName, "radio.cpe")}`,
        path: item.filePath,
        issi: item.expectedIssi,
      })),
    ];
    for (const input of inputs) {
      if (!input.path || !fs.existsSync(input.path) || !fs.statSync(input.path).isFile()) {
        throw new Error(`No se encontro el archivo requerido para publicar: ${input.name}`);
      }
    }
    const files = inputs.map((input) => ({ ...input, size: fs.statSync(input.path).size, sha256: sha256File(input.path) }));
    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify(files.map(({ category, name, issi, size, sha256 }) => ({ category, name, issi, size, sha256 }))))
      .digest("hex");
    return { project, summary, files, fingerprint, deliveryId: `ENTREGA-${fingerprint.slice(0, 12).toUpperCase()}` };
  }

  prepare(projectCode) {
    const collected = this.collect(projectCode);
    fs.mkdirSync(this.deliveriesRoot, { recursive: true });
    const projectRoot = path.join(this.deliveriesRoot, collected.project.code);
    const deliveryRoot = path.join(projectRoot, collected.deliveryId);
    if (!within(this.deliveriesRoot, deliveryRoot)) throw new Error("Ruta de entrega fuera del directorio permitido");
    fs.mkdirSync(deliveryRoot, { recursive: true });
    const manifestFiles = [];
    for (const item of collected.files) {
      const categoryRoot = path.join(deliveryRoot, item.category);
      fs.mkdirSync(categoryRoot, { recursive: true });
      const destination = path.join(categoryRoot, item.name);
      fs.copyFileSync(item.path, destination);
      manifestFiles.push({
        category: item.category,
        name: item.name,
        issi: item.issi,
        size: item.size,
        sha256: item.sha256,
        relativePath: path.relative(deliveryRoot, destination),
      });
    }
    const manifest = {
      schema: "PROYECTO_CPE_ENTREGA_V1",
      projectCode: collected.project.code,
      razonSocial: collected.project.razonSocial,
      responsible: collected.project.responsible,
      preparedAt: new Date().toISOString(),
      deliveryId: collected.deliveryId,
      fingerprint: collected.fingerprint,
      radios: collected.summary.total,
      files: manifestFiles,
    };
    fs.writeFileSync(path.join(deliveryRoot, "manifiesto.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...collected, deliveryRoot, manifest };
  }

  publishNas(prepared) {
    if (!this.config.nas.enabled) return { disabled: true };
    if (!this.config.nas.root) throw new Error("Falta configurar la ruta de publicacion del NAS");
    fs.mkdirSync(this.config.nas.root, { recursive: true });
    const projectRoot = path.join(this.config.nas.root, prepared.project.code);
    const finalPath = path.join(projectRoot, prepared.deliveryId);
    if (!within(this.config.nas.root, finalPath)) throw new Error("Ruta NAS de entrega fuera del directorio permitido");
    const finalManifest = path.join(finalPath, "manifiesto.json");
    if (fs.existsSync(finalManifest)) {
      const existing = JSON.parse(fs.readFileSync(finalManifest, "utf8"));
      if (existing.fingerprint === prepared.fingerprint) return { path: finalPath, alreadyPublished: true };
      throw new Error(`Ya existe una entrega diferente en ${finalPath}`);
    }
    fs.mkdirSync(projectRoot, { recursive: true });
    const temporaryPath = path.join(projectRoot, `.partial-${prepared.deliveryId}-${crypto.randomUUID()}`);
    try {
      fs.cpSync(prepared.deliveryRoot, temporaryPath, { recursive: true, errorOnExist: true, force: false });
      fs.renameSync(temporaryPath, finalPath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { recursive: true, force: true }); } catch {}
      throw error;
    }
    return { path: finalPath, alreadyPublished: false };
  }

  async publishDrive(prepared) {
    if (!this.config.googleDrive.enabled) return { disabled: true };
    const client = new GoogleDriveClient(this.config.googleDrive);
    return client.uploadTree(prepared.deliveryRoot, prepared.project.code, prepared.deliveryId);
  }

  async publish(projectCode) {
    const prepared = this.prepare(projectCode);
    const drive = await this.publishDrive(prepared);
    const nas = this.publishNas(prepared);
    return {
      projectCode: prepared.project.code,
      deliveryId: prepared.deliveryId,
      fingerprint: prepared.fingerprint,
      localPath: prepared.deliveryRoot,
      nas,
      drive,
      completedAt: new Date().toISOString(),
    };
  }
}

module.exports = { ProjectCpePublisher, loadPublicationConfig, sha256File };
