const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('better-sqlite3'),paths=require('../lib/runtime-paths');
const {parseUserReport,normalizeReportText:norm}=require('../lib/cps-user-report-reader');
const refs=require('../lib/validated-user-report-emergency-lote2');
const {groupLayouts}=require('../lib/validated-user-report-group-layouts');
const input='C:/Users/usrdolphin/Pictures/reporte user',out=paths.dataFile('user-reports-lote2-20260909');
fs.mkdirSync(out,{recursive:true});
process.env.CPE_DB_FILE=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpe-lote2-')),'p.sqlite');
const app=require('../server'),db=new D(paths.dataFile('cpe-dashboard.sqlite'),{readonly:true,fileMustExist:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const signature=r=>[r.id,r.size,r.mtimeMs,r.parserVersion,r.lastParsedAt,r.existsFlag];
const project=rows=>rows.map(g=>[g.gssi,norm(g.alias),g.statusText]).sort((a,b)=>a[0]-b[0]||a[1].localeCompare(b[1])||a[2].localeCompare(b[2]));
const spool=path.join(out,'repairs.ndjson');
function cpsLength(file){
  const fd=fs.openSync(file,'r');
  try{const size=fs.fstatSync(fd).size,head=Buffer.alloc(9),section=Buffer.alloc(7);
    assert.equal(fs.readSync(fd,head,0,9,0),9);assert.equal(head.subarray(0,7).toString(),'CPDFile');
    for(let cursor=9;cursor+7<=size;){assert.equal(fs.readSync(fd,section,0,7,cursor),7);const n=section.readInt32LE(3);assert.ok(n>=0&&cursor+7+n<=size);if(section.subarray(0,3).toString()==='CPS')return n;cursor+=7+n;}
    throw new Error('Missing CPS');
  }finally{fs.closeSync(fd);}
}
function validate(){
  const checked=[];
  for(const ref of refs){
    const report=parseUserReport(fs.readFileSync(path.join(input,ref.issi+'.html')));
    assert.equal(report.reportSha256,ref.reportSha256);assert.deepEqual(report.emergency,ref.emergency);
    const fileName=fs.readdirSync(input).find(n=>n.endsWith('.cpe')&&n.includes(`ISSI[${ref.issi}]`));assert.ok(fileName);
    const local=path.join(input,fileName),cps=app.parseCpeSections(local).sections.CPS,layout=groupLayouts[cps.length];
    assert.ok(ref.hashes.includes(hash(cps)));assert.equal(cps.length,ref.cpsLength);
    assert.equal(report.allGroups.length,layout.main.maxRecords);
    for(const g of report.allGroups){const base=layout.main.offset+(g.slot-1)*layout.main.recordSize;
      assert.equal(norm(cps.subarray(base,base+layout.main.aliasBytes).toString('utf16le').split('\0')[0].trim()),g.alias,ref.issi+' alias '+g.slot);
      assert.equal(cps.readUInt32LE(base+layout.main.gssiOffset),g.gssi,ref.issi+' GSSI '+g.slot);
    }
    const actual=app.extractCodeplugFile(local);
    for(const key of ['issi','serial','tei','software'])assert.equal(actual[key],report.identity[key]);
    assert.deepEqual(project(actual.rows),project(report.groups));
    for(const [key,value] of Object.entries(ref.emergency))assert.equal(actual[key],value);
    const sources=[];
    for(const row of db.prepare('SELECT * FROM scanned_files WHERE existsFlag=1 AND fileName=?').all(fileName)){
      if(!fs.existsSync(row.path))continue;
      const source=app.parseCpeSections(row.path).sections.CPS;
      assert.ok(ref.hashes.includes(hash(source)),'Source fingerprint not validated');
      const differences=[];for(let i=0;i<cps.length;i++)if(cps[i]!==source[i])differences.push(i);
      if(differences.length){
        assert.equal(ref.issi,'90374');assert.ok(differences.every(i=>(i>=260&&i<=264)||i===2302));
        const delta=[260,261,262,263,264].reduce((sum,i)=>sum+cps[i]-source[i],0);
        assert.equal((cps[2302]-source[2302]+256)%256,(delta+256)%256);
      }
      sources.push({path:row.path,cpsHash:hash(source),differences});
    }
    assert.ok(sources.length,'No indexed source for reference');
    checked.push({issi:ref.issi,cp:actual.codeplug,cpsLength:cps.length,groups:project(report.groups),emergency:ref.emergency,sources});
  }
  return checked;
}
async function prepare(){
  const checked=validate();console.log(JSON.stringify({checked}));
  const lengths=Object.keys(groupLayouts).map(Number);
  const sizes=lengths.flatMap(n=>[n+86,n+87,n+131165]);
  const rows=db.prepare(`SELECT * FROM scanned_files WHERE existsFlag=1 AND size IN (${sizes.map(()=>'?').join(',')}) ORDER BY id`).all(...sizes);
  const details=[],errors=[];const stats={candidates:rows.length,prepared:0,errors:0,oldGroups:0,newGroups:0,invisible:0,recoveredErrors:0,reportedEmergency:0,byCp:{}};
  const fd=fs.openSync(spool,'wx');
  try{for(const row of rows){
    try{const stat=fs.statSync(row.path);assert.equal(stat.size,row.size);assert.equal(stat.mtimeMs,row.mtimeMs);
      assert.ok(lengths.includes(cpsLength(row.path)));
      const codeplug=app.extractCodeplugFile(row.path),after=fs.statSync(row.path);
      assert.equal(after.size,stat.size);assert.equal(after.mtimeMs,stat.mtimeMs);
      fs.writeSync(fd,JSON.stringify({path:row.path,previous:signature(row),size:stat.size,mtimeMs:stat.mtimeMs,codeplug})+'\n');
      const invisible=codeplug.rows.filter(r=>r.status===2).length;
      details.push({id:row.id,issi:row.issi,cp:row.codeplug,oldGroups:row.groupCount,newGroups:codeplug.rows.length,invisible,mode:codeplug.emergencyMode,previousError:row.errorMessage});
      stats.prepared++;stats.oldGroups+=row.groupCount;stats.newGroups+=codeplug.rows.length;stats.invisible+=invisible;stats.recoveredErrors+=Number(Boolean(row.errorMessage));stats.reportedEmergency+=Number(codeplug.emergencyConfidence==='user-report-exact');
      const cp=row.codeplug||'(sin CP)';stats.byCp[cp]=(stats.byCp[cp]||0)+1;
    }catch(e){stats.errors++;errors.push({id:row.id,path:row.path,previous:signature(row),code:e.code||'',message:e.message});}
    if((stats.prepared+stats.errors)%100===0)console.log(JSON.stringify(stats));
  }}finally{fs.closeSync(fd);}
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({parserVersion:app.database.parserVersion,checked,stats,details,errors},null,2));console.log(JSON.stringify({out,stats,errors}));
}
async function apply(){
  const summary=JSON.parse(fs.readFileSync(path.join(out,'summary.json'),'utf8'));
  assert.equal(summary.parserVersion,app.database.parserVersion);
  const records=fs.readFileSync(spool,'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(records.length,summary.stats.prepared);
  for(const record of records){assert.deepEqual(signature(db.prepare('SELECT * FROM scanned_files WHERE path=?').get(record.path)),record.previous);const stat=fs.statSync(record.path);assert.equal(stat.size,record.size);assert.equal(stat.mtimeMs,record.mtimeMs);}
  const retired=[],skipped=[];
  for(const failure of summary.errors){
    const old=db.prepare('SELECT * FROM scanned_files WHERE id=?').get(failure.id);
    if(failure.code!=='ENOENT'||!old?.path.includes('\\REPSOL\\PAMPILLA\\')){skipped.push(failure);continue;}
    const replacementPath=old.path.replace('\\REPSOL\\PAMPILLA\\','\\REPSOL\\REFINERIA PAMPILLA\\');
    const replacement=db.prepare('SELECT * FROM scanned_files WHERE existsFlag=1 AND path=?').get(replacementPath);
    if(!replacement||!records.some(r=>r.path===replacementPath)){skipped.push(failure);continue;}
    assert.throws(()=>fs.statSync(old.path),e=>e.code==='ENOENT');
    for(const key of ['serial','tei','issi','codeplug','size','mtimeMs'])assert.equal(replacement[key],old[key]);
    assert.deepEqual(signature(old),failure.previous);retired.push({...failure,replacementPath});
  }
  const backup=paths.dataFile(`before-user-reports-lote2-${Date.now()}.sqlite`);await db.backup(backup);
  const backupDb=new D(backup,{readonly:true,fileMustExist:true});try{assert.equal(backupDb.pragma('integrity_check',{simple:true}),'ok');}finally{backupDb.close();}
  const {CpeDatabase}=require('../lib/cpe-database'),live=new CpeDatabase(paths.dataFile('cpe-dashboard.sqlite'),app.database.parserVersion);
  try{live.db.transaction(()=>{
    for(const r of records){assert.deepEqual(signature(live.getFile(r.path)),r.previous);live.storeOne(r);}
    for(const r of retired){assert.deepEqual(signature(live.getFile(r.path)),r.previous);live.setExists.run(0,r.id);}
    live.setMeta('user-report-lote2',JSON.stringify({backup,applied:records.length,retired:retired.length,at:new Date().toISOString()}));
  })();assert.equal(live.db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(live.db.pragma('foreign_key_check'),[]);}finally{live.close();}
  const result={applied:records.length,retired,skipped,backup};fs.writeFileSync(path.join(out,'applied.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
(process.argv.includes('--apply')?apply():prepare()).catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{db.close();app.database.close();});
