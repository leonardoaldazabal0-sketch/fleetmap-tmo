const fs = require("fs");
const path = require("path");

const app = require("../server");
const features = require("../lib/cpe-features");
const { CONTACT_LAYOUTS_BY_CPS_SIZE } = require("../lib/cpe-contacts");

const outputFile = path.resolve(process.argv[2] || path.join(__dirname, "..", "parser-coverage-audit.json"));
const CAPABILITIES = ["Grupos TMO", "Emergencia", "Escaneo", "DMO", "Broadcast", "GPS", "OTAP", "Agenda"];

function supportedState(readable, valid) {
  if (!valid) return "SIN CPE VÁLIDO";
  if (readable >= valid) return "SOPORTADO";
  if (readable > 0) return "PARCIAL";
  return "NO SOPORTADO";
}

function knownCpsLengths() {
  const values = new Set();
  const addKeys = (object) => Object.keys(object || {}).forEach((key) => values.add(Number(key)));
  addKeys(app.LAYOUTS_BY_CPS_SIZE);
  for (const layouts of Object.values(app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE || {})) addKeys(layouts);
  addKeys(app.EMERGENCY_LAYOUTS_BY_CPS_SIZE);
  addKeys(features.SCAN_INDICATOR_OFFSETS);
  addKeys(features.DMO_INDICATOR_OFFSETS);
  addKeys(features.GPS_INDICATOR_OFFSETS);
  addKeys(features.GPS_DESTINATION_OFFSETS);
  addKeys(features.OTAP_INDICATOR_OFFSETS);
  addKeys(features.OTAP_TABLES);
  addKeys(features.BROADCAST_LAYOUTS);
  for (const value of features.OTAP_UNSUPPORTED_CPS_LENGTHS) values.add(Number(value));
  for (const value of CONTACT_LAYOUTS_BY_CPS_SIZE.keys()) values.add(Number(value));
  return values;
}

function supportsTalkgroups(codeplug, cpsLength) {
  if (!Number.isFinite(cpsLength)) return false;
  if (app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE?.[codeplug]?.[cpsLength]) return true;
  if ([2728576, 3086720, 4859968].includes(cpsLength)) return true;
  if (app.LAYOUTS_BY_CPS_SIZE?.[cpsLength]) return true;
  return false;
}

function requiredFiles(pending) {
  const requirements = [];
  if (pending.includes("Grupos TMO")) requirements.push("CPE + User Report con grupos programados e invisibles");
  if (pending.includes("Emergencia")) requirements.push("pares CPE/User Report táctico y no táctico");
  if (pending.includes("Escaneo")) requirements.push("pares CPE/User Report Escaneo OFF/ON");
  if (pending.includes("DMO")) requirements.push("pares CPE/User Report DMO OFF/ON con grupo DMO");
  if (pending.includes("Broadcast")) requirements.push("pares CPE/User Report Broadcast inactivo/escucha");
  if (pending.includes("GPS")) requirements.push("pares CPE/User Report GPS OFF/ON con gateway");
  if (pending.includes("OTAP")) requirements.push("pares CPE/User Report OTAP OFF/ON con ITSI autorizadas");
  if (pending.includes("Agenda")) requirements.push("CPE + User Report con al menos 2 contactos");
  return requirements.join("; ");
}

function main() {
  const db = app.database.db;
  const variants = db.prepare(`
    SELECT
      COALESCE(NULLIF(codeplug,''), 'SIN CP') AS codeplug,
      COALESCE(NULLIF(software,''), 'SIN VERSIÓN') AS software,
      COALESCE(NULLIF(cpeVersion,''), 'SIN DATO') AS cpeVersion,
      size,
      COUNT(*) AS indexedFiles,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' THEN 1 ELSE 0 END) AS validFiles,
      SUM(CASE WHEN COALESCE(errorMessage,'')<>'' THEN 1 ELSE 0 END) AS errorFiles,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' AND emergencySupported=1 THEN 1 ELSE 0 END) AS emergencyReadable,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' AND json_valid(featuresJson)
        AND json_extract(featuresJson,'$.scan.state') IN ('Activo','Inactivo') THEN 1 ELSE 0 END) AS scanReadable,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' AND json_valid(featuresJson)
        AND json_extract(featuresJson,'$.dmo.state') IN ('Activo','Inactivo') THEN 1 ELSE 0 END) AS dmoReadable,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' AND json_valid(featuresJson)
        AND json_extract(featuresJson,'$.broadcast.state') IN ('Solo escucha','Inactivo','Revisar') THEN 1 ELSE 0 END) AS broadcastReadable,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' AND json_valid(featuresJson)
        AND json_extract(featuresJson,'$.gps.state') IN ('Activo','Inactivo') THEN 1 ELSE 0 END) AS gpsReadable,
      SUM(CASE WHEN COALESCE(errorMessage,'')='' AND json_valid(featuresJson)
        AND json_extract(featuresJson,'$.otap.state') IN ('Activo','Inactivo') THEN 1 ELSE 0 END) AS otapReadable,
      MIN(CASE WHEN COALESCE(errorMessage,'')='' AND COALESCE(issi,'')<>'' THEN issi END) AS exampleIssi,
      MIN(CASE WHEN COALESCE(errorMessage,'')='' THEN path END) AS examplePath
    FROM scanned_files
    WHERE existsFlag=1
    GROUP BY COALESCE(NULLIF(codeplug,''), 'SIN CP'),
      COALESCE(NULLIF(software,''), 'SIN VERSIÓN'),
      COALESCE(NULLIF(cpeVersion,''), 'SIN DATO'), size
  `).all();

  const representatives = db.prepare(`
    SELECT size, path FROM (
      SELECT size, path,
        ROW_NUMBER() OVER (PARTITION BY size ORDER BY
          CASE WHEN COALESCE(errorMessage,'')='' THEN 0 ELSE 1 END,
          dateKey DESC, mtimeMs DESC) AS rowNumber
      FROM scanned_files WHERE existsFlag=1
    ) WHERE rowNumber <= 3
    ORDER BY size, rowNumber
  `).all();
  const representativesBySize = new Map();
  for (const item of representatives) {
    if (!representativesBySize.has(item.size)) representativesBySize.set(item.size, []);
    representativesBySize.get(item.size).push(item.path);
  }

  const knownLengths = knownCpsLengths();
  const cpsByFileSize = new Map();
  for (const fileSize of [...new Set(variants.map((row) => Number(row.size)))]) {
    const knownCandidates = [fileSize - 86, fileSize - 87].filter((candidate) => knownLengths.has(candidate));
    if (knownCandidates.length === 1) {
      cpsByFileSize.set(fileSize, knownCandidates[0]);
      continue;
    }
    let detected = null;
    for (const filePath of representativesBySize.get(fileSize) || []) {
      try {
        detected = app.parseCpeSections(filePath).sections.CPS?.length || null;
        if (detected) break;
      } catch {
        // Try another representative of the same physical file size.
      }
    }
    cpsByFileSize.set(fileSize, detected || knownCandidates[0] || null);
  }

  const rows = variants.map((variant) => {
    const valid = Number(variant.validFiles || 0);
    const cpsLength = cpsByFileSize.get(Number(variant.size));
    const readable = {
      "Grupos TMO": supportsTalkgroups(variant.codeplug === "SIN CP" ? "" : variant.codeplug, cpsLength) ? valid : 0,
      Emergencia: Number(variant.emergencyReadable || 0),
      Escaneo: Number(variant.scanReadable || 0),
      DMO: Number(variant.dmoReadable || 0),
      Broadcast: Number(variant.broadcastReadable || 0),
      GPS: Number(variant.gpsReadable || 0),
      OTAP: Number(variant.otapReadable || 0),
      Agenda: CONTACT_LAYOUTS_BY_CPS_SIZE.has(cpsLength) ? valid : 0,
    };
    const coverage = Object.fromEntries(CAPABILITIES.map((name) => [name, supportedState(readable[name], valid)]));
    const pending = CAPABILITIES.filter((name) => coverage[name] !== "SOPORTADO");
    return {
      codeplug: variant.codeplug,
      software: variant.software,
      cpeVersion: variant.cpeVersion,
      cpsLength,
      physicalFileSize: Number(variant.size),
      indexedFiles: Number(variant.indexedFiles || 0),
      validFiles: valid,
      errorFiles: Number(variant.errorFiles || 0),
      exampleIssi: variant.exampleIssi || "",
      examplePath: variant.examplePath || "",
      readable,
      coverage,
      pending,
      requiredFiles: requiredFiles(pending),
    };
  }).sort((left, right) => {
    const leftPending = left.pending.length ? left.validFiles : -1;
    const rightPending = right.pending.length ? right.validFiles : -1;
    return rightPending - leftPending
      || Number(left.codeplug.replace(/\D/g, "") || 99999) - Number(right.codeplug.replace(/\D/g, "") || 99999)
      || left.software.localeCompare(right.software);
  });

  const namedRows = rows.filter((row) => row.codeplug !== "SIN CP");
  const familyNames = [...new Set(namedRows.map((row) => row.codeplug))];
  const capabilities = CAPABILITIES.map((name) => {
    const statusCounts = Object.fromEntries(["SOPORTADO", "PARCIAL", "NO SOPORTADO", "SIN CPE VÁLIDO"].map((status) => [status, namedRows.filter((row) => row.coverage[name] === status).length]));
    const validFiles = namedRows.reduce((sum, row) => sum + row.validFiles, 0);
    const readableFiles = namedRows.reduce((sum, row) => sum + row.readable[name], 0);
    const familiesWithGaps = new Set(namedRows.filter((row) => row.coverage[name] !== "SOPORTADO").map((row) => row.codeplug)).size;
    return {
      name,
      ...statusCounts,
      familiesWithGaps,
      readableFiles,
      pendingFiles: Math.max(0, validFiles - readableFiles),
      coveragePercent: validFiles ? Number((readableFiles * 100 / validFiles).toFixed(2)) : 0,
    };
  });

  const families = familyNames.map((codeplug) => {
    const familyRows = namedRows.filter((row) => row.codeplug === codeplug);
    const coverage = {};
    for (const name of CAPABILITIES) {
      const states = new Set(familyRows.map((row) => row.coverage[name]));
      coverage[name] = states.size === 1 && states.has("SOPORTADO")
        ? "SOPORTADO"
        : states.has("SOPORTADO") || states.has("PARCIAL") ? "PARCIAL" : "NO SOPORTADO";
    }
    return {
      codeplug,
      variants: familyRows.length,
      validFiles: familyRows.reduce((sum, row) => sum + row.validFiles, 0),
      errorFiles: familyRows.reduce((sum, row) => sum + row.errorFiles, 0),
      coverage,
      pending: CAPABILITIES.filter((name) => coverage[name] !== "SOPORTADO"),
    };
  }).sort((left, right) => right.validFiles - left.validFiles || Number(left.codeplug) - Number(right.codeplug));

  const payload = {
    generatedAt: new Date().toISOString(),
    databasePath: app.database.filePath,
    definitions: {
      supported: "Todos los CPE válidos de esa familia/versión entregan un estado verificable.",
      partial: "Solo una parte de los CPE válidos entrega información verificable.",
      unsupported: "Ningún CPE válido de esa familia/versión se puede verificar para esa función.",
    },
    summary: {
      namedFamilies: familyNames.length,
      familyVersionVariants: namedRows.length,
      validFiles: namedRows.reduce((sum, row) => sum + row.validFiles, 0),
      errorFiles: namedRows.reduce((sum, row) => sum + row.errorFiles, 0),
      unknownFamilyVariants: rows.filter((row) => row.codeplug === "SIN CP").length,
    },
    capabilities,
    families,
    rows,
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2), "utf8");
  console.log(JSON.stringify({ outputFile, ...payload.summary, capabilities }, null, 2));
}

try {
  main();
} finally {
  app.database.close();
}
