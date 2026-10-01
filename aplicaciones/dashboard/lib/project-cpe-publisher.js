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

function normalizePublicationRoute(input = {}) {
  const clientPath = String(input.clientPath || "").trim().replace(/[\\/]+/g, path.sep).replace(/^[/\\]+|[/\\]+$/g, "");
  const segments = clientPath.split(path.sep).map((item) => item.trim()).filter(Boolean);
  if (!segments.length) throw new Error("Indica la ruta del cliente dentro de Plantillas x Clientes");
  if (segments.some((item) => item === "." || item === ".." || /[<>:"|?*\x00-\x1F]/.test(item))) {
    throw new Error("La ruta del cliente contiene un segmento no permitido");
  }
  const formNumber = String(input.formNumber || "").trim().replace(/^FORM\s*/i, "");
  if (!/^\d{1,8}$/.test(formNumber)) throw new Error("Indica el numero de FORM");
  const programmingDate = String(input.programmingDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(programmingDate)) throw new Error("Indica la fecha de programacion");
  const parsedDate = new Date(`${programmingDate}T12:00:00Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== programmingDate) {
    throw new Error("La fecha de programacion no es valida");
  }
  const programmerInitials = String(input.programmerInitials || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{2,10}$/.test(programmerInitials)) throw new Error("Indica iniciales validas del programador (2 a 10 caracteres)");
  const year = programmingDate.slice(0, 4);
  const dateKey = programmingDate.replaceAll("-", "");
  const relativePath = path.join(
    `Plantillas x Clientes ${year}`,
    ...segments,
    `FORM ${formNumber}`,
    `${dateKey}_${programmerInitials}`,
    "DESPUES",
  );
  return { clientPath: segments.join(path.sep), formNumber, programmingDate, programmerInitials, relativePath };
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
      desktopRoot: String(drive.desktopRoot || "").trim(),
    },
    field: {
      centralUrl: String(config.field?.centralUrl || "").replace(/\/$/, ""),
      syncIntervalSeconds: Math.max(15, Number(config.field?.syncIntervalSeconds || 60)),
    },
  };
}

function copyTreeMergeVerified(sourceRoot, destinationRoot) {
  fs.mkdirSync(destinationRoot, { recursive: true });
  let copied = 0;
  let reused = 0;
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .sort((a, b) => Number(/^MANIFIESTO-/i.test(a.name)) - Number(/^MANIFIESTO-/i.test(b.name)) || a.name.localeCompare(b.name, "es"));
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    const sourceHash = sha256File(source);
    if (fs.existsSync(destination)) {
      if (!fs.statSync(destination).isFile() || sha256File(destination) !== sourceHash) {
        throw new Error(`Ya existe un archivo diferente en el destino: ${destination}`);
      }
      reused += 1;
      continue;
    }
    const temporary = `${destination}.partial-${crypto.randomUUID()}`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      if (sha256File(temporary) !== sourceHash) throw new Error(`La copia no coincide con el origen: ${entry.name}`);
      fs.renameSync(temporary, destination);
      copied += 1;
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  return { copied, reused, files: copied + reused };
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
    const api = this.config.googleDrive.enabled
      ? driveClient.status()
      : { configured: false, disabled: true, error: "Google Drive esta deshabilitado" };
    const desktopRoot = this.config.googleDrive.desktopRoot;
    const desktopConfigured = Boolean(
      this.config.googleDrive.enabled && desktopRoot && fs.existsSync(path.parse(desktopRoot).root),
    );
    const drive = this.config.googleDrive.enabled
      ? {
          configured: Boolean(api.configured || desktopConfigured),
          mode: api.configured ? "API" : desktopConfigured ? "DRIVE_DESKTOP" : "",
          account: api.account || "",
          folderId: api.folderId || this.config.googleDrive.folderId,
          desktopRoot,
          error: api.configured || desktopConfigured ? "" : api.error,
        }
      : api;
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
    const route = normalizePublicationRoute(project.publicationRoute || {});
    const summary = this.database.cpeProjectRadioValidationSummary(projectCode);
    if (!summary.allApproved) throw new Error("La entrega no puede publicarse hasta aprobar todas las radios");
    const approved = summary.validations.filter((item) => item.status === "APROBADO" && item.expectedIssi);
    const usedNames = new Set();
    const radioFiles = approved.map((item) => {
      let name = safeName(item.fileName, `${item.expectedIssi}.cpe`);
      if (usedNames.has(name.toLowerCase())) name = `${item.expectedIssi}-${name}`;
      usedNames.add(name.toLowerCase());
      return { category: "RADIO", name, path: item.filePath, issi: item.expectedIssi };
    });
    const inputs = [
      { category: "SOLICITUD", name: `SOLICITUD-${project.code}.xlsx`, path: project.sourceFilePath, issi: "" },
      { category: "MODELO", name: `MODELO-${project.code}-${safeName(project.modelFileName, "modelo.cpe")}`, path: project.modelFilePath, issi: "" },
      ...radioFiles,
    ];
    for (const input of inputs) {
      if (!input.path || !fs.existsSync(input.path) || !fs.statSync(input.path).isFile()) {
        throw new Error(`No se encontro el archivo requerido para publicar: ${input.name}`);
      }
    }
    const files = inputs.map((input) => ({ ...input, size: fs.statSync(input.path).size, sha256: sha256File(input.path) }));
    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ route: route.relativePath, files: files.map(({ category, name, issi, size, sha256 }) => ({ category, name, issi, size, sha256 })) }))
      .digest("hex");
    return { project, route, summary, files, fingerprint, deliveryId: `ENTREGA-${fingerprint.slice(0, 12).toUpperCase()}` };
  }

  prepare(projectCode) {
    const collected = this.collect(projectCode);
    fs.mkdirSync(this.deliveriesRoot, { recursive: true });
    const deliveryRoot = path.join(this.deliveriesRoot, collected.project.code, collected.deliveryId);
    if (!within(this.deliveriesRoot, deliveryRoot)) throw new Error("Ruta de entrega fuera del directorio permitido");
    fs.rmSync(deliveryRoot, { recursive: true, force: true });
    fs.mkdirSync(deliveryRoot, { recursive: true });
    const manifestFiles = [];
    for (const item of collected.files) {
      const destination = path.join(deliveryRoot, item.name);
      fs.copyFileSync(item.path, destination);
      manifestFiles.push({ category: item.category, name: item.name, issi: item.issi, size: item.size, sha256: item.sha256 });
    }
    const manifestFileName = `MANIFIESTO-${collected.project.code}.json`;
    const manifest = {
      schema: "PROYECTO_CPE_ENTREGA_V2",
      projectCode: collected.project.code,
      razonSocial: collected.project.razonSocial,
      responsible: collected.project.responsible,
      preparedAt: collected.project.createdAt,
      deliveryId: collected.deliveryId,
      fingerprint: collected.fingerprint,
      destinationRelativePath: collected.route.relativePath,
      radios: collected.summary.total,
      files: manifestFiles,
    };
    fs.writeFileSync(path.join(deliveryRoot, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...collected, deliveryRoot, manifest, manifestFileName };
  }

  publishNas(prepared) {
    if (!this.config.nas.enabled) return { status: "OMITIDO", disabled: true };
    if (!this.config.nas.root) throw new Error("Falta configurar la ruta de publicacion del NAS");
    fs.mkdirSync(this.config.nas.root, { recursive: true });
    const finalPath = path.join(this.config.nas.root, prepared.route.relativePath);
    if (!within(this.config.nas.root, finalPath)) throw new Error("Ruta NAS de entrega fuera del directorio permitido");
    const result = copyTreeMergeVerified(prepared.deliveryRoot, finalPath);
    return { status: "PUBLICADO", path: finalPath, alreadyPublished: result.copied === 0, ...result };
  }

  async publishDrive(prepared) {
    if (!this.config.googleDrive.enabled) return { status: "OMITIDO", disabled: true };
    const client = new GoogleDriveClient(this.config.googleDrive);
    const apiStatus = client.status();
    const routeSegments = prepared.route.relativePath.split(path.sep).filter(Boolean);
    if (apiStatus.configured) {
      return { status: "PUBLICADO", mode: "API", path: prepared.route.relativePath, ...(await client.uploadTree(prepared.deliveryRoot, routeSegments)) };
    }
    const desktopRoot = this.config.googleDrive.desktopRoot;
    if (!desktopRoot || !fs.existsSync(path.parse(desktopRoot).root)) {
      throw new Error(apiStatus.error || "Google Drive no esta configurado");
    }
    fs.mkdirSync(desktopRoot, { recursive: true });
    const finalPath = path.join(desktopRoot, prepared.route.relativePath);
    if (!within(desktopRoot, finalPath)) throw new Error("Ruta de Google Drive fuera del directorio permitido");
    const result = copyTreeMergeVerified(prepared.deliveryRoot, finalPath);
    return { status: "PUBLICADO", mode: "DRIVE_DESKTOP", path: finalPath, alreadyPublished: result.copied === 0, ...result };
  }

  async publish(projectCode, onProgress = async () => {}) {
    const prepared = this.prepare(projectCode);
    const details = {
      projectCode: prepared.project.code,
      deliveryId: prepared.deliveryId,
      fingerprint: prepared.fingerprint,
      destinationRelativePath: prepared.route.relativePath,
      localPath: prepared.deliveryRoot,
      drive: { status: this.config.googleDrive.enabled ? "PUBLICANDO" : "OMITIDO" },
      nas: { status: this.config.nas.enabled ? "PENDIENTE" : "OMITIDO" },
    };
    await onProgress(details);
    try {
      details.drive = await this.publishDrive(prepared);
    } catch (error) {
      details.drive = { status: "ERROR", error: error.message };
      await onProgress(details);
      throw error;
    }
    await onProgress(details);
    try {
      details.nas = this.publishNas(prepared);
    } catch (error) {
      details.nas = { status: "ERROR", error: error.message };
      await onProgress(details);
      throw error;
    }
    details.completedAt = new Date().toISOString();
    await onProgress(details);
    return details;
  }
}

module.exports = { ProjectCpePublisher, loadPublicationConfig, normalizePublicationRoute, copyTreeMergeVerified, sha256File };
