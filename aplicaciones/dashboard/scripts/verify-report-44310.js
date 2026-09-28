const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const paths = require('../lib/runtime-paths');
const reportDir = process.argv[2];
if (!reportDir) throw new Error('Required: report directory');
const applied = JSON.parse(fs.readFileSync(path.join(reportDir,'applied.json'),'utf8'));
const repairs = fs.readFileSync(path.join(reportDir,'repairs.ndjson'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
const excludedIds = new Set(repairs.map(r => r.previous[0]));
const retiredFile = path.join(reportDir,'retired-paths.json');
const retired = fs.existsSync(retiredFile) ? JSON.parse(fs.readFileSync(retiredFile,'utf8')) : [];
const retiredIds = new Set(retired.map(r=>r.id));
process.env.CPE_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpe-verify-44310-')),'parser.sqlite');
const app = require('../server');
const base = 'http://127.0.0.1:8787';
function digest(db, table, idColumn) {
  const hash = crypto.createHash('sha256');
  let count = 0;
  for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate()) {
    if (excludedIds.has(row[idColumn])) continue;
    if (table==='scanned_files' && retiredIds.has(row.id)) continue;
    hash.update(JSON.stringify(row)+'\n'); count++;
  }
  return {count, sha256:hash.digest('hex')};
}
async function main() {
  const health = await (await fetch(base+'/api/health')).json();
  assert.equal(health.ok,true);
  const current = new Database(paths.dataFile('cpe-dashboard.sqlite'),{readonly:true,fileMustExist:true});
  const before = new Database(applied.backup,{readonly:true,fileMustExist:true});
  const untouched = {};
  try {
    for (const [table,id] of [['scanned_files','id'],['talkgroups','fileId']]) {
      untouched[table] = digest(current,table,id);
      assert.deepEqual(untouched[table],digest(before,table,id),`Unrelated ${table} changed`);
    }
    assert.equal(current.pragma('integrity_check',{simple:true}),'ok');
    assert.deepEqual(current.pragma('foreign_key_check'),[]);
    for (const record of retired) {
      const previous = before.prepare('SELECT * FROM scanned_files WHERE id=?').get(record.id);
      const inactive = current.prepare('SELECT * FROM scanned_files WHERE id=?').get(record.id);
      assert.deepEqual(inactive,{...previous,existsFlag:0});
    }
  } finally { current.close(); before.close(); }
  const response = await (await fetch(base+'/api/radio-search?issi=44310')).json();
  const radio = response.results.find(r => r.issi==='44310');
  assert.ok(radio);
  assert.equal(radio.emergencyMode,'No táctico');
  assert.equal(radio.emergencyAlias,'ALP-EMERG');
  assert.equal(radio.emergencyGssi,9901);
  assert.deepEqual(radio.groups.map(g => [g.gssi,g.alias,g.statusText]),[
    [6024,'ROM-OPERACIO','Programado'],[9902,'ALP-OPERAC','Programado'],
    [9908,'ALP-BROADCAS','Invisible'],[9995,'ROM-EXPLO','Programado'],
  ]);
  const xmlRow = values => '<row>'+values.map((v,i)=>`<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${v}</t></is></c>`).join('')+'</row>';
  const master = app.createZip([
    {name:'xl/workbook.xml',data:'<workbook><sheets><sheet name="NMS" r:id="r1"/></sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels',data:'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'},
    {name:'xl/worksheets/sheet1.xml',data:'<worksheet><sheetData>'+xmlRow(['ISSI','cliente','razon_social','unidad'])+xmlRow(['44310','VOLCAN','RAZON SOCIAL VERIFICACION','ROMINA'])+'</sheetData></worksheet>'},
  ]).toString('base64');
  const excelResponse = await fetch(base+'/api/export-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({masterFileBase64:master})});
  assert.equal(excelResponse.status,200);
  const workbook = Buffer.from(await excelResponse.arrayBuffer());
  const files = app.readZip(workbook);
  const detail = files.get('xl/worksheets/sheet2.xml').toString();
  assert.match(detail,/ALP-EMERG/); assert.match(detail,/>9901</);
  assert.match(detail,/ROM-OPERACIO/); assert.match(detail,/ALP-BROADCAS/);
  assert.match(detail,/Invisible/); assert.match(detail,/RAZON SOCIAL VERIFICACION/);
  const order = ['ROM-OPERACIO','ALP-OPERAC','ALP-BROADCAS','ROM-EXPLO'].map(alias => detail.indexOf(alias));
  assert.deepEqual(order,[...order].sort((a,b)=>a-b));
  const result = {health:health.database,untouched,radio:{issi:radio.issi,groups:radio.groups,emergencyMode:radio.emergencyMode,emergencyGssi:radio.emergencyGssi},excelBytes:workbook.length,verifiedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(reportDir,'verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>app.database.close());
