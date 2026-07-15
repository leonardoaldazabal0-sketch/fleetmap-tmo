const MAX_MATRIX_RADIOS = 200;
const MAX_MATRIX_GROUPS = 250;
const MAX_TECHNICAL_ROWS = 500;

let databaseStatus = null;
let fleetPayload = null;
let quickPayload = null;
let radioSearchPayload = null;
let indexPollTimer = null;

const byId = (id) => document.getElementById(id);
const navButtons = [...document.querySelectorAll(".nav-button")];
const sections = {
  fleet: byId("fleetSection"),
  index: byId("indexSection"),
  quick: byId("quickSection"),
  lookup: byId("lookupSection"),
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
  if (name === "diagnostic") loadDiagnostics();
  if (name === "index") loadDatabaseStatus();
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
  ["Fecha programación", "programDate", 120],
];

function matrixFilterData() {
  const matrix = fleetPayload?.matrix || { radios: [], groups: [] };
  const query = normalize(byId("matrixSearch").value.trim());
  const state = byId("matrixStatusFilter").value;
  const matchingGroups = query
    ? matrix.groups.filter((group) => normalize(`${group.gssi} ${group.alias}`).includes(query))
    : [];
  const matchingGroupKeys = new Set(matchingGroups.map((group) => String(group.gssi)));
  const radios = matrix.radios.filter((radio) => {
    if (state === "with-codeplug" && !radio.hasCodeplug) return false;
    if (state === "without-codeplug" && radio.hasCodeplug) return false;
    if (state === "with-errors" && !radio.hasError) return false;
    if (!query) return true;
    const radioText = normalize([
      radio.razonSocial, radio.unidad, radio.serial, radio.tei, radio.issi,
      radio.codeplug, radio.software, radio.fileName, radio.observacion,
    ].join(" "));
    return radioText.includes(query) || radio.groupGssis.some((gssi) => matchingGroupKeys.has(String(gssi)));
  });
  const groups = query && matchingGroups.length ? matchingGroups : matrix.groups;
  return { radios, groups };
}

function renderMatrix() {
  if (!fleetPayload?.matrix) return;
  const container = byId("matrixContainer");
  const filtered = matrixFilterData();
  const radios = filtered.radios.slice(0, MAX_MATRIX_RADIOS);
  const groups = filtered.groups.slice(0, MAX_MATRIX_GROUPS);
  const truncatedRadios = filtered.radios.length - radios.length;
  const truncatedGroups = filtered.groups.length - groups.length;
  byId("matrixRenderNote").textContent = [
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
  const identityHeaders = identityColumns.map(([label, , width]) => {
    const html = `<th class="identity" rowspan="2" style="--sticky-left:${left}px;--column-width:${width}px">${escapeHtml(label)}</th>`;
    left += width;
    return html;
  }).join("");

  const body = radios.map((radio) => {
    let cellLeft = 0;
    const fixed = identityColumns.map(([, key, width]) => {
      const value = radio[key] || "";
      const html = `<td class="identity" style="--sticky-left:${cellLeft}px;--column-width:${width}px" title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
      cellLeft += width;
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

function renderMissing(missing) {
  const section = byId("missingSection");
  section.hidden = missing.length === 0;
  byId("missingCountBadge").textContent = formatNumber(missing.length);
  byId("missingBody").innerHTML = missing.slice(0, 500).map((item) => `<tr>
    <td>${escapeHtml(item.issi)}</td><td>${escapeHtml(item.razonSocial || item.cliente)}</td>
    <td>${escapeHtml(item.unidad || item.label)}</td><td>${escapeHtml(item.observacion)}</td>
  </tr>`).join("");
}

function renderTechnicalRows(rows) {
  byId("technicalCount").textContent = `${formatNumber(rows.length)} filas · mostrando hasta ${MAX_TECHNICAL_ROWS}`;
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
  renderTechnicalRows(payload.rows || []);
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
  const button = byId("downloadExcelButton");
  button.disabled = true;
  button.textContent = "Preparando…";
  try {
    const response = await fetch("/api/export-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: fleetPayload.rows || [],
        history: fleetPayload.history || [],
        missing: fleetPayload.missing || [],
        errors: fleetPayload.errors || [],
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

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportQuickCsv() {
  const rows = quickPayload?.rows || [];
  const columns = ["file", "serial", "tei", "issi", "codeplug", "software", "folderRow", "slot", "alias", "gssi", "statusText"];
  const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = "escaneo_rapido_tmo.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderQuick(payload) {
  quickPayload = payload;
  const rows = payload.rows || [];
  byId("quickFiles").textContent = formatNumber(payload.fileCount || payload.files?.length);
  byId("quickGroups").textContent = formatNumber(rows.length);
  byId("quickAnalyzed").textContent = formatNumber(payload.cache?.analyzed);
  byId("quickCached").textContent = formatNumber(payload.cache?.reused);
  byId("quickCsvButton").disabled = rows.length === 0;
  byId("quickBody").innerHTML = rows.length ? rows.slice(0, 1000).map((row) => `<tr>
    <td title="${escapeHtml(row.file)}">${escapeHtml(row.fileName)}</td><td>${escapeHtml(row.serial)}</td>
    <td>${escapeHtml(row.tei)}</td><td>${escapeHtml(row.issi)}</td><td>${escapeHtml(row.alias)}</td>
    <td>${escapeHtml(row.gssi)}</td><td>${escapeHtml(row.statusText)}</td><td>${escapeHtml(row.codeplug)}</td><td>${escapeHtml(row.software)}</td>
  </tr>`).join("") : '<tr><td colspan="9" class="empty-cell">No se encontraron grupos programados.</td></tr>';
  renderDatabaseStatus(payload.database);
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
        return `<span class="group-chip${confidenceClass}" title="${escapeHtml(group.statusText || "")}">${escapeHtml(group.gssi)}<small>${escapeHtml(group.alias)}</small></span>`;
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
      </div>
      ${errorBlock}
      <div class="lookup-groups">${groupsMarkup}</div>
    </article>`;
  }).join("");
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
  const input = byId("radioSearchInput");
  const term = input.value.trim();
  if (term.length < 3) {
    input.focus();
    setMessage(byId("radioSearchMessage"), "Escribe al menos 3 caracteres para buscar una radio.", "warning");
    return;
  }
  const button = byId("radioSearchButton");
  button.disabled = true;
  button.textContent = "Buscando…";
  setMessage(byId("radioSearchMessage"), "Consultando el índice SQLite…");
  try {
    const response = await fetch(`/api/radio-search?term=${encodeURIComponent(term)}`);
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
byId("fleetButton").addEventListener("click", generateFleetMap);
byId("regenerateButton").addEventListener("click", generateFleetMap);
byId("downloadExcelButton").addEventListener("click", downloadExcel);
byId("matrixSearch").addEventListener("input", renderMatrix);
byId("matrixStatusFilter").addEventListener("change", renderMatrix);
byId("quickScanButton").addEventListener("click", quickScan);
byId("quickPathInput").addEventListener("keydown", (event) => { if (event.key === "Enter") quickScan(); });
byId("quickCsvButton").addEventListener("click", exportQuickCsv);
byId("radioSearchButton").addEventListener("click", searchRadio);
byId("radioSearchInput").addEventListener("keydown", (event) => { if (event.key === "Enter") searchRadio(); });
byId("updateIndexButton").addEventListener("click", updateIndex);
byId("refreshDiagnosticsButton").addEventListener("click", loadDiagnostics);

showSection("fleet");
loadDatabaseStatus();
