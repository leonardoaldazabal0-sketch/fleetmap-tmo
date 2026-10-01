const MAX_MATRIX_RADIOS = 200;
const MAX_MATRIX_GROUPS = 250;
const MAX_TECHNICAL_ROWS = 500;

let databaseStatus = null;
let fleetPayload = null;
let quickPayload = null;
let radioSearchPayload = null;
let agendaIssiFile = null;
let indexPollTimer = null;
let healthPollTimer = null;
let healthLoading = false;
let projectRadioTransientErrors = [];
let runtimeState = null;

const byId = (id) => document.getElementById(id);
const navButtons = [...document.querySelectorAll(".nav-button")];
const sections = {
  fleet: byId("fleetSection"),
  project: byId("projectSection"),
  index: byId("indexSection"),
  quick: byId("quickSection"),
  lookup: byId("lookupSection"),
  agenda: byId("agendaSection"),
  diagnostic: byId("diagnosticSection"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalize(value) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("es-PE");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es-PE");
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function shortRoot(rootPath) {
  const parts = String(rootPath || "").split(/[\\/]+/).filter(Boolean);
  return parts.slice(-1)[0] || "Ruta central";
}

function setMessage(element, text, type = "") {
  element.hidden = !text;
  element.textContent = text || "";
  element.className = `inline-message${type ? ` ${type}` : ""}`;
}

function showSection(name) {
  for (const [key, section] of Object.entries(sections)) {
    section.hidden = key !== name;
    section.classList.toggle("active", key === name);
  }
  for (const button of navButtons) button.classList.toggle("active", button.dataset.section === name);
  if (healthPollTimer) {
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }
  if (name === "diagnostic") {
    loadHealthPanel();
    healthPollTimer = setInterval(() => loadHealthPanel(), 15_000);
  }
  if (name === "diagnostic") loadDiagnostics();
  if (name === "index") loadDatabaseStatus();
  if (name === "project") loadCpeProjects();
}

function renderDatabaseStatus(status) {
  if (!status) return;
  databaseStatus = status;
  const scan = status.latestScan;
  const updated = scan?.finishedAt ? formatDate(scan.finishedAt) : scan ? "Escaneo en curso" : "Sin escaneos";
  byId("fleetBaseUpdated").textContent = updated;
  byId("fleetIndexed").textContent = formatNumber(status.indexedFiles);
  byId("fleetBaseShort").textContent = shortRoot(status.centralRoot || scan?.rootPath);
  byId("fleetBaseShort").title = status.centralRoot || scan?.rootPath || "";

  byId("indexRootPath").textContent = status.centralRoot || scan?.rootPath || "—";
  byId("indexLastScan").textContent = updated;
  byId("indexFiles").textContent = formatNumber(status.indexedFiles);
  byId("indexGroups").textContent = formatNumber(status.storedGroups);

  const serverStatus = byId("serverStatus");
  serverStatus.textContent = scan && !scan.finishedAt ? "Índice actualizándose" : "Servidor activo";
  serverStatus.className = "server-status online";
}

async function loadDatabaseStatus() {
  try {
    const response = await fetch("/api/db-status");
    if (!response.ok) throw new Error("No se pudo consultar la base");
    renderDatabaseStatus(await response.json());
  } catch (error) {
    const serverStatus = byId("serverStatus");
    serverStatus.textContent = "Sin conexión";
    serverStatus.className = "server-status offline";
  }
}

function setHealthStatus(id, text, tone) {
  const element = byId(id);
  element.textContent = text;
  element.className = `status-pill ${tone || ""}`.trim();
}

function renderHealthPanel(payload) {
  const overall = payload.overall || {};
  const service = payload.service || {};
  const nas = payload.nas || {};
  const index = payload.index || {};
  const codeplugs = payload.codeplugs || {};
  const exports = payload.exports || {};
  const scan = index.latestScan || null;

  byId("healthOverall").className = `health-banner ${overall.tone || ""}`.trim();
  byId("healthOverallStatus").textContent = overall.status || "Estado no disponible";
  byId("healthOverallDetail").textContent = overall.detail || "No se recibió el detalle operativo.";
  byId("healthGeneratedAt").textContent = `Actualizado ${formatDate(payload.generatedAt)}`;

  setHealthStatus("healthServiceStatus", service.ok ? "Operativo" : "Sin servicio", service.ok ? "ok" : "error");
  byId("healthServiceDetail").textContent = service.startedAt
    ? `Activo desde ${formatDate(service.startedAt)} · ${formatDuration(Number(service.uptimeSeconds || 0) * 1000)}`
    : "Sin información del inicio del servicio";

  setHealthStatus("healthNasStatus", nas.status || "No disponible", nas.ok ? "ok" : "error");
  byId("healthNasDetail").textContent = nas.ok
    ? `${shortRoot(nas.rootPath)} · respuesta ${formatNumber(nas.responseMs)} ms`
    : (nas.error || "No se pudo consultar la ruta central");

  const indexStatus = index.running ? "Actualizando" : scan?.finishedAt ? "Disponible" : "Sin escaneo";
  setHealthStatus("healthIndexStatus", indexStatus, index.running ? "running" : scan?.finishedAt ? "ok" : "warning");
  byId("healthIndexDetail").textContent = index.running
    ? `Escaneo en curso${index.workerPid ? ` · proceso ${index.workerPid}` : ""}`
    : scan?.finishedAt ? `Último escaneo ${formatDate(scan.finishedAt)}` : "Todavía no existe un escaneo central terminado";

  const exportsRunning = Number(exports.running || 0);
  setHealthStatus("healthExportStatus", exportsRunning ? "Procesando" : "Disponible", exportsRunning ? "running" : "ok");
  byId("healthExportDetail").textContent = exportsRunning
    ? `${formatNumber(exportsRunning)} exportación en proceso`
    : `${formatNumber(exports.completed)} terminadas · ${formatNumber(exports.failed)} con error desde el último inicio`;

  byId("healthIndexed").textContent = formatNumber(codeplugs.indexedFiles);
  byId("healthCorrect").textContent = formatNumber(codeplugs.correctFiles);
  byId("healthCorrupt").textContent = formatNumber(codeplugs.corruptFiles);
  byId("healthUnsupported").textContent = formatNumber(codeplugs.unsupportedFiles);

  const scanStartedMs = scan?.startedAt ? Date.parse(scan.startedAt) : NaN;
  const scanFinishedMs = scan?.finishedAt ? Date.parse(scan.finishedAt) : NaN;
  const scanDuration = Number.isFinite(scanStartedMs)
    ? (Number.isFinite(scanFinishedMs) ? scanFinishedMs : Date.now()) - scanStartedMs
    : null;
  byId("healthScanStarted").textContent = formatDate(scan?.startedAt);
  byId("healthScanFinished").textContent = scan && !scan.finishedAt ? "En curso" : formatDate(scan?.finishedAt);
  byId("healthScanDuration").textContent = scanDuration == null ? "—" : formatDuration(scanDuration);
  byId("healthScanResult").textContent = !scan ? "Sin escaneos"
    : !scan.finishedAt ? "En curso"
      : Number(scan.errorCount || 0) ? "Completado con observaciones" : "Completado";
  byId("healthScanFound").textContent = formatNumber(scan?.foundCount);
  byId("healthScanParsed").textContent = formatNumber(scan?.parsedCount);
  byId("healthScanCached").textContent = formatNumber(scan?.cachedCount);
  byId("healthScanErrors").textContent = formatNumber(scan?.errorCount);

  byId("healthNextScan").textContent = formatDate(index.nextScanAt);
  byId("healthIndexActivity").textContent = index.running ? "Actualizando ahora"
    : index.pending ? "Nueva ejecución pendiente" : "Sin actualización en curso";
  byId("healthExportActivity").textContent = exportsRunning
    ? `${formatNumber(exportsRunning)} en proceso` : "Sin exportaciones en curso";
  const lastExport = exports.last;
  byId("healthLastExport").textContent = lastExport
    ? `${lastExport.status === "completed" ? "Terminada" : "Error"} · ${formatDate(lastExport.completedAt)} · ${formatDuration(lastExport.elapsedMs)}`
    : "Sin exportaciones desde el último inicio";

  if (!nas.ok) {
    setMessage(byId("healthMessage"), `El TIC NAS no está disponible: ${nas.error || "sin respuesta"}.`, "error");
  } else if (Number(codeplugs.corruptFiles) || Number(codeplugs.unsupportedFiles)) {
    setMessage(byId("healthMessage"), `${formatNumber(codeplugs.corruptFiles)} CPE requieren reemplazo y ${formatNumber(codeplugs.unsupportedFiles)} requieren soporte del analizador.`, "warning");
  } else {
    setMessage(byId("healthMessage"), "Todos los componentes operativos están disponibles.", "success");
  }
}

async function loadHealthPanel(force = false) {
  if (healthLoading) return;
  healthLoading = true;
  const button = byId("healthRefreshButton");
  button.disabled = true;
  try {
    const response = await fetch(`/api/health-panel${force ? "?refresh=1" : ""}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo consultar la salud del sistema");
    renderHealthPanel(payload);
  } catch (error) {
    byId("healthOverall").className = "health-banner error";
    byId("healthOverallStatus").textContent = "No se pudo consultar el sistema";
    byId("healthOverallDetail").textContent = error.message;
    setMessage(byId("healthMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    healthLoading = false;
  }
}

function downloadTemplate() {
  const link = document.createElement("a");
  link.href = "/api/template-xlsx";
  link.download = "plantilla_fleet_map.xlsx";
  link.click();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",")[1] : value);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function downloadProjectTemplate() {
  const groups = Number(byId("projectTemplateGroups").value);
  const dmoGroups = Number(byId("projectTemplateDmoGroups").value);
  if (!Number.isInteger(groups) || groups < 1 || groups > 100) {
    setMessage(byId("projectMessage"), "Indica entre 1 y 100 grupos TMO.", "warning");
    byId("projectTemplateGroups").focus();
    return;
  }
  if (!Number.isInteger(dmoGroups) || dmoGroups < 0 || dmoGroups > 50) {
    setMessage(byId("projectMessage"), "Indica entre 0 y 50 grupos DMO.", "warning");
    byId("projectTemplateDmoGroups").focus();
    return;
  }
  const button = byId("projectTemplateButton");
  button.disabled = true;
  button.textContent = "Generando…";
  setMessage(byId("projectMessage"), `Preparando plantilla con ${groups} grupos TMO y ${dmoGroups} DMO…`);
  try {
    const query = new URLSearchParams({ groups: String(groups), dmoGroups: String(dmoGroups) });
    const response = await fetch(`/api/cpe-projects/template?${query}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "No se pudo generar la plantilla");
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `Plantilla_Solicitud_CPE_TMO${groups}_DMO${dmoGroups}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(byId("projectMessage"), "Plantilla generada correctamente.", "success");
  } catch (error) {
    setMessage(byId("projectMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Descargar plantilla cliente";
  }
}

function renderProjectHistory(projects) {
  const body = byId("projectHistoryBody");
  if (!projects.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-cell">Sin solicitudes registradas</td></tr>';
    return;
  }
  body.innerHTML = projects.map((project) => `<tr>
    <td><button type="button" class="project-code-button" data-project-code="${escapeHtml(project.code)}" data-project-responsible="${escapeHtml(project.responsible)}">${escapeHtml(project.code)}</button></td>
    <td>${escapeHtml(formatDate(project.createdAt))}</td>
    <td>${escapeHtml(project.razonSocial || "—")}</td>
    <td>${escapeHtml(project.responsible)}</td>
    <td>${formatNumber(project.radioCount)}</td>
    <td>${formatNumber(project.groupCount)}</td>
    <td><span class="status-pill ${/NO_APROBADO/.test(project.status) ? "error" : /APROBAD[OA]S?|PUBLICADO/.test(project.status) ? "ok" : "warning"}">${escapeHtml(project.status.replaceAll("_", " "))}</span></td>
  </tr>`).join("");
}

async function loadCpeProjects() {
  const button = byId("projectRefreshButton");
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/cpe-projects");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudieron consultar las solicitudes");
    const projects = payload.projects || [];
    renderProjectHistory(projects);
    if (projects.length && !byId("projectModelCodeInput").value.trim()) {
      byId("projectModelCodeInput").value = projects[0].code;
    }
    if (projects.length && !byId("projectRadioCodeInput").value.trim()) {
      byId("projectRadioCodeInput").value = projects[0].code;
    }
    if (projects.length && !byId("projectRadioProgrammerInput").value.trim()) {
      byId("projectRadioProgrammerInput").value = projects[0].responsible || "";
    }
    const activeCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
    if (/^CPE-\d{8}-\d{3}$/.test(activeCode)) {
      loadProjectRadioValidations(false).catch(() => {});
    }
  } catch (error) {
    byId("projectHistoryBody").innerHTML = `<tr><td colspan="7" class="empty-cell error-text">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderRegisteredProject(payload) {
  const project = payload.project;
  byId("projectResult").hidden = false;
  byId("projectResultCode").textContent = project.code;
  byId("projectResultStatus").textContent = project.status;
  byId("projectResultClient").textContent = project.razonSocial || "—";
  byId("projectResultRadios").textContent = formatNumber(project.radioCount);
  byId("projectResultGroups").textContent = formatNumber(project.groupCount);
  byId("projectResultWarnings").textContent = formatNumber(project.warningCount);
  byId("projectModelCodeInput").value = project.code;
  byId("projectRadioCodeInput").value = project.code;
  byId("projectRadioProgrammerInput").value = project.responsible || "";
  const warnings = payload.validation?.warnings || project.warnings || [];
  const warningBox = byId("projectWarnings");
  warningBox.hidden = warnings.length === 0;
  warningBox.innerHTML = warnings.length
    ? `<strong>Observaciones que no impiden el registro:</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : "";
}

function renderProjectModelValidation(payload) {
  const result = payload.result || {};
  const approved = result.status === "APROBADO";
  byId("projectModelResult").hidden = false;
  const verdict = byId("projectModelVerdict");
  verdict.textContent = result.status || "NO APROBADO";
  verdict.className = approved ? "ok" : "error";
  byId("projectModelVersion").textContent = [result.model?.codeplug ? `CP ${result.model.codeplug}` : "CP no identificado", result.model?.software || "SW no identificado"].join(" · ");
  byId("projectModelIssis").textContent = (result.appliesToIssis || []).join(", ") || "Ninguna";
  byId("projectModelChecks").innerHTML = (result.checks || []).map((check) => `<div class="project-model-check ${check.passed ? "" : "failed"}">
    <b>${check.passed ? "✓" : "×"}</b>
    <strong>${escapeHtml(check.label)}</strong>
    <span><small>Esperado</small><br>${escapeHtml(check.expected || "—")}</span>
    <span><small>Encontrado</small><br>${escapeHtml(check.actual || "—")}</span>
    ${check.detail ? `<em>${escapeHtml(check.detail)}</em>` : ""}
  </div>`).join("");
  byId("projectModelNotes").innerHTML = (result.notes || []).length
    ? `<ul>${result.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    : "";
  const finalStatus = byId("projectFinalStepStatus");
  finalStatus.textContent = approved ? "LISTO PARA PROGRAMAR" : "BLOQUEADO";
  finalStatus.className = `status-pill ${approved ? "ok" : "error"}`;
  byId("projectFinalStepText").textContent = approved
    ? "El modelo fue aprobado. Selecciona abajo los CPE leídos después de programar."
    : "Corrige el CPE modelo y vuelve a validarlo antes de programar.";
  if (approved) byId("projectRadioCodeInput").value = byId("projectModelCodeInput").value.trim().toUpperCase();
}

function projectRadioDifferenceText(validation) {
  const failed = (validation.result?.checks || []).filter((check) => !check.passed);
  if (!failed.length) return "Sin diferencias";
  return failed.map((check) => {
    const comparison = check.detail || `Esperado: ${check.expected || "—"}; encontrado: ${check.actual || "—"}`;
    return `${check.label}: ${comparison}`;
  }).join(" | ");
}

function renderProjectRadioValidation(payload, transientErrors = projectRadioTransientErrors) {
  const summary = payload?.summary || payload || {};
  const validations = [...(summary.validations || [])];
  byId("projectRadioResult").hidden = false;
  byId("projectRadioTotal").textContent = formatNumber(summary.total);
  byId("projectRadioApproved").textContent = formatNumber(summary.approved);
  byId("projectRadioRejected").textContent = formatNumber(summary.notApproved + transientErrors.length);
  byId("projectRadioPending").textContent = formatNumber(summary.pending);

  const rows = validations.map((validation) => {
    const actual = validation.result?.actual || {};
    const approved = validation.status === "APROBADO";
    return `<tr>
      <td><strong>${escapeHtml(validation.fileName)}</strong><small>${escapeHtml(formatDate(validation.validatedAt))}<br>${escapeHtml(validation.programmer || "")}</small></td>
      <td>${escapeHtml(validation.expectedIssi || "—")}</td>
      <td>${escapeHtml(actual.issi || validation.actualIssi || "—")}</td>
      <td>${escapeHtml(actual.serial || validation.actualSerial || "—")}<br><small>${escapeHtml(actual.tei || validation.actualTei || "—")}</small></td>
      <td><span class="status-pill ${approved ? "ok" : "error"}">${approved ? "APROBADA" : "NO APROBADA"}</span></td>
      <td class="project-radio-differences">${escapeHtml(projectRadioDifferenceText(validation))}</td>
    </tr>`;
  });
  rows.push(...transientErrors.map((item) => `<tr>
    <td><strong>${escapeHtml(item.fileName)}</strong></td><td>—</td><td>—</td><td>—</td>
    <td><span class="status-pill error">ERROR</span></td><td class="project-radio-differences">${escapeHtml(item.error)}</td>
  </tr>`));
  byId("projectRadioResultsBody").innerHTML = rows.length
    ? rows.join("")
    : '<tr><td colspan="6" class="empty-cell">Todavía no se validaron radios</td></tr>';

  const finalStatus = byId("projectFinalStepStatus");
  finalStatus.textContent = summary.allApproved ? "RADIOS APROBADAS" : (summary.validated || transientErrors.length ? "EN VALIDACIÓN" : "PENDIENTE");
  finalStatus.className = `status-pill ${summary.allApproved ? "ok" : (summary.notApproved || transientErrors.length ? "error" : "warning")}`;
  byId("projectFinalStepText").textContent = summary.allApproved
    ? "Todas las radios coinciden con la solicitud. Ya pueden prepararse para el envío controlado."
    : `${formatNumber(summary.approved)} aprobada(s), ${formatNumber(summary.notApproved || 0)} no aprobada(s) y ${formatNumber(summary.pending)} sin validar. Corrige y vuelve a cargar únicamente las no aprobadas.`;
  loadProjectPublication(false).catch(() => {});
}

function renderProjectRuntime(payload) {
  runtimeState = payload;
  const fieldMode = payload.mode === "field";
  byId("dashboardRuntimeMode").textContent = fieldMode ? "CAMPO · SIN CONEXIÓN" : "CENTRAL · VM";
  byId("projectFieldPrepareButton").hidden = !fieldMode;
  const drive = payload.publication?.googleDrive || {};
  byId("projectDriveStatus").textContent = fieldMode ? "PUBLICA LA VM" : (drive.configured ? "CONFIGURADO" : (drive.disabled ? "DESHABILITADO" : "PENDIENTE DE ACCESO"));
  const nas = payload.publication?.nas || {};
  byId("projectNasPublishStatus").textContent = fieldMode ? "PUBLICA LA VM" : (nas.configured ? "CONFIGURADO" : "PENDIENTE");
  const sync = payload.fieldSync;
  byId("projectFieldQueueStatus").textContent = fieldMode
    ? `${formatNumber(sync?.pending || 0)} pendiente(s)`
    : "NO APLICA EN VM";
  byId("projectRouteSaveButton").hidden = fieldMode;
}

async function loadProjectRuntime() {
  const response = await fetch("/api/runtime");
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "No se pudo consultar el modo del dashboard");
  renderProjectRuntime(payload);
  return payload;
}

function projectRouteFromInputs() {
  return {
    clientPath: byId("projectRouteClientPath").value.trim(),
    formNumber: byId("projectRouteForm").value.trim().replace(/^FORM\s*/i, ""),
    programmingDate: byId("projectRouteDate").value,
    programmerInitials: byId("projectRouteInitials").value.trim().toUpperCase(),
  };
}

function updateProjectRoutePreview() {
  const route = projectRouteFromInputs();
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(route.programmingDate);
  const clientPath = route.clientPath.replace(/[\\/]+/g, "\\").replace(/^\\+|\\+$/g, "");
  if (!clientPath || !route.formNumber || !validDate || !route.programmerInitials) {
    byId("projectRoutePreview").textContent = "Completa la ruta final";
    return "";
  }
  const dateKey = route.programmingDate.replaceAll("-", "");
  const preview = `Plantillas x Clientes ${route.programmingDate.slice(0, 4)}\\${clientPath}\\FORM ${route.formNumber}\\${dateKey}_${route.programmerInitials}\\DESPUES`;
  byId("projectRoutePreview").textContent = preview;
  return preview;
}

function applyProjectRoute(route) {
  if (!route) return updateProjectRoutePreview();
  byId("projectRouteClientPath").value = route.clientPath || "";
  byId("projectRouteForm").value = route.formNumber || "";
  byId("projectRouteDate").value = route.programmingDate || "";
  byId("projectRouteInitials").value = route.programmerInitials || "";
  updateProjectRoutePreview();
}

async function loadProjectPublication(showMessages = false) {
  const runtime = await loadProjectRuntime();
  const projectCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
  if (runtime.mode === "field") {
    const sync = runtime.fieldSync || {};
    const pending = Number(sync.pending || 0);
    byId("projectPublicationStatus").textContent = pending ? "PENDIENTE DE SINCRONIZAR" : "SINCRONIZADO";
    byId("projectPublicationStatus").className = `status-pill ${pending ? "warning" : "ok"}`;
    byId("projectPublicationText").textContent = sync.last?.error
      ? `Sin conexión con la VM: ${sync.last.error}. Se reintentará automáticamente.`
      : "Las radios aprobadas se envían automáticamente a la VM cuando vuelve la conexión/VPN.";
    byId("projectPublicationRetryButton").hidden = true;
    if (showMessages) setMessage(byId("projectPublicationMessage"), pending ? "La cola local está protegida y se reintentará automáticamente." : "No hay archivos pendientes de sincronizar.", pending ? "warning" : "success");
    return runtime;
  }
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) return runtime;
  const response = await fetch(`/api/cpe-projects/publication?projectCode=${encodeURIComponent(projectCode)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "No se pudo consultar la publicación");
  const publication = payload.publication;
  const route = payload.project?.publicationRoute || null;
  applyProjectRoute(route);
  const status = publication?.status || "PENDIENTE";
  const published = status === "PUBLICADO";
  const waitingAccess = status === "ESPERANDO_ACCESO" || /cuenta de servicio|acceso/i.test(publication?.errorMessage || "");
  byId("projectPublicationStatus").textContent = waitingAccess ? "PENDIENTE DE ACCESO" : status;
  byId("projectPublicationStatus").className = `status-pill ${published ? "ok" : status === "ERROR" && !waitingAccess ? "error" : "warning"}`;
  byId("projectPublicationRetryButton").hidden = !publication || published;
  const details = publication?.details || {};
  const driveStatus = details.drive?.status || (route ? "PENDIENTE" : "RUTA PENDIENTE");
  const nasStatus = details.nas?.status || (route ? "PENDIENTE" : "RUTA PENDIENTE");
  byId("projectDriveStatus").textContent = driveStatus;
  byId("projectNasPublishStatus").textContent = nasStatus;
  byId("projectDrivePath").textContent = details.drive?.path || (route ? `${payload.destinations?.googleDrive?.desktopRoot || "Drive"}\\${route.relativePath || ""}` : "Ruta pendiente");
  byId("projectNasPublishPath").textContent = details.nas?.path || (route ? `${payload.destinations?.nas?.root || "TIC NAS"}\\${route.relativePath || ""}` : "Ruta pendiente");
  if (published) {
    byId("projectPublicationText").textContent = `Entrega ${details.deliveryId || ""} publicada y verificada en Drive y TIC NAS.`;
  } else if (publication?.errorMessage) {
    byId("projectPublicationText").textContent = `${publication.errorMessage}. El dashboard seguirá reintentando automáticamente.`;
  } else {
    byId("projectPublicationText").textContent = "Se pondrá en cola automáticamente cuando todas las radios estén aprobadas.";
  }
  if (showMessages) setMessage(byId("projectPublicationMessage"), published ? "La entrega está publicada y registrada." : "Estado de publicación actualizado.", published ? "success" : "warning");
  return payload;
}

async function saveProjectPublicationRoute() {
  const projectCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) {
    setMessage(byId("projectPublicationMessage"), "Escribe primero el código completo de programación CPE en el paso 4.", "warning");
    return;
  }
  const button = byId("projectRouteSaveButton");
  button.disabled = true;
  button.textContent = "Guardando…";
  try {
    const response = await fetch("/api/cpe-projects/publication-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectCode, route: projectRouteFromInputs() }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo guardar la ruta de publicación");
    applyProjectRoute(payload.route);
    setMessage(
      byId("projectPublicationMessage"),
      payload.queued
        ? "Ruta registrada. La publicación en Drive y TIC NAS quedó en cola."
        : "Ruta registrada. La publicación comenzará cuando todas las radios estén aprobadas.",
      "success",
    );
    setTimeout(() => loadProjectPublication(false).catch(() => {}), 1000);
  } catch (error) {
    setMessage(byId("projectPublicationMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Guardar ruta y publicar";
  }
}

async function prepareProjectForField() {
  const projectCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) {
    setMessage(byId("projectRadioMessage"), "Escribe el código de programación CPE que llevarás a campo.", "warning");
    return;
  }
  const button = byId("projectFieldPrepareButton");
  button.disabled = true;
  button.textContent = "Guardando…";
  try {
    const response = await fetch("/api/field/prepare-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectCode }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo guardar el proyecto para campo");
    byId("projectRadioProgrammerInput").value ||= payload.project?.responsible || "";
    setMessage(byId("projectRadioMessage"), "Programación guardada. Ya puedes desconectarte y validar sin Internet.", "success");
    await loadCpeProjects();
  } catch (error) {
    setMessage(byId("projectRadioMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Preparar programación para campo";
  }
}

async function retryProjectPublication() {
  const projectCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
  const button = byId("projectPublicationRetryButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/cpe-projects/publication/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectCode }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo reintentar la publicación");
    setMessage(byId("projectPublicationMessage"), "Publicación puesta nuevamente en cola.", "success");
    setTimeout(() => loadProjectPublication(false).catch(() => {}), 1500);
  } catch (error) {
    setMessage(byId("projectPublicationMessage"), error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadProjectRadioValidations(showMessages = true) {
  const projectCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) {
    if (showMessages) setMessage(byId("projectRadioMessage"), "Escribe el código completo de programación CPE.", "warning");
    return null;
  }
  const response = await fetch(`/api/cpe-projects/radio-validations?projectCode=${encodeURIComponent(projectCode)}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "No se pudo consultar el avance");
  renderProjectRadioValidation(payload);
  if (showMessages) setMessage(byId("projectRadioMessage"), "Avance actualizado.", "success");
  return payload;
}

async function validateProjectRadios() {
  const projectCode = byId("projectRadioCodeInput").value.trim().toUpperCase();
  const programmer = byId("projectRadioProgrammerInput").value.trim();
  const selectedFiles = [...byId("projectRadioFilesInput").files];
  const files = selectedFiles.filter((file) => /\.cpe$/i.test(file.name));
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) {
    setMessage(byId("projectRadioMessage"), "Escribe el código completo de programación CPE.", "warning");
    byId("projectRadioCodeInput").focus();
    return;
  }
  if (!programmer) {
    setMessage(byId("projectRadioMessage"), "Escribe el nombre del programador que realizó el trabajo.", "warning");
    byId("projectRadioProgrammerInput").focus();
    return;
  }
  if (!files.length) {
    setMessage(byId("projectRadioMessage"), "Selecciona la carpeta que contiene los CPE leídos después de programar.", "warning");
    byId("projectRadioFilesInput").click();
    return;
  }
  if (files.length > 300) {
    setMessage(byId("projectRadioMessage"), "Puedes validar hasta 300 radios por lote.", "warning");
    return;
  }

  const button = byId("projectRadioValidateButton");
  button.disabled = true;
  projectRadioTransientErrors = [];
  let approved = 0;
  let rejected = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      button.textContent = `Validando ${index + 1}/${files.length}`;
      setMessage(byId("projectRadioMessage"), `Leyendo ${file.name} (${index + 1} de ${files.length})…`);
      try {
        if (file.size > 15 * 1024 * 1024) throw new Error("El CPE supera el límite de 15 MB");
        const response = await fetch("/api/cpe-projects/radio-validation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectCode,
            programmer,
            source: runtimeState?.mode === "field" ? "DASHBOARD_CAMPO" : "DASHBOARD",
            fileName: file.name,
            fileBase64: await fileToBase64(file),
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "No se pudo validar el CPE");
        if (payload.validation?.status === "APROBADO") approved += 1;
        else rejected += 1;
        renderProjectRadioValidation(payload);
      } catch (error) {
        rejected += 1;
        projectRadioTransientErrors.push({ fileName: file.name, error: error.message });
      }
    }
    const current = await loadProjectRadioValidations(false);
    if (current) renderProjectRadioValidation(current, projectRadioTransientErrors);
    const type = rejected ? "warning" : "success";
    setMessage(byId("projectRadioMessage"), `Lote terminado: ${approved} aprobada(s) y ${rejected} no aprobada(s).`, type);
    await loadCpeProjects();
  } catch (error) {
    setMessage(byId("projectRadioMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Validar radios";
  }
}

async function validateProjectModel() {
  const projectCode = byId("projectModelCodeInput").value.trim().toUpperCase();
  const file = byId("projectModelFileInput").files[0];
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) {
    setMessage(byId("projectModelMessage"), "Escribe el código completo de programación CPE.", "warning");
    byId("projectModelCodeInput").focus();
    return;
  }
  if (!file) {
    setMessage(byId("projectModelMessage"), "Selecciona el archivo CPE modelo.", "warning");
    byId("projectModelFileInput").click();
    return;
  }
  const button = byId("projectModelValidateButton");
  button.disabled = true;
  button.textContent = "Validando…";
  setMessage(byId("projectModelMessage"), "Comparando grupos, emergencia y funciones con la solicitud…");
  try {
    const response = await fetch("/api/cpe-projects/model-validation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectCode, fileName: file.name, fileBase64: await fileToBase64(file) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo validar el CPE modelo");
    renderProjectModelValidation(payload);
    setMessage(
      byId("projectModelMessage"),
      payload.result.status === "APROBADO" ? "CPE modelo aprobado." : `CPE modelo no aprobado: ${payload.result.failedCount} diferencia(s).`,
      payload.result.status === "APROBADO" ? "success" : "error",
    );
    await loadCpeProjects();
  } catch (error) {
    setMessage(byId("projectModelMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Validar CPE modelo";
  }
}

async function registerCpeProject() {
  const file = byId("projectFileInput").files[0];
  const responsible = byId("projectResponsibleInput").value.trim();
  if (!responsible) {
    setMessage(byId("projectMessage"), "Escribe el nombre del programador responsable.", "warning");
    byId("projectResponsibleInput").focus();
    return;
  }
  if (!file) {
    setMessage(byId("projectMessage"), "Selecciona el Excel recibido y completado con ISSI, serie y TEI.", "warning");
    byId("projectFileInput").click();
    return;
  }
  const button = byId("projectRegisterButton");
  button.disabled = true;
  button.textContent = "Validando…";
  setMessage(byId("projectMessage"), "Validando identidades, grupos, funciones, gateway GPS, Escaneo y DMO…");
  try {
    const response = await fetch("/api/cpe-projects/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responsible, fileName: file.name, fileBase64: await fileToBase64(file) }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const errors = payload.validation?.errors || [];
      throw new Error(errors.length ? `No se registró: ${errors.slice(0, 5).join(" | ")}${errors.length > 5 ? ` | y ${errors.length - 5} error(es) más` : ""}` : payload.error || "No se pudo registrar la solicitud");
    }
    renderRegisteredProject(payload);
    setMessage(
      byId("projectMessage"),
      payload.duplicate ? `El archivo ya estaba registrado como ${payload.project.code}.` : `Solicitud registrada correctamente con código ${payload.project.code}.`,
      payload.duplicate ? "warning" : "success",
    );
    await loadCpeProjects();
  } catch (error) {
    setMessage(byId("projectMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Validar y registrar";
  }
}

function renderFleetSummary(payload) {
  const matrix = payload.matrix || { radios: [], groups: [] };
  const found = matrix.radios.filter((radio) => radio.hasCodeplug).length;
  byId("resultRadios").textContent = formatNumber(found);
  byId("resultGroups").textContent = formatNumber(matrix.groups.length);
  byId("resultMissing").textContent = formatNumber((payload.missing || []).length);
  byId("resultErrors").textContent = formatNumber((payload.errors || []).length);
  byId("resultGenerated").textContent = formatDate(matrix.generatedAt);
}

const identityColumns = [
  ["Razón social", "razonSocial", 180],
  ["Unidad", "unidad", 140],
  ["Serial", "serial", 130],
  ["TEI", "tei", 170],
  ["ISSI", "issi", 90],
  ["CP", "codeplug", 70],
  ["SW", "software", 130],
  ["Emergencia", "emergencyMode", 110],
  ["Destino emergencia", "emergencyGroup", 180],
  ["Fecha programación", "programDate", 120],
  ["Escaneo", "scanSummary", 150, "feature"],
  ["DMO", "dmoSummary", 150, "feature"],
  ["Broadcast", "broadcastSummary", 150, "feature"],
  ["GPS", "gpsSummary", 170, "feature"],
  ["OTAP", "otapSummary", 150, "feature"],
];

function matrixFilterData(payload, searchId, statusFilterId, featureFilterId) {
  const matrix = payload?.matrix || { radios: [], groups: [] };
  const query = normalize(byId(searchId).value.trim());
  const state = byId(statusFilterId).value;
  const featureFilter = featureFilterId && byId(featureFilterId) ? byId(featureFilterId).value : "all";
  const matchingGroups = query
    ? matrix.groups.filter((group) => normalize(`${group.gssi} ${group.alias}`).includes(query))
    : [];
  const matchingGroupKeys = new Set(matchingGroups.map((group) => String(group.gssi)));
  const radios = matrix.radios.filter((radio) => {
    if (state === "with-codeplug" && !radio.hasCodeplug) return false;
    if (state === "without-codeplug" && radio.hasCodeplug) return false;
    if (state === "with-errors" && !radio.hasError) return false;
    const features = radio.features || {};
    if (featureFilter === "scan-active" && features.scan?.state !== "Activo") return false;
    if (featureFilter === "scan-inactive" && features.scan?.state !== "Inactivo") return false;
    if (featureFilter === "dmo-active" && features.dmo?.state !== "Activo") return false;
    if (featureFilter === "broadcast-listen" && features.broadcast?.state !== "Solo escucha") return false;
    if (featureFilter === "gps-missing" && Number(features.gps?.destinationIssi || 0) > 0) return false;
    if (featureFilter === "otap-disabled" && features.otap?.state !== "Inactivo") return false;
    if (featureFilter === "unavailable" && ![features.scan, features.dmo, features.broadcast, features.gps, features.otap].some((item) => item?.state === "No disponible" || /no verificado/i.test(item?.state || ""))) return false;
    if (!query) return true;
    const radioText = normalize([
      radio.razonSocial, radio.unidad, radio.serial, radio.tei, radio.issi,
      radio.codeplug, radio.software, radio.fileName, radio.observacion,
      radio.emergencyMode, radio.emergencyGroup, radio.emergencyAlias, radio.emergencyGssi,
      radio.scanSummary, radio.dmoSummary, radio.broadcastSummary, radio.gpsSummary, radio.otapSummary,
      JSON.stringify(radio.features || {}),
    ].join(" "));
    return radioText.includes(query) || radio.groupGssis.some((gssi) => matchingGroupKeys.has(String(gssi)));
  });
  const groups = query && matchingGroups.length ? matchingGroups : matrix.groups;
  return { radios, groups };
}

function renderMatrixView(payload, containerId, noteId, searchId, statusFilterId, featureFilterId) {
  if (!payload?.matrix) return;
  const container = byId(containerId);
  const filtered = matrixFilterData(payload, searchId, statusFilterId, featureFilterId);
  const radios = filtered.radios.slice(0, MAX_MATRIX_RADIOS);
  const groups = filtered.groups.slice(0, MAX_MATRIX_GROUPS);
  const truncatedRadios = filtered.radios.length - radios.length;
  const truncatedGroups = filtered.groups.length - groups.length;
  byId(noteId).textContent = [
    `${formatNumber(filtered.radios.length)} radios`,
    `${formatNumber(filtered.groups.length)} grupos`,
    truncatedRadios > 0 ? `vista limitada a ${MAX_MATRIX_RADIOS} radios` : "",
    truncatedGroups > 0 ? `vista limitada a ${MAX_MATRIX_GROUPS} grupos` : "",
  ].filter(Boolean).join(" · ");

  if (!radios.length) {
    container.innerHTML = '<div class="empty-state">No hay radios que coincidan con el filtro.</div>';
    return;
  }

  const groupHeadersTop = groups.map((group) => `<th class="group-cell" title="${escapeHtml(group.alias)}">${escapeHtml(group.gssi)}</th>`).join("");
  const groupHeadersBottom = groups.map((group) => `<th class="group-cell" title="${escapeHtml(group.alias)}">${escapeHtml(group.alias)}</th>`).join("");
  let left = 0;
  const identityHeaders = identityColumns.map(([label, , width, kind]) => {
    const className = kind === "feature" ? "feature-column" : "identity";
    const html = `<th class="${className}" rowspan="2" style="--sticky-left:${left}px;--column-width:${width}px">${escapeHtml(label)}</th>`;
    if (kind !== "feature") left += width;
    return html;
  }).join("");

  const body = radios.map((radio) => {
    let cellLeft = 0;
    const fixed = identityColumns.map(([, key, width, kind]) => {
      const value = radio[key] || "";
      const featureClass = kind === "feature" ? `feature-column feature-cell ${/Activo|Configurado|Solo escucha|^ESCUCHA/.test(value) ? "is-configured" : /Inactivo|Sin configurar|Sin destino/.test(value) ? "is-inactive" : "is-unknown"}` : "identity";
      const html = `<td class="${featureClass}" style="--sticky-left:${cellLeft}px;--column-width:${width}px" title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
      if (kind !== "feature") cellLeft += width;
      return html;
    }).join("");
    const memberships = new Set(radio.groupGssis.map(String));
    const groupCells = groups.map((group) => memberships.has(String(group.gssi))
      ? '<td class="group-cell matrix-x">X</td>'
      : '<td class="group-cell"></td>').join("");
    const classes = [!radio.hasCodeplug ? "no-codeplug" : "", radio.hasError ? "has-error" : ""].filter(Boolean).join(" ");
    return `<tr class="${classes}">${fixed}${groupCells}</tr>`;
  }).join("");

  container.innerHTML = `<table class="matrix-table"><thead><tr>${identityHeaders}${groupHeadersTop}</tr><tr>${groupHeadersBottom}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderMatrix() {
  renderMatrixView(fleetPayload, "matrixContainer", "matrixRenderNote", "matrixSearch", "matrixStatusFilter", "matrixFeatureFilter");
}

function renderQuickMatrix() {
  renderMatrixView(quickPayload, "quickMatrixContainer", "quickMatrixRenderNote", "quickMatrixSearch", "quickMatrixStatusFilter", "quickMatrixFeatureFilter");
}

function renderMissing(missing) {
  const section = byId("missingSection");
  section.hidden = missing.length === 0;
  byId("missingCountBadge").textContent = formatNumber(missing.length);
  byId("missingBody").innerHTML = missing.slice(0, 500).map((item) => `<tr>
    <td>${escapeHtml(item.issi)}</td><td>${escapeHtml(item.razonSocial || item.cliente)}</td>
    <td>${escapeHtml(item.unidad || item.label)}</td><td>${escapeHtml(item.observacion)}</td>
  </tr>`).join("");
}

function renderTechnicalRows(rows, totalRows = rows.length) {
  byId("technicalCount").textContent = `${formatNumber(totalRows)} filas · mostrando hasta ${MAX_TECHNICAL_ROWS}`;
  byId("technicalBody").innerHTML = rows.slice(0, MAX_TECHNICAL_ROWS).map((row) => `<tr>
    <td title="${escapeHtml(row.file)}">${escapeHtml(row.fileName)}</td><td>${escapeHtml(row.razonSocial)}</td>
    <td>${escapeHtml(row.unidad || row.label)}</td><td>${escapeHtml(row.serial)}</td><td>${escapeHtml(row.issi)}</td>
    <td>${escapeHtml(row.alias)}</td><td>${escapeHtml(row.gssi)}</td><td>${escapeHtml(row.codeplug)}</td><td>${escapeHtml(row.software)}</td>
  </tr>`).join("");
}

function renderFleet(payload) {
  fleetPayload = payload;
  byId("fleetResults").hidden = false;
  renderFleetSummary(payload);
  renderMatrix();
  renderMissing(payload.missing || []);
  renderTechnicalRows(payload.rows || [], payload.totalRows);
  renderDatabaseStatus(payload.database);
  byId("fleetResults").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function generateFleetMap() {
  const input = byId("masterFileInput");
  const file = input.files[0];
  if (!file) {
    input.click();
    setMessage(byId("fleetMessage"), "Selecciona primero el Excel maestro de ISSI.", "warning");
    return;
  }
  const button = byId("fleetButton");
  button.disabled = true;
  button.textContent = "Generando…";
  setMessage(byId("fleetMessage"), "Consultando SQLite y preparando la matriz. La ruta central no se vuelve a escanear.");
  try {
    const response = await fetch("/api/fleet-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ masterFileName: file.name, masterFileBase64: await fileToBase64(file) }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo generar el Fleet Map");
    setMessage(byId("fleetMessage"), "Fleet Map generado correctamente.", "success");
    renderFleet(payload);
  } catch (error) {
    setMessage(byId("fleetMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Generar Fleet Map";
  }
}

async function downloadExcel() {
  if (!fleetPayload) return;
  const file = byId("masterFileInput").files[0];
  const button = byId("downloadExcelButton");
  button.disabled = true;
  button.textContent = "Preparando…";
  try {
    if (!file) throw new Error("Vuelve a seleccionar el Excel maestro antes de descargar.");
    const response = await fetch("/api/export-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        masterFileName: file.name,
        masterFileBase64: await fileToBase64(file),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "No se pudo descargar el Excel");
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = "fleet_map.xlsx";
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    setMessage(byId("fleetMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Descargar Excel";
  }
}

async function exportQuickExcel() {
  if (!quickPayload) return;
  const button = byId("quickExcelButton");
  button.disabled = true;
  button.textContent = "Preparando…";
  try {
    const response = await fetch("/api/export-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quickPayload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "No se pudo descargar el Excel");
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = "fleet_map_ruta.xlsx";
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    setMessage(byId("quickMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Descargar Excel";
  }
}

function renderQuick(payload) {
  quickPayload = payload;
  const rows = payload.rows || [];
  byId("quickFiles").textContent = formatNumber(payload.fileCount || payload.files?.length);
  byId("quickGroups").textContent = formatNumber(payload.matrix?.groups?.length || 0);
  byId("quickAnalyzed").textContent = formatNumber(payload.cache?.analyzed);
  byId("quickCached").textContent = formatNumber(payload.cache?.reused);
  byId("quickExcelButton").disabled = (payload.files || []).length === 0;
  byId("quickMatrixSection").hidden = false;
  renderQuickMatrix();
  byId("quickBody").innerHTML = rows.length ? rows.slice(0, 1000).map((row) => `<tr>
    <td title="${escapeHtml(row.file)}">${escapeHtml(row.fileName)}</td><td>${escapeHtml(row.serial)}</td>
    <td>${escapeHtml(row.tei)}</td><td>${escapeHtml(row.issi)}</td><td>${escapeHtml(row.alias)}</td>
    <td>${escapeHtml(row.gssi)}</td><td>${escapeHtml(row.statusText)}</td><td>${escapeHtml(row.codeplug)}</td><td>${escapeHtml(row.software)}</td>
  </tr>`).join("") : '<tr><td colspan="9" class="empty-cell">No se encontraron grupos programados.</td></tr>';
  renderDatabaseStatus(payload.database);
}

function featureTone(state) {
  if (state === "Activo" || state === "Habla y escucha" || /Configurado/.test(state || "")) return "ok";
  if (state === "Solo escucha") return "listen";
  if (state === "Inactivo" || state === "Sin configurar" || state === "Sin destino") return "off";
  return "unknown";
}

function indicatorState(feature) {
  return feature?.state === "Activo" || feature?.state === "Inactivo"
    ? feature.state
    : "No disponible";
}

function renderFeatureDetails(featuresValue) {
  const features = featuresValue || {};
  const scan = features.scan || { state: "No disponible", lists: [] };
  const dmo = features.dmo || { state: "No disponible", groups: [] };
  const broadcast = features.broadcast || { state: "No disponible" };
  const gps = features.gps || { state: "No disponible" };
  const otap = features.otap || { state: "No disponible", targets: [] };
  const scanState = indicatorState(scan);
  const dmoState = indicatorState(dmo);
  const gpsState = indicatorState(gps);
  const scanGroups = scanState === "Activo"
    ? (scan.lists || []).flatMap((list) => (list.groups || []).map((group) => ({ ...group, list: list.name || "" })))
    : [];
  const scanMarkup = scanState === "Activo" && scanGroups.length
    ? scanGroups.map((group) => `<span class="function-item"><b>${escapeHtml(group.gssi)}</b> ${escapeHtml(group.alias || "Sin alias")}<small>${escapeHtml([group.list, group.priority].filter(Boolean).join(" · "))}</small></span>`).join("")
    : scanState === "Activo"
      ? '<span class="function-empty">Escaneo activo sin grupos identificados.</span>'
      : '<span class="function-empty">Escaneo inactivo; no se muestran grupos.</span>';
  const dmoMarkup = dmoState === "Activo" && (dmo.groups || []).length
    ? dmo.groups.map((group) => `<span class="function-item"><b>${escapeHtml(group.gssi)}</b> ${escapeHtml(group.alias || "Sin alias")}<small>${escapeHtml([group.folder, group.frequency ? `${group.frequency} MHz` : ""].filter(Boolean).join(" · "))}</small></span>`).join("")
    : dmoState === "Activo"
      ? '<span class="function-empty">DMO activo sin grupos identificados.</span>'
      : dmoState === "Inactivo"
        ? '<span class="function-empty">Modo directo inactivo; no se muestran grupos DMO.</span>'
        : '<span class="function-empty">Estado DMO no disponible; no se muestran grupos.</span>';
  const otapMarkup = otap.state === "Activo" && (otap.targets || []).length
    ? otap.targets.map((target) => `<span class="function-item"><b>ISSI ${escapeHtml(target.issi)}</b><small>MCC ${escapeHtml(target.mcc)} · MNC ${escapeHtml(target.mnc)}</small></span>`).join("")
    : otap.state === "Activo"
      ? '<span class="function-empty">OTAP activo sin ITSIs autorizadas.</span>'
      : "";
  const broadcastResult = broadcast.state === "Solo escucha" ? "Escucha"
    : broadcast.state === "Revisar" ? "Revisar"
      : broadcast.state === "Inactivo" || broadcast.indicatorActive === false ? "Inactivo"
        : broadcast.state === "No disponible" || !broadcast.state ? "Pendiente de validación" : broadcast.state;
  const showBroadcastConfiguration = broadcastResult === "Escucha" || broadcastResult === "Revisar";
  const broadcastMarkup = showBroadcastConfiguration
    ? `<p>Grupo escucha: <strong>${escapeHtml(broadcast.alias || "—")}</strong></p><p>GSSI: <strong>${escapeHtml(broadcast.gssi || "—")}</strong></p><p>Prioridad anuncio: <strong>${escapeHtml(broadcast.announcementPriority ?? "No verificado")}</strong></p>`
    : '<p>Broadcast inactivo; no se muestra la configuración guardada.</p>';
  return `<div class="function-grid">
    <details class="function-card"><summary><span>Escaneo</span><b class="function-state ${featureTone(scanState)}">${escapeHtml(scanState)}</b></summary><div class="function-content">${scanState === "Activo" && scan.activeList ? `<p>Lista activa: <strong>${escapeHtml(scan.activeList)}</strong></p>` : ""}<div class="function-items">${scanMarkup}</div></div></details>
    <details class="function-card"><summary><span>DMO</span><b class="function-state ${featureTone(dmoState)}">${escapeHtml(dmoState)}</b></summary><div class="function-content"><div class="function-items">${dmoMarkup}</div></div></details>
    <details class="function-card"><summary><span>Broadcast</span><b class="function-state ${featureTone(broadcast.state)}">${escapeHtml(broadcastResult)}</b></summary><div class="function-content">${broadcastMarkup}</div></details>
    <details class="function-card"><summary><span>GPS</span><b class="function-state ${featureTone(gpsState)}">${escapeHtml(gpsState)}</b></summary><div class="function-content">${gpsState === "Activo" ? `<p>Gateway ISSI: <strong>${escapeHtml(gps.destinationIssi || "—")}</strong></p><p>${escapeHtml([gps.carrier, gps.protocol].filter(Boolean).join(" · ") || "Sin detalle adicional")}</p>` : gpsState === "Inactivo" ? '<p>GPS inactivo; no se muestra el gateway ISSI.</p>' : '<p>Estado GPS no disponible; no se muestra el gateway ISSI.</p>'}</div></details>
    <details class="function-card"><summary><span>OTAP</span><b class="function-state ${featureTone(otap.state)}">${escapeHtml(otap.state)}</b></summary><div class="function-content"><div class="function-items">${otapMarkup}</div></div></details>
  </div>`;
}

function renderContactItems(contacts) {
  return (contacts || []).length
    ? `<div class="contact-list">${contacts.map((contact) => `<span class="contact-chip"><b>${escapeHtml(contact.name)}</b><small>ISSI ${escapeHtml(contact.issi)}</small></span>`).join("")}</div>`
    : '<span class="function-empty">La agenda está vacía.</span>';
}

function renderDetailedContacts(contacts, emptyText = "La agenda está vacía.") {
  const items = contacts || [];
  if (!items.length) return `<div class="agenda-detail-empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="agenda-contact-detail" role="list">
    <div class="agenda-contact-heading" aria-hidden="true"><span>Nombre</span><span>ISSI</span></div>
    ${items.map((contact) => `<div class="agenda-contact-row" role="listitem"><strong>${escapeHtml(contact.name)}</strong><span>${escapeHtml(contact.issi)}</span></div>`).join("")}
  </div>`;
}

function renderAgendaDetails(agendaValue) {
  const agenda = agendaValue || { supported: false, state: "No disponible", contacts: [] };
  const state = agenda.supported ? agenda.state : "No disponible";
  const tone = agenda.supported ? (agenda.count ? "ok" : "off") : "unknown";
  const content = agenda.supported
    ? renderContactItems(agenda.contacts)
    : '<span class="function-empty">Esta familia o versión todavía no permite verificar la agenda.</span>';
  return `<details class="function-card agenda-radio-card"><summary><span>Agenda de contactos</span><b class="function-state ${tone}">${escapeHtml(state)} · ${formatNumber(agenda.count || 0)}</b></summary><div class="function-content">${content}</div></details>`;
}

function renderRadioSearch(payload) {
  radioSearchPayload = payload;
  if (payload.database) renderDatabaseStatus(payload.database);
  const results = payload.results || [];
  const groups = new Map();
  let errorCount = 0;
  for (const radio of results) {
    if (radio.errorMessage) errorCount += 1;
    for (const group of radio.groups || []) {
      const key = `${group.gssi}|${group.alias}`;
      if (!groups.has(key)) groups.set(key, group);
    }
  }

  byId("radioSearchCount").textContent = formatNumber(results.length);
  byId("radioSearchGroups").textContent = formatNumber(groups.size);
  byId("radioSearchErrors").textContent = formatNumber(errorCount);
  byId("radioSearchTerm").textContent = payload.term || "—";

  if (!results.length) {
    byId("radioSearchResults").innerHTML = '<div class="empty-state">No se encontraron radios para ese dato.</div>';
    return;
  }

  byId("radioSearchResults").innerHTML = results.map((radio) => {
    const badges = [
      radio.serial ? `<span class="lookup-badge">SERIE ${escapeHtml(radio.serial)}</span>` : "",
      radio.tei ? `<span class="lookup-badge">TEI ${escapeHtml(radio.tei)}</span>` : "",
      radio.issi ? `<span class="lookup-badge">ISSI ${escapeHtml(radio.issi)}</span>` : "",
      radio.codeplug ? `<span class="lookup-badge subtle">CP ${escapeHtml(radio.codeplug)}</span>` : '<span class="lookup-badge subtle">Sin codeplug</span>',
    ].filter(Boolean).join("");
    const groupsMarkup = (radio.groups || []).length
      ? (radio.groups || []).map((group) => {
        const confidenceClass = group.assignmentConfidence ? ` confidence-${group.assignmentConfidence}` : "";
        const invisible = group.statusText === "Invisible";
        return `<span class="group-chip${confidenceClass}${invisible ? " is-invisible" : ""}" title="${escapeHtml(group.statusText || "")}">${escapeHtml(group.gssi)}<small>${escapeHtml(group.alias)}</small>${invisible ? '<small class="group-state">Invisible</small>' : ""}</span>`;
      }).join("")
      : '<span class="lookup-empty-groups">La radio no tiene grupos programados en el índice.</span>';
    const matchTypes = (radio.matchTypes || []).length ? `Coincidencia por ${radio.matchTypes.join(", ").toUpperCase()}` : "Coincidencia";
    const errorBlock = radio.errorMessage
      ? `<div class="lookup-error">Error: ${escapeHtml(radio.errorMessage)}</div>`
      : "";
    return `<article class="lookup-card">
      <div class="lookup-card-header">
        <div>
          <h3>${escapeHtml(radio.fileName || radio.file || "Radio encontrada")}</h3>
          <p>${escapeHtml(radio.sourceFolder || radio.file || "")}</p>
        </div>
        <div class="lookup-meta">${escapeHtml(matchTypes)}</div>
      </div>
      <div class="lookup-badges">${badges}</div>
      <div class="lookup-grid">
        <div><span>Fecha</span><strong>${escapeHtml(radio.date || "—")}</strong></div>
        <div><span>SW</span><strong>${escapeHtml(radio.software || "—")}</strong></div>
        <div><span>CP</span><strong>${escapeHtml(radio.codeplug || "—")}</strong></div>
        <div><span>Grupos</span><strong>${formatNumber((radio.groups || []).length)}</strong></div>
        <div><span>Modo emergencia</span><strong>${escapeHtml(radio.emergencyMode || "No disponible")}</strong></div>
        <div><span>Destino emergencia</span><strong>${escapeHtml(radio.emergencyGroup || "—")}</strong></div>
      </div>
      ${errorBlock}
      ${renderFeatureDetails(radio.features)}
      ${renderAgendaDetails(radio.agenda)}
      <div class="lookup-groups">${groupsMarkup}</div>
    </article>`;
  }).join("");
}

function renderAgendaComparison(payload) {
  const results = payload.results || [];
  const summary = payload.summary || {};
  const individual = payload.mode === "individual";
  byId("agendaSummary").hidden = false;
  byId("agendaCount").textContent = formatNumber(payload.count);
  byId("agendaApprovedLabel").textContent = individual ? "Leídas" : "Aprobadas";
  byId("agendaApproved").textContent = formatNumber(individual ? summary.LEÍDO : summary.APROBADO);
  byId("agendaRejected").textContent = formatNumber(summary["NO APROBADO"]);
  byId("agendaUnavailable").textContent = formatNumber((summary["NO VERIFICABLE"] || 0) + (summary["NO ENCONTRADO"] || 0));
  const projectLabel = payload.project
    ? `${escapeHtml(payload.project.code)} · ${escapeHtml(payload.project.razonSocial || "Sin razón social")}`
    : escapeHtml(payload.referenceSource || "Agenda más frecuente");
  byId("agendaReference").hidden = individual;
  byId("agendaReference").innerHTML = individual ? "" : `<div class="agenda-reference-heading"><div><b>Agenda de referencia</b><small>${projectLabel}</small></div><strong>${formatNumber((payload.expectedContacts || []).length)} contactos</strong></div>${renderDetailedContacts(payload.expectedContacts || [])}`;
  byId("agendaResults").innerHTML = results.map((result) => {
    const tone = ["APROBADO", "LEÍDO"].includes(result.status) ? "ok" : result.status === "NO APROBADO" ? "error" : "unknown";
    const missing = result.differences?.missing || [];
    const extra = result.differences?.extra || [];
    const differences = missing.length || extra.length
      ? `<div class="agenda-differences">${missing.length ? `<div><b>Faltan (${missing.length})</b>${renderDetailedContacts(missing)}</div>` : ""}${extra.length ? `<div><b>Sobran o difieren (${extra.length})</b>${renderDetailedContacts(extra)}</div>` : ""}</div>`
      : result.agenda?.supported ? '<p class="agenda-ok">Coincide exactamente con la agenda de referencia.</p>' : `<p class="function-empty">${result.status === "NO ENCONTRADO" ? "No se encontró un CPE indexado para esta ISSI." : "No fue posible leer la agenda de esta familia o versión."}</p>`;
    const foundAgenda = result.agenda?.supported
      ? `<section class="agenda-found"><div class="agenda-found-heading"><h4>Agenda encontrada</h4><strong>${formatNumber(result.agenda.count || 0)} contactos</strong></div>${renderDetailedContacts(result.agenda.contacts)}</section>`
      : "";
    const visibleComparison = individual && result.agenda?.supported ? "" : differences;
    return `<article class="agenda-result-row"><div class="agenda-result-header"><div><h3>ISSI ${escapeHtml(result.issi)}</h3><p>${escapeHtml(result.fileName || result.file || "Sin archivo")}</p><small>${escapeHtml(result.date || "Fecha no disponible")}</small></div><b class="function-state ${tone}">${escapeHtml(result.status)}</b></div><div class="agenda-result-meta"><span>${formatNumber(result.agenda?.count || 0)} contactos</span>${missing.length ? `<span>${missing.length} faltantes</span>` : ""}${extra.length ? `<span>${extra.length} sobrantes o distintos</span>` : ""}</div>${visibleComparison}${foundAgenda}</article>`;
  }).join("");
}

async function runAgendaQuery(kind) {
  let body;
  let button;
  if (kind === "issi") {
    const issi = byId("agendaIssiInput").value.trim();
    if (!/^\d{1,8}$/.test(issi)) {
      setMessage(byId("agendaMessage"), "Escribe un ISSI válido.", "warning");
      byId("agendaIssiInput").focus();
      return;
    }
    body = { issis: [issi] };
    button = byId("agendaIssiButton");
  } else if (kind === "project") {
    const projectCode = byId("agendaProjectInput").value.trim();
    if (!projectCode) {
      setMessage(byId("agendaMessage"), "Indica el código de programación CPE.", "warning");
      byId("agendaProjectInput").focus();
      return;
    }
    body = { projectCode };
    button = byId("agendaProjectButton");
  } else {
    if (!agendaIssiFile) {
      setMessage(byId("agendaMessage"), "Selecciona la plantilla Excel con las ISSI.", "warning");
      return;
    }
    body = { fileName: agendaIssiFile.name };
    button = byId("agendaFileButton");
  }
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Consultando…";
  setMessage(byId("agendaMessage"), "Leyendo las agendas de los CPE…");
  try {
    if (kind === "file") body.fileBase64 = await fileToBase64(agendaIssiFile);
    const response = await fetch("/api/agendas/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudieron comparar las agendas");
    renderAgendaComparison(payload);
    setMessage(byId("agendaMessage"), `Comparación terminada para ${formatNumber(payload.count)} radios.`, "success");
  } catch (error) {
    setMessage(byId("agendaMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function downloadAgendaTemplate() {
  const link = document.createElement("a");
  link.href = "/api/agendas/template";
  link.download = "Plantilla_ISSI_Agendas.xlsx";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function quickScan() {
  const path = byId("quickPathInput").value.trim();
  if (!path) {
    byId("quickPathInput").focus();
    return;
  }
  const button = byId("quickScanButton");
  button.disabled = true;
  button.textContent = "Escaneando…";
  setMessage(byId("quickMessage"), "Leyendo la ruta puntual…");
  try {
    const response = await fetch("/api/scan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo escanear la ruta");
    renderQuick(payload);
    const message = payload.errors?.length
      ? `Escaneo terminado con ${payload.errors.length} observaciones.`
      : "Escaneo terminado correctamente.";
    setMessage(byId("quickMessage"), message, payload.errors?.length ? "warning" : "success");
  } catch (error) {
    setMessage(byId("quickMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Escanear";
  }
}

async function searchRadio() {
  const fields = [
    ["issi", byId("radioIssiInput")],
    ["serial", byId("radioSerialInput")],
    ["tei", byId("radioTeiInput")],
  ];
  const activeFields = fields
    .map(([name, input]) => [name, input, input.value.trim()])
    .filter(([, , value]) => value);
  if (!activeFields.length) {
    byId("radioIssiInput").focus();
    setMessage(byId("radioSearchMessage"), "Escribe un ISSI, una serie o un TEI.", "warning");
    return;
  }
  const shortField = activeFields.find(([, , value]) => value.length < 3);
  if (shortField) {
    shortField[1].focus();
    setMessage(byId("radioSearchMessage"), "Cada campo utilizado debe tener al menos 3 caracteres.", "warning");
    return;
  }
  const button = byId("radioSearchButton");
  button.disabled = true;
  button.textContent = "Buscando…";
  setMessage(byId("radioSearchMessage"), "Consultando el índice SQLite…");
  try {
    const params = new URLSearchParams(activeFields.map(([name, , value]) => [name, value]));
    const response = await fetch(`/api/radio-search?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo buscar la radio");
    renderRadioSearch(payload);
    setMessage(byId("radioSearchMessage"), payload.count ? `Se encontraron ${formatNumber(payload.count)} coincidencias.` : "No hubo coincidencias para ese dato.", payload.count ? "success" : "warning");
  } catch (error) {
    setMessage(byId("radioSearchMessage"), error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Buscar radio";
  }
}

async function updateIndex() {
  if (!window.confirm("¿Iniciar la actualización del índice central? Se ejecutará en segundo plano y puede tardar varios minutos.")) return;
  const button = byId("updateIndexButton");
  button.disabled = true;
  setMessage(byId("indexMessage"), "Solicitando actualización…");
  try {
    const response = await fetch("/api/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo iniciar la actualización");
    setMessage(byId("indexMessage"), payload.message, payload.started ? "success" : "warning");
    renderDatabaseStatus(payload.database);
    if (indexPollTimer) clearInterval(indexPollTimer);
    indexPollTimer = setInterval(async () => {
      await loadDatabaseStatus();
      const scan = databaseStatus?.latestScan;
      if (scan && !scan.finishedAt) {
        setMessage(byId("indexMessage"), `Actualizando: ${formatNumber(scan.foundCount)} encontrados, ${formatNumber(scan.parsedCount)} analizados, ${formatNumber(scan.cachedCount)} cacheados.`);
      } else if (scan?.finishedAt) {
        clearInterval(indexPollTimer);
        indexPollTimer = null;
        button.disabled = false;
        setMessage(byId("indexMessage"), `Índice actualizado: ${formatDate(scan.finishedAt)}.`, "success");
      }
    }, 5000);
  } catch (error) {
    button.disabled = false;
    setMessage(byId("indexMessage"), error.message, "error");
  }
}

async function loadDiagnostics() {
  const button = byId("refreshDiagnosticsButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/diagnostics");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "No se pudo cargar el diagnóstico");
    renderDatabaseStatus({ ...payload.status, centralRoot: payload.centralRoot });
    byId("diagnosticRoot").textContent = payload.centralRoot || "—";
    byId("diagnosticDatabase").textContent = payload.status?.databasePath || "—";
    const scan = payload.status?.latestScan;
    byId("diagnosticScanStats").textContent = scan
      ? `${formatNumber(scan.parsedCount)} analizados · ${formatNumber(scan.cachedCount)} cacheados · ${formatNumber(scan.errorCount)} errores`
      : "—";
    byId("errorTypeList").innerHTML = (payload.errorsByType || []).map((item) => `<div class="stat-item" title="${escapeHtml(item.error)}"><span>${escapeHtml(item.error)}</span><strong>${formatNumber(item.count)}</strong></div>`).join("");
    byId("reportList").innerHTML = (payload.reports || []).map((report) => `<div class="report-item">
      <strong>${escapeHtml(report.name)}</strong><code title="${escapeHtml(report.path)}">${escapeHtml(report.path)}</code>
      <span class="report-state${report.exists ? "" : " missing"}">${report.exists ? `${formatNumber(report.size)} bytes` : "No generado"}</span>
    </div>`).join("");
  } catch (error) {
    byId("errorTypeList").innerHTML = `<div class="inline-message error">${escapeHtml(error.message)}</div>`;
  } finally {
    button.disabled = false;
  }
}

for (const button of navButtons) button.addEventListener("click", () => showSection(button.dataset.section));
for (const button of document.querySelectorAll("[data-download-template]")) button.addEventListener("click", downloadTemplate);
byId("masterFileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  byId("masterFileLabel").textContent = file ? file.name : "Selecciona el maestro de ISSI";
  if (file) setMessage(byId("fleetMessage"), `Archivo listo: ${file.name}`, "success");
});
byId("projectFileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  byId("projectFileLabel").textContent = file ? file.name : "Ningún archivo seleccionado";
  if (file) setMessage(byId("projectMessage"), `Archivo listo: ${file.name}`, "success");
});
byId("projectModelFileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  byId("projectModelFileLabel").textContent = file ? file.name : "Ningún archivo seleccionado";
  if (file) setMessage(byId("projectModelMessage"), `CPE listo: ${file.name}`, "success");
});
byId("projectRadioFilesInput").addEventListener("change", (event) => {
  const selected = [...event.target.files];
  const files = selected.filter((file) => /\.cpe$/i.test(file.name));
  const skipped = selected.length - files.length;
  const roots = [...new Set(files.map((file) => String(file.webkitRelativePath || file.name).split("/")[0]))];
  byId("projectRadioFilesLabel").textContent = files.length
    ? `${roots.join(", ")} · ${files.length} CPE${skipped ? ` · ${skipped} archivo(s) omitido(s)` : ""}`
    : "La carpeta no contiene archivos CPE";
  if (files.length) setMessage(byId("projectRadioMessage"), `${files.length} CPE encontrados y listos para validar.`, "success");
});
byId("projectTemplateButton").addEventListener("click", downloadProjectTemplate);
byId("projectRegisterButton").addEventListener("click", registerCpeProject);
byId("projectModelValidateButton").addEventListener("click", validateProjectModel);
byId("projectRadioValidateButton").addEventListener("click", validateProjectRadios);
byId("projectFieldPrepareButton").addEventListener("click", prepareProjectForField);
byId("projectPublicationRefreshButton").addEventListener("click", async () => {
  const button = byId("projectPublicationRefreshButton");
  button.disabled = true;
  try {
    if (runtimeState?.mode === "field") await fetch("/api/field/sync", { method: "POST" });
    await loadProjectPublication(true);
  } catch (error) {
    setMessage(byId("projectPublicationMessage"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});
byId("projectPublicationRetryButton").addEventListener("click", retryProjectPublication);
byId("projectRouteSaveButton").addEventListener("click", saveProjectPublicationRoute);
for (const id of ["projectRouteClientPath", "projectRouteForm", "projectRouteDate", "projectRouteInitials"]) {
  byId(id).addEventListener("input", updateProjectRoutePreview);
}
byId("projectRadioRefreshButton").addEventListener("click", async () => {
  const button = byId("projectRadioRefreshButton");
  button.disabled = true;
  try { await loadProjectRadioValidations(true); }
  catch (error) { setMessage(byId("projectRadioMessage"), error.message, "error"); }
  finally { button.disabled = false; }
});
byId("projectRadioCodeInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") byId("projectRadioRefreshButton").click();
});
byId("projectHistoryBody").addEventListener("click", (event) => {
  const button = event.target.closest("[data-project-code]");
  if (!button) return;
  const code = button.dataset.projectCode || "";
  byId("projectModelCodeInput").value = code;
  byId("projectRadioCodeInput").value = code;
  if (button.dataset.projectResponsible) byId("projectRadioProgrammerInput").value = button.dataset.projectResponsible;
  loadProjectRadioValidations(true).catch((error) => setMessage(byId("projectRadioMessage"), error.message, "error"));
  byId("projectRadioCodeInput").scrollIntoView({ behavior: "smooth", block: "center" });
});
byId("projectRefreshButton").addEventListener("click", loadCpeProjects);
byId("fleetButton").addEventListener("click", generateFleetMap);
byId("regenerateButton").addEventListener("click", generateFleetMap);
byId("downloadExcelButton").addEventListener("click", downloadExcel);
byId("matrixSearch").addEventListener("input", renderMatrix);
byId("matrixStatusFilter").addEventListener("change", renderMatrix);
byId("matrixFeatureFilter").addEventListener("change", renderMatrix);
byId("quickScanButton").addEventListener("click", quickScan);
byId("quickPathInput").addEventListener("keydown", (event) => { if (event.key === "Enter") quickScan(); });
byId("quickExcelButton").addEventListener("click", exportQuickExcel);
byId("quickMatrixSearch").addEventListener("input", renderQuickMatrix);
byId("quickMatrixStatusFilter").addEventListener("change", renderQuickMatrix);
byId("quickMatrixFeatureFilter").addEventListener("change", renderQuickMatrix);
byId("radioSearchButton").addEventListener("click", searchRadio);
byId("agendaIssiButton").addEventListener("click", () => runAgendaQuery("issi"));
byId("agendaIssiInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runAgendaQuery("issi"); });
byId("agendaProjectButton").addEventListener("click", () => runAgendaQuery("project"));
byId("agendaProjectInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runAgendaQuery("project"); });
byId("agendaTemplateButton").addEventListener("click", downloadAgendaTemplate);
byId("agendaFileButton").addEventListener("click", () => runAgendaQuery("file"));
byId("agendaFileInput").addEventListener("change", (event) => {
  agendaIssiFile = event.target.files[0] || null;
  byId("agendaFileLabel").textContent = agendaIssiFile ? agendaIssiFile.name : "Ningún archivo seleccionado";
});
const radioSearchInputIds = ["radioIssiInput", "radioSerialInput", "radioTeiInput"];
for (const id of radioSearchInputIds) {
  const input = byId(id);
  input.addEventListener("input", () => {
    if (!input.value) return;
    for (const otherId of radioSearchInputIds) {
      if (otherId !== id) byId(otherId).value = "";
    }
  });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") searchRadio(); });
}
byId("updateIndexButton").addEventListener("click", updateIndex);
byId("refreshDiagnosticsButton").addEventListener("click", loadDiagnostics);
byId("healthRefreshButton").addEventListener("click", () => loadHealthPanel(true));

showSection("fleet");
loadDatabaseStatus();
loadProjectRuntime().catch((error) => setMessage(byId("projectPublicationMessage"), error.message, "error"));
