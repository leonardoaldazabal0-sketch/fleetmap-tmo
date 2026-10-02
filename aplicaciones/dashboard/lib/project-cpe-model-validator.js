function text(value) {
  return String(value ?? "").trim();
}

function normalizedLabel(value) {
  return text(value).replace(/\s+/g, " ").toUpperCase();
}

function normalizedMode(value) {
  return normalizedLabel(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function numericId(value) {
  const raw = text(value);
  return /^\d+$/.test(raw) ? String(Number(raw)) : raw;
}

function activeState(feature) {
  return feature?.state === "Activo";
}

function collectGssis(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectGssis(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  if (value.gssi != null && Number(value.gssi) > 0) found.add(numericId(value.gssi));
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") collectGssis(nested, found);
  }
  return found;
}

function groupMap(groups) {
  const result = new Map();
  for (const group of groups || []) {
    const gssi = numericId(group.gssi);
    if (gssi && Number(gssi) > 0) result.set(gssi, text(group.label ?? group.alias));
  }
  return result;
}

function groupsText(groups) {
  return [...groupMap(groups)].map(([gssi, label]) => `${label} (${gssi})`).join(", ") || "Ninguno";
}

function idsText(ids) {
  return [...ids].sort((a, b) => Number(a) - Number(b)).join(", ") || "Ninguno";
}

function profileSignature(radio) {
  const functions = radio.functions || {};
  return JSON.stringify({
    groups: [...groupMap(radio.groups)].sort((a, b) => Number(a[0]) - Number(b[0])),
    emergency: radio.emergency || {},
    scan: Boolean(functions.scan),
    scanGroups: [...collectGssis(radio.scanGroups)].sort((a, b) => Number(a) - Number(b)),
    dmo: Boolean(functions.dmo),
    dmoGroups: [...collectGssis(radio.dmoGroups)].sort((a, b) => Number(a) - Number(b)),
    broadcastListen: Boolean(functions.broadcastListen),
    broadcastGssi: numericId(functions.broadcastGssi),
    gps: Boolean(functions.gps),
    gpsGatewayIssi: numericId(functions.gpsGatewayIssi),
    otap: Boolean(functions.otap),
  });
}

function buildProfiles(radios) {
  const profiles = new Map();
  for (const radio of radios || []) {
    const signature = profileSignature(radio);
    if (!profiles.has(signature)) profiles.set(signature, { reference: radio, issis: [] });
    profiles.get(signature).issis.push(text(radio.issi));
  }
  return [...profiles.values()];
}

function compareModelToRadio(model, radio, requiredContacts = []) {
  const checks = [];
  const add = (key, label, expected, actual, passed, detail = "") => checks.push({
    key,
    label,
    expected: text(expected),
    actual: text(actual),
    passed: Boolean(passed),
    detail: text(detail),
  });

  const expectedGroups = groupMap(radio.groups);
  const actualGroups = groupMap(model.rows);
  const missingGroups = [];
  const extraGroups = [];
  const wrongLabels = [];
  for (const [gssi, label] of expectedGroups) {
    if (!actualGroups.has(gssi)) missingGroups.push(gssi);
    else if (normalizedLabel(actualGroups.get(gssi)) !== normalizedLabel(label)) {
      wrongLabels.push(`${gssi}: ${label} ≠ ${actualGroups.get(gssi)}`);
    }
  }
  for (const gssi of actualGroups.keys()) {
    if (!expectedGroups.has(gssi)) extraGroups.push(gssi);
  }
  add(
    "groups",
    "Grupos TMO",
    groupsText(radio.groups),
    groupsText(model.rows),
    !missingGroups.length && !extraGroups.length && !wrongLabels.length,
    [
      missingGroups.length ? `Faltan GSSI: ${missingGroups.join(", ")}` : "",
      extraGroups.length ? `Sobran GSSI: ${extraGroups.join(", ")}` : "",
      wrongLabels.length ? `Labels diferentes: ${wrongLabels.join("; ")}` : "",
    ].filter(Boolean).join(" | "),
  );

  const expectedEmergency = radio.emergency || { mode: "INACTIVO", gssi: "" };
  const expectedEmergencyMode = normalizedMode(expectedEmergency.mode);
  const actualEmergencyMode = normalizedMode(model.emergencyMode);
  const emergencyModePassed = expectedEmergencyMode === actualEmergencyMode;
  add(
    "emergency-mode",
    "Modo de emergencia",
    expectedEmergency.mode,
    model.emergencyMode || "No disponible",
    emergencyModePassed,
  );
  if (expectedEmergencyMode === "NO TACTICO") {
    add(
      "emergency-destination",
      "Destino de emergencia",
      expectedEmergency.gssi,
      model.emergencyGssi || "Sin destino",
      numericId(expectedEmergency.gssi) === numericId(model.emergencyGssi),
    );
  }

  const expectedFunctions = radio.functions || {};
  const features = model.features || {};
  const binaryFeature = (key, label) => {
    const expected = Boolean(expectedFunctions[key]);
    const feature = features[key];
    const actual = activeState(feature);
    add(key, label, expected ? "Activo" : "Inactivo", feature?.state || "No disponible", feature?.state !== "No disponible" && actual === expected);
  };

  binaryFeature("scan", "Escaneo");
  const expectedScanGssis = collectGssis(radio.scanGroups);
  const actualScanGssis = collectGssis(features.scan?.lists || []);
  if (expectedFunctions.scan) {
    add("scan-groups", "Grupos de Escaneo", idsText(expectedScanGssis), idsText(actualScanGssis), idsText(expectedScanGssis) === idsText(actualScanGssis));
  }

  binaryFeature("dmo", "DMO");
  const expectedDmoGssis = collectGssis(radio.dmoGroups);
  const actualDmoGssis = collectGssis(features.dmo?.groups || []);
  if (expectedFunctions.dmo) {
    add("dmo-groups", "Grupos DMO", idsText(expectedDmoGssis), idsText(actualDmoGssis), idsText(expectedDmoGssis) === idsText(actualDmoGssis));
  }

  const expectedBroadcast = Boolean(expectedFunctions.broadcastListen);
  const actualBroadcast = features.broadcast?.state === "Solo escucha";
  add(
    "broadcast",
    "Broadcast escucha",
    expectedBroadcast ? "Activo" : "Inactivo",
    features.broadcast?.state || "No disponible",
    features.broadcast?.state !== "No disponible" && actualBroadcast === expectedBroadcast,
  );
  if (expectedBroadcast) {
    add(
      "broadcast-destination",
      "Destino Broadcast",
      expectedFunctions.broadcastGssi,
      features.broadcast?.gssi || "Sin destino",
      numericId(expectedFunctions.broadcastGssi) === numericId(features.broadcast?.gssi),
    );
  }

  binaryFeature("gps", "GPS");
  if (expectedFunctions.gps) {
    add(
      "gps-gateway",
      "Gateway GPS",
      expectedFunctions.gpsGatewayIssi,
      features.gps?.destinationIssi || "Sin destino",
      numericId(expectedFunctions.gpsGatewayIssi) === numericId(features.gps?.destinationIssi),
    );
  }

  binaryFeature("otap", "OTAP");

  if (requiredContacts.length) {
    const actualContacts = new Set((model.agenda?.contacts || []).map((contact) => `${normalizedLabel(contact.name)}:${numericId(contact.issi)}`));
    const missingContacts = requiredContacts.filter((contact) => !actualContacts.has(`${normalizedLabel(contact.name)}:${numericId(contact.issi)}`));
    add(
      "contacts",
      "Contactos requeridos",
      `${requiredContacts.length} contacto(s)`,
      model.agenda?.supported ? `${model.agenda.count || 0} contacto(s)` : "No disponible",
      Boolean(model.agenda?.supported) && !missingContacts.length,
      missingContacts.length ? `Faltan: ${missingContacts.map((contact) => `${contact.name} (${contact.issi})`).join(", ")}` : "",
    );
  }

  return {
    checks,
    passed: checks.every((check) => check.passed),
    failedCount: checks.filter((check) => !check.passed).length,
  };
}

function uniqueGroupCatalog(project) {
  const configured = Array.isArray(project?.request?.groups) ? project.request.groups : [];
  const source = configured.length
    ? configured
    : (project?.request?.radios || []).flatMap((radio) => radio.groups || []);
  return [...groupMap(source)].map(([gssi, label]) => ({ gssi, label }));
}

function uniqueTextValues(values) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function compareMasterModel(project, model, requiredContacts = []) {
  const radios = Array.isArray(project?.request?.radios) ? project.request.radios : [];
  const checks = [];
  const variableSettings = [];
  const add = (key, label, expected, actual, passed, detail = "") => checks.push({
    key,
    label,
    expected: text(expected),
    actual: text(actual),
    passed: Boolean(passed),
    detail: text(detail),
  });

  const expectedGroups = groupMap(uniqueGroupCatalog(project));
  const actualGroups = groupMap(model.rows);
  const missingGroups = [];
  const extraGroups = [];
  const wrongLabels = [];
  for (const [gssi, label] of expectedGroups) {
    if (!actualGroups.has(gssi)) missingGroups.push(gssi);
    else if (normalizedLabel(actualGroups.get(gssi)) !== normalizedLabel(label)) {
      wrongLabels.push(`${gssi}: ${label} ≠ ${actualGroups.get(gssi)}`);
    }
  }
  for (const gssi of actualGroups.keys()) {
    if (!expectedGroups.has(gssi)) extraGroups.push(gssi);
  }
  add(
    "groups",
    "Catálogo general de grupos TMO",
    groupsText(uniqueGroupCatalog(project)),
    groupsText(model.rows),
    !missingGroups.length && !extraGroups.length && !wrongLabels.length,
    [
      missingGroups.length ? `Faltan GSSI: ${missingGroups.join(", ")}` : "",
      extraGroups.length ? `Sobran GSSI: ${extraGroups.join(", ")}` : "",
      wrongLabels.length ? `Labels diferentes: ${wrongLabels.join("; ")}` : "",
    ].filter(Boolean).join(" | "),
  );

  const features = model.features || {};
  const featureRule = (key, label, modelKey = key, activePredicate = activeState) => {
    const requested = radios.map((radio) => Boolean(radio.functions?.[key]));
    const expected = requested.some(Boolean);
    const actualFeature = features[modelKey];
    const actual = activePredicate(actualFeature);
    if (requested.some(Boolean) && requested.some((value) => !value)) variableSettings.push(label);
    add(
      key,
      label,
      expected ? "Activo en el maestro" : "Inactivo",
      actualFeature?.state || "No disponible",
      actualFeature?.state !== "No disponible" && actual === expected,
      expected && requested.some((value) => !value) ? "Se desactivará en las radios que no lo solicitaron." : "",
    );
    return expected;
  };

  const scanActive = featureRule("scan", "Escaneo");
  if (scanActive) {
    const expected = collectGssis(radios.flatMap((radio) => radio.scanGroups || []));
    const actual = collectGssis(features.scan?.lists || []);
    add("scan-groups", "Recursos generales de Escaneo", idsText(expected), idsText(actual), idsText(expected) === idsText(actual));
  }

  const dmoActive = featureRule("dmo", "DMO");
  if (dmoActive) {
    const configuredDmo = Array.isArray(project?.request?.dmoGroups) ? project.request.dmoGroups : [];
    const expected = collectGssis(configuredDmo.length ? configuredDmo : radios.flatMap((radio) => radio.dmoGroups || []));
    const actual = collectGssis(features.dmo?.groups || []);
    add("dmo-groups", "Catálogo general de grupos DMO", idsText(expected), idsText(actual), idsText(expected) === idsText(actual));
  }

  const broadcastActive = featureRule(
    "broadcastListen",
    "Broadcast escucha",
    "broadcast",
    (feature) => feature?.state === "Solo escucha",
  );
  if (broadcastActive) {
    const destinations = uniqueTextValues(radios
      .filter((radio) => radio.functions?.broadcastListen)
      .map((radio) => numericId(radio.functions?.broadcastGssi)));
    const actual = numericId(features.broadcast?.gssi);
    if (destinations.length > 1) variableSettings.push("Destino Broadcast");
    add(
      "broadcast-destination",
      "Destino Broadcast base",
      destinations.join(" / "),
      actual || "Sin destino",
      destinations.includes(actual),
      destinations.length > 1 ? "El maestro puede usar uno de los destinos solicitados; se ajustará por radio." : "",
    );
  }

  const gpsActive = featureRule("gps", "GPS");
  if (gpsActive) {
    const gateways = uniqueTextValues(radios
      .filter((radio) => radio.functions?.gps)
      .map((radio) => numericId(radio.functions?.gpsGatewayIssi)));
    const actual = numericId(features.gps?.destinationIssi);
    if (gateways.length > 1) variableSettings.push("Gateway GPS");
    add(
      "gps-gateway",
      "Gateway GPS base",
      gateways.join(" / "),
      actual || "Sin destino",
      gateways.includes(actual),
      gateways.length > 1 ? "El gateway se ajustará según la radio." : "",
    );
  }

  featureRule("otap", "OTAP");

  const emergencyOptions = [...new Map(radios.map((radio) => {
    const emergency = radio.emergency || { mode: "INACTIVO", gssi: "" };
    const mode = normalizedMode(emergency.mode);
    const gssi = mode === "NO TACTICO" ? numericId(emergency.gssi) : "";
    return [`${mode}:${gssi}`, { mode, gssi }];
  })).values()];
  const actualEmergencyMode = normalizedMode(model.emergencyMode);
  const actualEmergencyGssi = actualEmergencyMode === "NO TACTICO" ? numericId(model.emergencyGssi) : "";
  const emergencyPassed = emergencyOptions.some((option) => option.mode === actualEmergencyMode && option.gssi === actualEmergencyGssi);
  if (emergencyOptions.length > 1) variableSettings.push("Emergencia");
  add(
    "emergency-base",
    "Configuración de emergencia base",
    emergencyOptions.map((option) => option.gssi ? `${option.mode} (${option.gssi})` : option.mode).join(" / "),
    actualEmergencyGssi ? `${actualEmergencyMode} (${actualEmergencyGssi})` : actualEmergencyMode || "No disponible",
    emergencyPassed,
    emergencyOptions.length > 1 ? "El maestro puede usar una configuración solicitada; se ajustará por radio." : "",
  );

  if (requiredContacts.length) {
    const actualContacts = new Set((model.agenda?.contacts || []).map((contact) => `${normalizedLabel(contact.name)}:${numericId(contact.issi)}`));
    const missingContacts = requiredContacts.filter((contact) => !actualContacts.has(`${normalizedLabel(contact.name)}:${numericId(contact.issi)}`));
    add(
      "contacts",
      "Agenda general de contactos",
      `${requiredContacts.length} contacto(s)`,
      model.agenda?.supported ? `${model.agenda.count || 0} contacto(s)` : "No disponible",
      Boolean(model.agenda?.supported) && !missingContacts.length,
      missingContacts.length ? `Faltan: ${missingContacts.map((contact) => `${contact.name} (${contact.issi})`).join(", ")}` : "",
    );
  }

  return {
    checks,
    passed: checks.every((check) => check.passed),
    failedCount: checks.filter((check) => !check.passed).length,
    variableSettings: [...new Set(variableSettings)],
    masterGroupCount: expectedGroups.size,
  };
}

function validateProjectCpeModel(project, model) {
  const radios = Array.isArray(project?.request?.radios) ? project.request.radios : [];
  if (!radios.length) throw new Error("El proyecto no contiene radios para comparar");
  const requiredContacts = radios
    .filter((radio) => text(radio.contactName))
    .map((radio) => ({ name: text(radio.contactName), issi: text(radio.issi) }));
  const profiles = buildProfiles(radios).map((profile, index) => ({
    number: index + 1,
    issis: profile.issis,
    groupCount: groupMap(profile.reference.groups).size,
    gssis: [...groupMap(profile.reference.groups).keys()],
  }));
  const master = compareMasterModel(project, model, requiredContacts);
  return {
    status: master.passed ? "APROBADO" : "NO APROBADO",
    validationMode: "CPE_MAESTRO",
    profileCount: profiles.length,
    matchedProfile: null,
    appliesToIssis: master.passed ? radios.map((radio) => text(radio.issi)) : [],
    checks: master.checks,
    failedCount: master.failedCount,
    masterGroupCount: master.masterGroupCount,
    variableSettings: master.variableSettings,
    notes: [
      `El CPE maestro reúne los recursos generales para ${radios.length} radio(s) y ${profiles.length} configuración(es) finales.`,
      "Los grupos y parámetros particulares se validarán exactamente después de programar cada radio.",
      "ISSI, serie y TEI no se comparan en el maestro; se validarán en la lectura final de cada radio.",
      "Llamada privada y corte de llamada son privilegios NMS y no se evalúan en el CPE.",
      "Reporte GPS y Man Down aún no forman parte del parser de validación del modelo.",
      "OTAP valida su estado activo/inactivo; la plantilla aún no especifica ITSI autorizadas.",
      master.variableSettings.length ? `Parámetros que deberán ajustarse según cada radio: ${master.variableSettings.join(", ")}.` : "",
    ].filter(Boolean),
    profiles,
  };
}

module.exports = {
  buildProfiles,
  compareMasterModel,
  compareModelToRadio,
  profileSignature,
  validateProjectCpeModel,
};
