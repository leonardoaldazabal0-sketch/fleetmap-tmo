const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict');
process.env.CPE_DB_FILE=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpe-audit-live-')),'test.sqlite');
const app=require('../server');
const D=require('better-sqlite3');
const base='http://127.0.0.1:8787';
async function main(){
 const health=await (await fetch(base+'/api/health')).json();assert.equal(health.ok,true);
 const db=new D(health.database.databasePath,{readonly:true,fileMustExist:true});
 try{
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  assert.deepEqual(db.pragma('foreign_key_check'),[]);
  const bad=db.prepare(`SELECT COUNT(*) AS n FROM talkgroups t JOIN scanned_files f ON f.id=t.fileId WHERE f.existsFlag=1 AND (t.gssi<1 OR t.gssi>16777215 OR t.status NOT IN (0,1,2) OR t.slot>10000)`).get();
  assert.equal(bad.n,0);
  const counts=db.prepare(`SELECT COUNT(*) AS n FROM scanned_files f WHERE f.existsFlag=1 AND groupCount<>(SELECT COUNT(*) FROM talkgroups t WHERE t.fileId=f.id)`).get();assert.equal(counts.n,0);
 }finally{db.close()}
 const issis=['44310','45130','55391','56562','54575','74129','33759','89600'];const radios=[];
 for(const issi of issis){
  const r=await (await fetch(base+'/api/radio-search?issi='+issi)).json();assert.ok(r.count>0,issi);
  const radio=r.results.find(x=>x.issi===issi);assert.ok(radio,issi);
  const gssis=radio.groups.map(g=>g.gssi);assert.deepEqual(gssis,[...gssis].sort((a,b)=>a-b),issi);
  radios.push({issi,cp:radio.codeplug,groups:radio.groupCount,emergencyMode:radio.emergencyMode,emergencyGssi:radio.emergencyGssi});
 }
 const row=values=>'<row>'+values.map((v,i)=>`<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${v}</t></is></c>`).join('')+'</row>';
 const master=app.createZip([
  {name:'xl/workbook.xml',data:'<workbook><sheets><sheet name="NMS" r:id="r1"/></sheets></workbook>'},
  {name:'xl/_rels/workbook.xml.rels',data:'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'},
  {name:'xl/worksheets/sheet1.xml',data:'<worksheet><sheetData>'+row(['ISSI','cliente','razon_social','unidad'])+issis.map(i=>row([i,'CLIENTE AUDITORIA','RAZON SOCIAL AUDITORIA','UNIDAD'])).join('')+'</sheetData></worksheet>'},
 ]).toString('base64');
 const response=await fetch(base+'/api/export-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({masterFileBase64:master})});assert.equal(response.status,200);
 const bytes=Buffer.from(await response.arrayBuffer()),files=app.readZip(bytes);
 const xml=[...files.values()].map(b=>b.toString()).join('');assert.match(xml,/RAZON SOCIAL AUDITORIA/);assert.match(xml,/Matriz Fleet Map/);
 const wildcard=await (await fetch(base+'/api/radio-search?issi=%25')).json();assert.equal(wildcard.count,0);
 console.log(JSON.stringify({health:health.database,radios,excelBytes:bytes.length,zipEntries:files.size,integrity:'ok',invalidGroups:0,groupCountMismatches:0},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>app.database.close());
