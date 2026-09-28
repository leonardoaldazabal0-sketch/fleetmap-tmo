const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
const catalogPath = runtimePaths.dataFile("client-catalog-base.json");
const nasRoot = process.env.CPE_CLIENTS_2026_ROOT
  || "\\\\192.168.7.252\\tic\\002 Programacion\\Plantillas x Clientes 2026";
const categories = ["ENTIDADES PUBLICAS", "PRIVADAS", "PRIVADAS CON CONTRATISTAS"];
const outputJson = runtimePaths.dataFile("client-folder-matches-2026.json");
const outputCsv = runtimePaths.docFile("client-folder-matches-2026.csv");

const corporateWords = new Set([
  "S", "A", "SA", "SAC", "SAA", "SRL", "EIRL", "EMPRESA", "INDIVIDUAL",
  "RESPONSABILIDAD", "LIMITADA", "SOCIEDAD", "ANONIMA", "CERRADA", "ABIERTO",
  "PERU", "PERUANA", "SUCURSAL", "AGENCIA", "CIA", "COMPANIA",
  "DISTRITAL", "PROVINCIAL", "METROPOLITANA",
]);
const connectorWords = new Set(["DE", "DEL", "LA", "LAS", "LOS", "EL", "Y", "E", "PARA", "EN", "POR"]);
const genericAliases = new Set(["MUNICIPAL", "MUNICIPALIDAD", "EMPRESA", "CONSORCIO", "GRUPO", "MINISTERIO"]);

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/&/g, " Y ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value, removeCorporate = false) {
  const list = normalize(value).split(" ").filter(Boolean);
  return removeCorporate ? list.filter((token) => !corporateWords.has(token)) : list;
}

function simplified(value) {
  return tokens(value, true).join(" ");
}

function acronym(value) {
  return tokens(value, true)
    .filter((token) => !connectorWords.has(token))
    .map((token) => token[0])
    .join("");
}

function jaccard(left, right) {
  const a = new Set(tokens(left, true).filter((token) => !connectorWords.has(token)));
  const b = new Set(tokens(right, true).filter((token) => !connectorWords.has(token)));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function levenshtein(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function similarity(left, right) {
  const max = Math.max(normalize(left).length, normalize(right).length);
  return max ? 1 - levenshtein(left, right) / max : 0;
}

function aliases(client) {
  const values = [client.nombreComercial, client.razonSocial];
  for (const part of String(client.razonSocial || "").split(/\s+-\s+/)) values.push(part);
  const parenthetical = String(client.razonSocial || "").match(/\(([^)]+)\)/g) || [];
  values.push(...parenthetical.map((value) => value.slice(1, -1)));
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .filter((value) => !genericAliases.has(normalize(value)));
}

function candidateScore(folderName, client) {
  const folder = normalize(folderName);
  const folderSimple = simplified(folderName);
  let best = { score: 0, reason: "sin coincidencia" };

  for (const alias of aliases(client)) {
    const aliasNormal = normalize(alias);
    const aliasSimple = simplified(alias);
    if (!aliasNormal || !aliasSimple) continue;
    let score = 0;
    let reason = "";

    if (folder === aliasNormal) {
      score = 1;
      reason = alias === client.nombreComercial ? "nombre comercial exacto" : "razon social/alias exacto";
    } else if (folderSimple && folderSimple === aliasSimple) {
      score = 0.99;
      reason = "coincidencia exacta sin forma societaria";
    } else if (folder.length >= 2 && acronym(alias) === folder) {
      score = 0.94;
      reason = "sigla de razon social";
    } else if (folder.length >= 3 && aliasNormal.split(" ").includes(folder)) {
      score = 0.9;
      reason = "codigo presente en nombre registrado";
    } else if (folder.length >= 4 && (aliasSimple.includes(folderSimple) || folderSimple.includes(aliasSimple))) {
      const ratio = Math.min(folderSimple.length, aliasSimple.length) / Math.max(folderSimple.length, aliasSimple.length);
      score = 0.78 + ratio * 0.14;
      reason = "nombre contenido parcialmente";
    } else {
      const tokenScore = jaccard(folderName, alias);
      const editScore = similarity(folderName, alias);
      score = Math.max(tokenScore * 0.88, editScore * 0.82);
      reason = tokenScore >= editScore ? "similitud de palabras" : "similitud de escritura";
    }

    if (score > best.score) best = { score, reason, alias };
  }
  return best;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const folders = [];
const ignoredFolders = [];

for (const category of categories) {
  const categoryPath = path.join(nasRoot, category);
  for (const entry of fs.readdirSync(categoryPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (normalize(entry.name) === "NUEVA CARPETA") {
      ignoredFolders.push({ category, folderName: entry.name, reason: "nombre temporal" });
      continue;
    }
    folders.push({ category, folderName: entry.name });
  }
}

const matches = folders.map((folder) => {
  const expectedType = folder.category === "ENTIDADES PUBLICAS" ? "PUBLICO" : "PRIVADO";
  const ranked = catalog.clients
    .filter((client) => client.tipoEntidad === expectedType)
    .map((client) => ({ client, ...candidateScore(folder.folderName, client) }))
    .sort((left, right) => right.score - left.score);
  const first = ranked[0];
  const second = ranked[1];
  const crossType = catalog.clients
    .filter((client) => client.tipoEntidad !== expectedType)
    .map((client) => ({ client, ...candidateScore(folder.folderName, client) }))
    .sort((left, right) => right.score - left.score)[0];
  const ambiguous = Boolean(second && first.score >= 0.75 && first.score - second.score < 0.035);
  let confidence = "SIN COINCIDENCIA";
  if (first.score >= 0.98 && !ambiguous) confidence = "ALTA";
  else if (first.score >= 0.75 && !ambiguous) confidence = "MEDIA";
  else if (first.score >= 0.75 && ambiguous) confidence = "AMBIGUA";

  const suggested = confidence === "SIN COINCIDENCIA" ? null : first.client;
  return {
    category: folder.category,
    folderName: folder.folderName,
    confidence,
    score: Number(first.score.toFixed(3)),
    reason: first.reason,
    suggestedRuc: suggested?.ruc || "",
    suggestedCommercialName: suggested?.nombreComercial || "",
    suggestedLegalName: suggested?.razonSocial || "",
    secondCandidate: second && second.score >= 0.65
      ? `${second.client.ruc} | ${second.client.nombreComercial || second.client.razonSocial} | ${second.score.toFixed(3)}`
      : "",
    crossTypeCandidate: crossType && crossType.score >= 0.75
      ? `${crossType.client.tipoEntidad} | ${crossType.client.ruc} | ${crossType.client.nombreComercial || crossType.client.razonSocial} | ${crossType.score.toFixed(3)}`
      : "",
    reviewStatus: confidence === "ALTA" ? "PROPUESTA SEGURA - PENDIENTE APROBACION" : "REVISAR MANUALMENTE",
  };
});

const proposedRucs = new Set(matches.filter((match) => match.suggestedRuc).map((match) => match.suggestedRuc));
const payload = {
  version: "cruce-1",
  generatedAt: new Date().toISOString(),
  nasRoot,
  catalogVersion: catalog.version,
  summary: {
    nasBusinessFolders: folders.length,
    highConfidence: matches.filter((match) => match.confidence === "ALTA").length,
    mediumConfidence: matches.filter((match) => match.confidence === "MEDIA").length,
    ambiguous: matches.filter((match) => match.confidence === "AMBIGUA").length,
    withoutMatch: matches.filter((match) => match.confidence === "SIN COINCIDENCIA").length,
    uniqueCatalogClientsProposed: proposedRucs.size,
    activeCatalogClientsWithout2026Folder: catalog.clients.filter((client) => !proposedRucs.has(client.ruc)).length,
    ignoredTemporaryFolders: ignoredFolders.length,
  },
  matches,
  ignoredFolders,
};

fs.writeFileSync(outputJson, JSON.stringify(payload, null, 2), "utf8");
const headers = [
  "CategoriaNAS", "CarpetaNAS", "Confianza", "Puntaje", "Motivo", "RUCPropuesto",
  "NombreComercialPropuesto", "RazonSocialPropuesta", "SegundoCandidato", "EstadoRevision",
  "CandidatoOtroTipoEntidad",
];
const rows = matches.map((match) => [
  match.category, match.folderName, match.confidence, match.score, match.reason,
  match.suggestedRuc, match.suggestedCommercialName, match.suggestedLegalName,
  match.secondCandidate, match.reviewStatus,
  match.crossTypeCandidate,
]);
const csv = [headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
fs.writeFileSync(outputCsv, `\uFEFF${csv}`, "utf8");
console.log(JSON.stringify({ ...payload.summary, outputJson, outputCsv }, null, 2));
