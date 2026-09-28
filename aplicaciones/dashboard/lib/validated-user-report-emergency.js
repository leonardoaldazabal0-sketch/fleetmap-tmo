const {createHash} = require('node:crypto');

// Exact decoded-CPS fingerprints, NOT family-wide layout assumptions. The
// supplied and NAS copies differ only in timestamp/header bytes, verified on
// 2026-09-09. A subsequent programming change must never inherit an old report.
const references = [
  {
    issi: '55391', cpsLength: 3159936,
    reportSha256: 'ad93285ab903aacbbb458d1440ee2bee2bbcd869d7be2bc9c0a2abf37daf8ecc',
    hashes: ['dc4f57abe4ae3b481fc3d9228443fc7239d65a3d3e2b89c4657a7b46e322b889', 'cd1b629524f92cd7ed1377d374f151610c961f2c2e2c3d7f8ae512c996f8a375'],
    emergency: {emergencySupported:true, emergencyAddressType:'Llamada privada', emergencyMode:'Llamada privada', emergencyAlias:'', emergencyGssi:10213, emergencyAttachment:false, emergencyConfidence:'user-report-exact'},
  },
  {
    issi: '56562', cpsLength: 5263232,
    reportSha256: 'fdd51d4806def9c19a210b024c4f0fb8f0f1dda2cc8b29a7cb236cd2db1d28f3',
    hashes: ['67bcee5ad1c0d5d78089981c611ff41688d44c5cf7930280093ad4cf9ee5a4a1', '649f9191ad649dea1e1951dfbdfa739b6718e5f9c502efe24922e2b0d8fddb2c'],
    emergency: {emergencySupported:true, emergencyAddressType:'Grupo', emergencyMode:'No táctico', emergencyAlias:'CER-EMERGENC', emergencyGssi:9925, emergencyAttachment:true, emergencyConfidence:'user-report-exact'},
  },
  ...require('./validated-user-report-emergency-lote2'),
];

function emergencyFromValidatedReport(cps, records = references) {
  const candidates = records.filter(r=>r.cpsLength===cps.length);
  if (!candidates.length) return null;
  const hash = createHash('sha256').update(cps).digest('hex');
  const reference = candidates.find(r=>r.hashes.includes(hash));
  return reference ? {...reference.emergency} : null;
}

module.exports = {references, emergencyFromValidatedReport};
