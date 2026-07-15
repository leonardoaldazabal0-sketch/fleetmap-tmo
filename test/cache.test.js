const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CpeCache } = require("../lib/cpe-cache");

test("persiste datos y reutiliza solo una firma de archivo identica", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-cache-test-"));
  const source = path.join(root, "radio.cpe");
  const database = path.join(root, "data", "cache.json");
  fs.writeFileSync(source, "primera version");

  const firstStat = fs.statSync(source);
  const first = new CpeCache(database, "parser-1");
  first.store(source, firstStat, {
    serial: "123",
    issi: "456",
    codeplug: "1020",
    software: "R01",
    rows: [{ alias: "OPERACIONES", gssi: 99 }],
  });
  assert.equal(first.save(), true);

  const second = new CpeCache(database, "parser-1");
  assert.equal(second.lookup(source, firstStat).data.serial, "123");
  assert.equal(second.lookup(source, firstStat).data.rows[0].gssi, 99);
  assert.equal(new CpeCache(database, "parser-2").lookup(source, firstStat), null);

  fs.appendFileSync(source, " modificada");
  assert.equal(second.lookup(source, fs.statSync(source)), null);
});

test("elimina entradas ausentes dentro de la carpeta reescaneada", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-cache-prune-"));
  const source = path.join(root, "eliminado.cpe");
  const database = path.join(root, "cache.json");
  fs.writeFileSync(source, "contenido");

  const cache = new CpeCache(database, "1");
  cache.store(source, fs.statSync(source), { rows: [] });
  assert.equal(cache.pruneMissing(root, []), 1);
  assert.equal(Object.keys(cache.entries).length, 0);
});

test("reconstruye una cache JSON danada", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpe-cache-corrupt-"));
  const database = path.join(root, "cache.json");
  fs.writeFileSync(database, "{no-es-json");

  const cache = new CpeCache(database, "1");
  assert.match(cache.warning, /reconstruira/);
  assert.equal(cache.save(), true);
  assert.equal(JSON.parse(fs.readFileSync(database, "utf8")).schemaVersion, 1);
});
