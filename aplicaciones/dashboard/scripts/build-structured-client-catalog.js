const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const crypto = require("crypto");

const projectRoot = path.join(__dirname, "..");
const basePath = runtimePaths.dataFile("client-catalog-base.json");
const analysisPath = runtimePaths.dataFile("client-structure-analysis-2026.json");
const outputPath = runtimePaths.dataFile("client-catalog-structured.json");
const reviewCsvPath = runtimePaths.docFile("contractor-relationships-review.csv");

const approvedClients = new Map([
  ["20503840121", "REPSOL"],
  ["20100147514", "SOUTHERN"],
]);
const pilotStructuredRucs = new Set([...approvedClients.keys(), "20604932964", "20383045267"]);

const approvedHistoricalContractorRucs = new Map([
  ["3R INGENIERIAS", "20601668433"],
  ["ICB", "20330684411"],
  ["STIN", "20552643098"],
  ["COSAPI", "20552714378"],
  ["MASTER", "20402528941"],
]);

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function slug(value) {
  return normalized(value).replace(/\s+/g, "_") || "GENERAL";
}

function stableId(...parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16).toUpperCase();
}

function tokens(value) {
  const ignored = new Set(["S", "A", "SAC", "SA", "SRL", "PERU", "SOCIEDAD", "ANONIMA", "CERRADA"]);
  return normalized(value).split(" ").filter((word) => word.length > 1 && !ignored.has(word));
}

function scoreCandidate(folderName, client) {
  const source = normalized(folderName);
  const options = [client.nombreComercial, client.razonSocial].map(normalized).filter(Boolean);
  let best = 0;
  for (const option of options) {
    if (source === option) best = Math.max(best, 1);
    else if (option.includes(source) || source.includes(option)) best = Math.max(best, 0.9);
    const sourceTokens = new Set(tokens(source));
    const optionTokens = new Set(tokens(option));
    const common = [...sourceTokens].filter((word) => optionTokens.has(word)).length;
    const total = new Set([...sourceTokens, ...optionTokens]).size;
    if (total) best = Math.max(best, common / total);
  }
  return best;
}

function candidatesFor(folderName, clients) {
  return clients
    .filter((client) => client.tipoEntidad === "PRIVADO")
    .map((client) => ({
      ruc: client.ruc,
      name: client.nombreComercial || client.razonSocial,
      legalName: client.razonSocial,
      score: scoreCandidate(folderName, client),
    }))
    .filter((candidate) => candidate.score >= 0.45)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, "es"))
    .slice(0, 3);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
const clients = structuredClone(base.clients);
const clientByRuc = new Map(clients.map((client) => [client.ruc, client]));
const relationRows = [];

for (const [ruc, folderName] of approvedClients) {
  const client = clientByRuc.get(ruc);
  if (!client) throw new Error(`No se encontro el RUC aprobado ${ruc}`);
  const structure = analysis.clients.find((item) => (
    item.suggestedRuc === ruc && normalized(item.clientFolder) === normalized(folderName)
  ));
  if (!structure) throw new Error(`No se encontro la estructura NAS aprobada para ${folderName}`);

  const locations = structure.contractorLocations || [];
  const units = locations
    .filter((location) => location.unit)
    .map((location) => ({
      id: `UNIT-${ruc}-${slug(location.unit)}`,
      nombre: location.unit,
      activo: true,
      clienteRucRelacionado: normalized(location.unit).includes("REFINERIA PAMPILLA") ? "20259829594" : "",
      origen: "NAS_2026",
    }));
  client.codigoCarpeta = structure.clientFolder;
  client.categoriaCarpeta = structure.category;
  client.modoUnidad = units.length ? "CON_UNIDADES" : "SIN_UNIDADES";
  client.permiteContratistas = true;
  client.unidades = units;
  client.contratistas = [];

  for (const location of locations) {
    const unitId = location.unit ? `UNIT-${ruc}-${slug(location.unit)}` : "";
    for (const contractorName of location.contractors || []) {
      const candidates = candidatesFor(contractorName, clients);
      const best = candidates[0] || null;
      const uniqueHighCandidate = best && best.score >= 0.9
        && (!candidates[1] || best.score - candidates[1].score >= 0.15);
      const manuallyApprovedRuc = approvedHistoricalContractorRucs.get(normalized(contractorName)) || "";
      const manuallyApprovedClient = manuallyApprovedRuc ? clientByRuc.get(manuallyApprovedRuc) : null;
      if (manuallyApprovedRuc && !manuallyApprovedClient) {
        throw new Error(`El RUC aprobado para ${contractorName} no existe en el catalogo: ${manuallyApprovedRuc}`);
      }
      const validatedRuc = manuallyApprovedRuc || (uniqueHighCandidate ? best.ruc : "");
      const validatedName = manuallyApprovedClient?.razonSocial || (uniqueHighCandidate ? best.legalName : "");
      const relation = {
        id: `REL-${stableId(ruc, unitId, contractorName)}`,
        unidadId: unitId,
        nombreHistorico: contractorName,
        contratistaRuc: validatedRuc,
        contratistaRucPropuesto: validatedRuc,
        contratistaNombrePropuesto: validatedName,
        fechaInicio: "",
        fechaFin: "",
        estado: "ACTIVO",
        estadoValidacion: manuallyApprovedRuc
          ? "RUC_VALIDADO_MANUALMENTE"
          : (uniqueHighCandidate ? "RUC_VALIDADO" : "RUC_PENDIENTE"),
        origen: "NAS_2026",
      };
      client.contratistas.push(relation);
      relationRows.push({
        clienteRuc: ruc,
        cliente: client.nombreComercial || client.razonSocial,
        unidad: location.unit || "",
        contratistaHistorica: contractorName,
        rucPropuesto: relation.contratistaRucPropuesto,
        nombrePropuesto: relation.contratistaNombrePropuesto,
        candidatos: candidates.map((candidate) => `${candidate.ruc} | ${candidate.legalName} | ${candidate.score.toFixed(3)}`).join(" || "),
        estadoValidacion: relation.estadoValidacion,
      });
    }
  }
  client.observacionRevision = "Estructura de unidades/contratistas tomada del NAS 2026; validar RUC de relaciones historicas.";
}

const atu = clientByRuc.get("20604932964");
if (!atu) throw new Error("No se encontro ATU en el catalogo");
atu.codigoCarpeta = "ATU";
atu.categoriaCarpeta = "ENTIDADES PUBLICAS";
atu.modoUnidad = "SIN_UNIDADES";
atu.permiteContratistas = false;
atu.unidades = [];
atu.contratistas = [];
atu.observacionRevision = "Caso piloto validado: entidad publica, flujo directo sin unidades ni contratistas.";

const volcan = clientByRuc.get("20383045267");
if (!volcan) throw new Error("No se encontro VOLCAN en el catalogo");
const volcanUnits = ["ANDAYCHAGUA", "CARAHUACRA", "CERRO", "ROMINA", "SAN CRISTOBAL", "TICLIO"];
volcan.codigoCarpeta = "VOLCAN";
volcan.categoriaCarpeta = "PRIVADAS CON CONTRATISTAS";
volcan.modoUnidad = "UNIDAD_OPCIONAL";
volcan.permiteContratistas = true;
volcan.unidades = volcanUnits.map((unit) => ({
  id: `UNIT-${volcan.ruc}-${slug(unit)}`,
  nombre: unit,
  activo: true,
  clienteRucRelacionado: "",
  origen: "NAS_2026",
}));
volcan.contratistas = [];

const volcanRelations = [
  { unit: "", name: "EMICOSATH", ruc: "" },
  { unit: "", name: "MARTINEZ-MCEISA", ruc: "20344764540" },
  { unit: "", name: "SOLORZANO", ruc: "20486544873" },
  { unit: "", name: "TECNOMIN", ruc: "20221259581" },
  { unit: "ROMINA", name: "IESA", ruc: "20100146895" },
  { unit: "ROMINA", name: "TECNOMIN", ruc: "20221259581" },
  { unit: "TICLIO", name: "MASTER DRILLING", ruc: "20329921531" },
  { unit: "TICLIO", name: "SEPROCAL", ruc: "20508009977" },
];

for (const historical of volcanRelations) {
  const unitId = historical.unit ? `UNIT-${volcan.ruc}-${slug(historical.unit)}` : "";
  const proposedClient = historical.ruc ? clientByRuc.get(historical.ruc) : null;
  if (historical.ruc && !proposedClient) {
    throw new Error(`El RUC propuesto para ${historical.name} no existe: ${historical.ruc}`);
  }
  const relation = {
    id: `REL-${stableId(volcan.ruc, unitId, historical.name)}`,
    unidadId: unitId,
    nombreHistorico: historical.name,
    contratistaRuc: historical.ruc,
    contratistaRucPropuesto: historical.ruc,
    contratistaNombrePropuesto: proposedClient?.razonSocial || "",
    fechaInicio: "",
    fechaFin: "",
    estado: "ACTIVO",
    estadoValidacion: historical.ruc ? "RUC_VALIDADO" : "RUC_PENDIENTE",
    origen: "NAS_2026",
  };
  volcan.contratistas.push(relation);
  relationRows.push({
    clienteRuc: volcan.ruc,
    cliente: volcan.nombreComercial || volcan.razonSocial,
    unidad: historical.unit,
    contratistaHistorica: historical.name,
    rucPropuesto: historical.ruc,
    nombrePropuesto: proposedClient?.razonSocial || "",
    candidatos: historical.ruc ? `${historical.ruc} | ${proposedClient.razonSocial} | exacto` : "",
    estadoValidacion: relation.estadoValidacion,
  });
}
volcan.observacionRevision = "Unidades y contratistas validados; EMICOSATH permanece pendiente de RUC.";

const payload = {
  version: "catalogo-3-estructura-aprobada",
  generatedAt: new Date().toISOString(),
  sourceCatalog: path.basename(basePath),
  sourceStructure: path.basename(analysisPath),
  status: "PILOTO APROBADO - ATU, REPSOL, SOUTHERN Y VOLCAN; EMICOSATH PENDIENTE DE RUC",
  structureApproval: {
    status: "APROBADA",
    approvedAt: "2026-08-03",
    scope: "Cliente principal, unidad opcional, contratista opcional y relaciones con historial",
  },
  contractorRucApproval: {
    status: "APROBADOS",
    approvedAt: "2026-08-03",
    scope: "Coincidencias unicas propuestas y asignaciones manuales aprobadas para REPSOL y SOUTHERN",
  },
  volcanApproval: {
    status: "APROBADA",
    approvedAt: "2026-08-03",
    scope: "Unidades y siete relaciones de contratistas con RUC; EMICOSATH pendiente",
  },
  rules: [
    ...base.rules,
    "Un cliente puede tener unidades opcionales",
    "Una contratista se vincula al cliente principal y opcionalmente a una unidad",
    "Las relaciones se inactivan; no se borran del historial",
    "La carpeta de una relacion nueva se crea con la primera programacion",
  ],
  relationshipSchema: {
    client: "Cliente principal identificado por RUC",
    unit: "Unidad opcional dentro del cliente principal",
    contractor: "Relacion activa/inactiva, con fechas y RUC validado por administracion",
  },
  count: clients.length,
  structuredClients: [...pilotStructuredRucs],
  clients,
};

const headers = [
  "ClienteRUC", "Cliente", "Unidad", "ContratistaHistorica", "RUCPropuesto",
  "NombrePropuesto", "CandidatosCatalogo", "EstadoValidacion", "Aprobado",
];
const csvRows = relationRows.map((row) => [
  row.clienteRuc,
  row.cliente,
  row.unidad,
  row.contratistaHistorica,
  row.rucPropuesto,
  row.nombrePropuesto,
  row.candidatos,
  row.estadoValidacion,
  row.estadoValidacion.startsWith("RUC_VALIDADO") ? "SI" : "PENDIENTE",
]);

fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
fs.writeFileSync(
  reviewCsvPath,
  `\uFEFF${[headers, ...csvRows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`,
  "utf8"
);
console.log(JSON.stringify({
  outputPath,
  reviewCsvPath,
  structuredClients: payload.structuredClients,
  units: clients.filter((client) => pilotStructuredRucs.has(client.ruc)).reduce((sum, client) => sum + client.unidades.length, 0),
  contractorRelations: relationRows.length,
  validatedRucMatches: relationRows.filter((row) => row.estadoValidacion.startsWith("RUC_VALIDADO")).length,
  pendingRucMatches: relationRows.filter((row) => !row.estadoValidacion.startsWith("RUC_VALIDADO")).length,
}, null, 2));
