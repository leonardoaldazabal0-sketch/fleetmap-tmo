const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");

const catalogPath = runtimePaths.dataFile("client-catalog-structured.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const errors = [];
const clientRucs = new Set();
const relationshipIds = new Set();

for (const client of catalog.clients) {
  if (!/^\d{11}$/.test(client.ruc)) errors.push(`RUC invalido: ${client.ruc}`);
  if (clientRucs.has(client.ruc)) errors.push(`RUC duplicado: ${client.ruc}`);
  clientRucs.add(client.ruc);
  const unitIds = new Set((client.unidades || []).map((unit) => unit.id));
  for (const relation of client.contratistas || []) {
    if (relationshipIds.has(relation.id)) errors.push(`Relacion duplicada: ${relation.id}`);
    relationshipIds.add(relation.id);
    if (relation.unidadId && !unitIds.has(relation.unidadId)) {
      errors.push(`Unidad inexistente en ${client.ruc}: ${relation.unidadId}`);
    }
    if (relation.contratistaRuc && !/^\d{11}$/.test(relation.contratistaRuc)) {
      errors.push(`RUC de contratista invalido: ${relation.id}`);
    }
  }
}

const structured = catalog.clients.filter((client) => catalog.structuredClients.includes(client.ruc));
const result = {
  status: errors.length ? "REVISAR" : "VALIDO",
  clients: catalog.clients.length,
  uniqueRucs: clientRucs.size,
  structuredClients: structured.map((client) => ({
    ruc: client.ruc,
    folder: client.codigoCarpeta,
    mode: client.modoUnidad,
    units: client.unidades.length,
    contractorRelationships: client.contratistas.length,
  })),
  uniqueRelationshipIds: relationshipIds.size,
  errors,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
