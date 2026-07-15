const fs = require("fs");
const path = require("path");

process.env.CPE_DB_FILE ||= path.join(__dirname, "..", "data", "cp1274-inspection.sqlite");
const app = require(path.join(__dirname, "..", "server"));
const samplesDir = process.argv[2] || "F:\\prueba cpe";

function decodeUtf16(buffer) {
  const end = buffer.findIndex((value, index) => index % 2 === 0 && value === 0 && buffer[index + 1] === 0);
  return buffer.subarray(0, end < 0 ? buffer.length : end).toString("utf16le").trim();
}

function hex(buffer, start, length) {
  return buffer.subarray(start, start + length).toString("hex").match(/.{1,2}/g).join(" ");
}

const samples = fs.readdirSync(samplesDir).filter((name) => name.endsWith(".cpe")).sort().map((name) => {
  const cps = app.parseCpeSections(path.join(samplesDir, name)).sections.CPS;
  return {
    name,
    alias24: decodeUtf16(cps.subarray(817280, 817304)),
    alias28: decodeUtf16(cps.subarray(817280, 817308)),
    values: {
      at817304: cps.readUInt16LE(817304),
      at817306: cps.readUInt16LE(817306),
      gssi: cps.readUInt32LE(817308),
      at817312: cps.readUInt16LE(817312),
      at817314: cps.readUInt16LE(817314),
      assignmentStatus: cps.readUInt8(1376392),
      assignmentIndex: cps.readUInt16LE(1376394),
    },
    mainHex: hex(cps, 817272, 56),
    assignmentHex: hex(cps, 1376384, 24),
  };
});

const cps = app.parseCpeSections(path.join(samplesDir, samples[1].name)).sections.CPS;
const grids = [];
for (const recordSize of [48, 52, 56, 60, 64, 68]) {
  for (const gssiOffset of [28, 36]) {
    for (let slot = 1; slot <= 1000; slot += 1) {
      const base = 817308 - gssiOffset - (slot - 1) * recordSize;
      if (base < 100000 || base > 1000000) continue;
      let plausible = 0;
      let populated = 0;
      const examples = [];
      for (let index = 1; index <= 1000; index += 1) {
        const offset = base + (index - 1) * recordSize;
        if (offset < 0 || offset + recordSize > cps.length) break;
        const alias = decodeUtf16(cps.subarray(offset, offset + gssiOffset));
        const gssi = cps.readUInt32LE(offset + gssiOffset);
        if (alias || gssi) populated += 1;
        if (alias && /^[\x20-\x7e]{1,32}$/.test(alias) && gssi > 0 && gssi <= 16777215) {
          plausible += 1;
          if (examples.length < 5) examples.push({ index, alias, gssi });
        }
      }
      if (plausible >= 3) grids.push({ base, recordSize, gssiOffset, insertedSlot: slot, plausible, populated, examples });
    }
  }
}

grids.sort((a, b) => b.plausible - a.plausible || a.base - b.base);
console.log(JSON.stringify({ samples, grids: grids.slice(0, 20) }, null, 2));
app.database.close();
