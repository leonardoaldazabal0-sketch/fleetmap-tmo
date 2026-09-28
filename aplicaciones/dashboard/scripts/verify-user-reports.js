const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const D=require('better-sqlite3'),paths=require('../lib/runtime-paths');
const out=paths.dataFile('user-reports-20260909');
const summary=JSON.parse(fs.readFileSync(path.join(out,'summary.json'),'utf8'));
const prepared=JSON.parse(fs.readFileSync(path.join(out,'prepared.json'),'utf8'));
const applied=JSON.parse(fs.readFileSync(path.join(out,'applied.json'),'utf8'));
process.env.CPE_DB_FILE=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cpe-verify-user-reports-')),'p.sqlite');
const app=require('../server');
const base='http://127.0.0.1:8787';
async function main(){
  const current=new D(paths.dataFile('cpe-dashboard.sqlite'),{readonly:true,fileMustExist:true});
  const before=new D(applied.backup,{readonly:true,fileMustExist:true});
  const changed=new Set(prepared.records.map(r=>r.previous[0]));
  const retired=new Set(applied.retired.map(r=>r.id));
  try {
    assert.equal(current.pragma('integrity_check',{simple:true}),'ok');
    assert.deepEqual(current.pragma('foreign_key_check'),[]);
    const old=before.prepare('SELECT * FROM scanned_files WHERE id=?');
    let untouched=0;
    for(const row of current.prepare('SELECT * FROM scanned_files').iterate()){
      if(changed.has(row.id)) continue;
      const previous=old.get(row.id);
      assert.deepEqual(row,retired.has(row.id)?{...previous,existsFlag:0}:previous);untouched++;
    }
    for(const record of prepared.records){
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(record.path)).digest('hex'),record.sourceHash,'Original CPE changed');
      const row=current.prepare('SELECT * FROM scanned_files WHERE path=?').get(record.path);
      assert.equal(row.parserVersion,prepared.parserVersion);
      assert.equal(row.groupCount,record.codeplug.rows.length);
      const expected=record.codeplug.rows.map(r=>[r.gssi,r.alias,r.statusText,r.folderRow]).sort((a,b)=>a[0]-b[0]||a[3]-b[3]);
      const actual=current.prepare('SELECT gssi,alias,statusText,folderRow FROM talkgroups WHERE fileId=?').all(row.id).map(r=>[r.gssi,r.alias,r.statusText,r.folderRow]).sort((a,b)=>a[0]-b[0]||a[3]-b[3]);
      assert.deepEqual(actual,expected);
    }
    console.log(JSON.stringify({untouchedFileRows:untouched,originalCpesUnchanged:prepared.records.length}));
  }finally{current.close();before.close();}
  const radios=[];
  for(const reference of summary.checked){
    const response=await(await fetch(base+'/api/radio-search?issi='+reference.issi)).json();
    const radio=response.results.find(r=>r.file===reference.path);assert.ok(radio);
    for(const [key,value] of Object.entries(reference.emergency)) assert.equal(radio[key],value,key);
    assert.deepEqual(radio.groups.map(r=>[r.gssi,r.alias,r.statusText]),reference.groups);
    if(reference.issi==='55391')assert.equal(radio.emergencyGroup,'ISSI 10213');
    radios.push({issi:radio.issi,emergencyMode:radio.emergencyMode,destination:radio.emergencyGroup,groups:radio.groups});
  }
  const row=values=>'<row>'+values.map((v,i)=>`<c r="${String.fromCharCode(65+i)}1" t="inlineStr"><is><t>${v}</t></is></c>`).join('')+'</row>';
  const master=app.createZip([
    {name:'xl/workbook.xml',data:'<workbook><sheets><sheet name="NMS" r:id="r1"/></sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels',data:'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'},
    {name:'xl/worksheets/sheet1.xml',data:'<worksheet><sheetData>'+row(['ISSI','cliente','razon_social'])+['55391','56562'].map(i=>row([i,'CLIENTE','RAZON SOCIAL PRUEBA'])).join('')+'</sheetData></worksheet>'},
  ]).toString('base64');
  const res=await fetch(base+'/api/export-xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({masterFileBase64:master})});assert.equal(res.status,200);
  const bytes=Buffer.from(await res.arrayBuffer()),zip=app.readZip(bytes);
  const detail=zip.get('xl/worksheets/sheet2.xml').toString(),matrix=zip.get('xl/worksheets/sheet1.xml').toString();
  for(const term of ['Llamada privada','10213','CER-EMERGENC','9925','SCR-BROADCAS','Invisible','ISSI/GSSI emergencia','RAZON SOCIAL PRUEBA'])assert.ok(detail.includes(term),term);
  assert.match(matrix,/ISSI 10213/);assert.doesNotMatch(matrix,/YAU-EMERGENC/);
  const result={radios,excelBytes:bytes.length,applied:applied.applied,retired:applied.retired.length,verifiedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>app.database.close());
