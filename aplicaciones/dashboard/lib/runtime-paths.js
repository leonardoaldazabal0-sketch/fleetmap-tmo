const fs = require('node:fs');
const path = require('node:path');

// All operational data live outside application source. Environment overrides
// remain available for tests and maintenance; NAS/Drive destinations are unchanged.
function createPaths(root = process.env.CPE_HOME || path.resolve(__dirname, '../../..')) {
  root = path.resolve(root);
  const configFile = path.join(root, 'configuracion', 'rutas.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  const dir = (key) => {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Ruta sin configurar: ${key}`);
    return path.resolve(root, config[key]);
  };
  function dataFile(name, ...parts) {
    if (typeof name !== 'string' || !name || path.basename(name) !== name || name === '..') {
      throw new Error('Nombre de dato invalido');
    }
    let category = 'reportes';
    if (name === 'cpe-dashboard.sqlite') category = 'bases';
    else if (name.startsWith('before-') || name === 'folder-rename-backups' || name.startsWith('source-before-')) category = 'respaldos';
    else if (['client-catalog-base.json', 'client-catalog-structured.json', 'client-relationships-approved.json', 'catalogo-clientes.json'].includes(name)) category = 'catalogos';
    else if (name.endsWith('.log')) category = 'registros';
    else if (name.endsWith('.sqlite') || ['cpe-cache.json','size-probe','pending-cp-diagnostics'].includes(name)) category = 'temporales';
    const base = dir(category);
    const target = path.resolve(base, name, ...parts);
    const relative = path.relative(base, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Ruta fuera de su categoria');
    return target;
  }
  return { root, configFile, dir, dataFile, docFile: (...parts) => path.join(dir('documentacion'), ...parts) };
}

module.exports = { ...createPaths(), createPaths };
