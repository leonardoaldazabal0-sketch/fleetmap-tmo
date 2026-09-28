const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('better-sqlite3'),paths=require('../lib/runtime-paths');
const {normalizeReportText:norm}=require('../lib/cps-user-report-reader');
const out=paths.dataFile('user-reports-lote2-20260909');
const summary=JSON.parse(fs.readFileSync(path.join(out,'summary.json'),'utf8'));
const applied=JSON.parse(fs.readFileSync(path.join(out,'applied.json'),'utf8'));
const records=fs.readFileSync(path.join(out,'repairs.ndjson'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
process.env.CPE_DB_FILE=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpe-verify-lote2-')),'p.sqlite');
const app=require('../server');
const project=rows=>rows.map(r=>[r.gssi,norm(r.alias),r.statusText]).sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])||a[2].localeCompare(b[2]));
async function main(){
  const current=new D(paths.dataFile('cpe-dashboard.sqlite'),{readonly:true,fileMustExist:true}),before=new D(applied.backup,{readonly:true,fileMustExist:true});
  const changed=new Set(records.map(r=>r.previous[0])),retired=new Set(applied.retired.map(r=>r.id));
  let untouched=0;
  try{
    assert.equal(current.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(current.pragma('foreign_key_check'),[]);
    const old=before.prepare('SELECT * FROM scanned_files WHERE id=?');
    for(const row of current.prepare('SELECT * FROM scanned_files').iterate()){
      if(changed.has(row.id))continue;const previous=old.get(row.id);assert.deepEqual(row,retired.has(row.id)?{...previous,existsFlag:0}:previous);untouched++;
    }
    const find=current.prepare('SELECT * FROM scanned_files WHERE path=?'),groups=current.prepare('SELECT gssi,alias,statusText FROM talkgroups WHERE fileId=?');
    for(const r of records){const row=find.get(r.path);assert.equal(row.parserVersion,summary.parserVersion);assert.equal(row.groupCount,r.codeplug.rows.length);assert.deepEqual(project(groups.all(row.id)),project(r.codeplug.rows));}
    console.log(JSON.stringify({verifiedRecords:records.length,otherFileRowsChecked:untouched}));
  }finally{current.close();before.close();}
  const results=[],excelRows=[];
  for(const ref of summary.checked){
    const response=await(await fetch('http://127.0.0.1:8787/api/radio-search?issi='+ref.issi)).json();
    for(const source of ref.sources){
      const cps=app.parseCpeSections(source.path).sections.CPS;assert.equal(crypto.createHash('sha256').update(cps).digest('hex'),source.cpsHash,'Reference original changed');
      const radio=response.results.find(r=>r.file===source.path);assert.ok(radio,source.path);
      assert.deepEqual(project(radio.groups),ref.groups);
      assert.deepEqual(radio.groups.map(g=>g.gssi),radio.groups.map(g=>g.gssi).sort((a,b)=>a-b));
      for(const [key,value] of Object.entries(ref.emergency))assert.equal(radio[key],value,ref.issi+' '+key);
    }
    const codeplug=app.extractCodeplugFile(ref.sources[0].path);
    excelRows.push(...codeplug.rows.map(r=>({...r,...ref.emergency,razonSocial:'RAZON SOCIAL VERIFICACION'})));
    results.push({issi:ref.issi,cp:ref.cp,groups:ref.groups.length,mode:ref.emergency.emergencyMode,destination:ref.emergency.emergencyGssi||'Grupo actual'});
  }
  // Export the exact verified versions: some supplied samples are historical
  // ANTES files and must not be confused with the latest Fleet Map selection.
  const response=await fetch('http://127.0.0.1:8787/api/export-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows:excelRows})});assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer()),zip=app.readZip(bytes),detail=zip.get('xl/worksheets/sheet2.xml').toString();
  for(const word of ['Invisible','OPERACIONES','RTG- MANIOBR','URGENCIA','10010043','EMER_TOTAL','7226','RAZON SOCIAL VERIFICACION'])assert.ok(detail.includes(word),word);
  const rows=[...detail.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(1);
  const byFile=new Map();
  for(const row of rows){const cells=[...row[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map(c=>c[1].replace(/<[^>]+>/g,''));const key=cells[7]+'|'+cells[16];const values=byFile.get(key)||[];values.push(Number(cells[20]));byFile.set(key,values);}
  for(const values of byFile.values())assert.deepEqual(values,[...values].sort((a,b)=>a-b));
  const verified={applied:applied.applied,retired:applied.retired.length,skipped:applied.skipped.length,results,excelBytes:bytes.length,verifiedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(verified,null,2));console.log(JSON.stringify(verified,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>app.database.close());
