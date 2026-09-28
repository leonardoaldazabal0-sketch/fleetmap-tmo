const fs=require('fs'),path=require('path');
const Database=require('better-sqlite3');
const apply=process.argv.includes('--apply');
const source=process.argv.find(x=>x.startsWith('--source-db='))?.slice(12);
if(!apply && !source)throw new Error('Dry-run requires --source-db=... and CPE_DB_FILE pointing to a temporary database');
const app=require('../server');
const runtimePaths=require('../lib/runtime-paths');
const {maskCodeplugInfo}=require('../lib/cpe-file-filter');
const db=apply?app.database.db:new Database(source,{readonly:true,fileMustExist:true});
const sizes=new Set([945430,1065366,1905814,2036893,2599894,2626774,3020950,3087062,3276566,3346455,917334,959446,1090525,603543,604311]);
async function main(){
 const all=db.prepare('SELECT * FROM scanned_files WHERE existsFlag=1').all();
 const masks=all.filter(r=>maskCodeplugInfo(r.path,r.codeplug));
 const candidates=all.filter(r=>sizes.has(r.size)&&!maskCodeplugInfo(r.path,r.codeplug));
 const results=[],pending=[];
 const stats={candidates:candidates.length,parsed:0,groups:0,withoutGroups:0,failures:0,masks:masks.length};
 let backup='';
 if(apply){backup=runtimePaths.dataFile('before-september-'+Date.now()+'.sqlite');await db.backup(backup);}
 for(const row of candidates){
  try {
   const stat=fs.statSync(row.path),codeplug=app.extractCodeplugFile(row.path);
   const invalid=codeplug.rows.some(g=>!g.alias||g.gssi<=0||g.gssi>16777215||/[\u0001-\u001f\ufffd]/.test(g.alias));
   if(invalid)throw new Error('Extracted group failed validation');
   stats.parsed++;stats.groups+=codeplug.rows.length;if(!codeplug.rows.length)stats.withoutGroups++;
   results.push({id:row.id,issi:row.issi,codeplug:row.codeplug,path:row.path,previousError:row.errorMessage,oldCount:row.groupCount,count:codeplug.rows.length,groups:codeplug.rows.map(g=>[g.alias,g.gssi]),mode:codeplug.emergencyMode,gssi:codeplug.emergencyGssi});
   if(apply)pending.push({path:row.path,size:stat.size,mtimeMs:stat.mtimeMs,codeplug});
  }catch(error){stats.failures++;results.push({id:row.id,path:row.path,error:error.message});}
  if(pending.length>=50)app.database.storeBatch(pending.splice(0));
  if((stats.parsed+stats.failures)%100===0)console.log(JSON.stringify(stats));
 }
 if(apply){
  if(pending.length)app.database.storeBatch(pending);
  // Retain all original records and files; deactivate masks from the radio index.
  app.database.markDeleted(masks.map(r=>r.id));
  app.database.setMeta('mtm5400_mask_exclusions',JSON.stringify({at:new Date().toISOString(),ids:masks.map(r=>r.id),reason:'User confirmed these CPs are control-head masks'}));
 }
 const report=runtimePaths.dataFile(apply?'september-reprocess-report.json':'september-dry-run.json');
 fs.writeFileSync(report,JSON.stringify({stats,backup,masks:masks.map(r=>({id:r.id,path:r.path,cp:r.codeplug})),results},null,2));
 console.log(JSON.stringify({stats,report,backup}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{if(!apply)db.close();app.database.close()});
