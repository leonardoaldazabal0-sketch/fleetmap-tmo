const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.CPE_DB_FILE = path.join(os.tmpdir(), `broadcast-reports-${process.pid}.sqlite`);
const app = require("../server");
const { byIssi } = require("../lib/validated-user-report-features");

const input = "C:\\Users\\usrdolphin\\Pictures\\reporte user";
const signature = Buffer.from([1, 1, 0, 11]);

function layoutFor(codeplug, cpsLength) {
  return app.LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE[codeplug]?.[cpsLength]
    || app.LAYOUTS_BY_CPS_SIZE[cpsLength]
    || null;
}

function findCandidates(cps) {
  const found = [];
  for (let cursor = 0; cursor < Math.min(cps.length, 20000);) {
    const offset = cps.indexOf(signature, cursor);
    if (offset < 0 || offset >= 20000) break;
    const zerosAfter = cps.subarray(offset + 4, offset + 40).every((byte) => byte === 0);
    const priority = offset >= 3 ? cps[offset - 3] : 255;
    if (zerosAfter && priority <= 15) found.push(offset);
    cursor = offset + 1;
  }
  return found;
}

try {
  const results = [];
  for (const name of fs.readdirSync(input).filter((name) => name.toLowerCase().endsWith(".cpe"))) {
    const meta = {
      issi: name.match(/_ISSI\[([^\]]*)\]/i)?.[1] || "",
      codeplug: name.match(/_CP\[([^\]]*)\]/i)?.[1] || "",
    };
    if (!byIssi[meta.issi]) continue;
    const filePath = path.join(input, name);
    const cps = app.parseCpeSections(filePath).sections.CPS;
    const emergency = app.EMERGENCY_LAYOUTS_BY_CPS_SIZE[cps.length];
    const layout = layoutFor(meta.codeplug, cps.length);
    const extracted = app.extractCodeplugFile(filePath);
    const candidates = findCandidates(cps).map((signatureOffset) => {
      const destinationPosition = cps.readUInt32LE(signatureOffset - 14);
      const destination = extracted.rows.find((row) => Number(row.folderRow) === destinationPosition);
      const mainBase = destination && layout
        ? layout.main.offset + (destination.slot - 1) * layout.main.recordSize
        : -1;
      return {
        signatureOffset,
        destinationPosition,
        priority: cps[signatureOffset - 3],
        announcementAlias: cps.subarray(signatureOffset + 40, signatureOffset + 100).toString("utf16le").split("\0")[0],
        destination: destination ? { alias: destination.alias, gssi: destination.gssi, statusText: destination.statusText, slot: destination.slot } : null,
        groupCode: mainBase < 0 ? null : cps[mainBase + layout.main.aliasBytes + 10],
      };
    });
    results.push({
      issi: meta.issi,
      codeplug: meta.codeplug,
      cpsLength: cps.length,
      expected: byIssi[meta.issi].broadcast,
      emergencyModeOffset: emergency?.modeOffset ?? null,
      proposedIndicatorOffset: emergency ? emergency.modeOffset + 38 : null,
      proposedIndicatorByte: emergency ? cps[emergency.modeOffset + 38] : null,
      indicatorProbe: Object.fromEntries([2670, 2674, 2718, 2742, 2746].map((offset) => [offset, cps[offset]])),
      candidates,
    });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  app.database.close();
  try { fs.rmSync(process.env.CPE_DB_FILE, { force: true }); } catch {}
}
