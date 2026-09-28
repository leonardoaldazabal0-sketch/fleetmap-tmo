const path = require("path");

function backupCodeplugInfo(filePath) {
  const fileName = path.basename(String(filePath || ""));
  if (!fileName.toLowerCase().endsWith(".cpe") || fileName.includes("[") || fileName.includes("]")) return null;
  const parts = fileName.slice(0, -4)
    .replace(/(?:\s+\(\d+\))+$/, '')
    // Algunos backups CPS antiguos agregan una revisión como "  2.0".
    .replace(/\s+\d+\.\d+$/, '')
    .split("_");
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

// These CP families contain MTM5400 control-head masks, not radio programming.
const MASK_CODEPLUGS = new Set(['7348', '7392', '7417', '7450', '7461']);
function maskCodeplugInfo(filePath, codeplug = '') {
  const fileName = path.basename(String(filePath || ''));
  if (!/\.cpe$/i.test(fileName)) return null;
  const cp = codeplug || fileName.match(/CP\[(\d{4})\]/i)?.[1]
    || fileName.match(/^CP(\d{4})(?:_|\(|\.)/i)?.[1]
    || fileName.match(/^[a-z0-9]+_(\d{4})_/i)?.[1] || '';
  return MASK_CODEPLUGS.has(cp) ? { codeplug: cp, fileName, reason: 'Mascara MTM5400' } : null;
}
function isExcludedCodeplugFile(filePath) {
  return isBackupCodeplugFile(filePath) || Boolean(maskCodeplugInfo(filePath));
}
module.exports = { backupCodeplugInfo, isBackupCodeplugFile, maskCodeplugInfo, isExcludedCodeplugFile };
