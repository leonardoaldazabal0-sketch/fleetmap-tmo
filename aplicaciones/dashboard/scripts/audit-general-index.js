// Prepare repairs using current extraction; apply only records whose original
const runtimePaths = require("../lib/runtime-paths");
// size/mtime and index signature still match. Original CPEs are never modified.
const fs=require('fs'),path=require('path'),os=require('os'),D=require('better-sqlite3');
const root=path.join(__dirname,'..');
const livePath=runtimePaths.dataFile('cpe-dashboard.sqlite');
const apply=process.argv.includes('--apply');
const reportDir=process.argv.find(a=>a.startsWith('--report-dir='))?.slice(13) || fs.mkdtempSync(path.join(os.tmpdir(),'cpe-general-audit-'));
fs.mkdirSync(reportDir,{recursive:true});
process.env.CPE_DB_FILE=apply?livePath:path.join(reportDir,'parser.sqlite');
const app=require('../server');
const {isExcludedCodeplugFile}=require('../lib/cpe-file-filter');
const source=new D(livePath,{readonly:true,fileMustExist:true});
const spool=path.join(reportDir,'repairs.ndjson');
async function main(){
 if(apply){
  const backup=runtimePaths.dataFile('before-general-audit-'+Date.now()+'.sqlite');await app.database.db.backup(backup);
  const stats={applied:0,excluded:0,stale:0};const exclusions=[];
  const records=fs.readFileSync(spool,'utf8').trim().split('\n').filter(Boolean);let pending=[];
  for(const line of records){const r=JSON.parse(line);const current=app.database.getFile(r.path);
   if(!current||current.mtimeMs!==r.previousMtime||current.size!==r.previousSize||!current.existsFlag){stats.stale++;continue;}
   if(r.exclude){app.database.markDeleted([current.id]);exclusions.push({id:current.id,path:r.path});stats.excluded++;continue;}
   let stat;try{stat=fs.statSync(r.path)}catch{stats.stale++;continue;}
   if(stat.size!==r.size||stat.mtimeMs!==r.mtimeMs){stats.stale++;continue;}
   if(r.error)r.error=Object.assign(new Error(r.error.message),{name:r.error.name});
   pending.push(r);stats.applied++;if(pending.length>=100){app.database.storeBatch(pending);pending=[];console.log(JSON.stringify(stats));}
  }
  if(pending.length)app.database.storeBatch(pending);
  app.database.setMeta('general-audit-2026-09-07',JSON.stringify({stats,backup,exclusions,finishedAt:new Date().toISOString()}));
  fs.writeFileSync(path.join(reportDir,'applied.json'),JSON.stringify({stats,backup},null,2));console.log(JSON.stringify({stats,backup}));return;
 }
 const all=source.prepare('SELECT * FROM scanned_files WHERE existsFlag=1').all();
 const bad=new Set(source.prepare(`SELECT DISTINCT f.id FROM scanned_files f JOIN talkgroups t ON t.fileId=f.id
 WHERE f.existsFlag=1 AND (t.gssi<1 OR t.gssi>16777215 OR t.status NOT IN (0,1,2) OR t.slot>10000)`).all().map(r=>r.id));
 const candidates=all.filter(r=>bad.has(r.id)||r.errorMessage||isExcludedCodeplugFile(r.path)||
   (r.codeplug==='1330'&&![4860054,0].includes(r.size))||
   (r.codeplug==='1020'&&![2728662,2728650,0].includes(r.size))||
   (r.codeplug==='1407'&&![3086806,0].includes(r.size)));
 const fd=fs.openSync(spool,'w');const details=[];
 const stats={candidates:candidates.length,parsed:0,errors:0,missing:0,excluded:0,oldGroups:0,newGroups:0};
 console.log(JSON.stringify({reportDir,stats}));
 try{for(const row of candidates){
  const base={path:row.path,previousMtime:row.mtimeMs,previousSize:row.size};
  if(isExcludedCodeplugFile(row.path)){fs.writeSync(fd,JSON.stringify({...base,exclude:true})+'\n');stats.excluded++;continue;}
  let stat;try{stat=fs.statSync(row.path)}catch(e){stats.missing++;details.push({id:row.id,issi:row.issi,path:row.path,issue:e.message});continue;}
  const record={...base,size:stat.size,mtimeMs:stat.mtimeMs};
  try{record.codeplug=app.extractCodeplugFile(row.path);stats.parsed++;stats.oldGroups+=row.groupCount;stats.newGroups+=record.codeplug.rows.length;
   details.push({id:row.id,issi:row.issi,cp:row.codeplug,previousError:row.errorMessage,oldGroups:row.groupCount,newGroups:record.codeplug.rows.length});
  }catch(e){record.error={name:e.name,message:e.message};record.meta={...row,date:row.folderDate};stats.errors++;details.push({id:row.id,path:row.path,issue:e.message});}
  fs.writeSync(fd,JSON.stringify(record)+'\n');
  if((stats.parsed+stats.errors+stats.missing)%100===0)console.log(JSON.stringify(stats));
 }}finally{fs.closeSync(fd)}
 fs.writeFileSync(path.join(reportDir,'summary.json'),JSON.stringify({stats,details},null,2));console.log(JSON.stringify({reportDir,stats}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{source.close();app.database.close()});
