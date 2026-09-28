const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const root = process.env.CPE_CLIENTS_2026_ROOT
  || "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2026";
const matchesPath = runtimePaths.dataFile("client-folder-matches-2026.json");
const outputJson = runtimePaths.dataFile("client-structure-analysis-2026.json");
const outputCsv = runtimePaths.docFile("client-structure-analysis-2026.csv");

const categories = ["ENTIDADES PUBLICAS", "PRIVADAS", "PRIVADAS CON CONTRATISTAS"];
const workflowNames = new Set([
  "ADICION", "CAMBIO", "PROGRAMACION", "REPARACION", "REPOSICION",
  "PRESTAMO", "DESACTIVACION", "ACTUALIZACION", "MANTENIMIENTO",
  "ANTES", "DESPUES", "BACKUP", "BACKUPS", "CODEPLUGS", "PLANTILLAS",
]);

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function isWorkflowName(name) {
  const value = normalized(name).replace(/[{}]+$/g, "").trim();
  return workflowNames.has(value)
    || /^FORM(?:ULARIO)?(?:\s|$)/.test(value)
    || /^F(?:ORM)?\s*\d+/.test(value)
    || /^20\d{6}(?:[_\-. ].*)?$/.test(value)
    || /^OT(?:\s|\d|$)/.test(value)
    || /^ORDEN(?:\s|$)/.test(value);
}

function listDirectories(directory, errors) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "es"));
  } catch (error) {
    errors.push({ path: directory, error: error.message });
    return [];
  }
}

function matchKey(category, folderName) {
  return `${normalized(category)}|${normalized(folderName)}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const matchReport = JSON.parse(fs.readFileSync(matchesPath, "utf8"));
const matchByFolder = new Map(matchReport.matches.map((match) => [matchKey(match.category, match.folderName), match]));
const errors = [];
const clients = [];

for (const category of categories) {
  const categoryPath = path.join(root, category);
  for (const clientFolder of listDirectories(categoryPath, errors)) {
    if (normalized(clientFolder) === "NUEVA CARPETA") continue;
    const clientPath = path.join(categoryPath, clientFolder);
    const immediateChildren = listDirectories(clientPath, errors);
    const directWorkflowFolders = immediateChildren.filter(isWorkflowName);
    const directContractorMarkers = immediateChildren.filter((name) => normalized(name) === "CONTRATISTAS");
    const unitCandidates = immediateChildren.filter((name) => (
      !isWorkflowName(name)
      && normalized(name) !== "CONTRATISTAS"
      && normalized(name) !== "NUEVA CARPETA"
    ));
    const contractors = [];
    const contractorLocations = [];

    for (const marker of directContractorMarkers) {
      const markerPath = path.join(clientPath, marker);
      const names = listDirectories(markerPath, errors).filter((name) => !isWorkflowName(name));
      contractors.push(...names);
      contractorLocations.push({ unit: "", markerPath, contractors: names });
    }

    for (const unit of unitCandidates) {
      const unitPath = path.join(clientPath, unit);
      const unitChildren = listDirectories(unitPath, errors);
      for (const marker of unitChildren.filter((name) => normalized(name) === "CONTRATISTAS")) {
        const markerPath = path.join(unitPath, marker);
        const names = listDirectories(markerPath, errors).filter((name) => !isWorkflowName(name));
        contractors.push(...names);
        contractorLocations.push({ unit, markerPath, contractors: names });
      }
    }

    const uniqueContractors = [...new Set(contractors)].sort((left, right) => left.localeCompare(right, "es"));
    const match = matchByFolder.get(matchKey(category, clientFolder)) || {};
    const hasUnits = unitCandidates.length > 0;
    const hasContractors = directContractorMarkers.length > 0
      || contractorLocations.length > 0
      || category === "PRIVADAS CON CONTRATISTAS";
    const hasMixedStructure = directWorkflowFolders.length > 0 && hasUnits;
    const reliableMatch = match.confidence === "ALTA";
    const reviewReasons = [];
    if (!reliableMatch) reviewReasons.push("confirmar cliente/RUC");
    if (hasMixedStructure) reviewReasons.push("flujo directo y unidades mezclados");
    if (category === "PRIVADAS CON CONTRATISTAS" && !directContractorMarkers.length && !contractorLocations.length) {
      reviewReasons.push("categoria contratistas sin marcador CONTRATISTAS visible");
    }
    if (!immediateChildren.length) reviewReasons.push("carpeta sin subcarpetas");

    clients.push({
      category,
      clientFolder,
      path: clientPath,
      matchConfidence: match.confidence || "SIN CRUCE",
      suggestedRuc: match.suggestedRuc || "",
      suggestedLegalName: match.suggestedLegalName || "",
      suggestedCommercialName: match.suggestedCommercialName || "",
      modeSuggestion: hasUnits ? (hasMixedStructure ? "MIXTO" : "CON_UNIDADES") : "SIN_UNIDADES",
      allowsContractorsSuggestion: hasContractors,
      categorySuggestion: category === "ENTIDADES PUBLICAS"
        ? "ENTIDADES PUBLICAS"
        : (hasContractors ? "PRIVADAS CON CONTRATISTAS" : "PRIVADAS"),
      immediateChildren,
      directWorkflowFolders,
      unitCandidates,
      contractorMarkers: contractorLocations.map((item) => item.markerPath),
      contractorLocations,
      contractors: uniqueContractors,
      reviewStatus: reviewReasons.length ? "REVISAR" : "PROPUESTA SEGURA",
      reviewReasons,
    });
  }
}

const summary = {
  analyzedFolders: clients.length,
  withUnitsSuggested: clients.filter((client) => client.modeSuggestion === "CON_UNIDADES").length,
  mixedStructure: clients.filter((client) => client.modeSuggestion === "MIXTO").length,
  allowsContractorsSuggested: clients.filter((client) => client.allowsContractorsSuggestion).length,
  safeProposals: clients.filter((client) => client.reviewStatus === "PROPUESTA SEGURA").length,
  requiresReview: clients.filter((client) => client.reviewStatus === "REVISAR").length,
  readErrors: errors.length,
};

const payload = {
  version: "analisis-estructura-1",
  generatedAt: new Date().toISOString(),
  root,
  status: "BORRADOR - NO MODIFICA CATALOGO NI NAS",
  summary,
  clients,
  readErrors: errors,
};

const headers = [
  "CategoriaActual", "CarpetaCliente", "ConfianzaCruce", "RUCPropuesto",
  "RazonSocialPropuesta", "ModoUnidadSugerido", "PermiteContratistasSugerido",
  "CategoriaSugerida", "UnidadesDetectadas", "ContratistasDetectados",
  "FlujosDirectos", "EstadoRevision", "MotivosRevision", "Ruta",
];
const rows = clients.map((client) => [
  client.category,
  client.clientFolder,
  client.matchConfidence,
  client.suggestedRuc,
  client.suggestedLegalName,
  client.modeSuggestion,
  client.allowsContractorsSuggestion ? "SI" : "NO",
  client.categorySuggestion,
  client.unitCandidates.join(" | "),
  client.contractors.join(" | "),
  client.directWorkflowFolders.join(" | "),
  client.reviewStatus,
  client.reviewReasons.join(" | "),
  client.path,
]);

fs.writeFileSync(outputJson, JSON.stringify(payload, null, 2), "utf8");
fs.writeFileSync(
  outputCsv,
  `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`,
  "utf8"
);
console.log(JSON.stringify({ ...summary, outputJson, outputCsv }, null, 2));
