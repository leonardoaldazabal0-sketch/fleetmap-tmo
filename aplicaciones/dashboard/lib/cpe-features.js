const { featuresFromValidatedReport } = require("./validated-user-report-features");

const GPS_DESTINATION_OFFSETS = {
  1787008: 1315364,
  2538688: 2062404,
  2849984: 2081604,
  3087360: 2187076,
  3159936: 2259588,
  4738944: 2282820,
  4861952: 2404932,
  5263232: 2688772,
};

// Indicador "Rastreo de grupos de conversacion". Cada posicion fue aislada
// comparando una base inactiva con una copia donde solo se activo Escaneo y
// validando ambos CPE contra sus respectivos User Reports.
const SCAN_INDICATOR_OFFSETS = {
  1064192: 2718, // CP7492 R13
  1079232: 2668, // CP7715 R13
  2535552: 2716, // CP0778 R35
  2728576: 2742, // CP1020 R35
  3021888: 2742, // CP1274 R55
  4859968: 2746, // CP1330/CP1315 R36
  4862464: 2746, // CP1511 R35
  4997184: 2746, // CP1649 R35/R36
  5066880: 2746, // CP1726 R35
};

// Indicadores de la lista "Indicadores de funciones" del CPS. Los nombres
// visibles se mantienen como "Modo directo (DMO)" y "GPS" en los User Report
// R13-R55 revisados, aunque la posicion binaria cambia entre generaciones.
// Las posiciones se validaron con pares CPE/User Report y, para las revisiones
// de una misma arquitectura, con alineacion exacta de sus bloques CPS.
const DMO_INDICATOR_OFFSETS = {
  1064192: 2712,
  1079232: 2662,
  1787008: 2666,
  2535552: 2710,
  2538688: 2710,
  2728576: 2736,
  2848576: 2740,
  2849984: 2736,
  3021888: 2736,
  3087360: 2740,
  3144064: 2740,
  3159936: 2740,
  3222528: 2740,
  3276480: 2740,
  3346368: 2740,
  4738944: 2736,
  4739776: 2736,
  4859968: 2740,
  4861952: 2740,
  4862464: 2740,
  4997184: 2740,
  5066880: 2740,
  5263232: 2804,
};

// GPS no comparte posicion con DMO. El supuesto historico DMO + 2 produjo
// falsos estados, por lo que solo se conservan posiciones aisladas activando
// exclusivamente GPS en pares controlados CPE/User Report.
const GPS_INDICATOR_OFFSETS = {
  1064192: 2836,
  1079232: 2840,
  2535552: 2886,
  2728576: 2912,
  3021888: 2912,
  4859968: 2916,
  4862464: 2920,
  4997184: 2920,
  5066880: 2924,
};

const OTAP_TABLES = {
  // La etiqueta cambia entre "OTAP" y "OTAP LMR" segun la version del CPS,
  // pero todas estas tablas representan la misma lista "ITSI autorizadas".
  // Cada posicion fue validada en varios CPE de la misma longitud; no se
  // extrapola por familia ni por nombre de archivo.
  2728576: { offset: 218692, maxRecords: 2000 },
  3021888: { offset: 143264, maxRecords: 2000 },
  3144064: { offset: 142272, maxRecords: 2000 },
  3276480: { offset: 142956, maxRecords: 2000 },
  3346368: { offset: 143124, maxRecords: 2000 },
  4739776: { offset: 143260, maxRecords: 2000 },
  4859968: { offset: 141948, maxRecords: 2000 },
  4861952: { offset: 142100, maxRecords: 2000 },
  4862464: { offset: 142248, maxRecords: 2000 },
  4997184: { offset: 160296, maxRecords: 2000 },
  5066880: { offset: 160464, maxRecords: 2000 },
  5263232: { offset: 162392, maxRecords: 2000 },
};

// Indicadores OTAP de la lista de funciones. CP1020 expone "OTAP con SDS"
// (clave CPS 61030) en 2839. Esta posicion distingue dos User Report activos,
// uno inactivo y el CPE 53031 verificado manualmente como inactivo. El valor
// anterior 3152 pertenece a otro parametro y producia falsos positivos.
// Las estructuras nuevas pueden exponer "OTAP LMR" (clave CPS 61031), pero
// su posicion no es uniforme. No se extrapola a otra longitud aunque tenga
// la misma etiqueta o una tabla de ITSI autorizadas compatible.
const OTAP_INDICATOR_OFFSETS = {
  2728576: 2839,
  3021888: 2839,
  4859968: 2843,
  4862464: 2843,
  4997184: 2843,
  5066880: 2843,
};

// Estas versiones no exponen OTAP en "Indicadores de funciones". La ausencia
// fue confirmada tanto en la base como en todas sus variantes controladas.
const OTAP_UNSUPPORTED_CPS_LENGTHS = new Set([1064192, 1079232, 2535552]);

// Posiciones confirmadas con User Report 56562 y con el par CP1726 habla /
// escucha 23000-23008. El destino guarda la posicion de la lista de grupos,
// no el GSSI ni el indice de la tabla principal.
const BROADCAST_LAYOUTS = {
  // CP7492 R13: esta generación no expone la dirección en el User Report.
  1064192: {
    indicatorOffset: 2769,
    activeIndicatorValue: 1,
    destinationPositionOffset: 5250,
    priorityOffset: 5261,
    announcementAliasOffset: 5300,
    announcementAliasBytes: 60,
    mainOffset: 244496,
    mainRecordSize: 52,
    mainAliasBytes: 24,
  },
  // CP0778 R35.
  2535552: {
    indicatorOffset: 2768,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9066,
    priorityOffset: 9077,
    announcementAliasOffset: 9116,
    announcementAliasBytes: 60,
    mainOffset: 751776,
    mainRecordSize: 56,
    mainAliasBytes: 24,
  },
  // CP1020 R35/R36.
  2728576: {
    indicatorOffset: 2794,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9110,
    priorityOffset: 9121,
    announcementAliasOffset: 9164,
    announcementAliasBytes: 60,
    mainOffset: 776088,
    mainRecordSize: 56,
    mainAliasBytes: 24,
  },
  // CP1315/CP1330 R27.
  2848576: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9794,
    priorityOffset: 9805,
    announcementAliasOffset: 9848,
    announcementAliasBytes: 60,
    mainOffset: 814728,
    mainRecordSize: 56,
    mainAliasBytes: 24,
  },
  // CP1274 R27.
  2849984: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9786,
    priorityOffset: 9797,
    announcementAliasOffset: 9840,
    announcementAliasBytes: 60,
    mainOffset: 816200,
    mainRecordSize: 56,
    mainAliasBytes: 24,
  },
  // CP1274 R55.
  3021888: {
    indicatorOffset: 2794,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9786,
    priorityOffset: 9797,
    announcementAliasOffset: 9840,
    announcementAliasBytes: 60,
    mainOffset: 816720,
    mainRecordSize: 56,
    mainAliasBytes: 24,
    destinationUsesContinuousOrdinal: true,
  },
  // CP1315/CP1330 R55.
  3144064: {
    indicatorOffset: 2746,
    activeIndicatorValue: 0,
    destinationPositionOffset: 9794,
    priorityOffset: 9805,
    announcementAliasOffset: 9848,
    announcementAliasBytes: 60,
    mainOffset: 815304,
    mainRecordSize: 64,
    mainAliasBytes: 32,
  },
  // CP1726 R27.
  3159936: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9814,
    priorityOffset: 9825,
    announcementAliasOffset: 9868,
    announcementAliasBytes: 60,
    mainOffset: 815628,
    mainRecordSize: 68,
    mainAliasBytes: 32,
  },
  // CP1274 R36.
  4739776: {
    indicatorOffset: 2740,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9786,
    priorityOffset: 9797,
    announcementAliasOffset: 9840,
    announcementAliasBytes: 60,
    mainOffset: 971328,
    mainRecordSize: 56,
    mainAliasBytes: 24,
  },
  // CP1315/CP1330 R36.
  4859968: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9794,
    priorityOffset: 9805,
    announcementAliasOffset: 9848,
    announcementAliasBytes: 60,
    mainOffset: 969984,
    mainRecordSize: 64,
    mainAliasBytes: 32,
  },
  // CP1511 R35. Los ejemplos incompletos conservan prioridad y alias.
  4862464: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9810,
    priorityOffset: 9821,
    announcementAliasOffset: 9864,
    announcementAliasBytes: 60,
    mainOffset: 970308,
    mainRecordSize: 64,
    mainAliasBytes: 32,
  },
  // CP1649 R35/R36.
  4997184: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9810,
    priorityOffset: 9821,
    announcementAliasOffset: 9864,
    announcementAliasBytes: 60,
    mainOffset: 988356,
    mainRecordSize: 64,
    mainAliasBytes: 32,
  },
  5066880: {
    indicatorOffset: 2798,
    activeIndicatorValue: 1,
    destinationPositionOffset: 9814,
    priorityOffset: 9825,
    announcementAliasOffset: 9868,
    announcementAliasBytes: 60,
    mainOffset: 988548,
    mainRecordSize: 68,
    mainAliasBytes: 32,
  },
  // CP7715 R13. La direccion se conserva aunque el indicador este apagado;
  // el grupo ALERTA validado es el unico grupo invisible de rastreo continuo.
  1079232: {
    indicatorOffset: 2718,
    activeIndicatorValue: 1,
    destinationPositionOffset: 5398,
    priorityOffset: 5409,
    announcementAliasOffset: 5448,
    announcementAliasBytes: 60,
    mainOffset: 245452,
    mainRecordSize: 52,
    mainAliasBytes: 24,
    allowUniqueContinuousGroup: true,
  },
  5263232: {
    indicatorOffset: 2746,
    activeIndicatorValue: 0,
    destinationPositionOffset: 9882,
    priorityOffset: 9893,
    announcementAliasOffset: 9936,
    announcementAliasBytes: 60,
    mainOffset: 990468,
    mainRecordSize: 68,
    mainAliasBytes: 32,
  },
};

function unavailableFeatures() {
  return {
    source: "",
    scan: { state: "No disponible", activeList: "", lists: [] },
    dmo: { state: "No disponible", groups: [] },
    broadcast: {
      state: "No disponible",
      alias: "",
      gssi: 0,
      canInitiate: null,
      indicatorActive: null,
      destinationConfigured: null,
      announcementPriority: null,
      announcementAlias: "",
      groupInvisible: null,
      continuousTracking: null,
    },
    gps: { state: "No disponible", destinationIssi: 0, carrier: "", protocol: "" },
    otap: { state: "No disponible", targets: [] },
  };
}

function readUtf16(cps, offset, length) {
  if (offset < 0 || offset + length > cps.length) return "";
  return cps.subarray(offset, offset + length).toString("utf16le").split("\0")[0].trim();
}

function deriveDmoLayout(layout, cpsLength) {
  if (layout?.dmo) {
    const dmo = layout.dmo;
    if (dmo.offset >= 0 && dmo.recordSize > 0 && dmo.maxRecords > 0
      && dmo.offset + dmo.recordSize * dmo.maxRecords <= cpsLength) {
      return { ...dmo };
    }
    return null;
  }
  if (!layout?.main || !layout?.folder || layout.main.maxRecords !== 10000 || layout.folder.maxRecords !== 10000) return null;
  const recordSize = layout.main.recordSize - 4;
  if (![52, 60, 64].includes(recordSize)) return null;
  const offset = layout.main.offset
    + layout.main.recordSize * layout.main.maxRecords
    + layout.folder.recordSize * layout.folder.maxRecords;
  if (offset + recordSize * 2000 > cpsLength) return null;
  return {
    offset,
    recordSize,
    maxRecords: 2000,
    aliasBytes: layout.main.aliasBytes,
    gssiOffset: layout.main.gssiOffset,
  };
}

function extractDmoGroups(cps, layout) {
  const dmo = deriveDmoLayout(layout, cps.length);
  if (!dmo) return { groups: [], scanOffset: null };
  const groups = [];
  const seen = new Set();
  for (let index = 0; index < dmo.maxRecords; index += 1) {
    const base = dmo.offset + index * dmo.recordSize;
    const alias = readUtf16(cps, base, dmo.aliasBytes);
    const gssi = cps.readUInt32LE(base + dmo.gssiOffset);
    const state = cps[base + dmo.aliasBytes];
    if (![1, 2].includes(state) || !alias || gssi < 1 || gssi > 16777215) continue;
    const key = `${gssi}\u0000${alias}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ alias, gssi });
  }
  groups.sort((left, right) => left.gssi - right.gssi || left.alias.localeCompare(right.alias, undefined, { numeric: true }));
  return { groups, scanOffset: dmo.offset + dmo.recordSize * dmo.maxRecords };
}

function priorityLabel(code) {
  if (code === 5) return "Alto";
  if (code === 0) return "";
  return `Codigo ${code}`;
}

function buildBroadcastFeature(values) {
  let indicatorActive = Number.isInteger(values.indicatorByte)
    ? values.indicatorByte === values.activeIndicatorValue
    : null;
  const destination = values.destination || null;
  const destinationConfigured = Boolean(destination);
  const groupInvisible = destination
    ? (destination.status === 2 || destination.statusText === "Invisible" || values.mainState === 2)
    : null;
  const continuousTracking = destination ? values.groupCode === 7 : null;
  const announcementPriority = Number(values.announcementPriority || 0);
  const configuredCorrectly = destinationConfigured
    && groupInvisible
    && continuousTracking
    && announcementPriority === 10;
  const configurationHint = Boolean(
    values.destinationPosition
    || announcementPriority
    || String(values.announcementAlias || "").trim(),
  );
  if (indicatorActive == null && values.inferIndicatorFromConfig && configuredCorrectly) {
    indicatorActive = true;
  } else if (indicatorActive == null && values.inferInactiveWhenBlank && !configurationHint) {
    indicatorActive = false;
  }
  const validDestination = destinationConfigured && groupInvisible === true && continuousTracking === true;
  const listening = indicatorActive === true
    && validDestination
    && announcementPriority === 10;
  const review = indicatorActive === true
    && validDestination
    && announcementPriority !== 10;
  return {
    state: listening
      ? "Solo escucha"
      : review ? "Revisar" : "Inactivo",
    alias: destination?.alias || "",
    gssi: Number(destination?.gssi || 0),
    canInitiate: false,
    indicatorActive,
    destinationConfigured,
    announcementPriority,
    announcementAlias: String(values.announcementAlias || ""),
    groupInvisible,
    continuousTracking,
  };
}

function extractBroadcastConfig(cps, layout, talkgroups) {
  const broadcast = BROADCAST_LAYOUTS[cps.length];
  if (!broadcast || !layout?.main) return null;
  const end = broadcast.announcementAliasOffset + broadcast.announcementAliasBytes;
  if (end > cps.length || (broadcast.indicatorOffset != null && broadcast.indicatorOffset >= cps.length)) return null;
  const destinationPosition = broadcast.destinationPositionOffset == null
    ? 0
    : cps.readUInt32LE(broadcast.destinationPositionOffset);
  let destination = (talkgroups || []).find((group) => Number(group.folderRow) === destinationPosition) || null;

  function groupValues(group) {
    if (!group || Number(group.slot) < 1) return { groupCode: null, mainState: null };
    const base = layout.main.offset + (Number(group.slot) - 1) * layout.main.recordSize;
    const codeOffset = base + layout.main.aliasBytes + 10;
    const stateOffset = base + layout.main.aliasBytes;
    return {
      groupCode: codeOffset < cps.length ? cps[codeOffset] : null,
      mainState: stateOffset < cps.length ? cps[stateOffset] : null,
    };
  }

  let { groupCode, mainState } = groupValues(destination);
  const destinationValid = destination
    && groupCode === 7
    && (destination.status === 2 || destination.statusText === "Invisible" || mainState === 2);
  if (!destinationValid && (destinationPosition > 0 || broadcast.allowUniqueContinuousGroup)) {
    const candidates = (talkgroups || []).map((group) => ({ group, ...groupValues(group) }))
      .filter((candidate) => candidate.groupCode === 7
        && (candidate.group.status === 2
          || candidate.group.statusText === "Invisible"
          || candidate.mainState === 2));
    if (candidates.length === 1) {
      destination = candidates[0].group;
      groupCode = candidates[0].groupCode;
      mainState = candidates[0].mainState;
    }
  }
  if (!destination && broadcast.destinationUsesContinuousOrdinal && destinationPosition > 0) {
    const candidates = [];
    for (let index = 0; index < layout.main.maxRecords; index += 1) {
      const base = layout.main.offset + index * layout.main.recordSize;
      if (base + layout.main.recordSize > cps.length) break;
      const state = cps[base + layout.main.aliasBytes];
      const code = cps[base + layout.main.aliasBytes + 10];
      if (state !== 2 || code !== 7) continue;
      const alias = readUtf16(cps, base, layout.main.aliasBytes);
      const gssi = cps.readUInt32LE(base + layout.main.gssiOffset);
      if (!alias || gssi < 1 || gssi > 16777215) continue;
      candidates.push({ slot: index + 1, alias, gssi, status: 2, statusText: "Invisible" });
    }
    destination = candidates[destinationPosition - 1] || null;
    ({ groupCode, mainState } = groupValues(destination));
  }
  return buildBroadcastFeature({
    indicatorByte: broadcast.indicatorOffset == null ? null : cps[broadcast.indicatorOffset],
    activeIndicatorValue: broadcast.activeIndicatorValue,
    destination,
    groupCode,
    mainState,
    destinationPosition,
    announcementPriority: cps[broadcast.priorityOffset],
    announcementAlias: readUtf16(cps, broadcast.announcementAliasOffset, broadcast.announcementAliasBytes),
    inferIndicatorFromConfig: broadcast.inferIndicatorFromConfig,
    inferInactiveWhenBlank: broadcast.inferInactiveWhenBlank,
  });
}

function extractScanLists(cps, scanOffset, talkgroups) {
  if (scanOffset == null || scanOffset + 268 > cps.length) return [];
  const aliases = new Map((talkgroups || []).map((group) => [Number(group.gssi), String(group.alias || "")]));
  const lists = [];
  for (let listIndex = 0; listIndex < 40; listIndex += 1) {
    const base = scanOffset + listIndex * 268;
    if (base + 268 > cps.length) break;
    const name = readUtf16(cps, base, 24);
    const enabled = cps[base + 24] === 1;
    const count = Math.min(cps[base + 25], 20);
    if (!name || !enabled || count === 0) continue;
    const groups = [];
    const seen = new Set();
    for (let item = 0; item < count; item += 1) {
      const itemBase = base + 28 + item * 12;
      const priority = cps.readUInt16LE(itemBase + 4);
      const gssi = cps.readUInt32LE(itemBase + 8);
      if (gssi < 1 || gssi > 16777215 || seen.has(gssi)) continue;
      seen.add(gssi);
      groups.push({ alias: aliases.get(gssi) || "", gssi, priority: priorityLabel(priority) });
    }
    if (groups.length) lists.push({ name, groups });
  }
  return lists;
}

function extractOtapTargetsFromTable(table) {
  const targets = [];
  const seen = new Set();
  for (let base = 0; base + 8 <= table.length; base += 8) {
    const mcc = table.readUInt16LE(base);
    const mnc = table.readUInt16LE(base + 2);
    const issi = table.readUInt32LE(base + 4);
    if (!mcc && !mnc && !issi) continue;
    if (mcc > 1023 || mnc > 16383 || issi > 16777215) continue;
    const key = `${mcc}|${mnc}|${issi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ mcc, mnc, issi });
  }
  return targets;
}

function extractOtapTargets(cps) {
  const layout = OTAP_TABLES[cps.length];
  if (!layout || layout.offset + layout.maxRecords * 8 > cps.length) return [];
  return extractOtapTargetsFromTable(cps.subarray(layout.offset, layout.offset + layout.maxRecords * 8));
}

function extractOtapEnabled(cps) {
  if (OTAP_UNSUPPORTED_CPS_LENGTHS.has(cps.length)) return false;
  const offset = OTAP_INDICATOR_OFFSETS[cps.length];
  if (offset == null || offset >= cps.length) return null;
  if (cps[offset] === 1) return true;
  if (cps[offset] === 0) return false;
  return null;
}

function extractFeatureIndicator(cps, offsets) {
  const offset = offsets[cps.length];
  if (offset == null || offset >= cps.length) return null;
  if (cps[offset] === 1) return true;
  if (cps[offset] === 0) return false;
  return null;
}

function extractDmoEnabled(cps) {
  return extractFeatureIndicator(cps, DMO_INDICATOR_OFFSETS);
}

function extractScanEnabled(cps) {
  return extractFeatureIndicator(cps, SCAN_INDICATOR_OFFSETS);
}

function extractGpsEnabled(cps) {
  return extractFeatureIndicator(cps, GPS_INDICATOR_OFFSETS);
}

function extractGpsDestination(cps) {
  const knownOffset = GPS_DESTINATION_OFFSETS[cps.length];
  if (knownOffset != null && knownOffset + 4 <= cps.length) {
    const value = cps.readUInt32LE(knownOffset);
    return { supported: true, destinationIssi: value <= 16777215 ? value : 0 };
  }
  const candidates = [];
  for (let offset = 16; offset + 4 <= cps.length; offset += 1) {
    if (cps[offset - 13] !== 1 || cps.readUInt32LE(offset - 12) !== 10) continue;
    let zeroPrefix = true;
    for (let index = offset - 8; index < offset; index += 1) {
      if (cps[index] !== 0) { zeroPrefix = false; break; }
    }
    if (!zeroPrefix) continue;
    const value = cps.readUInt32LE(offset);
    if (value > 0 && value <= 16777215) candidates.push(value);
  }
  const unique = [...new Set(candidates)];
  return unique.length === 1
    ? { supported: true, destinationIssi: unique[0] }
    : { supported: false, destinationIssi: 0 };
}

function extractCpeFeatures(cps, options = {}) {
  const exact = featuresFromValidatedReport(cps);
  if (exact) {
    // Los reportes antiguos pueden incluir las ITSIs autorizadas sin que el
    // indicador OTAP este activo. El byte del indicador es la fuente de verdad
    // para Activo/Inactivo tambien en las excepciones validadas por hash.
    const exactOtapEnabled = extractOtapEnabled(cps);
    if (exact.otap && exactOtapEnabled != null) {
      exact.otap.state = exactOtapEnabled ? "Activo" : "Inactivo";
    }
    const exactDmoEnabled = extractDmoEnabled(cps);
    if (exact.dmo && exactDmoEnabled != null) {
      exact.dmo.state = exactDmoEnabled ? "Activo" : "Inactivo";
    }
    const exactScanEnabled = extractScanEnabled(cps);
    if (exact.scan && exactScanEnabled != null) {
      exact.scan.state = exactScanEnabled ? "Activo" : "Inactivo";
    }
    const exactGpsEnabled = extractGpsEnabled(cps);
    if (exact.gps && exactGpsEnabled != null) {
      exact.gps.state = exactGpsEnabled ? "Activo" : "Inactivo";
    }
    return exact;
  }

  const features = unavailableFeatures();
  const { groups: dmoGroups, scanOffset } = extractDmoGroups(cps, options.layout);
  const scanLists = extractScanLists(cps, scanOffset, options.talkgroups || []);
  const gps = extractGpsDestination(cps);
  const gpsDestination = gps.destinationIssi;
  const dmoEnabled = extractDmoEnabled(cps);
  const scanEnabled = extractScanEnabled(cps);
  const gpsEnabled = extractGpsEnabled(cps);
  const otapTargets = extractOtapTargets(cps);
  const otapEnabled = extractOtapEnabled(cps);
  const broadcast = extractBroadcastConfig(cps, options.layout, options.talkgroups || []);

  if (scanOffset != null || scanEnabled != null) {
    features.scan = {
      state: scanEnabled === true
        ? "Activo"
        : scanEnabled === false
          ? "Inactivo"
          : scanLists.length ? "Configurado; estado no verificado" : "Estado no verificado",
      activeList: "",
      lists: scanLists,
    };
  }
  if (deriveDmoLayout(options.layout, cps.length) || dmoEnabled != null) {
    features.dmo = {
      state: dmoEnabled === true ? "Activo" : dmoEnabled === false ? "Inactivo" : "No disponible",
      groups: dmoGroups,
    };
  }
  if (gps.supported || gpsEnabled != null) {
    features.gps = {
      state: gpsEnabled === true ? "Activo" : gpsEnabled === false ? "Inactivo" : "No disponible",
      destinationIssi: gpsDestination > 0 && gpsDestination <= 16777215 ? gpsDestination : 0,
      carrier: "",
      protocol: "LIP",
    };
  }
  if (OTAP_TABLES[cps.length] || OTAP_INDICATOR_OFFSETS[cps.length] != null
    || OTAP_UNSUPPORTED_CPS_LENGTHS.has(cps.length)) {
    features.otap = {
      state: otapEnabled === true ? "Activo" : otapEnabled === false ? "Inactivo" : "No disponible",
      targets: otapTargets,
    };
  }
  if (broadcast) features.broadcast = broadcast;
  if (scanOffset != null || scanEnabled != null || gps.supported || gpsEnabled != null || dmoEnabled != null
    || OTAP_TABLES[cps.length] || OTAP_INDICATOR_OFFSETS[cps.length] != null
    || OTAP_UNSUPPORTED_CPS_LENGTHS.has(cps.length) || broadcast) {
    features.source = "cpe-layout-validated";
  }
  return features;
}

module.exports = {
  BROADCAST_LAYOUTS,
  DMO_INDICATOR_OFFSETS,
  GPS_DESTINATION_OFFSETS,
  GPS_INDICATOR_OFFSETS,
  OTAP_INDICATOR_OFFSETS,
  OTAP_TABLES,
  OTAP_UNSUPPORTED_CPS_LENGTHS,
  SCAN_INDICATOR_OFFSETS,
  deriveDmoLayout,
  buildBroadcastFeature,
  extractBroadcastConfig,
  extractCpeFeatures,
  extractDmoEnabled,
  extractDmoGroups,
  extractGpsDestination,
  extractGpsEnabled,
  extractOtapEnabled,
  extractOtapTargets,
  extractOtapTargetsFromTable,
  extractScanLists,
  extractScanEnabled,
  unavailableFeatures,
};
