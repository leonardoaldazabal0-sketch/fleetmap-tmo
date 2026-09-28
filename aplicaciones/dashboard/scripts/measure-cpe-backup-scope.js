const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const { isBackupCodeplugFile } = require("../lib/cpe-file-filter");

const projectRoot = path.join(__dirname, "..");
const root = process.env.CPE_CENTRAL_ROOT || "\\\\192.168.7.252\\tic\\002 Programacion";
const outputPath = runtimePaths.dataFile("cpe-backup-scope-measurement.json");

function measureFolder(folderPath) {
  const result = {
    folder: path.basename(folderPath),
    path: folderPath,
    cpeFiles: 0,
    backupNamedCpeFiles: 0,
    bytes: 0,
    errors: [],
  };
  const pending = [folderPath];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      result.errors.push({ path: current, error: error.message });
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".cpe")) continue;
      try {
        result.cpeFiles += 1;
        if (isBackupCodeplugFile(fullPath)) result.backupNamedCpeFiles += 1;
        result.bytes += fs.statSync(fullPath).size;
      } catch (error) {
        result.errors.push({ path: fullPath, error: error.message });
      }
    }
  }
  result.decimalGB = Number((result.bytes / 1_000_000_000).toFixed(2));
  result.gibibytes = Number((result.bytes / (1024 ** 3)).toFixed(2));
  return result;
}

const topFolders = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /plantillas.*clientes/i.test(entry.name))
  .map((entry) => path.join(root, entry.name))
  .sort((left, right) => left.localeCompare(right, "es"));

const folders = [];
for (const folderPath of topFolders) {
  const measured = measureFolder(folderPath);
  folders.push(measured);
  process.stderr.write(`${measured.folder}: ${measured.cpeFiles} CPE, ${measured.decimalGB} GB\n`);
}

const totalBytes = folders.reduce((sum, folder) => sum + folder.bytes, 0);
const payload = {
  generatedAt: new Date().toISOString(),
  root,
  scope: "Todos los archivos .cpe dentro de carpetas de primer nivel Plantillas x Clientes, incluidos backups de CPS",
  folders,
  totals: {
    folders: folders.length,
    cpeFiles: folders.reduce((sum, folder) => sum + folder.cpeFiles, 0),
    backupNamedCpeFiles: folders.reduce((sum, folder) => sum + folder.backupNamedCpeFiles, 0),
    bytes: totalBytes,
    decimalGB: Number((totalBytes / 1_000_000_000).toFixed(2)),
    gibibytes: Number((totalBytes / (1024 ** 3)).toFixed(2)),
    errors: folders.reduce((sum, folder) => sum + folder.errors.length, 0),
  },
};
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ ...payload.totals, outputPath }, null, 2));
