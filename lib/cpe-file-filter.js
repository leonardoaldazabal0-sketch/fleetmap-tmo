const path = require("path");

function backupCodeplugInfo(filePath) {
  const fileName = path.basename(String(filePath || ""));
  if (!fileName.toLowerCase().endsWith(".cpe") || fileName.includes("[") || fileName.includes("]")) return null;
  const parts = fileName.slice(0, -4).split("_");
  if (parts.length < 3 || parts.length > 5) return null;
  const [serial, codeplug, ...tail] = parts;
  if (!/^[a-z0-9]+$/i.test(serial) || !/^\d{4}$/.test(codeplug)) return null;
  if (!tail.every((value) => /^[a-f0-9]+$/i.test(value))) return null;
  if (tail[tail.length - 1].length < 16) return null;
  return { serial, codeplug, fileName };
}

function isBackupCodeplugFile(filePath) {
  return Boolean(backupCodeplugInfo(filePath));
}

module.exports = { backupCodeplugInfo, isBackupCodeplugFile };
