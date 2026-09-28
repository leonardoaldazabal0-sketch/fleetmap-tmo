const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const app=require('../server');
const root=process.argv[2] || String.raw`C:\Users\usrdolphin\Pictures\Nueva carpeta`;
let count=0;
try {
for(const name of fs.readdirSync(root).filter(x=>/\.cpe$/i.test(x))){
  const result=app.extractCodeplugFile(path.join(root,name));
  const b=name.includes('_GRUPOS_B');
  const expected=b ? (/^CP(1649|1726)_/.test(name)?[7168,7169,8588,9000]:[7169,8588,9000]):[7168,7169,8588];
  assert.deepEqual(result.rows.map(r=>r.gssi).sort((a,b)=>a-b),expected,name);
  assert.ok(result.rows.every(r=>r.alias && r.gssi>0),name);
  if(!b){
    let tactical=!name.includes('_NO_TACTICO');
    if(name.startsWith('CP0520_'))tactical=!tactical; // supplied labels reversed; same bits as CP0525
    assert.equal(result.emergencyMode,tactical?'Táctico':'No táctico',name);
    if(!tactical && !name.startsWith('CP0520_'))assert.equal(result.emergencyGssi,8588,name);
  }
  console.log(JSON.stringify({name,groups:result.rows.map(r=>[r.alias,r.gssi]),mode:result.emergencyMode,emergencyGssi:result.emergencyGssi}));count++;
}
console.log(JSON.stringify({validated:count}));
} finally { app.database.close(); }
