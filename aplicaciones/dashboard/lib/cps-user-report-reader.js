// Offline CPS HTML report reader. Values are data, never executable HTML.
const {createHash} = require('node:crypto');
const clean = text => text.replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/\s+/g,' ').trim();
const normalizedLabel = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
function parseUserReport(raw) {
  const html=raw.toString(raw[0]===255&&raw[1]===254?'utf16le':'utf8');
  const tables=new Map();let title='';
  for(const m of html.matchAll(/<TABLE\b[^>]*>[\s\S]*?<\/TABLE>/gi)) {
    const text=clean(m[0]);
    if(text.startsWith('Codeplug')){title=text;continue;}
    const rows=[...m[0].matchAll(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi)].map(r=>[...r[0].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map(c=>clean(c[1]))).filter(r=>r.length);
    const headers=[...m[0].matchAll(/<TH\b[^>]*>([^<]*(?:<(?!\/TH)[\s\S]*?)?)<\/TH>/gi)].map(h=>clean(h[1]));
    tables.set(title,{rows,headers});
  }
  const find=suffix=>[...tables].find(([key])=>key.endsWith(suffix))?.[1];
  const groupTable=find('\\TMO\\Lista de grupos de conversación TMO');
  if(!groupTable)throw new Error('Missing TMO talkgroup table');
  const stateIndex=groupTable.headers.indexOf('Estado')+1;
  if(stateIndex<1)throw new Error('Missing group state column');
  const allGroups=groupTable.rows.map(r=>({slot:Number(r[0]),alias:r[1],gssi:Number(r[2]),statusText:r[stateIndex]}));
  const fields=Object.fromEntries((find('Destino de llamada de emergencia - TMO')?.rows||[]).map(r=>[r[1],r[2]]));
  const type=fields['Tipo de dirección de emergencia'];
  const mode=fields['Tipo de grupo de emergencia'];
  const tactical=type==='Grupo'&&mode==='Táctico';
  if(type!=='Llamada privada'&&!(type==='Grupo'&&['Táctico','No táctica'].includes(mode)))throw new Error('Unrecognized emergency type/mode');
  const gssi=tactical?0:Number(fields['ISSI/GSSI de emergencia']);
  if(!Number.isInteger(gssi)||gssi<0||gssi>16777215)throw new Error('Invalid emergency SSI');
  const identityTable=[...tables.values()].find(t=>t.rows.some(r=>r[1]==='ISSI de la radio'));
  if(!identityTable)throw new Error('Missing radio identity');
  const identityFields=Object.fromEntries(identityTable.rows.map(r=>[r[1],r[2]]));
  const indicatorTable=[...tables].find(([key])=>normalizedLabel(key).endsWith('\\indicadores de funciones'))?.[1];
  const indicatorFields=new Map((indicatorTable?.rows||[]).filter(r=>r.length>=3).map(r=>[normalizedLabel(r[1]),r[2]]));
  const indicator=(...names)=>{
    for(const name of names){
      const value=indicatorFields.get(normalizedLabel(name));
      if(value==='True')return true;
      if(value==='False')return false;
    }
    return null;
  };
  const contactTable=[...tables].find(([key])=>normalizedLabel(key).endsWith('\\agenda de contactos\\lista de contactos'))?.[1];
  const contactHeaders=(contactTable?.headers||[]).map(normalizedLabel);
  const contactNameIndex=contactHeaders.indexOf('nombre');
  const contactStateIndex=contactHeaders.indexOf('estado');
  const contactPrivateIndex=contactHeaders.indexOf('privada');
  const contacts=(contactTable?.rows||[]).map(row=>({
    slot:Number(row[0]),
    name:String(row[contactNameIndex+1]||'').replace(/\s+/g,' ').trim(),
    state:String(row[contactStateIndex+1]||'').trim(),
    issi:String(row[contactPrivateIndex+1]||'').trim(),
  })).filter(contact=>contact.name&&normalizedLabel(contact.state)==='personal'&&/^\d{1,8}$/.test(contact.issi)&&Number(contact.issi)>0&&Number(contact.issi)<=16777215);
  return {
    reportSha256:createHash('sha256').update(raw).digest('hex'),
    identity:{issi:identityFields['ISSI de la radio'],serial:identityFields['Número de serie'],tei:identityFields['TEI de la radio'],software:identityFields['Imagen de la aplicación'],model:identityFields['Tipo de modelo']},
    allGroups,groups:allGroups.filter(r=>['Programado','Invisible'].includes(r.statusText)),
    emergency:{emergencySupported:true,emergencyAddressType:type,emergencyMode:type==='Llamada privada'?'Llamada privada':tactical?'Táctico':'No táctico',emergencyAlias:type==='Llamada privada'?'':tactical?'Grupo actual':fields['Alias no táctico']||'',emergencyGssi:gssi,emergencyAttachment:type==='Grupo'&&!tactical&&fields['Enviar archivo adjunto a grupo no táctico']==='True',emergencyConfidence:'user-report-exact'},
    featureIndicators:{
      scan:indicator('Rastreo de grupos de conversación'),
      dmo:indicator('Modo directo (DMO)'),
      gps:indicator('GPS'),
      otap:indicator('OTAP LMR','OTAP con SDS','OTAP'),
      broadcast:indicator('Función de llamada de anuncio'),
    },
    contacts,
  };
}
module.exports={parseUserReport,normalizeReportText:text=>String(text).replace(/\s+/g,' ').trim()};
