'use strict';
const runtimePaths = require("../lib/runtime-paths");

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = runtimePaths.dataFile('client-catalog-structured.json');
const matchesPath = runtimePaths.dataFile('client-folder-matches-2026.json');
const relationshipsPath = runtimePaths.dataFile('client-relationships-approved.json');
const outputDir = runtimePaths.dir('catalogos');
const outputPath = path.join(outputDir, 'catalogo-clientes.json');

function countEncodingMarkers(value) {
  return (value.match(/[ÃÂâ]/g) || []).length;
}

function repairMojibake(value) {
  if (typeof value !== 'string' || !/[ÃÂâ]/.test(value)) {
    return value;
  }

  const candidate = Buffer.from(value, 'latin1').toString('utf8');
  if (candidate.includes('\uFFFD')) {
    return value;
  }

  return countEncodingMarkers(candidate) < countEncodingMarkers(value)
    ? candidate
    : value;
}

function repairTree(value) {
  if (Array.isArray(value)) {
    return value.map(repairTree);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairTree(item)]),
    );
  }

  return repairMojibake(value);
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeFolderCode(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' Y ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/[^A-Z0-9()\-., ]/g, ' ')
    .replace(/\bSOCIEDAD ANONIMA CERRADA\b/g, ' ')
    .replace(/\bEMPRESA INDIVIDUAL DE RESPONSABILIDAD LIMITADA\b/g, ' ')
    .replace(/\bS\.?\s*A\.?\s*C\.?\b/g, ' ')
    .replace(/\bE\.?\s*I\.?\s*R\.?\s*L\.?\b/g, ' ')
    .replace(/\bS\.?\s*R\.?\s*L\.?\b/g, ' ')
    .replace(/\bS\.?\s*A\.?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ .,-]+$/g, '')
    .trim();
}

function shortenFolderCode(value, maxLength = 60) {
  if (value.length <= maxLength) {
    return value;
  }

  const shortened = value.slice(0, maxLength + 1);
  const lastSpace = shortened.lastIndexOf(' ');
  return shortened.slice(0, lastSpace >= 30 ? lastSpace : maxLength).trim();
}

function uniqueFolderCode(baseValue, ruc, usedCodes) {
  let code = shortenFolderCode(normalizeFolderCode(baseValue));
  if (!code) {
    code = `CLIENTE ${ruc}`;
  }

  const normalizedKey = code.toUpperCase();
  if (!usedCodes.has(normalizedKey)) {
    usedCodes.add(normalizedKey);
    return code;
  }

  const suffix = ` - ${String(ruc || '').slice(-6)}`;
  code = `${shortenFolderCode(code, 60 - suffix.length)}${suffix}`;
  usedCodes.add(code.toUpperCase());
  return code;
}

function idPart(value) {
  return normalizeFolderCode(value).replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const catalog = repairTree(source);
const matches = repairTree(JSON.parse(fs.readFileSync(matchesPath, 'utf8')));
const relationships = repairTree(JSON.parse(fs.readFileSync(relationshipsPath, 'utf8')));

const confidenceRank = { ALTA: 3, MEDIA: 2 };
const historicalByRuc = new Map();
for (const match of matches.matches || []) {
  if (!match.suggestedRuc || !confidenceRank[match.confidence]) {
    continue;
  }

  const current = historicalByRuc.get(match.suggestedRuc);
  const candidateRank = confidenceRank[match.confidence];
  const currentRank = current ? confidenceRank[current.confidence] : -1;
  if (
    !current ||
    candidateRank > currentRank ||
    (candidateRank === currentRank && Number(match.score || 0) > Number(current.score || 0))
  ) {
    historicalByRuc.set(match.suggestedRuc, match);
  }
}

catalog.version = 'catalogo-5-clientes-aprobados';
catalog.generatedAt = new Date().toISOString();
catalog.status = 'TODOS LOS CLIENTES APROBADOS PARA OPERACION';
catalog.pilot = {
  technicianName: 'OSCAR SANCHEZ',
  technicianInitials: 'OS',
};

catalog.structureApproval = {
  status: 'APROBACION TOTAL',
  approvedAt: '2026-08-10',
  scope: 'Los 426 clientes activos pueden crear su estructura de primera programacion.',
};

const usedCodes = new Set(
  catalog.clients
    .map((client) => normalizeFolderCode(client.codigoCarpeta))
    .filter(Boolean),
);
const folderCodeStats = {
  existing: 0,
  historical: 0,
  generated: 0,
};

catalog.clients = catalog.clients.map((client) => {
  const displayParts = uniqueNonEmpty([
    client.nombreComercial,
    client.razonSocial,
    client.ruc,
  ]);

  let folderCode = normalizeFolderCode(client.codigoCarpeta);
  let folderCodeSource = 'EXISTING_APPROVED';
  let folderCodeConfidence = 'APPROVED';
  const historicalMatch = historicalByRuc.get(client.ruc);

  if (folderCode) {
    folderCodeStats.existing++;
  } else if (historicalMatch) {
    folderCode = uniqueFolderCode(historicalMatch.folderName, client.ruc, usedCodes);
    folderCodeSource = 'HISTORICAL_APPROVED';
    folderCodeConfidence = historicalMatch.confidence;
    folderCodeStats.historical++;
  } else {
    const usefulCommercialName = String(client.nombreComercial || '').trim();
    folderCode = uniqueFolderCode(
      usefulCommercialName && !/^(0+|-+|N\/?A)$/i.test(usefulCommercialName)
        ? usefulCommercialName
        : client.razonSocial,
      client.ruc,
      usedCodes,
    );
    folderCodeSource = 'GENERATED_APPROVED';
    folderCodeConfidence = 'APPROVED_BY_RULE';
    folderCodeStats.generated++;
  }

  return {
    ...client,
    codigoCarpeta: folderCode,
    folderCodeApproved: true,
    folderCodeApprovedAt: '2026-08-10',
    folderCodeSource,
    folderCodeConfidence,
    nombreMostrar: displayParts.join(' — '),
    terminosBusqueda: uniqueNonEmpty([
      client.ruc,
      client.codigoCarpeta,
      client.nombreComercial,
      client.razonSocial,
      ...(client.terminosBusqueda || []),
    ]),
  };
});

const clientsByRuc = new Map(catalog.clients.map((client) => [client.ruc, client]));
for (const approved of relationships.clients || []) {
  const client = clientsByRuc.get(approved.ruc);
  if (!client) {
    throw new Error(`No existe el cliente aprobado para relaciones: ${approved.ruc}`);
  }

  const units = Array.isArray(client.unidades) ? client.unidades : [];
  for (const approvedUnit of approved.units || []) {
    const existingUnit = units.find(
      (unit) => normalizeFolderCode(unit.nombre) === normalizeFolderCode(approvedUnit.name),
    );
    if (existingUnit) {
      existingUnit.activo = true;
      existingUnit.assignmentConfidence = approvedUnit.assignmentConfidence;
      existingUnit.approvalSource = relationships.version;
    } else {
      units.push({
        id: `UNIT-${client.ruc}-${idPart(approvedUnit.name)}`,
        nombre: normalizeFolderCode(approvedUnit.name),
        activo: true,
        clienteRucRelacionado: '',
        origen: 'APPROVED_STRUCTURE_2026',
        assignmentConfidence: approvedUnit.assignmentConfidence,
        approvalSource: relationships.version,
      });
    }
  }
  client.unidades = units.sort((left, right) => left.nombre.localeCompare(right.nombre, 'es'));

  const contractors = Array.isArray(client.contratistas) ? client.contratistas : [];
  for (const approvedContractor of approved.contractors || []) {
    const unit = approvedContractor.unit
      ? units.find(
        (item) => normalizeFolderCode(item.nombre) === normalizeFolderCode(approvedContractor.unit),
      )
      : null;
    if (approvedContractor.unit && !unit) {
      throw new Error(
        `No existe la unidad ${approvedContractor.unit} para ${client.codigoCarpeta}`,
      );
    }

    const unitId = unit ? unit.id : '';
    const existingContractor = contractors.find(
      (contractor) =>
        normalizeFolderCode(contractor.nombreHistorico) === normalizeFolderCode(approvedContractor.name) &&
        String(contractor.unidadId || '') === unitId,
    );

    if (existingContractor) {
      existingContractor.estado = 'ACTIVO';
      existingContractor.assignmentConfidence = approvedContractor.assignmentConfidence;
      existingContractor.approvalSource = relationships.version;
    } else {
      contractors.push({
        id: `REL-${client.ruc}-${idPart(approvedContractor.name)}-${idPart(unitId || 'GENERAL')}`,
        unidadId: unitId,
        nombreHistorico: normalizeFolderCode(approvedContractor.name),
        contratistaRuc: approvedContractor.ruc || '',
        contratistaRucPropuesto: approvedContractor.ruc || '',
        contratistaNombrePropuesto: approvedContractor.legalName || '',
        fechaInicio: '',
        fechaFin: '',
        estado: 'ACTIVO',
        estadoValidacion: approvedContractor.ruc
          ? 'RUC_VALIDADO_POR_APROBACION'
          : 'NOMBRE_APROBADO_RUC_PENDIENTE',
        origen: 'APPROVED_STRUCTURE_2026',
        assignmentConfidence: approvedContractor.assignmentConfidence,
        approvalSource: relationships.version,
      });
    }
  }
  client.contratistas = contractors.sort((left, right) =>
    left.nombreHistorico.localeCompare(right.nombreHistorico, 'es'),
  );
  client.modoUnidad = approved.mode;
  client.permiteContratistas = client.contratistas.length > 0;
  client.relationshipStatus = 'APPROVED';
  client.relationshipApprovalSource = relationships.version;
}

for (const client of catalog.clients) {
  client.unidades = Array.isArray(client.unidades) ? client.unidades : [];
  client.contratistas = Array.isArray(client.contratistas) ? client.contratistas : [];
  if (!client.relationshipStatus) {
    client.relationshipStatus = client.unidades.length || client.contratistas.length
      ? 'APPROVED'
      : 'NO_RELATIONSHIPS_DETECTED_2026';
  }
}

catalog.relationshipApproval = {
  version: relationships.version,
  approvedAt: relationships.approvedAt,
  scope: relationships.scope,
};
catalog.unresolvedHistoricalStructures = relationships.unresolvedHistoricalStructures || [];
catalog.relationshipStats = {
  clientsWithUnits: catalog.clients.filter((client) => client.unidades.length > 0).length,
  units: catalog.clients.reduce((sum, client) => sum + client.unidades.length, 0),
  clientsWithContractors: catalog.clients.filter((client) => client.contratistas.length > 0).length,
  contractorRelationships: catalog.clients.reduce(
    (sum, client) => sum + client.contratistas.length,
    0,
  ),
  contractorsPendingRuc: catalog.clients.reduce(
    (sum, client) => sum + client.contratistas.filter((item) => !item.contratistaRuc).length,
    0,
  ),
  clientsWithoutDetectedRelationships: catalog.clients.filter(
    (client) => client.relationshipStatus === 'NO_RELATIONSHIPS_DETECTED_2026',
  ).length,
};

catalog.count = catalog.clients.length;
catalog.approvedClientCount = catalog.clients.length;
catalog.structuredClients = catalog.clients.map((client) => client.ruc);
catalog.folderCodeStats = folderCodeStats;

const rucs = catalog.clients.map((client) => client.ruc).filter(Boolean);
const duplicateRucs = rucs.filter((ruc, index) => rucs.indexOf(ruc) !== index);
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;

if (duplicateRucs.length > 0) {
  throw new Error(`El catalogo contiene RUC duplicados: ${uniqueNonEmpty(duplicateRucs).join(', ')}`);
}

const folderCodes = catalog.clients.map((client) => client.codigoCarpeta);
const duplicateFolderCodes = folderCodes.filter(
  (code, index) => folderCodes.findIndex((item) => item.toUpperCase() === code.toUpperCase()) !== index,
);
if (duplicateFolderCodes.length > 0) {
  throw new Error(`El catalogo contiene carpetas duplicadas: ${uniqueNonEmpty(duplicateFolderCodes).join(', ')}`);
}
if (catalog.clients.some((client) => !client.codigoCarpeta || client.codigoCarpeta.length > 60)) {
  throw new Error('Todos los clientes deben tener un codigo de carpeta de hasta 60 caracteres.');
}

if (/[ÃÂ]|\uFFFD/.test(serialized)) {
  throw new Error('El catalogo operativo aun contiene texto con codificacion danada.');
}

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, serialized, 'utf8');

console.log(JSON.stringify({
  outputPath,
  version: catalog.version,
  clients: catalog.clients.length,
  approvedClients: catalog.approvedClientCount,
  folderCodeStats,
  relationshipStats: catalog.relationshipStats,
  technician: catalog.pilot,
}, null, 2));
