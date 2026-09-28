const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const {emergencyFromValidatedReport,references} = require('../lib/validated-user-report-emergency');

test('un User Report solo se aplica a un contenido CPS exacto, nunca por ISSI o familia', () => {
  const cps = Buffer.from('CPS de prueba');
  const entry = {cpsLength:cps.length,hashes:[createHash('sha256').update(cps).digest('hex')],emergency:{emergencyMode:'Llamada privada',emergencyGssi:10213}};
  assert.deepEqual(emergencyFromValidatedReport(cps,[entry]),entry.emergency);
  const edited = Buffer.from(cps); edited[0] ^= 1;
  assert.equal(emergencyFromValidatedReport(edited,[entry]),null);
  assert.equal(emergencyFromValidatedReport(Buffer.concat([cps,Buffer.from([0])]),[entry]),null);
  const output = emergencyFromValidatedReport(cps,[entry]); output.emergencyGssi=1;
  assert.equal(entry.emergency.emergencyGssi,10213);
  assert.equal(emergencyFromValidatedReport(Buffer.alloc(3159936)),null);
});

test('el reporte privado no hereda el alias ni el adjunto de un grupo almacenado', () => {
  const radio = references.find(r=>r.issi==='55391').emergency;
  assert.equal(radio.emergencyAddressType,'Llamada privada');
  assert.equal(radio.emergencyAlias,'');
  assert.equal(radio.emergencyAttachment,false);
  assert.equal(radio.emergencyGssi,10213);
});
