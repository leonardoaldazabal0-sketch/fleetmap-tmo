const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const databasePath = process.env.CPE_DB_FILE || path.join(root, "data", "cpe-dashboard.sqlite");
const discovery = JSON.parse(fs.readFileSync(path.join(root, "data", "cp-layout-discovery.json"), "utf8"));
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
    if (name === "CPS") return decryptDbf(file.subarray(cursor, cursor + size));
    cursor += size;
  }
  throw new Error("CPS ausente");
}

function decodeUtf16(buffer) {
  const codes = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const value = buffer.readUInt16LE(i);
    if (!value) break;
    if (value < 32 || value > 0xfffd) return "";
    codes.push(value);
  }
  return String.fromCharCode(...codes).trim();
}

function groupAt(cps, layout, index) {
  if (index <= 0 || index > layout.maxMain) return null;
  const at = layout.base + (index - 1) * layout.recordSize;
  if (at < 0 || at + layout.recordSize > cps.length) return null;
  const alias = decodeUtf16(cps.subarray(at, at + layout.aliasBytes));
  const gssi = cps.readUInt32LE(at + layout.gssiOffset);
  if (!alias || !gssi) return null;
  return `${alias}\u0001${gssi}`;
}

function extractFolder(cps, layout, folder) {
  const groups = new Set();
  const limit = Math.min(folder.maxRecords, Math.floor((cps.length - folder.offset) / folder.recordSize));
  for (let row = 0; row < limit; row += 1) {
    const at = folder.offset + row * folder.recordSize;
    const status = cps[at + folder.statusOffset];
    if (status > 2) continue;
    const index = cps.readUInt16LE(at + folder.indexOffset);
    const group = groupAt(cps, layout, index);
    if (group) groups.add(group);
  }
  return groups;
}

function extractAssignment(cps, layout, assignment) {
  const groups = new Set();
  for (let index = 1; index <= layout.maxMain; index += 1) {
    const at = layout.base + (index - 1) * layout.recordSize;
    if (at + layout.recordSize > cps.length) break;
    if (cps[at + assignment.stateOffset] !== assignment.activeValue) continue;
    const position = cps.readUInt16LE(at + assignment.positionOffset);
    if (!position || position > 10000) continue;
    const group = groupAt(cps, layout, index);
    if (group) groups.add(group);
  }
  return groups;
}

function score(extracted, known) {
  let intersection = 0;
  for (const group of extracted) if (known.has(group)) intersection += 1;
  const precision = extracted.size ? intersection / extracted.size : 0;
  const recall = known.size ? intersection / known.size : 0;
  return {
    intersection,
    extracted: extracted.size,
    known: known.size,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    value: intersection * 10 + precision * 20 + recall * 20 - Math.max(0, extracted.size - known.size) * 0.02,
  };
}

const fileByPath = db.prepare("SELECT id FROM scanned_files WHERE path=?");
const groupsByFile = db.prepare("SELECT alias, gssi FROM talkgroups WHERE fileId=? AND alias<>'' AND gssi>0");
function knownSet(supportedPath) {
  const file = fileByPath.get(supportedPath);
  return new Set((file ? groupsByFile.all(file.id) : []).map((row) => `${row.alias}\u0001${row.gssi}`));
}

const results = [];
for (const family of discovery.report) {
  const usable = family.samples.filter((sample) => sample.matchCount >= 2 && sample.candidates?.length);
  const bySize = new Map();
  for (const sample of usable) {
    if (!bySize.has(sample.cpsSize)) bySize.set(sample.cpsSize, []);
    bySize.get(sample.cpsSize).push(sample);
  }
  for (const [cpsSize, samples] of bySize) {
    const layoutVotes = new Map();
    for (const sample of samples) {
      const candidate = sample.candidates[0];
      const key = `${candidate.recordSize}|${candidate.base}|${sample.gssiOffset}`;
      layoutVotes.set(key, (layoutVotes.get(key) || 0) + candidate.confirmations);
    }
    const [layoutKey] = [...layoutVotes.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!layoutKey) continue;
    const [recordSize, base, gssiOffset] = layoutKey.split("|").map(Number);
    const baseLayout = {
      base,
      recordSize,
      gssiOffset,
      aliasBytes: Math.max(2, gssiOffset - 4),
      maxMain: 10000,
    };
    const loaded = samples.slice(0, 3).map((sample) => ({
      cps: readCps(sample.unsupportedPath),
      known: knownSet(sample.supportedPath),
    }));
    const candidates = [];
    for (const maxMain of [1000, 2000, 2500, 5000, 10000]) {
      const layout = { ...baseLayout, maxMain };
      for (const folderRecordSize of [4, 8]) {
        for (const statusOffset of [0, 1]) {
          for (const indexOffset of [2, 4, 6]) {
            if (indexOffset + 2 > folderRecordSize) continue;
            const folder = {
              offset: base + recordSize * maxMain,
              recordSize: folderRecordSize,
              statusOffset,
              indexOffset,
              maxRecords: 10000,
            };
            const scores = loaded.map(({ cps, known }) => score(extractFolder(cps, layout, folder), known));
            candidates.push({ type: "folder", maxMain, ...folder, scores });
          }
        }
      }
      const stateOffsets = [gssiOffset + 6, gssiOffset + 10].filter((offset) => offset < recordSize);
      const positionOffsets = [gssiOffset + 12, gssiOffset + 16, gssiOffset + 20]
        .filter((offset) => offset + 2 <= recordSize);
      for (const stateOffset of stateOffsets) {
        for (const activeValue of [1, 2]) {
          for (const positionOffset of positionOffsets) {
            const assignment = { stateOffset, activeValue, positionOffset };
            const scores = loaded.map(({ cps, known }) => score(extractAssignment(cps, layout, assignment), known));
            candidates.push({ type: "assignment", maxMain, ...assignment, scores });
          }
        }
      }
    }
    for (const candidate of candidates) {
      candidate.totalScore = candidate.scores.reduce((sum, item) => sum + item.value, 0);
      candidate.totalIntersection = candidate.scores.reduce((sum, item) => sum + item.intersection, 0);
    }
    candidates.sort((a, b) => b.totalScore - a.totalScore);
    results.push({
      codeplug: family.codeplug,
      files: family.files,
      cpsSize,
      main: baseLayout,
      sampleCount: loaded.length,
      best: candidates.slice(0, 8),
    });
  }
}

const outputPath = path.join(root, "data", "cp-layout-scores.json");
fs.writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify({ outputPath, results: results.map((result) => ({
  codeplug: result.codeplug,
  files: result.files,
  cpsSize: result.cpsSize,
  main: result.main,
  best: result.best[0],
})) }, null, 2));
db.close();
