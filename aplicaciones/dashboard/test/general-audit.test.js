const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const runtimePaths = require('../lib/runtime-paths');
const temporaryBase = process.env.CPE_TEST_TMP_DIR || path.join(runtimePaths.dir('temporales'), 'pruebas');
fs.mkdirSync(temporaryBase, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryBase, 'cpe-audit-test-'));
process.env.CPE_DB_FILE = path.join(root, 'test.sqlite');
process.env.CPE_CENTRAL_ROOT = root;
const app = require('../server');
test.after(() => {
  app.database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('recupera una lectura CPE cuando la lectura completa de SMB falla', () => {
  const file = path.join(root, 'lectura-por-bloques.cpe');
  const expected = Buffer.alloc(256 * 1024 + 17, 0x5a);
  fs.writeFileSync(file, expected);
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(file)) {
      const error = new Error('UNKNOWN: unknown error, read');
      error.code = 'UNKNOWN';
      throw error;
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    assert.deepEqual(app.readFileSyncResilient(file), expected);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('no relee desde el NAS un CPE que ya tiene error persistido', () => {
  const file = path.join(root, 'cpe-corrupto.cpe');
  fs.writeFileSync(file, Buffer.alloc(32));
  const originalReadFileSync = fs.readFileSync;
  let attempted = false;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(file)) attempted = true;
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    const features = app.resolveFileFeatures({ path: file, featuresJson: '', errorMessage: 'CPE corrupto' });
    assert.equal(attempted, false);
    assert.equal(features.otap.state, 'No disponible');
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

function master(issi = '44310.0') {
  const row = values => '<row>' + values.map((v, i) => `<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${v}</t></is></c>`).join('') + '</row>';
  return app.createZip([
    {name:'xl/workbook.xml', data:`<workbook><sheets><sheet r:id='a' name='Datos'/><sheet name='NMS' r:id='b'/></sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels', data:`<Relationships><Relationship Target='worksheets/a.xml' Id='a'/><Relationship Id='b' Target='worksheets/b.xml'/></Relationships>`},
    {name:'xl/worksheets/a.xml',data:'<worksheet><sheetData>' + row(['ISSI','tipo_cliente','cliente_SIG','razon_social_SIG']) + row([issi,'EMPRESA','CLIENTE','RAZ&#243;n SOCIAL']) + '</sheetData></worksheet>'},
    {name:'xl/worksheets/b.xml',data:'<worksheet><sheetData>'+row(['Resumen'])+'</sheetData></worksheet>'},
  ]).toString('base64');
}

test('maestro selecciona hoja con ISSI y columnas exactas sin corromper ISSI decimal', () => {
  const result = app.parseMasterWorkbook(master());
  assert.equal(result.sheetName, 'Datos');
  assert.equal(result.records[0].issi, '44310');
  assert.equal(result.records[0].cliente, 'CLIENTE');
  assert.equal(result.records[0].tipoCliente, 'EMPRESA');
  assert.equal(result.records[0].razonSocial, 'RAZón SOCIAL');
  assert.throws(() => app.parseMasterWorkbook(master('44310.5')), /ISSI invalido/);
  assert.throws(() => app.parseMasterWorkbook(master('radio 44310')), /ISSI invalido/);
});

test('rechaza ZIP corrupto, truncado y expansion excesiva', () => {
  const valid = app.createZip([{name:'a.xml',data:'abc'}]);
  assert.equal(app.readZip(valid).get('a.xml').toString(), 'abc');
  assert.throws(() => app.readZip(valid.subarray(0, 12)), /Excel invalido/);
  const corrupt = Buffer.from(valid);
  corrupt[35] ^= 1;
  assert.throws(() => app.readZip(corrupt), /corrupt/);
  const huge = Buffer.from(valid);
  const central = huge.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  huge.writeUInt32LE(300*1024*1024, central+24);
  assert.throws(() => app.readZip(huge), /demasiado grande/);
});

test('busquedas literales, campos combinados y cache versionada', () => {
  app.database.storeBatch([{path:path.join(root,'radio.cpe'),size:100,mtimeMs:10,
    codeplug:{serial:'AB.CD-12',tei:'T1',issi:'44310',rows:[]}}]);
  for (const term of ['_', '%', '---', ' / . ']) {
    assert.deepEqual(app.database.searchRadios(term), []);
    assert.deepEqual(app.database.searchRadiosByFields({serial:term}), []);
  }
  assert.equal(app.database.searchRadios('abcd12')[0].issi, '44310');
  assert.equal(app.database.searchRadiosByFields({serial:'abcd12',issi:'44310'})[0].tei, 'T1');
  assert.deepEqual(app.database.searchRadiosByFields({serial:'abcd12',issi:'99999'}), []);
  const saved = app.database.getFile(path.join(root,'radio.cpe'));
  assert.equal(app.database.signatureMatches(saved,{size:100,mtimeMs:10}), true);
  assert.equal(app.database.signatureMatches({...saved,parserVersion:'13'},{size:100,mtimeMs:10}), false);
  app.database.db.prepare('UPDATE scanned_files SET parserVersion=? WHERE id=?').run('13', saved.id);
  app.database.updateFeatures(saved.id, {scan:{state:'Activo',lists:[]}});
  const refreshed = app.database.getFile(path.join(root,'radio.cpe'));
  assert.equal(refreshed.parserVersion, app.database.parserVersion);
  assert.equal(JSON.parse(refreshed.featuresJson).scan.state, 'Activo');
});

test('exportacion elimina caracteres XML invalidos conservando espacios', () => {
  const buffer = app.buildWorkbook({rows:[],history:[],missing:[{issi:'123',cliente:' A\u0001B '}],errors:[]});
  const text = [...app.readZip(buffer).values()].map(v=>v.toString()).join('');
  assert.ok(!text.includes('\u0001'));
  assert.match(text, /xml:space="preserve"/);
});

test('HTTP responde ante errores y sigue disponible', async () => {
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(base+'/api/health')).status, 200);
    const healthResponse = await fetch(base+'/api/health-panel?refresh=1');
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.service.ok, true);
    assert.equal(health.nas.ok, true);
    assert.equal(health.codeplugs.indexedFiles, health.codeplugs.correctFiles + health.codeplugs.corruptFiles + health.codeplugs.unsupportedFiles);
    assert.equal((await fetch(base+'/api/radio-search?issi=%25')).status, 200);
    assert.equal((await fetch(base+'/..%5cpublic-secret.txt')).status, 404);
    assert.equal((await fetch(base+'/api/health')).status, 200);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});
