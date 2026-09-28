const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const D=require('better-sqlite3'),paths=require('../lib/runtime-paths');
const {backupCodeplugInfo,isExcludedCodeplugFile}=require('../lib/cpe-file-filter');
const dbPath=paths.dataFile('cpe-dashboard.sqlite'),db=new D(dbPath,{fileMustExist:true});
async function main(){
  const old1059=db.prepare('SELECT * FROM scanned_files WHERE id=10841').get();
  assert.equal(old1059.codeplug,'1059');assert.equal(old1059.existsFlag,1);assert.equal(fs.existsSync(old1059.path),false);
  const replacementPath=old1059.path.replace('\\REPSOL\\PAMPILLA\\','\\REPSOL\\REFINERIA PAMPILLA\\');
  const replacement=db.prepare('SELECT * FROM scanned_files WHERE path=? AND existsFlag=1').get(replacementPath);assert.ok(replacement);
  for(const key of ['serial','tei','issi','codeplug','size','mtimeMs'])assert.equal(replacement[key],old1059[key]);
  assert.equal(replacement.errorMessage,'');assert.ok(replacement.groupCount>0);assert.equal(replacement.emergencySupported,1);
  const backupRow=db.prepare('SELECT * FROM scanned_files WHERE id=5034').get();assert.equal(backupRow.existsFlag,1);assert.equal(fs.existsSync(backupRow.path),true);
  assert.equal(isExcludedCodeplugFile(backupRow.path),true);assert.equal(backupCodeplugInfo(backupRow.path).codeplug,'7374');
  const backup=paths.dataFile(`before-final-unsupported-${Date.now()}.sqlite`);await db.backup(backup);
  const check=new D(backup,{readonly:true,fileMustExist:true});try{assert.equal(check.pragma('integrity_check',{simple:true}),'ok');}finally{check.close();}
  const targets=[{id:10841,path:old1059.path,reason:'Ruta antigua con reemplazo validado',replacementPath},{id:5034,path:backupRow.path,reason:'Backup CPS CP7374, no programación de radio'}];
  db.transaction(()=>{for(const target of targets){const result=db.prepare('UPDATE scanned_files SET existsFlag=0 WHERE id=? AND path=? AND existsFlag=1').run(target.id,target.path);assert.equal(result.changes,1);}})();
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const report={backup,targets,filesDeleted:0,at:new Date().toISOString()};
  fs.writeFileSync(path.join(paths.dataFile('user-reports-lote2-20260909'),'final-unsupported-retired.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>db.close());
