const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const runtimePaths = require("../lib/runtime-paths");

process.env.CPE_DB_FILE = path.join(os.tmpdir(), `broadcast-analysis-${process.pid}.sqlite`);
const app = require("../server");
const compareOnly = process.argv.includes("--compare");

function findAll(buffer, needle) {
  const found = [];
  for (let cursor = 0; cursor < buffer.length;) {
    const offset = buffer.indexOf(needle, cursor);
    if (offset < 0) break;
    found.push(offset);
    cursor = offset + 1;
  }
  return found;
}

function describe(cps, offset) {
  const start = Math.max(0, offset - 40);
  const end = Math.min(cps.length, offset + 96);
  return {
    offset,
    hex: cps.subarray(start, end).toString("hex").match(/.{1,32}/g),
    utf16: cps.subarray(start - (start % 2), end).toString("utf16le").replace(/[\u0000-\u001f\u007f-\uffff]/g, "."),
  };
}

const live = new Database(runtimePaths.dataFile("cpe-dashboard.sqlite"), { readonly: true, fileMustExist: true });
try {
  const candidateRows = live.prepare(`
    SELECT f.issi,f.path,f.codeplug,f.software,f.size,t.slot,t.alias,t.gssi,t.status,t.statusText
    FROM scanned_files f JOIN talkgroups t ON t.fileId=f.id
    WHERE f.existsFlag=1 AND f.size=5066967
      AND (t.alias LIKE '%BROAD%' OR t.alias LIKE '%ANUNC%')
    ORDER BY f.issi,t.gssi
  `).all();
  if (!compareOnly) console.log(JSON.stringify({
    candidateCount: candidateRows.length,
    byStatus: Object.fromEntries(Object.entries(Object.groupBy(candidateRows, (row) => row.statusText))
      .map(([status, rows]) => [status, rows.length])),
    sample: candidateRows.slice(0, 40),
  }, null, 2));
  const cases = [
    { issi: "58383", alias: "ROM-BROADCAS", gssi: 6078 },
    { issi: "23000", alias: "BROADCAST", gssi: 7199 },
    { issi: "23008", alias: "BROADCAST", gssi: 7199 },
    {
      issi: "56562", alias: "SCR-BROADCAS", gssi: 9976,
      path: "C:\\Users\\usrdolphin\\Pictures\\reporte user\\SN[121TBT0787]_TEI[00016B2B5062730]_ISSI[56562]_CP[1902]_SW[R35.000.10338]_USB9.cpe",
    },
  ];
  const cpsByIssi = new Map();
  const structures = [];
  for (const item of cases) {
    const filePath = item.path || live.prepare(`
      SELECT path FROM scanned_files WHERE existsFlag=1 AND issi=?
      ORDER BY dateKey DESC,mtimeMs DESC,id DESC LIMIT 1
    `).get(item.issi)?.path;
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`CPE ausente para ${item.issi}`);
    const cps = app.parseCpeSections(filePath).sections.CPS;
    cpsByIssi.set(item.issi, cps);
    const parsedBroadcast = app.extractCodeplugFile(filePath).features.broadcast;
    const gssi = Buffer.alloc(4);
    gssi.writeUInt32LE(item.gssi);
    const patterns = {
      groupAliasUtf16: Buffer.from(item.alias, "utf16le"),
      gssiU32: gssi,
      broadcastUtf16: Buffer.from("BROADCAST", "utf16le"),
      broadcastAscii: Buffer.from("BROADCAST", "ascii"),
    };
    const matches = {};
    for (const [name, needle] of Object.entries(patterns)) {
      matches[name] = findAll(cps, needle).slice(0, 30).map((offset) => describe(cps, offset));
    }
    const announcementAliasOffset = findAll(cps.subarray(0, 20000), patterns.broadcastUtf16)[0] ?? -1;
    const groupAliasOffset = findAll(cps, patterns.groupAliasUtf16)[0] ?? -1;
    structures.push({
      issi: item.issi,
      cpsLength: cps.length,
      parsedBroadcast,
      featureByte2746: cps[2746],
      announcementAliasOffset,
      announcementWindow: announcementAliasOffset < 0 ? "" : cps.subarray(announcementAliasOffset - 80, announcementAliasOffset + 96).toString("hex"),
      announcementNonZero: announcementAliasOffset < 0 ? [] : Array.from({ length: 176 }, (_, index) => ({
        delta: index - 80,
        value: cps[announcementAliasOffset - 80 + index],
      })).filter((item) => item.value),
      groupAliasOffset,
      groupWindow: groupAliasOffset < 0 ? "" : cps.subarray(groupAliasOffset, groupAliasOffset + 68).toString("hex"),
      groupNonZero: groupAliasOffset < 0 ? [] : Array.from({ length: 68 }, (_, delta) => ({ delta, value: cps[groupAliasOffset + delta] })).filter((item) => item.value),
    });
    if (!compareOnly) console.log(JSON.stringify({ issi: item.issi, filePath, cpsLength: cps.length, matches }, null, 2));
  }
  console.log(JSON.stringify({ structures }, null, 2));
  const left = cpsByIssi.get("23000");
  const right = cpsByIssi.get("23008");
  const differences = [];
  if (left?.length === right?.length) {
    for (let offset = 0; offset < left.length;) {
      if (left[offset] === right[offset]) { offset += 1; continue; }
      const start = offset;
      while (offset < left.length && left[offset] !== right[offset]) offset += 1;
      const end = offset;
      differences.push({
        start,
        length: end - start,
        left: left.subarray(start, Math.min(end, start + 64)).toString("hex"),
        right: right.subarray(start, Math.min(end, start + 64)).toString("hex"),
      });
    }
  }
  console.log(JSON.stringify({ compare: ["23000", "23008"], differenceRuns: differences.length, differences: differences.slice(0, 300) }, null, 2));
} finally {
  live.close();
  app.database.close();
  try { fs.rmSync(process.env.CPE_DB_FILE, { force: true }); } catch {}
}
