// 2026-09-09: exact User Report emergency evidence + validated folder layouts.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const Database=require('better-sqlite3'),paths=require('../lib/runtime-paths');
// This historical batch is only for the original two reports.
const references=require('../lib/validated-user-report-emergency').references.filter(r=>['55391','56562'].includes(r.issi));
const input='C:/Users/usrdolphin/Pictures/reporte user';
const out=paths.dataFile('user-reports-20260909');
const apply=process.argv.includes('--apply');
fs.mkdirSync(out,{recursive:true});
process.env.CPE_DB_FILE=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpe-user-reports-')),'parser.sqlite');
const app=require('../server');
const db=new Database(paths.dataFile('cpe-dashboard.sqlite'),{readonly:true,fileMustExist:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const signature=r=>[r.id,r.size,r.mtimeMs,r.parserVersion,r.lastParsedAt,r.existsFlag];
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
function reportTables(file) {
  const raw=fs.readFileSync(file);
  const html=raw.toString(raw[0]===255&&raw[1]===254?'utf16le':'utf8');
  const tables=new Map(); let section='';
  for(const m of html.matchAll(/<TABLE\b[^>]*>[\s\S]*?<\/TABLE>/gi)) {
    if(clean(m[0]).startsWith('Codeplug')) {section=clean(m[0]);continue;}
    const rows=[...m[0].matchAll(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi)].map(r=>[...r[0].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map(c=>clean(c[1]))).filter(r=>r.length);
    tables.set(section,rows);
  }
  return {raw,tables};
}
function validateReports() {
  const checks=[];
  for(const ref of references) {
    const report=reportTables(path.join(input,ref.issi+'.html'));
    assert.equal(hash(report.raw),ref.reportSha256,'Report changed');
    const rows=[...report.tables].find(([title])=>title.endsWith('\\TMO\\Lista de grupos de conversación TMO'))?.[1];
    assert.equal(rows?.length,10000);
    const expected=rows.filter(r=>r.includes('Programado')||r.includes('Invisible')).map(r=>[Number(r[2]),r[1],r.includes('Invisible')?'Invisible':'Programado']).sort((a,b)=>a[0]-b[0]);
    const fields=Object.fromEntries([...report.tables].find(([title])=>title.endsWith('Destino de llamada de emergencia - TMO'))[1].map(r=>[r[1],r[2]]));
    assert.equal(fields['Tipo de dirección de emergencia'],ref.emergency.emergencyAddressType);
    assert.equal(Number(fields['ISSI/GSSI de emergencia']),ref.emergency.emergencyGssi);
    if(ref.emergency.emergencyAddressType==='Grupo') {
      assert.equal(fields['Tipo de grupo de emergencia'],'No táctica');
      assert.equal(fields['Alias no táctico'],ref.emergency.emergencyAlias);
      assert.equal(fields['Enviar archivo adjunto a grupo no táctico'],'True');
    }
    const name=fs.readdirSync(input).find(n=>n.includes(`ISSI[${ref.issi}]`)&&n.endsWith('.cpe'));
    assert.ok(name);
    const local=path.join(input,name),extracted=app.extractCodeplugFile(local);
    for(const [key,value] of Object.entries(ref.emergency)) assert.equal(extracted[key],value,key);
    assert.deepEqual(extracted.rows.map(r=>[r.gssi,r.alias,r.statusText]).sort((a,b)=>a[0]-b[0]),expected);
    const originals=db.prepare('SELECT * FROM scanned_files WHERE existsFlag=1 AND issi=? AND fileName=?').all(ref.issi,name);
    assert.ok(originals.length);
    const localCps=app.parseCpeSections(local).sections.CPS;
    for(const original of originals) {
      const cps=app.parseCpeSections(original.path).sections.CPS;
      assert.ok(ref.hashes.includes(hash(cps)));
      const differing=[];
      for(let i=0;i<cps.length;i++)if(cps[i]!==localCps[i])differing.push(i);
      const checksumOffset=cps.readUInt32LE(0)+2;
      assert.ok(differing.every(i=>(i>=273&&i<=276)||i===checksumOffset),'Unreviewed source difference');
      const dateDelta=[273,274,275,276].reduce((sum,i)=>sum+localCps[i]-cps[i],0);
      assert.equal((localCps[checksumOffset]-cps[checksumOffset]+256)%256,(dateDelta+256)%256);
      const actual=app.extractCodeplugFile(original.path);
      assert.deepEqual(actual.rows.map(r=>[r.gssi,r.alias,r.statusText]).sort((a,b)=>a[0]-b[0]),expected);
      for(const [key,value] of Object.entries(ref.emergency))assert.equal(actual[key],value,key);
      checks.push({issi:ref.issi,path:original.path,groups:expected,emergency:ref.emergency,sourceCpsHash:hash(cps),differingBytes:differing});
    }
  }
  return checks;
}
async function main() {
  if(apply) {
    const plan=JSON.parse(fs.readFileSync(path.join(out,'prepared.json'),'utf8'));
    assert.equal(plan.parserVersion,app.database.parserVersion);
    const retired=[];
    // These three old folder references have indexed replacements in the same
    // batch. Preserve history, but do not leave missing paths as live results.
    for(const failure of plan.errors) {
      assert.ok([10834,10848,10849].includes(failure.id),'Unreviewed preparation error');
      const old=db.prepare('SELECT * FROM scanned_files WHERE id=?').get(failure.id);
      assert.equal(old.path,failure.path);
      assert.throws(()=>fs.statSync(old.path),e=>e.code==='ENOENT');
      const replacementPath=old.path.replace('\\REPSOL\\PAMPILLA\\','\\REPSOL\\REFINERIA PAMPILLA\\');
      assert.notEqual(replacementPath,old.path);
      const replacement=db.prepare('SELECT * FROM scanned_files WHERE path=? AND existsFlag=1').get(replacementPath);
      assert.ok(replacement);
      for(const key of ['serial','tei','issi','codeplug','size','mtimeMs'])assert.equal(old[key],replacement[key]);
      assert.ok(plan.records.some(r=>r.path===replacementPath));
      retired.push({id:old.id,path:old.path,replacementPath,previous:signature(old)});
    }
    for(const record of plan.records) {
      assert.deepEqual(signature(db.prepare('SELECT * FROM scanned_files WHERE path=?').get(record.path)),record.previous);
      const stat=fs.statSync(record.path);
      assert.equal(stat.size,record.size);assert.equal(stat.mtimeMs,record.mtimeMs);
      assert.equal(hash(fs.readFileSync(record.path)),record.sourceHash);
    }
    const backup=paths.dataFile(`before-user-reports-${Date.now()}.sqlite`);
    await db.backup(backup);
    const check=new Database(backup,{readonly:true,fileMustExist:true});
    try {assert.equal(check.pragma('integrity_check',{simple:true}),'ok');}finally{check.close();}
    const {CpeDatabase}=require('../lib/cpe-database');
    const live=new CpeDatabase(paths.dataFile('cpe-dashboard.sqlite'),app.database.parserVersion);
    try {
      live.db.transaction(()=>{
        for(const record of plan.records){assert.deepEqual(signature(live.getFile(record.path)),record.previous);live.storeOne(record);}
        for(const record of retired){assert.deepEqual(signature(live.getFile(record.path)),record.previous);live.setExists.run(0,record.id);}
        live.setMeta('user-reports-20260909',JSON.stringify({backup,applied:plan.records.length}));
      })();
      assert.equal(live.db.pragma('integrity_check',{simple:true}),'ok');
      assert.deepEqual(live.db.pragma('foreign_key_check'),[]);
    } finally {live.close();}
    const result={applied:plan.records.length,retired,backup};
    fs.writeFileSync(path.join(out,'applied.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));return;
  }
  const checked=validateReports();console.log(JSON.stringify({checked}));
  const candidates=db.prepare('SELECT * FROM scanned_files WHERE existsFlag=1 AND size IN (3160022,3160023,5263318,5263319)').all();
  const records=[],errors=[],details=[];
  for(const row of candidates) {
    try {
      const stat=fs.statSync(row.path);
      assert.equal(stat.size,row.size);assert.equal(stat.mtimeMs,row.mtimeMs);
      const raw=fs.readFileSync(row.path),sections=app.parseCpeSections(row.path).sections;
      assert.ok([3159936,5263232].includes(sections.CPS?.length));
      const codeplug=app.extractCodeplugFile(row.path);
      const after=fs.statSync(row.path);assert.equal(after.size,stat.size);assert.equal(after.mtimeMs,stat.mtimeMs);
      records.push({path:row.path,previous:signature(row),size:stat.size,mtimeMs:stat.mtimeMs,sourceHash:hash(raw),codeplug});
      details.push({id:row.id,issi:row.issi,cp:row.codeplug,oldGroups:row.groupCount,newGroups:codeplug.rows.length,invisible:codeplug.rows.filter(r=>r.status===2).length,emergencyMode:codeplug.emergencyMode,emergencyConfidence:codeplug.emergencyConfidence});
    }catch(e){errors.push({id:row.id,path:row.path,error:e.message});}
  }
  const stats={candidates:candidates.length,prepared:records.length,errors:errors.length,oldGroups:details.reduce((s,r)=>s+r.oldGroups,0),newGroups:details.reduce((s,r)=>s+r.newGroups,0),invisible:details.reduce((s,r)=>s+r.invisible,0),reportedEmergencies:details.filter(r=>r.emergencyConfidence==='user-report-exact').length};
  fs.writeFileSync(path.join(out,'prepared.json'),JSON.stringify({parserVersion:app.database.parserVersion,records,errors}));
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({checked,stats,details,errors},null,2));console.log(JSON.stringify({out,stats}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{db.close();app.database.close();});
