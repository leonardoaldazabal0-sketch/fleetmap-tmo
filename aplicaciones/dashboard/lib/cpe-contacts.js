const crypto = require("crypto");

// Offsets validated byte-for-byte against CPS User Reports. Unknown payload
// sizes stay unsupported so they are never confused with an empty agenda.
const CONTACT_LAYOUTS_BY_CPS_SIZE = new Map([
  [1045696, { nameOffset: 494496, privateOffset: 538496, maxRecords: 1000, family: "CP0405" }],
  [1064192, { nameOffset: 495776, privateOffset: 539776, maxRecords: 1000, family: "CP7492" }],
  [1787008, { nameOffset: 1052256, privateOffset: 1096256, maxRecords: 1000, family: "CP0652" }],
  [2535552, { nameOffset: 1795872, privateOffset: 1839872, maxRecords: 1000, family: "CP0778" }],
  [2538688, { nameOffset: 1795872, privateOffset: 1839872, maxRecords: 1000, family: "CP0865" }],
  [2728576, { nameOffset: 1820192, privateOffset: 1864192, maxRecords: 1000, family: "CP1020" }],
  [2848576, { nameOffset: 1858784, privateOffset: 1902784, maxRecords: 1000, family: "CP1330 R27" }],
  [2849984, { nameOffset: 1860256, privateOffset: 1904256, maxRecords: 1000, family: "CP1274 R27" }],
  [3144064, { nameOffset: 1965600, privateOffset: 2009600, maxRecords: 1000, family: "CP1315 R55" }],
  [3159936, { nameOffset: 2035296, privateOffset: 2079296, maxRecords: 1000, family: "CP1726" }],
  [4739776, { nameOffset: 2015392, privateOffset: 2059392, maxRecords: 1000, family: "CP1274 R36" }],
  [4859968, { nameOffset: 2120288, privateOffset: 2164288, maxRecords: 1000, family: "CP1330 R36" }],
  [4861952, { nameOffset: 2120416, privateOffset: 2164416, maxRecords: 1000, family: "CP1407" }],
  [4862464, { nameOffset: 2120608, privateOffset: 2164608, maxRecords: 1000, family: "CP1511" }],
  [4997184, { nameOffset: 2138656, privateOffset: 2182656, maxRecords: 1000, family: "CP1649 R35/R36" }],
]);

function cleanName(value) {
  return String(value || "").replace(/\0/g, "").replace(/\s+/g, " ").trim();
}

function canonicalName(value) {
  return cleanName(value).normalize("NFC").toLocaleUpperCase("es-PE");
}

function canonicalizeContacts(contacts) {
  return (Array.isArray(contacts) ? contacts : [])
    .map((contact) => ({ name: cleanName(contact.name), issi: String(contact.issi || "").trim() }))
    .filter((contact) => contact.name && /^\d{1,8}$/.test(contact.issi) && Number(contact.issi) <= 16777215)
    .sort((left, right) => Number(left.issi) - Number(right.issi) || canonicalName(left.name).localeCompare(canonicalName(right.name)));
}

function agendaHash(contacts) {
  const value = canonicalizeContacts(contacts)
    .map((contact) => `${contact.issi}\t${canonicalName(contact.name)}`)
    .join("\n");
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function extractCpeContacts(cps) {
  if (!Buffer.isBuffer(cps)) {
    return { supported: false, state: "No disponible", count: 0, hash: "", confidence: "", contacts: [] };
  }
  const layout = CONTACT_LAYOUTS_BY_CPS_SIZE.get(cps.length);
  if (!layout) {
    return { supported: false, state: "No disponible", count: 0, hash: "", confidence: "", contacts: [] };
  }

  const contacts = [];
  for (let slot = 0; slot < layout.maxRecords; slot += 1) {
    const nameBase = layout.nameOffset + slot * 44;
    const privateIndex = cps.readUInt16LE(nameBase + 24);
    const name = cleanName(cps.subarray(nameBase, nameBase + 24).toString("utf16le"));
    if (!name || privateIndex < 1 || privateIndex > layout.maxRecords) continue;
    const privateBase = layout.privateOffset + (privateIndex - 1) * 12;
    const issi = cps.readUInt32LE(privateBase);
    if (issi < 1 || issi > 16777215) continue;
    contacts.push({ slot: slot + 1, name, issi: String(issi) });
  }
  const normalized = canonicalizeContacts(contacts);
  return {
    supported: true,
    state: normalized.length ? "Con contactos" : "Sin contactos",
    count: normalized.length,
    hash: agendaHash(normalized),
    confidence: "user-report-exact-layout",
    family: layout.family,
    contacts: normalized,
  };
}

function compareContactAgendas(expectedContacts, actualContacts) {
  const expected = canonicalizeContacts(expectedContacts);
  const actual = canonicalizeContacts(actualContacts);
  const keyOf = (item) => `${item.issi}|${canonicalName(item.name)}`;
  const remainingActual = new Map();
  for (const item of actual) {
    const key = keyOf(item);
    if (!remainingActual.has(key)) remainingActual.set(key, []);
    remainingActual.get(key).push(item);
  }
  const missing = [];
  for (const item of expected) {
    const matches = remainingActual.get(keyOf(item));
    if (matches?.length) matches.pop();
    else missing.push(item);
  }
  const extra = [...remainingActual.values()].flat();
  return {
    approved: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    expectedCount: expected.length,
    actualCount: actual.length,
  };
}

module.exports = {
  CONTACT_LAYOUTS_BY_CPS_SIZE,
  agendaHash,
  canonicalizeContacts,
  compareContactAgendas,
  extractCpeContacts,
};
