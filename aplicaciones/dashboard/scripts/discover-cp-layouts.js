const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : runtimePaths.dataFile("cpe-dashboard.sqlite");
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

function decryptDbf(buffer) {
  const out = Buffer.from(buffer);
  for (let i = 0; i < out.length; i += 1) {
    let value = out[i] ^ ((i * 111) & 0xff);
    value = (value - ((out.length - i) & 0xff)) & 0xff;
    out[i] = value;
  }
  return out;
}

function readCps(filePath) {
  const file = fs.readFileSync(filePath);
  let cursor = 9;
  while (cursor + 7 <= file.length) {
    const name = file.subarray(cursor, cursor + 3).toString("ascii");
    const size = file.readInt32LE(cursor + 3);
    cursor += 7;
    if (size < 0 || cursor + size > file.length) throw new Error("Seccion CPE invalida");
    if (name === "CPS") return decryptDbf(file.subarray(cursor, cursor + size));
    cursor += size;
  }
  throw new Error("CPS ausente");
}

function identityKeys(row) {
  const keys = [];
  if (row.serial) keys.push(`S:${row.serial}`);
  if (row.issi) keys.push(`I:${row.issi}`);
  return keys;
}

const supported = db.prepare(`
  SELECT id, path, serial, issi, codeplug, groupCount
  FROM scanned_files WHERE existsFlag=1 AND errorMessage='' AND groupCount>0
  ORDER BY groupCount DESC
`).all();
const supportedByIdentity = new Map();
for (const row of supported) {
  for (const key of identityKeys(row)) {
    if (!supportedByIdentity.has(key)) supportedByIdentity.set(key, row);
  }
}

const familyRows = db.prepare(`
  SELECT codeplug, COUNT(*) AS files FROM scanned_files
  WHERE existsFlag=1 AND errorMessage<>'' AND codeplug<>''
  GROUP BY codeplug ORDER BY files DESC
`).all();
const errorFiles = db.prepare(`
  SELECT id, path, serial, issi, codeplug, size
  FROM scanned_files WHERE existsFlag=1 AND errorMessage<>'' AND codeplug=?
  ORDER BY id
`);
const knownGroups = db.prepare(`
  SELECT alias, gssi, slot FROM talkgroups
  WHERE fileId=? AND alias<>'' AND gssi>0 ORDER BY folderRow LIMIT 80
`);

function findMatches(cps, groups) {
  const matches = [];
  for (const group of groups) {
    if (!group.alias || group.alias.length < 3) continue;
    const pattern = Buffer.from(`${group.alias}\0`, "utf16le");
    let position = -1;
    let occurrences = 0;
    while ((position = cps.indexOf(pattern, position + 1)) >= 0 && occurrences < 20) {
      occurrences += 1;
      for (let gssiOffset = 16; gssiOffset <= 52; gssiOffset += 4) {
        if (position + gssiOffset + 4 <= cps.length && cps.readUInt32LE(position + gssiOffset) === group.gssi) {
          matches.push({ alias: group.alias, gssi: group.gssi, slot: group.slot, position, gssiOffset });
        }
      }
    }
  }
  return matches;
}

function inferCandidates(matches) {
  const unique = [...new Map(matches.map((match) => [`${match.position}|${match.slot}|${match.gssiOffset}`, match])).values()];
  const offsets = new Map();
  for (const match of unique) offsets.set(match.gssiOffset, (offsets.get(match.gssiOffset) || 0) + 1);
  const bestOffset = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const filtered = unique.filter((match) => match.gssiOffset === bestOffset);
  const sizes = [40, 44, 48, 52, 56, 60, 64, 68, 72, 80, 88, 96, 104, 112, 128, 140, 144, 160];
  const candidates = [];
  for (const recordSize of sizes) {
    const bases = filtered.map((match) => match.position - (match.slot - 1) * recordSize);
    const counts = new Map();
    for (const base of bases) counts.set(base, (counts.get(base) || 0) + 1);
    const [base, confirmations] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (confirmations >= 2) candidates.push({ recordSize, base, confirmations });
  }
  candidates.sort((a, b) => b.confirmations - a.confirmations);
  return { matchCount: filtered.length, gssiOffset: bestOffset, candidates: candidates.slice(0, 5) };
}

const report = [];
for (const family of familyRows) {
  const samples = [];
  const usedUnsupported = new Set();
  for (const unsupported of errorFiles.all(family.codeplug)) {
    let known;
    for (const key of identityKeys(unsupported)) {
      known = supportedByIdentity.get(key);
      if (known) break;
    }
    if (!known || usedUnsupported.has(unsupported.path)) continue;
    usedUnsupported.add(unsupported.path);
    try {
      const groups = knownGroups.all(known.id);
      const cps = readCps(unsupported.path);
      const inference = inferCandidates(findMatches(cps, groups));
      samples.push({
        unsupportedPath: unsupported.path,
        supportedPath: known.path,
        supportedCodeplug: known.codeplug,
        cpsSize: cps.length,
        knownGroupCount: groups.length,
        ...inference,
      });
    } catch (error) {
      samples.push({ unsupportedPath: unsupported.path, error: error.message });
    }
    if (samples.length >= 5) break;
  }
  report.push({ codeplug: family.codeplug, files: family.files, samples });
}

const outputPath = runtimePaths.dataFile("cp-layout-discovery.json");
fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
console.log(JSON.stringify({
  outputPath,
  familiesWithMatches: report.filter((family) => family.samples.some((sample) => sample.matchCount >= 2)).map((family) => ({
    codeplug: family.codeplug,
    files: family.files,
    evidence: family.samples.map((sample) => ({
      cpsSize: sample.cpsSize,
      matches: sample.matchCount,
      gssiOffset: sample.gssiOffset,
      candidate: sample.candidates?.[0],
    })),
  })),
}, null, 2));
db.close();
