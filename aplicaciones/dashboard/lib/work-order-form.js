const { PDFParse } = require("pdf-parse");

const LEGAL_WORDS = new Set([
  "S", "A", "SA", "SAA", "SAC", "SRL", "EIRL", "SOCIEDAD", "ANONIMA", "CERRADA",
  "INDUSTRIAL", "EMPRESA", "MUNICIPALIDAD", "DE", "DEL", "LA", "LOS", "LAS",
]);

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cleanValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstMatch(text, patterns, group = 1) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[group]) return cleanValue(match[group]);
  }
  return "";
}

function clientComparable(value) {
  return normalized(value)
    .split(" ")
    .filter((token) => token.length > 1 && !LEGAL_WORDS.has(token))
    .join("");
}

function clientsMatch(left, right) {
  const a = clientComparable(left);
  const b = clientComparable(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)));
}

function formIdentity(fileName, text) {
  const source = `${fileName}\n${text}`;
  const formType = /FORMULARIO DE ADICI[OÓ]N|DT\s*-?\s*FA\b/i.test(source)
    ? "ADICION"
    : /FORMULARIO DE CAMBIO|DT\s*-?\s*FC\b/i.test(source)
      ? "CAMBIO"
      : /FORMULARIO DE PROGRAMACI[OÓ]N|DT\s*-?\s*FPG\b/i.test(source)
        ? "PROGRAMACION"
        : "";
  const formNumberRaw = firstMatch(fileName, [/_([0-9]{6,8})(?:[-_])/])
    || firstMatch(text, [/\n(0{2,}[0-9]{3,8})\s+(?:DT\s*-)/i]);
  const formNumber = formNumberRaw ? String(Number(formNumberRaw)) : "";
  const formCodeRaw = firstMatch(fileName, [/_([0-9]{6,8}[-_]20[0-9]{2}[-_]DT[-_ ]?F(?:A|C|PG))/i]);
  return {
    formType,
    formNumber,
    formCode: formCodeRaw.replaceAll("_", "-").replace(/\s+/g, ""),
  };
}

function extractClientName(text) {
  const beforeType = firstMatch(text, [/(?:^|\n)([^\n\t:]{3,120})\s*\tTIPO DE CLIENTE:/im]);
  if (beforeType && !/^(CLIENTE|FACTURADO)$/i.test(beforeType)) return beforeType;
  return firstMatch(text, [/CLIENTE:\s*\t?([^\n\t]{3,120})/i]);
}

function parseWorkOrderFormText(input = {}) {
  const fileName = String(input.fileName || "formulario.pdf");
  const pages = Array.isArray(input.pages) ? input.pages.map((page) => String(page || "")) : [];
  const firstPage = pages[0] || String(input.text || "").split(/\n--\s*1 of \d+\s*--/i)[0];
  const firstTwoPages = pages.length ? pages.slice(0, 2).join("\n") : String(input.text || "");
  const identity = formIdentity(fileName, firstPage);
  const ruc = firstMatch(firstPage, [/RUC:\s*\t?([0-9]{11})/i]);
  const clientName = extractClientName(firstPage);
  const clientType = firstMatch(firstPage, [/TIPO DE CLIENTE:\s*\t?([^\n\t]+)/i]);
  const formDate = firstMatch(firstPage, [/FECHA:\s*\t?(\d{2}\/\d{2}\/20\d{2})/i]);
  const contractNumber = firstMatch(firstPage, [
    /N[º°]?[ \t]+DEL CONTRATO:[ \t]*([A-Z0-9-]{3,40})/i,
    /NUMERO DE CONTRATO:[ \t]*([A-Z0-9-]{3,40})/i,
  ]);
  let contractType = firstMatch(firstPage, [/TIPO DE CONTRATO:[ \t]*([^\n\t]+)/i]);
  if (/DEL CONTRATO/i.test(contractType)) {
    contractType = firstMatch(firstPage, [/(CONTRATO DE (?:ALQUILER|SERVICIO)[^\n\t]*)/i]);
  }
  const issiCondition = firstMatch(firstPage, [/CONDICION DE ISSI:\s*\t?([^\n\t]+)/i]);
  const radioOwner = firstMatch(firstPage, [/RADIO PERTENECIENTE A:\s*\t?([^\n\t]+)/i]);
  let requestType = "";
  if (identity.formType === "PROGRAMACION") {
    requestType = firstMatch(firstPage, [/TIPO DE REQUERIMIENTO:\s*\t?([^\n\t]+)/i]);
  } else if (identity.formType === "CAMBIO") {
    requestType = firstMatch(firstPage, [/\n([^\n\t]{3,100})\s*\tMOTIVO:/i]);
  } else if (identity.formType === "ADICION") {
    requestType = firstMatch(firstPage, [/\n([^\n\t]{3,100})\s*\tSUB TIPO:/i]);
  }

  let portableCount = 0;
  let baseCount = 0;
  let declaredRadioCount = 0;
  const splitCount = firstPage.match(/CANTIDAD DE RADIOS:\s*\t?(\d+)\s+port[aá]tiles\s+y\s+(\d+)\s+bases/i);
  if (splitCount) {
    portableCount = Number(splitCount[1]);
    baseCount = Number(splitCount[2]);
    declaredRadioCount = portableCount + baseCount;
  } else {
    const total = firstMatch(firstPage, [
      /CANTIDAD DE RADIOS:[\s\S]{0,250}?\b(\d+)\s+RADIOS\b/i,
      /\b(\d+)\s+RADIOS\s*\(/i,
    ]);
    declaredRadioCount = Number(total || 0);
  }
  const currentBatchCount = Number(firstMatch(firstTwoPages, [/POR EL MOMENTO SERAN LAS\s+(\d+)/i]) || 0);
  const accessoryCount = Number(firstMatch(firstPage, [
    /CANTIDAD DE ACCESORIOS:[\s\S]{0,250}?\b(\d+)\s+ANTENAS\b/i,
    /\b(\d+)\s+ANTENAS\b/i,
  ]) || 0);
  const normalizedRequest = normalized(`${requestType} ${firstPage.slice(0, 5000)}`);
  const accessoryOnly = identity.formType === "CAMBIO"
    && /CAMBIO DE ACCESORIOS/.test(normalizedRequest)
    && !/CAMBIO DE RADIO|REEMPLAZO DE RADIO|PROGRAMACION/.test(normalized(requestType));
  const requiresCpeProgramming = Boolean(identity.formType)
    && !accessoryOnly
    && (identity.formType === "PROGRAMACION" || declaredRadioCount > 0 || /RADIO|GRUPO|ISSI/.test(normalizedRequest));
  const operationFolder = identity.formType;
  const clientFolder = normalized(clientName).split(" ").filter((token) => !LEGAL_WORDS.has(token)).slice(0, 2).join(" ") || normalized(clientName);
  const clientClass = /ENTIDAD DEL ESTADO|PUBLIC/i.test(clientType) ? "ENTIDADES PUBLICAS" : "PRIVADAS";
  const warnings = [];
  if (!identity.formType) warnings.push("No se identificó el tipo de formulario.");
  if (!identity.formNumber) warnings.push("No se identificó el número de FORM.");
  if (!ruc) warnings.push("No se identificó el RUC del cliente.");
  if (!clientName) warnings.push("No se identificó la razón social del cliente.");
  if (accessoryOnly) warnings.push("El formulario corresponde únicamente a accesorios y no requiere validación CPE.");

  return {
    ...identity,
    fileName,
    ruc,
    clientName,
    clientType,
    clientClass,
    clientFolder,
    requestType,
    formDate,
    contractNumber,
    contractType,
    issiCondition,
    radioOwner,
    declaredRadioCount,
    portableCount,
    baseCount,
    currentBatchCount,
    accessoryCount,
    accessoryOnly,
    requiresCpeProgramming,
    operationFolder,
    warnings,
  };
}

async function parseWorkOrderForm(buffer, fileName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("El formulario no es un PDF válido");
  }
  if (buffer.length > 20 * 1024 * 1024) throw new Error("El formulario PDF supera el límite de 20 MB");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const pages = (result.pages || []).map((page) => page.text || "");
    return parseWorkOrderFormText({ fileName, pages, text: result.text || "" });
  } finally {
    await parser.destroy();
  }
}

function validateWorkOrderAgainstProject(workOrder, projectValidation) {
  const summary = projectValidation?.summary || {};
  const errors = [];
  const warnings = [...(workOrder.warnings || [])];
  const checks = [];
  const addCheck = (field, expected, actual, passed, message) => {
    checks.push({ field, expected: String(expected || ""), actual: String(actual || ""), passed });
    if (!passed && message) errors.push(message);
  };
  addCheck("Tipo de trabajo", "Programación de radios", workOrder.requestType || workOrder.formType,
    workOrder.requiresCpeProgramming, "El formulario no corresponde a un trabajo que requiera programación CPE.");
  addCheck("RUC", workOrder.ruc, summary.ruc, Boolean(workOrder.ruc && summary.ruc && workOrder.ruc === String(summary.ruc).trim()),
    `El RUC del formulario (${workOrder.ruc || "no identificado"}) no coincide con el Excel (${summary.ruc || "no indicado"}).`);
  addCheck("Cliente", workOrder.clientName, summary.razonSocial, clientsMatch(workOrder.clientName, summary.razonSocial),
    `El cliente del formulario (${workOrder.clientName || "no identificado"}) no coincide con el Excel (${summary.razonSocial || "no indicado"}).`);
  const acceptedCounts = [workOrder.declaredRadioCount, workOrder.currentBatchCount].filter((value) => value > 0);
  const countMatches = acceptedCounts.includes(Number(summary.radios || 0));
  addCheck("Cantidad de radios", acceptedCounts.join(" o "), summary.radios, countMatches,
    `La cantidad del formulario (${acceptedCounts.join(" o ") || "no identificada"}) no coincide con las ${summary.radios || 0} radios del Excel.`);
  if (workOrder.contractNumber && summary.contractRef
      && normalized(workOrder.contractNumber) !== normalized(summary.contractRef)) {
    errors.push(`El contrato del formulario (${workOrder.contractNumber}) no coincide con el Excel (${summary.contractRef}).`);
    checks.push({ field: "Contrato", expected: workOrder.contractNumber, actual: summary.contractRef, passed: false });
  } else {
    checks.push({ field: "Contrato", expected: workOrder.contractNumber || "No indicado", actual: summary.contractRef || "Se completará desde el formulario", passed: true });
  }
  return { valid: errors.length === 0, errors, warnings, checks };
}

function suggestPublicationRoute(project, date = new Date()) {
  const form = project?.workOrder;
  if (!form?.formNumber || !form.operationFolder || !form.clientClass) return null;
  const programmerInitials = String(project.responsible || "")
    .trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return {
    clientPath: [form.clientClass, form.clientFolder || project.razonSocial, form.operationFolder].filter(Boolean).join("\\"),
    formNumber: form.formNumber,
    programmingDate: date.toISOString().slice(0, 10),
    programmerInitials,
  };
}

module.exports = {
  parseWorkOrderForm,
  parseWorkOrderFormText,
  validateWorkOrderAgainstProject,
  suggestPublicationRoute,
  clientsMatch,
  normalized,
};
