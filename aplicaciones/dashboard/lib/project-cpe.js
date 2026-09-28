function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function text(value) {
  return String(value ?? "").trim();
}

function integerIdentity(value) {
  const raw = text(value);
  if (!raw) return "";
  return /^\d+\.0+$/.test(raw) ? raw.split(".")[0] : raw;
}

function serialIdentity(value) {
  return text(value).replace(/\s+/g, "").toUpperCase();
}

function teiIdentity(value) {
  return text(value).replace(/[\s-]+/g, "").toUpperCase();
}

function isPositiveIdentity(value) {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 16777215;
}

function isMarked(value) {
  return normalizeText(value) === "X";
}

function rowHasValues(row, from = 0, to = row.length) {
  return row.slice(from, to).some((value) => text(value));
}

function findTitleRow(rows, phrase) {
  const wanted = normalizeText(phrase);
  return rows.findIndex((row) => row.some((cell) => normalizeText(cell).includes(wanted)));
}

function technicalValue(rows, label) {
  const wanted = normalizeText(label);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    for (let column = 0; column < row.length; column += 1) {
      if (normalizeText(row[column]) !== wanted) continue;
      const below = text((rows[rowIndex + 1] || [])[column]);
      if (below !== "") return below;
      const beside = text(row[column + 1]);
      if (beside !== "") return beside;
    }
  }
  return "";
}

function validateMarks(row, columns, sheetName, sourceRow, errors) {
  for (const col of columns) {
    const value = text(row[col]);
    if (value && !isMarked(value)) {
      errors.push(`${sheetName}, fila ${sourceRow}: use X o vacío en la columna ${col + 1}.`);
    }
  }
}

function parseGroups(labelRow, gssiRow, startColumn, count, prefix, errors, warnings, sheetName) {
  const groups = [];
  const seenGssi = new Map();
  const seenLabels = new Map();
  for (let index = 0; index < count; index += 1) {
    const column = startColumn + index;
    const label = text(labelRow[column]);
    const gssi = integerIdentity(gssiRow[column]);
    if (!label && !gssi) continue;
    const code = `${prefix}${String(index + 1).padStart(2, "0")}`;
    if (!label) errors.push(`${sheetName}: falta el label de ${code}.`);
    if (!gssi) errors.push(`${sheetName}: falta el GSSI de ${code}.`);
    if (label.length > 15) errors.push(`${sheetName}: el label de ${code} supera 15 caracteres (${label}).`);
    if (gssi && !isPositiveIdentity(gssi)) errors.push(`${sheetName}: GSSI inválido en ${code} (${gssi}).`);
    if (gssi && seenGssi.has(gssi)) {
      errors.push(`${sheetName}: el GSSI ${gssi} está repetido en ${seenGssi.get(gssi)} y ${code}.`);
    }
    if (label && seenLabels.has(normalizeText(label))) {
      warnings.push(`${sheetName}: el label ${label} se repite en ${seenLabels.get(normalizeText(label))} y ${code}.`);
    }
    if (gssi) seenGssi.set(gssi, code);
    if (label) seenLabels.set(normalizeText(label), code);
    groups.push({ code, column, label, gssi });
  }
  return groups;
}

function projectMetadata(radios, errors, warnings) {
  const first = radios[0] || {};
  const fields = [
    ["ruc", "RUC"],
    ["razonSocial", "razón social"],
    ["contractRef", "contrato/OC"],
  ];
  for (const [key, label] of fields) {
    const values = [...new Set(radios.map((radio) => normalizeText(radio[key])).filter(Boolean))];
    if (values.length > 1) errors.push(`La plantilla contiene más de un ${label}.`);
  }
  if (!first.razonSocial) errors.push("Falta la razón social en la primera radio registrada.");
  if (!first.ruc) warnings.push("La solicitud no indica RUC.");
  return {
    fechaSolicitud: first.fechaSolicitud || "",
    ruc: first.ruc || "",
    razonSocial: first.razonSocial || "",
    contractRef: first.contractRef || "",
  };
}

function parseProjectCpeSheets(sheetRows) {
  const errors = [];
  const warnings = [];
  const requiredSheets = ["PLANTILLA", "ESCANEO", "DMO", "OP CAMPOS"];
  for (const name of requiredSheets) {
    if (!sheetRows.has(name)) errors.push(`Falta la hoja obligatoria ${name}.`);
  }
  if (errors.length) return { valid: false, schemaVersion: "", errors, warnings, request: null };

  const schemaRows = sheetRows.get("OP CAMPOS");
  const schemaVersion = schemaRows.flat().map(text).find((value) => /^CLIENTE_CPE_V\d+$/.test(value)) || "";
  const layouts = {
    CLIENTE_CPE_V3: {
      model: 7,
      area: 8,
      groupStart: 9,
      featureStart: 19,
      totalColumns: 32,
      requireInternalIdentities: false,
    },
    CLIENTE_CPE_V4: {
      serial: 7,
      tei: 8,
      model: 9,
      area: 10,
      groupStart: 11,
      featureStart: 21,
      totalColumns: 34,
      requireInternalIdentities: true,
    },
    CLIENTE_CPE_V5: {
      serial: 7,
      tei: 8,
      model: 9,
      area: 10,
      groupStart: 11,
      featureStart: 21,
      totalColumns: 34,
      requireInternalIdentities: true,
      contactNameColumn: 5,
    },
    CLIENTE_CPE_V6: {
      serial: 7,
      tei: 8,
      model: 9,
      area: 10,
      groupStart: 11,
      featureStart: 21,
      totalColumns: 35,
      requireInternalIdentities: true,
      contactNameColumn: 5,
      gpsGatewayOffset: 9,
      booleanFeatureOffsets: [2, 3, 4, 5, 6, 8, 10, 11, 12],
    },
    CLIENTE_CPE_V7: {
      serial: 7,
      tei: 8,
      model: 9,
      area: 10,
      groupStart: 11,
      requireInternalIdentities: true,
      contactNameColumn: 5,
      gpsGatewayOffset: 9,
      booleanFeatureOffsets: [2, 3, 4, 5, 6, 8, 10, 11, 12],
    },
  };
  let layout = layouts[schemaVersion];
  if (!layout) {
    errors.push(`Versión de plantilla no soportada: ${schemaVersion || "no identificada"}.`);
  }

  let groupCount = 10;
  let dmoGroupCount = 10;
  if (schemaVersion === "CLIENTE_CPE_V7") {
    const configuredGroups = technicalValue(schemaRows, "GROUPS");
    const configuredDmoGroups = technicalValue(schemaRows, "DMO_GROUPS");
    if (!/^\d+$/.test(configuredGroups) || Number(configuredGroups) < 1 || Number(configuredGroups) > 100) {
      errors.push("OP CAMPOS: GROUPS debe ser un entero entre 1 y 100.");
    } else {
      groupCount = Number(configuredGroups);
    }
    if (!/^\d+$/.test(configuredDmoGroups) || Number(configuredDmoGroups) < 0 || Number(configuredDmoGroups) > 50) {
      errors.push("OP CAMPOS: DMO_GROUPS debe ser un entero entre 0 y 50.");
    } else {
      dmoGroupCount = Number(configuredDmoGroups);
    }
    layout = {
      ...layout,
      featureStart: layout.groupStart + groupCount,
      totalColumns: layout.groupStart + groupCount + 14,
    };
  }

  const mainRows = sheetRows.get("PLANTILLA");
  const scanRows = sheetRows.get("ESCANEO");
  const dmoRows = sheetRows.get("DMO");
  const mainTitle = findTitleRow(mainRows, "PLANTILLA DE PROGRAMACION");
  const scanTitle = findTitleRow(scanRows, "ASIGNACION DE GRUPOS - ESCANEO");
  const dmoTitle = findTitleRow(dmoRows, "ASIGNACION DE GRUPOS - DMO");
  if (mainTitle < 0) errors.push("No se encontró el encabezado de la hoja PLANTILLA.");
  if (scanTitle < 0) errors.push("No se encontró el encabezado de la hoja ESCANEO.");
  if (dmoTitle < 0) errors.push("No se encontró el encabezado de la hoja DMO.");
  if (errors.length) return { valid: false, schemaVersion, errors, warnings, request: null };

  const groupStart = layout.groupStart;
  const groupColumns = Array.from({ length: groupCount }, (_, index) => groupStart + index);
  const mainLabelRow = mainRows[mainTitle + 1] || [];
  const mainGssiRow = mainRows[mainTitle + 2] || [];
  const groups = parseGroups(mainLabelRow, mainGssiRow, groupStart, groupCount, "G", errors, warnings, "PLANTILLA");
  if (!groups.length) errors.push("Debe definir al menos un grupo TMO.");

  const dmoLabelRow = dmoRows[dmoTitle + 1] || [];
  const dmoGssiRow = dmoRows[dmoTitle + 2] || [];
  const dmoGroups = parseGroups(dmoLabelRow, dmoGssiRow, 4, dmoGroupCount, "D", errors, warnings, "DMO");
  const dmoColumns = Array.from({ length: dmoGroupCount }, (_, index) => 4 + index);

  const mainDataStart = mainTitle + 3;
  const scanDataStart = scanTitle + 3;
  const dmoDataStart = dmoTitle + 3;
  const radios = [];
  const seenRadioIds = new Map();
  const seenContactNames = new Map();
  const seenIssis = new Map();
  const seenSerials = new Map();
  const seenTeis = new Map();
  const booleanFeatureOffsets = layout.booleanFeatureOffsets || [2, 3, 4, 5, 6, 8, 9, 10, 11];
  const booleanColumns = booleanFeatureOffsets.map((offset) => layout.featureStart + offset);

  for (let rowIndex = mainDataStart; rowIndex < mainRows.length; rowIndex += 1) {
    const row = mainRows[rowIndex] || [];
    if (!rowHasValues(row, 1, layout.totalColumns)) continue;
    const sourceRow = rowIndex - mainTitle + 3;
    const radioId = layout.contactNameColumn === undefined ? text(row[5]) : "";
    const contactName = layout.contactNameColumn === undefined ? "" : text(row[layout.contactNameColumn]);
    const issi = integerIdentity(row[6]);
    const serial = layout.serial === undefined ? "" : serialIdentity(row[layout.serial]);
    const tei = layout.tei === undefined ? "" : teiIdentity(row[layout.tei]);
    if (layout.contactNameColumn === undefined && !radioId) errors.push(`PLANTILLA, fila ${sourceRow}: falta ID / N° RADIO.`);
    if (layout.contactNameColumn === undefined && radioId && seenRadioIds.has(normalizeText(radioId))) {
      errors.push(`PLANTILLA, fila ${sourceRow}: ID de radio repetido (${radioId}).`);
    }
    if (contactName.length > 12) errors.push(`PLANTILLA, fila ${sourceRow}: el nombre en agenda supera 12 caracteres (${contactName}).`);
    if (contactName && seenContactNames.has(normalizeText(contactName))) {
      errors.push(`PLANTILLA, fila ${sourceRow}: nombre en agenda repetido (${contactName}).`);
    }
    if (issi && !isPositiveIdentity(issi)) errors.push(`PLANTILLA, fila ${sourceRow}: ISSI inválido (${issi}).`);
    if (issi && seenIssis.has(issi)) errors.push(`PLANTILLA, fila ${sourceRow}: ISSI repetido (${issi}).`);
    if (layout.requireInternalIdentities && !issi) errors.push(`PLANTILLA, fila ${sourceRow}: falta ISSI de uso interno.`);
    if (layout.requireInternalIdentities && !serial) errors.push(`PLANTILLA, fila ${sourceRow}: falta SERIE de uso interno.`);
    if (layout.requireInternalIdentities && !tei) errors.push(`PLANTILLA, fila ${sourceRow}: falta TEI de uso interno.`);
    if (serial && !/^[A-Z0-9]{5,20}$/.test(serial)) {
      errors.push(`PLANTILLA, fila ${sourceRow}: SERIE inválida (${serial}).`);
    }
    if (tei && !/^[0-9A-F]{15}$/.test(tei)) {
      errors.push(`PLANTILLA, fila ${sourceRow}: TEI inválido; debe contener 15 caracteres hexadecimales (${tei}).`);
    }
    if (serial && seenSerials.has(serial)) errors.push(`PLANTILLA, fila ${sourceRow}: SERIE repetida (${serial}).`);
    if (tei && seenTeis.has(tei)) errors.push(`PLANTILLA, fila ${sourceRow}: TEI repetido (${tei}).`);
    if (radioId) seenRadioIds.set(normalizeText(radioId), sourceRow);
    if (contactName) seenContactNames.set(normalizeText(contactName), sourceRow);
    if (issi) seenIssis.set(issi, sourceRow);
    if (serial) seenSerials.set(serial, sourceRow);
    if (tei) seenTeis.set(tei, sourceRow);

    validateMarks(row, groupColumns, "PLANTILLA", sourceRow, errors);
    validateMarks(row, booleanColumns, "PLANTILLA", sourceRow, errors);
    const assignedGroups = groups.filter((group) => isMarked(row[group.column])).map(({ column, ...group }) => group);
    for (const column of groupColumns) {
      if (isMarked(row[column]) && !groups.some((group) => group.column === column)) {
        errors.push(`PLANTILLA, fila ${sourceRow}: hay una X en un grupo sin label/GSSI.`);
      }
    }

    const emergencyRaw = normalizeText(row[layout.featureStart]);
    const emergencyMode = emergencyRaw || "INACTIVO";
    if (!["TACTICO", "NO TACTICO", "INACTIVO"].includes(emergencyMode)) {
      errors.push(`PLANTILLA, fila ${sourceRow}: modo de emergencia inválido (${text(row[layout.featureStart])}).`);
    }
    const emergencyGssi = integerIdentity(row[layout.featureStart + 1]);
    if (emergencyGssi && !isPositiveIdentity(emergencyGssi)) {
      errors.push(`PLANTILLA, fila ${sourceRow}: GSSI de emergencia inválido (${emergencyGssi}).`);
    }
    if (emergencyMode === "NO TACTICO" && !emergencyGssi) {
      errors.push(`PLANTILLA, fila ${sourceRow}: emergencia NO TÁCTICO requiere GSSI.`);
    }
    if (emergencyMode !== "NO TACTICO" && emergencyGssi) {
      warnings.push(`PLANTILLA, fila ${sourceRow}: el GSSI de emergencia se ignorará porque el modo no es NO TÁCTICO.`);
    }

    const broadcastListen = isMarked(row[layout.featureStart + 6]);
    const broadcastGssi = integerIdentity(row[layout.featureStart + 7]);
    if (broadcastGssi && !isPositiveIdentity(broadcastGssi)) {
      errors.push(`PLANTILLA, fila ${sourceRow}: GSSI Broadcast inválido (${broadcastGssi}).`);
    }
    if (broadcastListen && !broadcastGssi) {
      errors.push(`PLANTILLA, fila ${sourceRow}: Broadcast escucha requiere GSSI destino.`);
    }
    if (!broadcastListen && broadcastGssi) {
      warnings.push(`PLANTILLA, fila ${sourceRow}: el GSSI Broadcast se ignorará porque escucha no está marcada.`);
    }

    const gpsEnabled = isMarked(row[layout.featureStart + 8]);
    const gpsGatewayIssi = layout.gpsGatewayOffset === undefined
      ? ""
      : integerIdentity(row[layout.featureStart + layout.gpsGatewayOffset]);
    if (gpsEnabled && gpsGatewayIssi && !isPositiveIdentity(gpsGatewayIssi)) {
      errors.push(`PLANTILLA, fila ${sourceRow}: ISSI Gateway GPS inválido (${gpsGatewayIssi}).`);
    }
    if (layout.gpsGatewayOffset !== undefined && gpsEnabled && !gpsGatewayIssi) {
      errors.push(`PLANTILLA, fila ${sourceRow}: GPS está activo pero falta ISSI Gateway GPS.`);
    }
    if (!gpsEnabled && gpsGatewayIssi) {
      warnings.push(`PLANTILLA, fila ${sourceRow}: el ISSI Gateway GPS se ignorará porque GPS no está marcado.`);
    }

    const detailOffset = rowIndex - mainDataStart;
    const scanRow = scanRows[scanDataStart + detailOffset] || [];
    const dmoRow = dmoRows[dmoDataStart + detailOffset] || [];
    validateMarks(scanRow, dmoColumns, "ESCANEO", sourceRow, errors);
    validateMarks(dmoRow, dmoColumns, "DMO", sourceRow, errors);
    const scanGroups = groups.filter((group, index) => isMarked(scanRow[4 + index])).map(({ column, ...group }) => group);
    const assignedDmoGroups = dmoGroups.filter((group, index) => isMarked(dmoRow[4 + index])).map(({ column, ...group }) => group);
    const scanEnabled = isMarked(row[layout.featureStart + 4]);
    const dmoEnabled = isMarked(row[layout.featureStart + 5]);
    if (scanEnabled && !scanGroups.length) errors.push(`PLANTILLA, fila ${sourceRow}: Escaneo está activo pero no tiene grupos en la hoja ESCANEO.`);
    if (!scanEnabled && scanGroups.length) errors.push(`PLANTILLA, fila ${sourceRow}: tiene grupos en ESCANEO pero la función no está marcada.`);
    if (dmoEnabled && !assignedDmoGroups.length) errors.push(`PLANTILLA, fila ${sourceRow}: DMO está activo pero no tiene grupos en la hoja DMO.`);
    if (!dmoEnabled && assignedDmoGroups.length) errors.push(`PLANTILLA, fila ${sourceRow}: tiene grupos DMO asignados pero la función no está marcada.`);

    radios.push({
      sourceRow,
      fechaSolicitud: text(row[1]),
      ruc: text(row[2]),
      razonSocial: text(row[3]),
      contractRef: text(row[4]),
      radioId,
      contactName,
      issi,
      serial,
      tei,
      model: text(row[layout.model]),
      area: text(row[layout.area]),
      groups: assignedGroups,
      emergency: {
        mode: emergencyMode === "TACTICO" ? "TÁCTICO" : emergencyMode === "NO TACTICO" ? "NO TÁCTICO" : "INACTIVO",
        gssi: emergencyMode === "NO TACTICO" ? emergencyGssi : "",
      },
      functions: {
        privateCall: isMarked(row[layout.featureStart + 2]),
        callCut: isMarked(row[layout.featureStart + 3]),
        scan: scanEnabled,
        dmo: dmoEnabled,
        broadcastListen,
        broadcastGssi: broadcastListen ? broadcastGssi : "",
        gps: gpsEnabled,
        gpsGatewayIssi: gpsEnabled ? gpsGatewayIssi : "",
        otap: isMarked(row[layout.featureStart + (layout.gpsGatewayOffset === undefined ? 9 : 10)]),
        gpsReport: isMarked(row[layout.featureStart + (layout.gpsGatewayOffset === undefined ? 10 : 11)]),
        manDown: isMarked(row[layout.featureStart + (layout.gpsGatewayOffset === undefined ? 11 : 12)]),
        coverage: text(row[layout.featureStart + (layout.gpsGatewayOffset === undefined ? 12 : 13)]),
      },
      scanGroups,
      dmoGroups: assignedDmoGroups,
    });
  }

  if (!radios.length) errors.push("La plantilla no contiene radios.");
  const metadata = projectMetadata(radios, errors, warnings);
  if (dmoGroups.length && !radios.some((radio) => radio.functions.dmo)) {
    warnings.push("Se definieron grupos DMO, pero ninguna radio tiene DMO activo.");
  }
  const request = {
    schemaVersion,
    metadata,
    capacities: { tmoGroups: groupCount, dmoGroups: dmoGroupCount },
    groups: groups.map(({ column, ...group }) => group),
    dmoGroups: dmoGroups.map(({ column, ...group }) => group),
    radios,
  };
  if (["CLIENTE_CPE_V3", "CLIENTE_CPE_V4", "CLIENTE_CPE_V5"].includes(schemaVersion)) {
    errors.push(`La plantilla ${schemaVersion.replace("CLIENTE_CPE_", "")} ya no puede registrarse: descarga la plantilla V7, que incluye gateway GPS y grupos dinámicos.`);
  }
  return {
    valid: errors.length === 0,
    schemaVersion,
    errors,
    warnings,
    summary: {
      razonSocial: metadata.razonSocial,
      ruc: metadata.ruc,
      contractRef: metadata.contractRef,
      radios: radios.length,
      groups: groups.length,
      dmoGroups: dmoGroups.length,
      scanRadios: radios.filter((radio) => radio.functions.scan).length,
      dmoRadios: radios.filter((radio) => radio.functions.dmo).length,
      gpsRadios: radios.filter((radio) => radio.functions.gps).length,
      gpsGatewayRadios: radios.filter((radio) => radio.functions.gps && radio.functions.gpsGatewayIssi).length,
      identifiedRadios: radios.filter((radio) => radio.issi && radio.serial && radio.tei).length,
      contacts: radios.filter((radio) => radio.contactName).length,
    },
    request,
  };
}

module.exports = { parseProjectCpeSheets };
