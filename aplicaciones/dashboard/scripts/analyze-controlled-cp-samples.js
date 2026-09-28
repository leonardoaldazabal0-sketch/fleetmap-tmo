const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");

process.env.CPE_DB_FILE ||= runtimePaths.dataFile("controlled-samples-analysis.sqlite");
const app = require(path.join(__dirname, "..", "server"));

const samplesDir = process.argv[2] || "F:\\CPE-TMO\\datos\\muestras\\familias-controladas";
const files = fs.readdirSync(samplesDir)
  .filter((name) => name.toLowerCase().endsWith(".cpe"))
  .sort()
  .map((name) => ({ name, path: path.join(samplesDir, name) }));

function findAll(buffer, needle) {
  const positions = [];
  let offset = 0;
  while (offset <= buffer.length - needle.length) {
    const found = buffer.indexOf(needle, offset);
    if (found < 0) break;
    positions.push(found);
    offset = found + 1;
  }
  return positions;
}

function diffRuns(left, right) {
  const runs = [];
  const limit = Math.min(left.length, right.length);
  let start = -1;
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      if (start < 0) start = index;
    } else if (start >= 0) {
      runs.push({ start, end: index - 1, length: index - start });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: limit - 1, length: limit - start });
  return runs;
}

const parsed = files.map((file) => {
  const cpe = app.parseCpeSections(file.path);
  const cps = cpe.sections.CPS;
  const searches = {};
  for (const alias of ["PRUEBA_TMO_01", "PRUEBA_TMO_02"]) {
    searches[alias] = findAll(cps, Buffer.from(alias, "utf16le"));
  }
  for (const gssi of [7654321, 7654322]) {
    const value = Buffer.alloc(4);
    value.writeUInt32LE(gssi);
    searches[`gssi:${gssi}`] = findAll(cps, value);
  }
  return {
    ...file,
    version: `${cpe.version}.${cpe.subversion}`,
    sections: Object.fromEntries(Object.entries(cpe.sections).map(([name, data]) => [name, data.length])),
    cps,
    searches,
  };
});

const comparisons = [];
for (let index = 1; index < parsed.length; index += 1) {
  for (const referenceIndex of [0, index - 1]) {
    if (referenceIndex === index) continue;
    const left = parsed[referenceIndex];
    const right = parsed[index];
    const runs = diffRuns(left.cps, right.cps);
    comparisons.push({
      from: left.name,
      to: right.name,
      changedBytes: runs.reduce((sum, run) => sum + run.length, 0),
      runCount: runs.length,
      runs: runs.slice(0, 100),
    });
  }
}

console.log(JSON.stringify({
  samples: parsed.map(({ cps, path: filePath, ...sample }) => ({ ...sample, path: filePath })),
  comparisons,
}, null, 2));

app.database.close();
