const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTACT_LAYOUTS_BY_CPS_SIZE,
  compareContactAgendas,
  extractCpeContacts,
} = require("../lib/cpe-contacts");

function writeUtf16(buffer, offset, value, bytes = 24) {
  Buffer.from(String(value), "utf16le").copy(buffer, offset, 0, bytes);
}

test("extrae nombres e ISSI siguiendo el índice privado de la agenda", () => {
  const size = 2535552;
  const layout = CONTACT_LAYOUTS_BY_CPS_SIZE.get(size);
  const cps = Buffer.alloc(size);
  writeUtf16(cps, layout.nameOffset, "JEFE MINA");
  cps.writeUInt16LE(2, layout.nameOffset + 24);
  cps.writeUInt32LE(44310, layout.privateOffset + 12);
  writeUtf16(cps, layout.nameOffset + 44, "SUPERVISOR");
  cps.writeUInt16LE(1, layout.nameOffset + 44 + 24);
  cps.writeUInt32LE(45140, layout.privateOffset);

  const agenda = extractCpeContacts(cps);
  assert.equal(agenda.supported, true);
  assert.equal(agenda.count, 2);
  assert.deepEqual(agenda.contacts, [
    { name: "JEFE MINA", issi: "44310" },
    { name: "SUPERVISOR", issi: "45140" },
  ]);
});

test("un tamaño desconocido es no disponible y no una agenda vacía", () => {
  assert.deepEqual(extractCpeContacts(Buffer.alloc(128)), {
    supported: false, state: "No disponible", count: 0, hash: "", confidence: "", contacts: [],
  });
});

test("compara agendas como conjunto e ignora el orden", () => {
  const expected = [{ name: "JEFE MINA", issi: "44310" }, { name: "SUPERVISOR", issi: "45140" }];
  assert.equal(compareContactAgendas(expected, [...expected].reverse()).approved, true);
  const different = compareContactAgendas(expected, [{ name: "JEFE", issi: "44310" }]);
  assert.equal(different.approved, false);
  assert.equal(different.missing.length, 2);
  assert.equal(different.extra.length, 1);
  const duplicate = compareContactAgendas(expected, [...expected, expected[0]]);
  assert.equal(duplicate.approved, false);
  assert.equal(duplicate.extra.length, 1);
});
