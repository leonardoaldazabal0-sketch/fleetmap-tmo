'use strict';
const runtimePaths = require("../lib/runtime-paths");

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const catalogPath = runtimePaths.dataFile('catalogo-clientes.json');
const jsonPath = runtimePaths.dataFile('client-relationships-audit.json');
const csvPath = runtimePaths.docFile('client-relationships-audit.csv');

function normalized(value) {
  return String(value || '').trim().toUpperCase();
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const errors = [];
const rucs = new Set();
const folderCodes = new Set();
const rows = [];

for (const client of catalog.clients || []) {
  const context = `${client.codigoCarpeta || '(sin carpeta)'} / ${client.ruc || '(sin RUC)'}`;
  const ruc = String(client.ruc || '');
  const folderCode = normalized(client.codigoCarpeta);
  const units = Array.isArray(client.unidades) ? client.unidades : [];
  const contractors = Array.isArray(client.contratistas) ? client.contratistas : [];
  const unitIds = new Set();
  const unitNames = new Set();
  const contractorIds = new Set();
  const contractorKeys = new Set();

  if (!/^\d{11}$/.test(ruc)) errors.push(`${context}: RUC invalido.`);
  if (rucs.has(ruc)) errors.push(`${context}: RUC duplicado.`);
  rucs.add(ruc);

  if (!folderCode) errors.push(`${context}: codigo de carpeta vacio.`);
  if (folderCode.length > 60) errors.push(`${context}: codigo de carpeta supera 60 caracteres.`);
  if (folderCodes.has(folderCode)) errors.push(`${context}: codigo de carpeta duplicado.`);
  folderCodes.add(folderCode);

  for (const unit of units) {
    const unitName = normalized(unit.nombre);
    if (!unit.id || unitIds.has(unit.id)) errors.push(`${context}: ID de unidad vacio o duplicado.`);
    if (!unitName || unitNames.has(unitName)) errors.push(`${context}: unidad vacia o duplicada (${unitName}).`);
    unitIds.add(unit.id);
    unitNames.add(unitName);
  }

  for (const contractor of contractors) {
    const key = `${contractor.unidadId || 'GENERAL'}|${normalized(contractor.nombreHistorico)}`;
    if (!contractor.id || contractorIds.has(contractor.id)) {
      errors.push(`${context}: ID de relacion de contratista vacio o duplicado.`);
    }
    if (!normalized(contractor.nombreHistorico) || contractorKeys.has(key)) {
      errors.push(`${context}: relacion de contratista vacia o duplicada (${key}).`);
    }
    if (contractor.unidadId && !unitIds.has(contractor.unidadId)) {
      errors.push(`${context}: contratista asociado a una unidad inexistente (${contractor.unidadId}).`);
    }
    if (contractor.contratistaRuc && !/^\d{11}$/.test(contractor.contratistaRuc)) {
      errors.push(`${context}: RUC de contratista invalido (${contractor.contratistaRuc}).`);
    }
    contractorIds.add(contractor.id);
    contractorKeys.add(key);
  }

  rows.push({
    RUC: ruc,
    Cliente: client.razonSocial,
    Carpeta: client.codigoCarpeta,
    EstadoRelaciones: client.relationshipStatus,
    ModoUnidad: client.modoUnidad,
    CantidadUnidades: units.length,
    Unidades: units.map((unit) => unit.nombre).join(' | '),
    CantidadContratistas: contractors.length,
    Contratistas: contractors.map((contractor) => {
      const unit = units.find((item) => item.id === contractor.unidadId);
      const scope = unit ? ` @ ${unit.nombre}` : '';
      const contractorRuc = contractor.contratistaRuc || 'RUC PENDIENTE';
      return `${contractor.nombreHistorico} [${contractorRuc}]${scope}`;
    }).join(' | '),
    ContratistasSinRuc: contractors.filter((contractor) => !contractor.contratistaRuc).length,
    FuenteRelaciones: client.relationshipApprovalSource || (
      units.length || contractors.length ? 'CATALOGO_ESTRUCTURADO' : ''
    ),
  });
}

const relationshipClients = rows.filter(
  (row) => row.CantidadUnidades > 0 || row.CantidadContratistas > 0,
);
const report = {
  generatedAt: new Date().toISOString(),
  catalogVersion: catalog.version,
  scope: 'Catalogo completo y estructuras historicas detectadas en Plantillas x Clientes 2026.',
  result: errors.length === 0 ? 'VALID' : 'INVALID',
  totals: {
    clients: rows.length,
    clientsWithRelationships: relationshipClients.length,
    clientsWithUnits: rows.filter((row) => row.CantidadUnidades > 0).length,
    units: rows.reduce((sum, row) => sum + row.CantidadUnidades, 0),
    clientsWithContractors: rows.filter((row) => row.CantidadContratistas > 0).length,
    contractorRelationships: rows.reduce((sum, row) => sum + row.CantidadContratistas, 0),
    contractorsPendingRuc: rows.reduce((sum, row) => sum + row.ContratistasSinRuc, 0),
    clientsWithoutDetectedRelationships2026: rows.filter(
      (row) => row.EstadoRelaciones === 'NO_RELATIONSHIPS_DETECTED_2026',
    ).length,
    integrityErrors: errors.length,
  },
  clientsWithRelationships: relationshipClients,
  unresolvedHistoricalStructures: catalog.unresolvedHistoricalStructures || [],
  integrityErrors: errors,
};

const columns = Object.keys(rows[0] || {});
const csv = [
  columns.map(csvCell).join(','),
  ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
].join('\r\n');

fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
fs.mkdirSync(path.dirname(csvPath), { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
fs.writeFileSync(csvPath, `\uFEFF${csv}\r\n`, 'utf8');

console.log(JSON.stringify({
  jsonPath,
  csvPath,
  result: report.result,
  totals: report.totals,
  unresolvedHistoricalStructures: report.unresolvedHistoricalStructures,
}, null, 2));

if (errors.length > 0) process.exitCode = 1;
