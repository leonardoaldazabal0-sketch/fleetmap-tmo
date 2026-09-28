const assert=require('node:assert/strict'),test=require('node:test');
const {parseUserReport}=require('../lib/cps-user-report-reader');
const section=(name,headers,rows)=>`<TABLE><TR><TD>Codeplug\\${name}</TD></TR></TABLE><TABLE><TR><TH/>${headers.map(h=>`<TH>${h}</TH>`).join('')}</TR>${rows.map(r=>'<TR>'+r.map(c=>`<TD>${c}</TD>`).join('')+'</TR>').join('')}</TABLE>`;
const report=section('Info',['field','value'],[[1,'ISSI de la radio','123'],[2,'Número de serie','TEST'],[3,'TEI de la radio','1234'],[4,'Imagen de la aplicación','R1']])+section('Indicadores de funciones',['field','value'],[[1,'Rastreo de grupos de conversación','True'],[2,'Modo directo (DMO)','False'],[3,'GPS','True'],[4,'OTAP con SDS','False'],[5,'Función de llamada de anuncio','True']])+section('Opciones\\Destino de llamada de emergencia - TMO',['field','value'],[[1,'Tipo de dirección de emergencia','Grupo'],[2,'Tipo de grupo de emergencia','No táctica'],[3,'Alias no táctico','EMERG'],[4,'ISSI/GSSI de emergencia','9000'],[5,'Enviar archivo adjunto a grupo no táctico','True']])+section('Opciones\\Destino de llamada de emergencia - DMO',['field','value'],[[1,'Tipo de dirección de emergencia','Grupo'],[2,'Tipo de grupo de emergencia','Táctico']])+section('Agenda de contactos\\Lista de contactos',['Nombre','Estado','Privada'],[[1,'JEFE MINA','Personal','44310'],[2,'LIBRE','Sin programar','0']])+section('Grupos\\TMO\\Lista de grupos de conversación TMO',['Nombre','ID','Red','Estado'],[[1,'A &amp; B',9000,'Cualquiera','Invisible'],[2,'GUARDADO',1,'Cualquiera','Sin programar']]);
test('lee UTF8/UTF16, selecciona TMO y distingue grupos invisibles de guardados',()=>{
  for(const raw of [Buffer.from(report),Buffer.from('\ufeff'+report,'utf16le')]){
    const actual=parseUserReport(raw);
    assert.equal(actual.identity.issi,'123');
    assert.equal(actual.emergency.emergencyMode,'No táctico');
    assert.equal(actual.emergency.emergencyGssi,9000);
    assert.deepEqual(actual.groups,[{slot:1,alias:'A & B',gssi:9000,statusText:'Invisible'}]);
    assert.deepEqual(actual.featureIndicators,{scan:true,dmo:false,gps:true,otap:false,broadcast:true});
    assert.deepEqual(actual.contacts,[{slot:1,name:'JEFE MINA',state:'Personal',issi:'44310'}]);
  }
});
test('reportes incompletos no se aceptan como prueba de emergencia',()=>{
  assert.throws(()=>parseUserReport(Buffer.from('<HTML>incompleto</HTML>')),/Missing TMO/);
  assert.throws(()=>parseUserReport(Buffer.from(report.replace('No táctica','Desconocido'))),/Unrecognized emergency/);
});
