const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/runtime-paths');

test('separa base, catalogos, informes, logs y respaldos del codigo', () => {
  for (const [name, category] of [
    ['cpe-dashboard.sqlite','bases'], ['client-catalog-base.json','catalogos'],
    ['client-relationships-approved.json','catalogos'], ['catalogo-clientes.json','catalogos'],
    ['server.log','registros'], ['cp-error-analysis.json','reportes'],
    ['before-test.sqlite','respaldos'], ['folder-rename-backups','respaldos'],
    ['controlled-samples-analysis.sqlite','temporales'], ['pending-cp-diagnostics','temporales'],
  ]) assert.equal(path.dirname(paths.dataFile(name)),paths.dir(category),name);
  assert.equal(paths.docFile('test.md'),path.join(paths.dir('documentacion'),'test.md'));
  assert.throws(()=>paths.dataFile('../cpe-dashboard.sqlite'),/invalido/);
  assert.throws(()=>paths.dataFile('informe','..','..','escape'),/fuera/);
});

test('herramientas usan resolucion central de rutas y cargador no guarda cola en codigo', () => {
  const scriptRoot=path.join(__dirname,'..','scripts');
  for(const name of fs.readdirSync(scriptRoot).filter(n=>n.endsWith('.js'))){
    const source=fs.readFileSync(path.join(scriptRoot,name),'utf8');
    if(source.includes('runtimePaths.')) assert.match(source,/require\(['"]\.\.\/lib\/runtime-paths['"]\)/,name);
    assert.doesNotMatch(source,/path\.join\((?:__dirname,\s*['"]\.\.['"]|root|projectRoot),\s*['"]data['"]/g,name);
  }
  const source=fs.readFileSync(path.join(paths.root,'aplicaciones','cargador-tmo','Cargador-TMO.ps1'),'utf8');
  assert.match(source,/\$RuntimeConfig\.programaciones/);
  assert.doesNotMatch(source,/Join-Path \$ScriptRoot \$Pilot.localQueue/);
  assert.match(source,/api\/cpe-projects\/radio-validation/);
  assert.match(source,/Valide primero estas radios con el Proyecto CPE/);
  const pilot=JSON.parse(fs.readFileSync(path.join(paths.root,'configuracion','cargador-tmo','piloto.json'),'utf8'));
  assert.match(pilot.dashboardUrl,/^http:\/\/192\.168\.15\.219:8787$/);
});
