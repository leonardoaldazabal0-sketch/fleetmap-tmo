const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const root = path.join(__dirname, "..");
const dataDir = path.join(root, "data");
const databaseFile = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : path.join(dataDir, "cpe-dashboard.sqlite");
const sourceReport = path.join(dataDir, "error-report-by-cps-length.json");
const stagingDir = path.join(dataDir, "pending-cp-diagnostics");
const selectedFamilies = ["1059", "0743", "1211", "1726", "7438", "0930", "0639", "unknown"];
const familyLabels = new Map(selectedFamilies.map((value) => [value, value === "unknown" ? "Sin CP identificable" : `CP${value}`]));
const db = new Database(databaseFile, { readonly: true, fileMustExist: true });

function decryptDbf(buffer) {
  const out = Buffer.from(buffer);
  for (let index = 0; index < out.length; index += 1) {
    let value = out[index] ^ ((index * 111) & 0xff);
    value = (value - ((out.length - index) & 0xff)) & 0xff;
    out[index] = value;
  }
  return out;
}

function inspectCpe(fileBuffer) {
  if (fileBuffer.length < 9 || fileBuffer.subarray(0, 7).toString("ascii") !== "CPDFile") {
    throw new Error("Cabecera CPDFile invalida");
  }
  let cursor = 9;
  while (cursor + 7 <= fileBuffer.length) {
    const name = fileBuffer.subarray(cursor, cursor + 3).toString("ascii");
    const length = fileBuffer.readInt32LE(cursor + 3);
    cursor += 7;
    if (length < 0 || cursor + length > fileBuffer.length) throw new Error(`Seccion ${name} invalida`);
    if (name === "CPS") return { cpsLength: length, cps: decryptDbf(fileBuffer.subarray(cursor, cursor + length)) };
    cursor += length;
  }
  throw new Error("Sin seccion CPS");
}

function readCpsLength(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = Buffer.alloc(9);
    if (fs.readSync(fd, header, 0, 9, 0) !== 9 || header.subarray(0, 7).toString("ascii") !== "CPDFile") {
      throw new Error("Cabecera CPDFile invalida");
    }
    const sectionHeader = Buffer.alloc(7);
    let cursor = 9;
    while (cursor + 7 <= fileSize) {
      if (fs.readSync(fd, sectionHeader, 0, 7, cursor) !== 7) break;
      const name = sectionHeader.subarray(0, 3).toString("ascii");
      const length = sectionHeader.readInt32LE(3);
      if (length < 0 || cursor + 7 + length > fileSize) throw new Error(`Seccion ${name} invalida`);
      if (name === "CPS") return length;
      cursor += 7 + length;
    }
    throw new Error("Sin seccion CPS");
  } finally {
    fs.closeSync(fd);
  }
}

function findKnownPairs(cps, groups) {
  const matches = [];
  const seen = new Set();
  for (const group of groups) {
    const alias = String(group.alias || "").trim();
    const gssi = Number(group.gssi || 0);
    if (alias.length < 3 || gssi < 1 || gssi > 999999) continue;
    const patterns = [Buffer.from(alias, "utf16le"), Buffer.from(`${alias}\0`, "utf16le")];
    for (const pattern of patterns) {
      let position = -1;
      let occurrences = 0;
      while ((position = cps.indexOf(pattern, position + 1)) >= 0 && occurrences < 20) {
        occurrences += 1;
        for (let offset = 16; offset <= 64; offset += 2) {
          if (position + offset + 4 > cps.length || cps.readUInt32LE(position + offset) !== gssi) continue;
          const key = `${alias}\u0000${gssi}\u0000${position}\u0000${offset}`;
          if (!seen.has(key)) {
            seen.add(key);
            matches.push({ alias, gssi, aliasOffset: position, gssiRelativeOffset: offset });
          }
        }
      }
    }
  }
  return matches.slice(0, 20);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeFolderName(label) {
  return label.replace(/[^A-Za-z0-9_-]+/g, "_");
}

const referenceBySerial = db.prepare(`
  SELECT id, path FROM scanned_files
  WHERE existsFlag=1 AND errorMessage='' AND groupCount>0 AND serial=?
  ORDER BY dateKey DESC, mtimeMs DESC LIMIT 1
`);
const referenceByIssi = db.prepare(`
  SELECT id, path FROM scanned_files
  WHERE existsFlag=1 AND errorMessage='' AND groupCount>0 AND issi=?
  ORDER BY dateKey DESC, mtimeMs DESC LIMIT 1
`);
const referenceGroups = db.prepare(`
  SELECT alias, gssi FROM talkgroups
  WHERE fileId=? AND alias<>'' AND gssi BETWEEN 1 AND 999999
  ORDER BY folderRow, slot LIMIT 200
`);

function referenceFor(row) {
  if (row.serial) {
    const match = referenceBySerial.get(row.serial);
    if (match) return match;
  }
  if (row.issi) return referenceByIssi.get(row.issi) || null;
  return null;
}

function inspectExample(row) {
  const result = {
    path: row.path,
    serial: row.serial || "",
    issi: row.issi || "",
    software: row.software || "",
    fileSize: row.size,
    cpsLength: null,
    sha256: "",
    hashError: "",
    exactErrorType: row.errorType || "",
    exactErrorMessage: row.errorMessage || "",
    parserFoundAliasGssiButNoAssignments: false,
    diagnosticFoundAliasGssiButNoAssignments: null,
    diagnosticEvidence: {
      method: "known alias/GSSI pairs from a successful file with the same serial or ISSI",
      referencePath: "",
      matches: [],
      note: "The production parser stopped before assignment extraction because this variant is unsupported.",
    },
  };
  try {
    const file = fs.readFileSync(row.path);
    result.sha256 = crypto.createHash("sha256").update(file).digest("hex");
    result.fileSize = file.length;
    const inspected = inspectCpe(file);
    result.cpsLength = inspected.cpsLength;
    const reference = referenceFor(row);
    if (reference) {
      const matches = findKnownPairs(inspected.cps, referenceGroups.all(reference.id));
      result.diagnosticEvidence.referencePath = reference.path;
      result.diagnosticEvidence.matches = matches;
      result.diagnosticFoundAliasGssiButNoAssignments = matches.length > 0;
    } else {
      result.diagnosticEvidence.note += " No reliable same-radio reference was available, so the result is null.";
    }
  } catch (error) {
    result.hashError = error.message;
    result.diagnosticEvidence.note += ` File inspection failed: ${error.message}`;
  }
  return result;
}

try {
  if (!fs.existsSync(sourceReport)) throw new Error(`Falta ${sourceReport}`);
  const safeRoot = `${path.resolve(dataDir)}${path.sep}`.toLowerCase();
  if (!`${path.resolve(stagingDir)}${path.sep}`.toLowerCase().startsWith(safeRoot)) {
    throw new Error("La carpeta temporal de diagnostico queda fuera de data");
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stagingDir, "data"), { recursive: true });
  fs.copyFileSync(sourceReport, path.join(stagingDir, "data", "error-report-by-cps-length.json"));

  const rows = db.prepare(`
    SELECT path, fileName, size, serial, issi, software, errorType, errorMessage,
      CASE WHEN codeplug='' THEN 'unknown' ELSE codeplug END AS family
    FROM scanned_files
    WHERE existsFlag=1 AND errorMessage<>''
      AND (codeplug IN ('1059','0743','1211','1726','7438','0930','0639') OR codeplug='')
    ORDER BY family, path
  `).all();

  const variants = new Map();
  for (const row of rows) {
    let cpsLength = null;
    let inspectionError = "";
    try {
      cpsLength = readCpsLength(row.path);
    } catch (error) {
      inspectionError = error.message;
    }
    const key = `${row.family}|${cpsLength == null ? "unreadable" : cpsLength}|${row.size}|${inspectionError}`;
    const variant = variants.get(key) || {
      family: row.family,
      cp: familyLabels.get(row.family),
      cpsLength,
      fileSize: row.size,
      inspectionError,
      count: 0,
      sampleRows: [],
    };
    variant.count += 1;
    if (variant.sampleRows.length < 3) variant.sampleRows.push(row);
    variants.set(key, variant);
  }

  const familyPayloads = new Map(selectedFamilies.map((family) => [family, []]));
  const csvRows = [["CP", "cpsLength", "fileSize", "cantidad", "ejemploPath", "ejemploSerial", "ejemploISSI", "SW"]];
  for (const variant of [...variants.values()].sort((a, b) => selectedFamilies.indexOf(a.family) - selectedFamilies.indexOf(b.family) || (a.cpsLength || 0) - (b.cpsLength || 0) || a.fileSize - b.fileSize)) {
    const examples = variant.sampleRows.map(inspectExample);
    const first = examples[0] || {};
    csvRows.push([variant.cp, variant.cpsLength, variant.fileSize, variant.count, first.path, first.serial, first.issi, first.software]);
    familyPayloads.get(variant.family).push({
      cpsLength: variant.cpsLength,
      fileSize: variant.fileSize,
      count: variant.count,
      inspectionError: variant.inspectionError,
      parserFoundAliasGssiButNoAssignmentsInAnyExample: false,
      diagnosticAliasGssiWithoutAssignmentsInAnyExample: examples.some((example) => example.diagnosticFoundAliasGssiButNoAssignments === true)
        ? true
        : examples.every((example) => example.diagnosticFoundAliasGssiButNoAssignments === false)
          ? false
          : null,
      examples,
    });
  }

  fs.writeFileSync(path.join(stagingDir, "summary.csv"), `\uFEFF${csvRows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`);
  for (const family of selectedFamilies) {
    const label = familyLabels.get(family);
    const folder = path.join(stagingDir, safeFolderName(label));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "diagnostics.json"), `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      family: label,
      variants: familyPayloads.get(family),
    }, null, 2)}\n`);
  }

  fs.writeFileSync(path.join(stagingDir, "README.txt"), [
    "Pending CP diagnostics generated by cpe-dashboard.",
    "No .cpe files are embedded; paths and SHA-256 hashes identify the authorized source samples.",
    "parserFoundAliasGssiButNoAssignments is false because the production parser stopped at unsupported layout selection before extracting assignments.",
    "diagnosticFoundAliasGssiButNoAssignments=true means a known alias/GSSI pair from the same serial or ISSI was found independently in the decrypted CPS.",
    "A null diagnostic result means there was no reliable same-radio reference or the file could not be inspected. It must not be interpreted as false.",
    "No layout in this package is confirmed or enabled.",
  ].join("\r\n"));

  console.log(JSON.stringify({
    stagingDir,
    filesAnalyzed: rows.length,
    variants: variants.size,
    examplesHashed: [...variants.values()].reduce((sum, variant) => sum + variant.sampleRows.length, 0),
    families: [...familyPayloads].map(([family, items]) => ({ family: familyLabels.get(family), variants: items.length })),
  }, null, 2));
} finally {
  db.close();
}
