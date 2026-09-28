const { compareModelToRadio } = require("./project-cpe-model-validator");

function text(value) {
  return String(value ?? "").trim();
}

function normalizedIdentity(value) {
  return text(value).replace(/[\s._\-/\\]+/g, "").toUpperCase();
}

function normalizedIssi(value) {
  const raw = text(value);
  return /^\d+$/.test(raw) ? String(Number(raw)) : normalizedIdentity(raw);
}

function identityCheck(key, label, expected, actual, normalizer = normalizedIdentity) {
  const expectedText = text(expected);
  const actualText = text(actual);
  return {
    key,
    label,
    expected: expectedText || "No informado",
    actual: actualText || "No identificado",
    passed: Boolean(expectedText && actualText && normalizer(expectedText) === normalizer(actualText)),
    detail: "",
  };
}

function requiredContacts(radios) {
  return (radios || [])
    .filter((radio) => text(radio.contactName))
    .map((radio) => ({ name: text(radio.contactName), issi: text(radio.issi) }));
}

function findExpectedRadio(radios, actual) {
  const actualIssi = normalizedIssi(actual.issi);
  if (actualIssi) {
    const byIssi = radios.find((radio) => normalizedIssi(radio.issi) === actualIssi);
    if (byIssi) return { radio: byIssi, matchedBy: "ISSI" };
  }

  const actualSerial = normalizedIdentity(actual.serial);
  if (actualSerial) {
    const matches = radios.filter((radio) => normalizedIdentity(radio.serial) === actualSerial);
    if (matches.length === 1) return { radio: matches[0], matchedBy: "SERIE" };
  }

  const actualTei = normalizedIdentity(actual.tei);
  if (actualTei) {
    const matches = radios.filter((radio) => normalizedIdentity(radio.tei) === actualTei);
    if (matches.length === 1) return { radio: matches[0], matchedBy: "TEI" };
  }
  return { radio: null, matchedBy: "" };
}

function validateProjectCpeRadio(project, actual) {
  const radios = Array.isArray(project?.request?.radios) ? project.request.radios : [];
  if (!radios.length) throw new Error("El proyecto no contiene radios para comparar");

  const match = findExpectedRadio(radios, actual || {});
  if (!match.radio) {
    return {
      status: "NO APROBADO",
      expectedIssi: "",
      matchedBy: "",
      actual: {
        issi: text(actual?.issi),
        serial: text(actual?.serial),
        tei: text(actual?.tei),
        codeplug: text(actual?.codeplug),
        software: text(actual?.software),
      },
      checks: [{
        key: "project-radio",
        label: "Radio incluida en la solicitud",
        expected: radios.map((radio) => text(radio.issi)).filter(Boolean).join(", "),
        actual: text(actual?.issi) || "ISSI no identificado",
        passed: false,
        detail: "No se encontró coincidencia por ISSI, serie ni TEI.",
      }],
      failedCount: 1,
    };
  }

  const expected = match.radio;
  const identities = [
    identityCheck("identity-issi", "ISSI", expected.issi, actual.issi, normalizedIssi),
    identityCheck("identity-serial", "Serie", expected.serial, actual.serial),
    identityCheck("identity-tei", "TEI", expected.tei, actual.tei),
  ];
  const programming = compareModelToRadio(actual, expected, requiredContacts(radios));
  const checks = [...identities, ...programming.checks];
  const failedCount = checks.filter((check) => !check.passed).length;
  return {
    status: failedCount ? "NO APROBADO" : "APROBADO",
    expectedIssi: text(expected.issi),
    matchedBy: match.matchedBy,
    expected: {
      issi: text(expected.issi),
      serial: text(expected.serial),
      tei: text(expected.tei),
    },
    actual: {
      issi: text(actual.issi),
      serial: text(actual.serial),
      tei: text(actual.tei),
      codeplug: text(actual.codeplug),
      software: text(actual.software),
    },
    checks,
    failedCount,
  };
}

module.exports = {
  findExpectedRadio,
  normalizedIdentity,
  normalizedIssi,
  validateProjectCpeRadio,
};
