const path = require("path");
const runtimePaths = require("../lib/runtime-paths");
const Database = require("better-sqlite3");

const projectRoot = path.join(__dirname, "..");
const databasePath = process.env.CPE_DB_FILE || runtimePaths.dataFile("cpe-dashboard.sqlite");
const centralRoot = process.env.CPE_CENTRAL_ROOT || "\\\\192.168.7.252\\tic\\002 Programacion";
const prefix = `${path.win32.resolve(centralRoot)}\\`;

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const files = database.prepare(`
  SELECT path, size
  FROM scanned_files
  WHERE existsFlag=1 AND path LIKE ?
`).all(`${prefix}%`);
const latestScan = database.prepare(`
  SELECT * FROM scan_runs WHERE rootPath=? ORDER BY id DESC LIMIT 1
`).get(path.win32.resolve(centralRoot)) || null;
database.close();

const groups = new Map();
for (const file of files) {
  if (!file.path.startsWith(prefix)) continue;
  const topFolder = file.path.slice(prefix.length).split("\\")[0];
  if (!/plantillas.*clientes/i.test(topFolder)) continue;
  if (!groups.has(topFolder)) groups.set(topFolder, { folder: topFolder, cpeFiles: 0, bytes: 0 });
  const group = groups.get(topFolder);
  group.cpeFiles += 1;
  group.bytes += Number(file.size || 0);
}

const folders = [...groups.values()]
  .sort((left, right) => left.folder.localeCompare(right.folder, "es"))
  .map((group) => ({
    ...group,
    decimalGB: Number((group.bytes / 1_000_000_000).toFixed(2)),
    gibibytes: Number((group.bytes / (1024 ** 3)).toFixed(2)),
  }));
const totalBytes = folders.reduce((sum, folder) => sum + folder.bytes, 0);
console.log(JSON.stringify({
  centralRoot,
  scope: "Solo carpetas de primer nivel cuyo nombre coincide con Plantillas x Clientes",
  folders,
  totals: {
    folders: folders.length,
    cpeFiles: folders.reduce((sum, folder) => sum + folder.cpeFiles, 0),
    bytes: totalBytes,
    decimalGB: Number((totalBytes / 1_000_000_000).toFixed(2)),
    gibibytes: Number((totalBytes / (1024 ** 3)).toFixed(2)),
  },
  latestScan,
}, null, 2));
