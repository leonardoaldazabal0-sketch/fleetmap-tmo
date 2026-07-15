const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { fork } = require("child_process");
const { URL } = require("url");
const { CpeDatabase } = require("./lib/cpe-database");
const { isBackupCodeplugFile } = require("./lib/cpe-file-filter");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATABASE_FILE = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : path.join(__dirname, "data", "cpe-dashboard.sqlite");
const LEGACY_CACHE_FILE = path.join(__dirname, "data", "cpe-cache.json");
const PARSER_VERSION = "7";
const BATCH_SIZE = 200;
const CENTRAL_ROOT = process.env.CPE_CENTRAL_ROOT || String.raw`\\192.168.7.252\tic\002 Programacion`;
const database = new CpeDatabase(DATABASE_FILE, PARSER_VERSION);

const LAYOUTS = {
  "1020": {
    main: {
      offset: 776088,
      recordSize: 56,
      maxRecords: 10000,
      aliasBytes: 24,
      gssiOffset: 28,
      networkIndexOffset: 52,
      defaultZoneOffset: 26,
    },
    folder: {
      offset: 1336088,
      recordSize: 4,
      maxRecords: 10000,
      statusOffset: 0,
      tgIndexOffset: 2,
    },
  },
  "1407": {
    main: {
      offset: 814796,
      recordSize: 64,
      maxRecords: 10000,
      aliasBytes: 32,
      gssiOffset: 36,
      networkIndexOffset: null,
      defaultZoneOffset: null,
    },
    folder: {
      offset: 1454796,
      recordSize: 4,
      maxRecords: 15,
      statusOffset: 0,
      tgIndexOffset: 2,
    },
  },
  "1330": {
    main: {
      offset: 969984,
      recordSize: 64,
      maxRecords: 10000,
      aliasBytes: 32,
      gssiOffset: 36,
      networkIndexOffset: null,
      defaultZoneOffset: null,
    },
    assignment: {
      stateOffset: 42,
      activeValue: 2,
      positionOffset: 48,
    },
  },
};

// Conservative additions from cpe-families-support-for-vm.zip. These layouts
// are deliberately keyed by both codeplug and CPS length so they cannot
// replace a working layout from another family that happens to share a size.
const LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE = {
  "1315": {
    2848576: {
      main: { offset: 814728, recordSize: 56, maxRecords: 10000, aliasBytes: 20, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42, confidence: "high" },
    },
  },
  "0865": {
    2487104: {
      main: { offset: 751776, recordSize: 56, maxRecords: 10000, aliasBytes: 20, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42, confidence: "high" },
    },
  },
  "0405": {
    1045696: {
      main: { offset: 244740, recordSize: 52, maxRecords: 10000, aliasBytes: 20, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42, confidence: "high" },
    },
  },
  "0232": {
    945600: {
      main: { offset: 235528, recordSize: 48, maxRecords: 10000, aliasBytes: 20, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42, confidence: "medium", fallbackWhenNoAssignments: true },
    },
  },
  "7472": {
    613248: {
      main: { offset: 245256, recordSize: 48, maxRecords: 10000, aliasBytes: 20, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42, confidence: "high" },
    },
  },
};

const LAYOUTS_BY_CPS_SIZE = {
  946688: {
    main: { offset: 235980, recordSize: 48, maxRecords: 1000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  981504: {
    main: { offset: 236240, recordSize: 48, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 332240, recordSize: 4, maxRecords: 10000, statusOffset: 1, tgIndexOffset: 2 },
  },
  981888: {
    main: { offset: 236240, recordSize: 48, maxRecords: 1000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  983552: {
    main: { offset: 236404, recordSize: 48, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 332404, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  1013376: {
    main: { offset: 243784, recordSize: 48, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 339784, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  1019712: {
    main: { offset: 244128, recordSize: 48, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 340128, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  1064192: {
    main: { offset: 244496, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 348496, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  1065536: {
    main: { offset: 245400, recordSize: 52, maxRecords: 1000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  1079232: {
    main: { offset: 245452, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 349452, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  1115712: {
    main: { offset: 245400, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 349400, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  1737856: {
    main: { offset: 272628, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  1787008: {
    main: { offset: 272628, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  1905664: {
    main: { offset: 335508, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 895508, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  2535552: {
    main: { offset: 751776, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1311776, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  2538688: {
    main: { offset: 751776, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  2849984: {
    main: { offset: 816200, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42 },
  },
  3021888: {
    main: { offset: 816720, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42 },
  },
  3087360: {
    main: { offset: 815372, recordSize: 64, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1455372, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  3159936: {
    main: { offset: 815628, recordSize: 68, maxRecords: 1000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 42, activeValue: 2, positionOffset: 48 },
  },
  3144064: {
    main: { offset: 815304, recordSize: 64, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1455304, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  4738944: {
    main: { offset: 969336, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  4739776: {
    main: { offset: 971328, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42 },
  },
  4862464: {
    main: { offset: 970308, recordSize: 64, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1610308, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  4997184: {
    main: { offset: 988356, recordSize: 64, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1628356, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  5066880: {
    main: { offset: 988548, recordSize: 68, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1668548, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  5263232: {
    main: { offset: 990468, recordSize: 68, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 42, activeValue: 2, positionOffset: 48 },
  },
};

function decryptDbf(buffer) {
  const out = Buffer.from(buffer);
  const length = out.length;
  for (let i = 0; i < length; i += 1) {
    let value = out[i];
    value ^= (i * 111) & 0xff;
    value = (value - ((length - i) & 0xff)) & 0xff;
    out[i] = value;
  }
  return out;
}

function parseCpeSections(filePath) {
  const file = fs.readFileSync(filePath);
  if (file.length < 16) {
    throw new Error("Archivo demasiado pequeno");
  }

  const magic = file.subarray(0, 7).toString("ascii");
  if (magic !== "CPDFile") {
    throw new Error("No parece un archivo CPE Motorola");
  }

  const version = file[7];
  const subversion = file[8];
  const sections = {};
  let cursor = 9;

  while (cursor + 7 <= file.length) {
    const name = file.subarray(cursor, cursor + 3).toString("ascii");
    const size = file.readInt32LE(cursor + 3);
    cursor += 7;
    if (size < 0 || cursor + size > file.length) {
      throw new Error(`Seccion ${name} con tamano invalido`);
    }

    const encrypted = file.subarray(cursor, cursor + size);
    sections[name] = decryptDbf(encrypted);
    cursor += size;
  }

  return { version, subversion, sections };
}

function decodeUtf16Le(buffer) {
  const codes = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = buffer[i] | (buffer[i + 1] << 8);
    if (code === 0) {
      break;
    }
    codes.push(code);
  }

  return String.fromCharCode(...codes).trim();
}

function statusText(status) {
  if (status === 1) return "Programado";
  if (status === 2) return "Invisible";
  if (status === 0) return "Sin programar";
  return `Desconocido ${status}`;
}

function readExtCpuId(ext) {
  if (!ext || ext.length < 2) return "";
  const length = ext[0];
  if (length <= 0 || length + 1 > ext.length) return "";
  return ext.subarray(1, 1 + length).toString("ascii").replace(/\0/g, "").trim();
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeHeader(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function metadataFromFilename(filePath) {
  const name = path.basename(filePath);
  const read = (label) => {
    const match = name.match(new RegExp(`${label}\\[([^\\]]+)\\]`, "i"));
    return match ? match[1] : "";
  };

  return {
    fileName: name,
    serial: read("SN"),
    tei: read("TEI"),
    issi: read("ISSI"),
    codeplug: read("CP"),
    software: read("SW"),
  };
}

function layoutFor(meta, cps) {
  if (meta.codeplug && LAYOUTS[meta.codeplug]) {
    return LAYOUTS[meta.codeplug];
  }

  const familyLayouts = LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE[meta.codeplug];
  if (familyLayouts && familyLayouts[cps.length]) {
    return familyLayouts[cps.length];
  }

  if (cps.length === 2728576) {
    return LAYOUTS["1020"];
  }

  if (cps.length === 3086720) {
    return LAYOUTS["1407"];
  }

  if (cps.length === 4859968) {
    return LAYOUTS["1330"];
  }

  if (LAYOUTS_BY_CPS_SIZE[cps.length]) {
    return LAYOUTS_BY_CPS_SIZE[cps.length];
  }

  throw new Error(`Codeplug ${meta.codeplug || "desconocido"} no soportado todavia`);
}

function readUInt16OrZero(buffer, offset) {
  if (offset == null || offset < 0 || offset + 2 > buffer.length) return 0;
  return buffer.readUInt16LE(offset);
}

function readUInt8OrZero(buffer, offset) {
  if (offset == null || offset < 0 || offset >= buffer.length) return 0;
  return buffer[offset];
}

function readMainGroup(cps, layout, index) {
  const main = layout.main;
  const base = main.offset + (index - 1) * main.recordSize;
  if (index <= 0 || base < 0 || base + main.recordSize > cps.length) {
    return null;
  }

  const aliasOffset = Number(main.aliasOffset || 0);
  const alias = decodeUtf16Le(cps.subarray(base + aliasOffset, base + aliasOffset + main.aliasBytes));
  const gssi = cps.readUInt32LE(base + main.gssiOffset);
  if (!alias && gssi === 0) {
    return null;
  }
  if (main.requireAlias && !alias) {
    return null;
  }
  if (main.minGssi != null && gssi < main.minGssi) {
    return null;
  }
  if (main.maxGssi != null && gssi > main.maxGssi) {
    return null;
  }

  return {
    slot: index,
    alias,
    gssi,
    networkIndex: readUInt8OrZero(
      cps,
      main.networkIndexOffset == null ? null : base + main.networkIndexOffset
    ),
    defaultZone: readUInt16OrZero(
      cps,
      main.defaultZoneOffset == null ? null : base + main.defaultZoneOffset
    ),
  };
}

function extractTalkgroups(filePath) {
  const { version, subversion, sections } = parseCpeSections(filePath);
  const cps = sections.CPS;
  if (!cps) {
    throw new Error("No se encontro la seccion CPS");
  }

  const meta = metadataFromFilename(filePath);
  meta.cpeVersion = `${version}.${subversion}`;
  meta.cpuId = readExtCpuId(sections.EXT);

  const layout = layoutFor(meta, cps);
  const rows = [];
  if (layout.folder) {
    const folder = layout.folder;
    for (let rowIndex = 0; rowIndex < folder.maxRecords; rowIndex += 1) {
      const base = folder.offset + rowIndex * folder.recordSize;
      if (base + folder.recordSize > cps.length) break;

      const status = cps[base + folder.statusOffset];
      const tgIndex = cps.readUInt16LE(base + folder.tgIndexOffset);
      if (tgIndex === 0 && status === 0) {
        continue;
      }

      const group = readMainGroup(cps, layout, tgIndex);
      if (!group) {
        continue;
      }

      const row = {
        file: filePath,
        fileName: meta.fileName,
        serial: meta.serial,
        tei: meta.tei,
        issi: meta.issi,
        codeplug: meta.codeplug,
        software: meta.software,
        cpuId: meta.cpuId,
        folderRow: rowIndex + 1,
        slot: group.slot,
        alias: group.alias,
        gssi: group.gssi,
        status,
        statusText: statusText(status),
        networkIndex: group.networkIndex,
        defaultZone: group.defaultZone,
      };
      rows.push(row);
    }
  } else if (layout.assignment) {
    const assignment = layout.assignment;
    for (let index = 1; index <= layout.main.maxRecords; index += 1) {
      const base = layout.main.offset + (index - 1) * layout.main.recordSize;
      if (base + layout.main.recordSize > cps.length) break;

      const state = assignment.activeU16Offset == null
        ? readUInt8OrZero(cps, base + assignment.stateOffset)
        : readUInt16OrZero(cps, base + assignment.activeU16Offset);
      const position = assignment.positionByteOffset == null
        ? readUInt16OrZero(cps, base + assignment.positionOffset)
        : readUInt8OrZero(cps, base + assignment.positionByteOffset);
      if (state !== assignment.activeValue || position === 0) {
        continue;
      }

      const group = readMainGroup(cps, layout, index);
      if (!group) {
        continue;
      }

      rows.push({
        file: filePath,
        fileName: meta.fileName,
        serial: meta.serial,
        tei: meta.tei,
        issi: meta.issi,
        codeplug: meta.codeplug,
        software: meta.software,
        cpuId: meta.cpuId,
        folderRow: position,
        slot: group.slot,
        alias: group.alias,
        gssi: group.gssi,
        status: 1,
        statusText: statusText(1),
        assignmentConfidence: assignment.confidence || "",
        networkIndex: group.networkIndex,
        defaultZone: group.defaultZone,
      });
    }

    // Medium/low confidence layouts must not lose an otherwise valid alias/GSSI
    // merely because their assignment bytes differ in an unobserved variant.
    // The fallback is deliberately all-or-nothing to avoid duplicating or
    // inflating files where the verified assignment rule already produced rows.
    if (rows.length === 0 && assignment.fallbackWhenNoAssignments) {
      const seenFallbackGroups = new Set();
      for (let index = 1; index <= layout.main.maxRecords; index += 1) {
        const group = readMainGroup(cps, layout, index);
        if (!group) continue;
        const groupKey = `${group.alias}\u0000${group.gssi}`;
        if (seenFallbackGroups.has(groupKey)) continue;
        seenFallbackGroups.add(groupKey);
        rows.push({
          file: filePath,
          fileName: meta.fileName,
          serial: meta.serial,
          tei: meta.tei,
          issi: meta.issi,
          codeplug: meta.codeplug,
          software: meta.software,
          cpuId: meta.cpuId,
          folderRow: "",
          slot: group.slot,
          alias: group.alias,
          gssi: group.gssi,
          status: 1,
          statusText: statusText(1),
          assignmentConfidence: assignment.confidence || "",
          networkIndex: group.networkIndex,
          defaultZone: group.defaultZone,
        });
      }
    }

    rows.sort((left, right) => left.folderRow - right.folderRow || left.slot - right.slot);
  } else {
    for (let index = 1; index <= layout.main.maxRecords; index += 1) {
      const group = readMainGroup(cps, layout, index);
      if (!group) {
        continue;
      }

      const status = 1;
      const row = {
      file: filePath,
      fileName: meta.fileName,
      serial: meta.serial,
      tei: meta.tei,
      issi: meta.issi,
      codeplug: meta.codeplug,
      software: meta.software,
      cpuId: meta.cpuId,
        folderRow: "",
        slot: group.slot,
        alias: group.alias,
        gssi: group.gssi,
      status,
      statusText: statusText(status),
        networkIndex: group.networkIndex,
        defaultZone: group.defaultZone,
      };
      rows.push(row);
    }
  }

  return { meta, rows };
}

function parseFolderDate(filePath) {
  const parts = path.resolve(filePath).split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    let match = part.match(/(20\d{2})[.\-_ ]?([01]\d)[.\-_ ]?([0-3]\d)(?:[_\- ]?([A-Za-z]{1,6}))?/);
    if (!match) {
      continue;
    }

    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return {
      date,
      dateKey: Number(`${match[1]}${match[2]}${match[3]}`),
      programmer: match[4] || "",
      sourceFolder: part,
    };
  }

  return { date: "", dateKey: 0, programmer: "", sourceFolder: "" };
}

function extractCodeplugFile(filePath) {
  const extracted = extractTalkgroups(filePath);
  const folderDate = parseFolderDate(filePath);
  const stat = fs.statSync(filePath);
  return {
    path: filePath,
    ...extracted.meta,
    ...folderDate,
    modifiedTime: stat.mtimeMs,
    modifiedAt: stat.mtime.toISOString(),
    size: stat.size,
    groupCount: extracted.rows.length,
    rows: extracted.rows.map((row) => ({
      ...row,
      programDate: folderDate.date,
      dateKey: folderDate.dateKey,
      programmer: folderDate.programmer,
      sourceFolder: folderDate.sourceFolder,
    })),
  };
}

function cacheSummary(discovered) {
  return {
    discovered,
    analyzed: 0,
    reused: 0,
    removed: 0,
    saved: true,
    warning: "",
  };
}

function codeplugFileSummary(codeplug) {
  return {
    path: codeplug.path,
    fileName: codeplug.fileName,
    serial: codeplug.serial,
    tei: codeplug.tei,
    issi: codeplug.issi,
    codeplug: codeplug.codeplug,
    software: codeplug.software,
    cpeVersion: codeplug.cpeVersion,
    cpuId: codeplug.cpuId,
    programDate: codeplug.date,
    programmer: codeplug.programmer,
    modifiedTime: codeplug.modifiedTime,
    modifiedAt: codeplug.modifiedAt,
    size: codeplug.size,
    groupCount: codeplug.groupCount,
  };
}

function databaseFileSummary(file) {
  return {
    path: file.path,
    fileName: file.fileName,
    serial: file.serial || "",
    tei: file.tei || "",
    issi: file.issi || "",
    codeplug: file.codeplug || "",
    software: file.software || "",
    cpeVersion: file.cpeVersion || "",
    cpuId: file.cpuId || "",
    programDate: file.folderDate || "",
    programmer: file.programmer || "",
    modifiedTime: file.mtimeMs,
    modifiedAt: new Date(file.mtimeMs).toISOString(),
    size: file.size,
    groupCount: file.groupCount || 0,
  };
}

function comparablePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(rootPath, filePath) {
  const root = comparablePath(rootPath);
  const candidate = comparablePath(filePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function* walkCpeFiles(targetPath, errors = []) {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error("La ruta no existe");
  }

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    if (resolved.toLowerCase().endsWith(".cpe") && !isBackupCodeplugFile(resolved)) yield resolved;
    return;
  }

  const pending = [resolved];
  while (pending.length > 0) {
    const dir = pending.pop();
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      errors.push({ file: dir, message: error.message });
      continue;
    }
    items.sort((left, right) => left.name.localeCompare(right.name));
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        pending.push(full);
      } else if (item.isFile() && item.name.toLowerCase().endsWith(".cpe") && !isBackupCodeplugFile(item.name)) {
        yield full;
      }
    }
  }
}

function scanPath(targetPath, options = {}) {
  const includeRows = options.includeRows !== false;
  const includeFiles = options.includeFiles !== false;
  const collectionErrors = [];
  const resolvedTarget = path.resolve(targetPath);
  if (!fs.existsSync(resolvedTarget)) throw new Error("La ruta no existe");
  const targetIsDirectory = fs.statSync(resolvedTarget).isDirectory();
  const files = walkCpeFiles(resolvedTarget, collectionErrors);
  const result = {
    scannedPath: resolvedTarget,
    files: [],
    rows: [],
    errors: collectionErrors,
    cache: cacheSummary(0),
    fileCount: 0,
  };
  const runId = database.startScan(resolvedTarget);
  const pendingRecords = [];
  const reappearedIds = [];
  const foundPaths = new Set();

  const flush = () => {
    if (pendingRecords.length === 0) return;
    database.storeBatch(pendingRecords);
    pendingRecords.length = 0;
  };
  const checkpoint = () => {
    if (result.fileCount % BATCH_SIZE !== 0) return;
    flush();
    result.cache.errorCount = result.errors.length;
    database.updateScan(runId, result.cache);
  };

  try {
    for (const file of files) {
      result.fileCount += 1;
      result.cache.discovered += 1;
      foundPaths.add(comparablePath(file));
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (error) {
        result.errors.push({ file, message: error.message });
        checkpoint();
        continue;
      }

      const indexed = database.getFile(file);
      if (database.signatureMatches(indexed, stat)) {
        result.cache.reused += 1;
        if (!indexed.existsFlag) reappearedIds.push(indexed.id);
        if (indexed.errorMessage) {
          result.errors.push({ file, message: indexed.errorMessage, errorType: indexed.errorType });
          checkpoint();
          continue;
        }
        if (includeFiles) result.files.push(databaseFileSummary(indexed));
        if (includeRows) {
          const cached = database.hydrateFile(indexed);
          result.rows.push(...cached.rows);
        }
        checkpoint();
        continue;
      }

      result.cache.analyzed += 1;
      try {
        const codeplug = extractCodeplugFile(file);
        pendingRecords.push({
          path: file,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          codeplug,
        });
        if (includeFiles) result.files.push(codeplugFileSummary(codeplug));
        if (includeRows) result.rows.push(...codeplug.rows);
      } catch (error) {
        const meta = { ...metadataFromFilename(file), ...parseFolderDate(file) };
        pendingRecords.push({
          path: file,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          meta,
          error,
        });
        result.errors.push({ file, message: error.message, errorType: error.name });
      }

      checkpoint();
    }
    flush();
    database.markExisting(reappearedIds);

    if (targetIsDirectory && collectionErrors.length === 0) {
      const deletedIds = database.listExistingFiles()
        .filter((entry) => isPathInside(resolvedTarget, entry.path) && !foundPaths.has(comparablePath(entry.path)))
        .map((entry) => entry.id);
      database.markDeleted(deletedIds);
      result.cache.removed = deletedIds.length;
    } else if (collectionErrors.length > 0) {
      result.cache.warning = "No se marcaron archivos eliminados porque algunas carpetas no pudieron leerse";
    }
  } finally {
    result.cache.errorCount = result.errors.length;
    database.finishScan(runId, result.cache);
  }

  result.database = database.status(resolvedTarget);
  return result;
}

function migrateLegacyJsonCache(cacheFile = LEGACY_CACHE_FILE, marker = "legacy_json_cache_imported_v1") {
  const previous = database.getMeta(marker);
  if (previous) return { imported: 0, alreadyImported: true, details: previous };
  if (!fs.existsSync(cacheFile)) {
    return { imported: 0, alreadyImported: false, found: false };
  }

  const payload = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const entries = Object.values(payload.entries || {});
  const pending = [];
  let imported = 0;
  for (const entry of entries) {
    if (!entry?.path || !Number.isFinite(Number(entry.size)) || !Number.isFinite(Number(entry.modifiedTime))) {
      continue;
    }
    if (entry.data) {
      pending.push({
        path: entry.path,
        size: Number(entry.size),
        mtimeMs: Number(entry.modifiedTime),
        lastParsedAt: entry.scannedAt,
        codeplug: entry.data,
      });
    } else {
      const error = new Error(entry.error || "Error importado de la cache JSON");
      error.name = "LegacyCacheError";
      pending.push({
        path: entry.path,
        size: Number(entry.size),
        mtimeMs: Number(entry.modifiedTime),
        lastParsedAt: entry.scannedAt,
        meta: { ...metadataFromFilename(entry.path), ...parseFolderDate(entry.path) },
        error,
      });
    }
    if (pending.length >= BATCH_SIZE) {
      imported += pending.length;
      database.storeBatch(pending);
      pending.length = 0;
    }
  }
  imported += pending.length;
  database.storeBatch(pending);
  const details = JSON.stringify({ imported, importedAt: new Date().toISOString(), source: path.resolve(cacheFile) });
  database.setMeta(marker, details);
  return { imported, alreadyImported: false, found: true, details };
}

function readZip(buffer) {
  const files = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("Excel invalido: no se encontro ZIP central directory");
  }

  const entries = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entries; entry += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Excel invalido: central directory corrupto");
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Excel invalido: metodo ZIP no soportado ${method}`);
    }
    if (uncompressedSize && data.length !== uncompressedSize) {
      data = Buffer.from(data);
    }
    files.set(name.replace(/\\/g, "/"), data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unescapeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  const strings = [];
  const siRegex = /<si[\s\S]*?<\/si>/g;
  const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let siMatch;
  while ((siMatch = siRegex.exec(xml))) {
    const textParts = [];
    let tMatch;
    while ((tMatch = tRegex.exec(siMatch[0]))) {
      textParts.push(unescapeXml(tMatch[1]));
    }
    strings.push(textParts.join(""));
  }
  return strings;
}

function parseWorkbookSheets(files) {
  const workbook = files.get("xl/workbook.xml")?.toString("utf8");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbook || !rels) {
    throw new Error("Excel invalido: no se encontro workbook");
  }

  const relMap = new Map();
  const relRegex = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*>/g;
  let relMatch;
  while ((relMatch = relRegex.exec(rels))) {
    relMap.set(relMatch[1], relMatch[2].replace(/^\/?xl\//, ""));
  }

  const sheets = [];
  const sheetRegex = /<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(workbook))) {
    const target = relMap.get(sheetMatch[2]);
    if (target) {
      sheets.push({ name: unescapeXml(sheetMatch[1]), path: `xl/${target}`.replace(/\/xl\//, "/") });
    }
  }
  return sheets;
}

function columnIndex(cellRef) {
  const letters = String(cellRef || "").match(/[A-Z]+/i)?.[0] || "A";
  let index = 0;
  for (const char of letters.toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml))) {
    const row = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] || "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      const idx = columnIndex(ref);
      let value = "";
      if (type === "s") {
        const sharedIndex = Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || 0);
        value = sharedStrings[sharedIndex] || "";
      } else if (type === "inlineStr") {
        value = unescapeXml(body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1] || "");
      } else {
        value = unescapeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "");
      }
      row[idx] = value;
    }
    rows.push(row.map((value) => value ?? ""));
  }
  return rows;
}

function parseMasterWorkbook(base64) {
  const buffer = Buffer.from(base64, "base64");
  const files = readZip(buffer);
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const sheets = parseWorkbookSheets(files);
  const preferred = sheets.find((sheet) => normalizeHeader(sheet.name) === "nms") || sheets[1] || sheets[0];
  if (!preferred) {
    throw new Error("El Excel maestro no tiene hojas");
  }

  const xml = files.get(preferred.path)?.toString("utf8");
  if (!xml) {
    throw new Error(`No se pudo leer la hoja ${preferred.name}`);
  }

  const rows = parseSheetRows(xml, sharedStrings);
  const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell).includes("issi")));
  if (headerIndex < 0) {
    throw new Error("No encontre una columna ISSI en el Excel maestro");
  }

  const headers = rows[headerIndex].map(normalizeHeader);
  const indexOf = (...names) => {
    for (const name of names) {
      const normalized = normalizeHeader(name);
      const exact = headers.indexOf(normalized);
      if (exact >= 0) return exact;
      const partial = headers.findIndex((header) => header === normalized || header.includes(normalized));
      if (partial >= 0) return partial;
    }
    return -1;
  };

  const issiCol = indexOf("issi_SIG", "issi", "TetraAddress_NMS1");
  const records = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const issi = String(row[issiCol] ?? "").replace(/\D/g, "");
    if (!issi) continue;
    records.push({
      issi,
      cliente: row[indexOf("cliente", "cliente_SIG")] || "",
      ruc: row[indexOf("ruc_SIG", "ruc")] || "",
      tipoCliente: row[indexOf("Tipo de cliente", "tipo_cliente")] || "",
      razonSocial: row[indexOf("razon_social_SIG", "razon_social", "razon social")] || "",
      organizacion: row[indexOf("organizacion_SIG", "organizacion")] || "",
      label: row[indexOf("label_SIG", "label")] || "",
      unidad: row[indexOf("unidad", "area", "sede")] || "",
      observacion: row[indexOf("observacion", "observaciones")] || "",
      sourceRow: r + 1,
    });
  }

  return { sheetName: preferred.name, records };
}

function compareCodeplugFreshness(a, b) {
  const dateDiff = (b.dateKey || 0) - (a.dateKey || 0);
  if (dateDiff !== 0) return dateDiff;
  const timeDiff = (b.modifiedTime || b.mtimeMs || 0) - (a.modifiedTime || a.mtimeMs || 0);
  if (timeDiff !== 0) return timeDiff;
  return Number(b.codeplug || 0) - Number(a.codeplug || 0);
}

function buildFleetMap(rootPath, masterBase64) {
  const master = parseMasterWorkbook(masterBase64);
  const wantedIssis = new Set(master.records.map((record) => record.issi));
  const resolvedRoot = path.resolve(rootPath);
  const indexedUnderRoot = database.listExistingFiles()
    .filter((entry) => isPathInside(resolvedRoot, entry.path));
  if (indexedUnderRoot.length === 0) {
    throw new Error("La ruta no esta indexada. Usa Actualizar indice antes de generar el Fleet Map");
  }

  const byIssi = new Map();
  const fileRows = database.getFilesForIssis([...wantedIssis])
    .filter((entry) => isPathInside(resolvedRoot, entry.path));
  for (const file of fileRows) {
    if (!byIssi.has(file.issi)) byIssi.set(file.issi, []);
    byIssi.get(file.issi).push(file);
  }
  const errors = database.getErrorsForIssis([...wantedIssis])
    .filter((entry) => isPathInside(resolvedRoot, entry.file));
  const cache = cacheSummary(indexedUnderRoot.length);
  cache.reused = indexedUnderRoot.length;

  const rows = [];
  const history = [];
  const missing = [];
  for (const record of master.records) {
    const matches = (byIssi.get(record.issi) || []).sort(compareCodeplugFreshness);
    if (matches.length === 0) {
      missing.push(record);
      continue;
    }

    matches.forEach((codeplug, index) => {
      history.push({
        ...record,
        actual: index === 0 ? "Actual" : "Historico",
        serial: codeplug.serial,
        tei: codeplug.tei,
        codeplug: codeplug.codeplug,
        software: codeplug.software,
        fileName: codeplug.fileName,
        file: codeplug.path,
        programDate: codeplug.folderDate,
        programmer: codeplug.programmer,
        groupCount: codeplug.groupCount,
      });
    });

    const latest = database.hydrateFile(matches[0]);
    for (const group of latest.rows) {
      rows.push({
        ...group,
        ...record,
        actual: "Actual",
        programDate: latest.date,
        programmer: latest.programmer,
        sourceFolder: latest.sourceFolder,
      });
    }
  }

  const matrix = buildWebFleetMatrix(rows, missing, errors);
  return {
    mode: "fleet-map",
    masterSheet: master.sheetName,
    scannedPath: resolvedRoot,
    files: fileRows.map(databaseFileSummary),
    fileCount: indexedUnderRoot.length,
    rows,
    history,
    missing,
    errors,
    matrix,
    cache,
    database: database.status(resolvedRoot),
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let name = "";
  let value = index + 1;
  while (value > 0) {
    const mod = (value - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    value = Math.floor((value - mod) / 26);
  }
  return name;
}

function sheetXml(rows, options = {}) {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const ref = `A1:${columnName(maxCols - 1)}${Math.max(rows.length, 1)}`;
  const xmlRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      const style = Number(options.styleForCell?.(rowIndex, colIndex, value) || 0);
      const styleAttribute = style > 0 ? ` s="${style}"` : "";
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${ref}"${styleAttribute}><v>${value}</v></c>`;
      }
      return `<c r="${ref}"${styleAttribute} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    }).join("");
    const height = options.rowHeights?.[rowIndex];
    const heightAttribute = height ? ` ht="${height}" customHeight="1"` : "";
    return `<row r="${rowIndex + 1}"${heightAttribute}>${cells}</row>`;
  }).join("");

  const freezeColumns = Number(options.freeze?.columns || 0);
  const freezeRows = Number(options.freeze?.rows || 0);
  const activePane = freezeColumns > 0 && freezeRows > 0
    ? "bottomRight"
    : freezeColumns > 0 ? "topRight" : "bottomLeft";
  const pane = options.freeze
    ? `<pane xSplit="${freezeColumns}" ySplit="${freezeRows}" topLeftCell="${options.freeze.topLeftCell}" activePane="${activePane}" state="frozen"/><selection pane="${activePane}" activeCell="${options.freeze.topLeftCell}" sqref="${options.freeze.topLeftCell}"/>`
    : "";
  const columns = Array.isArray(options.columns) && options.columns.length
    ? `<cols>${options.columns.map((column) => `<col min="${column.min}" max="${column.max}" width="${column.width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const autoFilter = options.autoFilter ? `<autoFilter ref="${options.autoFilter}"/>` : "";
  const merges = Array.isArray(options.merges) && options.merges.length
    ? `<mergeCells count="${options.merges.length}">${options.merges.map((merge) => `<mergeCell ref="${merge}"/>`).join("")}</mergeCells>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${ref}"/>
  <sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${columns}
  <sheetData>${xmlRows}</sheetData>
  ${autoFilter}
  ${merges}
</worksheet>`;
}

function workbookStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><color rgb="FF1F2937"/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="4">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCEAF7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAF3FA"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFB8C7D6"/></left><right style="thin"><color rgb="FFB8C7D6"/></right><top style="thin"><color rgb="FFB8C7D6"/></top><bottom style="thin"><color rgb="FFB8C7D6"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFill="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function createZip(files) {
  const fileParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    fileParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...fileParts, ...centralParts, end]);
}

function groupRowsByRadio(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.issi || ""}|${row.serial || ""}|${row.fileName || ""}`;
    if (!map.has(key)) {
      map.set(key, { ...row, groups: [] });
    }
    map.get(key).groups.push(`${row.alias} (${row.gssi})`);
  }
  return [...map.values()];
}

function buildFleetMatrix(rows) {
  const radioMap = new Map();
  const groupMap = new Map();

  for (const row of rows) {
    const radioKey = `${row.issi || ""}|${row.serial || ""}|${row.fileName || ""}`;
    if (!radioMap.has(radioKey)) {
      radioMap.set(radioKey, { ...row, groupGssis: new Set() });
    }

    const gssi = Number(row.gssi || 0);
    const alias = String(row.alias || "").trim();
    if (!Number.isFinite(gssi) || gssi <= 0 || !alias) continue;
    const groupKey = String(gssi);
    radioMap.get(radioKey).groupGssis.add(groupKey);
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        gssi,
        aliases: new Map(),
        folderTotal: 0,
        folderCount: 0,
        radios: new Set(),
        units: new Set(),
        identities: new Set(),
      });
    }
    const group = groupMap.get(groupKey);
    group.aliases.set(alias, (group.aliases.get(alias) || 0) + 1);
    const folderRow = Number(row.folderRow || 0);
    if (folderRow > 0) {
      group.folderTotal += folderRow;
      group.folderCount += 1;
    }
    group.radios.add(radioKey);
    if (row.unidad) group.units.add(String(row.unidad));
    if (row.issi || row.serial) group.identities.add(String(row.issi || row.serial));
  }

  const groups = [...groupMap.values()].map((group) => ({
    ...group,
    key: String(group.gssi),
    alias: [...group.aliases.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || "",
    averageFolderRow: group.folderCount ? group.folderTotal / group.folderCount : null,
  })).sort((left, right) => {
    if (left.averageFolderRow != null && right.averageFolderRow != null) {
      return left.averageFolderRow - right.averageFolderRow || left.gssi - right.gssi;
    }
    if (left.averageFolderRow != null) return -1;
    if (right.averageFolderRow != null) return 1;
    return left.gssi - right.gssi;
  });
  if (groups.length > 16374) {
    throw new Error(`La matriz supera el limite de Excel: ${groups.length} grupos unicos`);
  }

  const fixedHeaders = ["Cliente", "RUC", "Unidad", "Fecha programacion", "Archivo", "Serial", "TEI", "ISSI", "CP", "SW"];
  const matrixRows = [
    ["Datos del radio", ...Array(fixedHeaders.length - 1).fill(""), ...groups.map((group) => group.gssi)],
    [...fixedHeaders, ...groups.map((group) => group.alias)],
    ...[...radioMap.values()].map((radio) => [
      radio.cliente || radio.razonSocial || radio.organizacion || radio.label || "",
      radio.ruc || "",
      radio.unidad || "",
      radio.programDate || "",
      radio.fileName || "",
      radio.serial || "",
      radio.tei || "",
      radio.issi || "",
      radio.codeplug || "",
      radio.software || "",
      ...groups.map((group) => radio.groupGssis.has(group.key) ? "X" : ""),
    ]),
  ];

  const dictionaryRows = [
    ["GSSI", "Alias", "Cantidad de radios que lo tienen", "Lista de unidades donde aparece", "Lista de ISSI o seriales"],
    ...groups.map((group) => [
      group.gssi,
      group.alias,
      group.radios.size,
      [...group.units].sort((left, right) => left.localeCompare(right)).join(", "),
      [...group.identities].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).join(", "),
    ]),
  ];

  return { groups, radios: [...radioMap.values()], matrixRows, dictionaryRows };
}

function buildWebFleetMatrix(rows, missing, errors) {
  const matrix = buildFleetMatrix(rows);
  const errorIssis = new Set((errors || []).map((error) => String(error.issi || "")).filter(Boolean));
  const radios = matrix.radios.map((radio) => ({
    razonSocial: radio.razonSocial || radio.cliente || radio.organizacion || "",
    unidad: radio.unidad || radio.label || "",
    serial: radio.serial || "",
    tei: radio.tei || "",
    issi: radio.issi || "",
    codeplug: radio.codeplug || "",
    software: radio.software || "",
    programDate: radio.programDate || "",
    fileName: radio.fileName || "",
    observacion: "",
    hasCodeplug: true,
    hasError: errorIssis.has(String(radio.issi || "")),
    groupGssis: [...radio.groupGssis],
  }));
  for (const item of missing || []) {
    radios.push({
      razonSocial: item.razonSocial || item.cliente || item.organizacion || "",
      unidad: item.unidad || item.label || "",
      serial: "",
      tei: "",
      issi: item.issi || "",
      codeplug: "",
      software: "",
      programDate: "",
      fileName: "",
      observacion: item.observacion || "",
      hasCodeplug: false,
      hasError: errorIssis.has(String(item.issi || "")),
      groupGssis: [],
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    groups: matrix.groups.map((group) => ({
      gssi: group.gssi,
      alias: group.alias,
      averageFolderRow: group.averageFolderRow,
    })),
    radios,
  };
}

function searchRadio(term) {
  const cleanTerm = String(term ?? "").trim();
  if (cleanTerm.length < 3) {
    return { term: cleanTerm, results: [], count: 0 };
  }

  const matches = database.searchRadios(cleanTerm, 25).map((file) => {
    const hydrated = database.hydrateFile(file);
    const rows = hydrated?.rows || [];
    const groups = [];
    const seen = new Set();
    for (const row of rows) {
      const key = `${Number(row.gssi || 0)}|${String(row.alias || "").trim()}`;
      if (seen.has(key) || !row.gssi || !row.alias) continue;
      seen.add(key);
      groups.push({
        gssi: Number(row.gssi || 0),
        alias: String(row.alias || "").trim(),
        folderRow: row.folderRow || "",
        statusText: row.statusText || "",
        assignmentConfidence: row.assignmentConfidence || "",
      });
    }

    const matchTypes = [];
    const normalized = cleanTerm.toLowerCase();
    const compact = normalized.replace(/[\s\-_./\\]+/g, "");
    const fieldValues = [
      ["serial", String(file.serial || "")],
      ["tei", String(file.tei || "")],
      ["issi", String(file.issi || "")],
    ];
    for (const [field, value] of fieldValues) {
      const lower = value.toLowerCase();
      const compactValue = lower.replace(/[\s\-_./\\]+/g, "");
      if (lower === normalized || compactValue === compact || lower.includes(normalized) || compactValue.includes(compact)) {
        matchTypes.push(field);
      }
    }

    return {
      path: file.path,
      fileName: file.fileName,
      file: file.path,
      size: file.size,
      modifiedTime: file.mtimeMs,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      date: file.folderDate || "",
      dateKey: file.dateKey || 0,
      sourceFolder: file.sourceFolder || "",
      programmer: file.programmer || "",
      serial: file.serial || "",
      tei: file.tei || "",
      issi: file.issi || "",
      codeplug: file.codeplug || "",
      software: file.software || "",
      cpuId: file.cpuId || "",
      cpeVersion: file.cpeVersion || "",
      groupCount: file.groupCount || 0,
      errorType: file.errorType || "",
      errorMessage: file.errorMessage || "",
      hasGroups: groups.length > 0,
      groups,
      matchTypes,
    };
  });

  return {
    term: cleanTerm,
    count: matches.length,
    results: matches,
    database: database.status(CENTRAL_ROOT),
  };
}

function buildWorkbook(payload) {
  const safeRows = Array.isArray(payload) ? payload : (Array.isArray(payload?.rows) ? payload.rows : []);
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const missing = Array.isArray(payload?.missing) ? payload.missing : [];
  const scanErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  const matrix = buildFleetMatrix(safeRows);
  const fleetRows = [
    ["RUC", "Tipo cliente", "Razon social", "Unidad", "Label", "Serial", "TEI", "ISSI", "CP", "SW", "Fecha", "Programador", "Archivo", "Ruta", "Fila", "Grupo", "GSSI", "Estado"],
    ...safeRows.map((row) => [
      row.ruc,
      row.tipoCliente,
      row.razonSocial,
      row.unidad,
      row.label,
      row.serial,
      row.tei,
      row.issi,
      row.codeplug,
      row.software,
      row.programDate,
      row.programmer,
      row.fileName,
      row.file,
      Number(row.folderRow || row.slot || 0),
      row.alias,
      Number(row.gssi || 0),
      row.statusText,
    ]),
  ];

  const radioRows = [
    ["RUC", "Tipo cliente", "Razon social", "Unidad", "Serial", "TEI", "ISSI", "CP", "SW", "Fecha", "Archivo", "Cantidad grupos", "Grupos"],
    ...groupRowsByRadio(safeRows).map((row) => [
      row.ruc,
      row.tipoCliente,
      row.razonSocial,
      row.unidad,
      row.serial,
      row.tei,
      row.issi,
      row.codeplug,
      row.software,
      row.programDate,
      row.fileName,
      row.groups.length,
      row.groups.join(", "),
    ]),
  ];

  const historyRows = [
    ["ISSI", "Estado", "RUC", "Tipo cliente", "Razon social", "Unidad", "Serial", "TEI", "CP", "SW", "Fecha", "Programador", "Archivo", "Ruta", "Cantidad grupos"],
    ...history.map((row) => [
      row.issi,
      row.actual,
      row.ruc,
      row.tipoCliente,
      row.razonSocial,
      row.unidad,
      row.serial,
      row.tei,
      row.codeplug,
      row.software,
      row.programDate,
      row.programmer,
      row.fileName,
      row.file,
      row.groupCount,
    ]),
  ];

  const missingRows = [
    ["ISSI", "RUC", "Tipo cliente", "Razon social", "Unidad", "Label", "Fila Excel"],
    ...missing.map((row) => [
      row.issi,
      row.ruc,
      row.tipoCliente,
      row.razonSocial,
      row.unidad,
      row.label,
      row.sourceRow,
    ]),
  ];

  const summaryRows = [
    ["Metrica", "Valor"],
    ["Filas exportadas", safeRows.length],
    ["Radios", groupRowsByRadio(safeRows).length],
    ["ISSIs", new Set(safeRows.map((row) => row.issi).filter(Boolean)).size],
    ["Programados", safeRows.filter((row) => row.statusText === "Programado").length],
    ["Historial codeplugs", history.length],
    ["ISSIs sin codeplug", missing.length],
    ["Errores de escaneo", scanErrors.length],
    ["Fecha exportacion", new Date().toISOString()],
  ];

  const errorRows = [
    ["Archivo", "Tipo", "Error"],
    ...scanErrors.map((error) => [error.file, error.errorType || "Error", error.message]),
  ];

  const matrixLastColumn = columnName(Math.max(matrix.matrixRows[0].length, 10) - 1);
  const matrixColumns = [18, 14, 18, 17, 34, 16, 20, 12, 10, 18]
    .map((width, index) => ({ min: index + 1, max: index + 1, width }));
  if (matrix.groups.length > 0) {
    matrixColumns.push({ min: 11, max: 10 + matrix.groups.length, width: 11 });
  }
  const matrixOptions = {
    freeze: { columns: 10, rows: 2, topLeftCell: "K3" },
    autoFilter: `A2:${matrixLastColumn}${Math.max(matrix.matrixRows.length, 2)}`,
    merges: ["A1:J1"],
    columns: matrixColumns,
    rowHeights: { 0: 24, 1: 42 },
    styleForCell: (rowIndex, colIndex, value) => {
      if (rowIndex === 0) return 1;
      if (rowIndex === 1) return colIndex < 10 ? 3 : 2;
      return colIndex >= 10 && value === "X" ? 4 : 0;
    },
  };
  const dictionaryOptions = {
    freeze: { columns: 0, rows: 1, topLeftCell: "A2" },
    autoFilter: `A1:E${Math.max(matrix.dictionaryRows.length, 1)}`,
    columns: [
      { min: 1, max: 1, width: 12 },
      { min: 2, max: 2, width: 24 },
      { min: 3, max: 3, width: 20 },
      { min: 4, max: 4, width: 42 },
      { min: 5, max: 5, width: 60 },
    ],
    rowHeights: { 0: 30 },
    styleForCell: (rowIndex) => rowIndex === 0 ? 3 : 0,
  };

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Matriz Fleet Map" sheetId="1" r:id="rId1"/>
    <sheet name="Fleet Map" sheetId="2" r:id="rId2"/>
    <sheet name="Grupos por Radio" sheetId="3" r:id="rId3"/>
    <sheet name="Diccionario Grupos" sheetId="4" r:id="rId4"/>
    <sheet name="Resumen" sheetId="5" r:id="rId5"/>
    <sheet name="Historial ISSI" sheetId="6" r:id="rId6"/>
    <sheet name="ISSI sin Codeplug" sheetId="7" r:id="rId7"/>
    <sheet name="Errores de Escaneo" sheetId="8" r:id="rId8"/>
  </sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet5.xml"/>
  <Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet6.xml"/>
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet7.xml"/>
  <Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet8.xml"/>
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet5.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet6.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet7.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet8.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  return createZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: workbookStylesXml() },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml(matrix.matrixRows, matrixOptions) },
    { name: "xl/worksheets/sheet2.xml", data: sheetXml(fleetRows) },
    { name: "xl/worksheets/sheet3.xml", data: sheetXml(radioRows) },
    { name: "xl/worksheets/sheet4.xml", data: sheetXml(matrix.dictionaryRows, dictionaryOptions) },
    { name: "xl/worksheets/sheet5.xml", data: sheetXml(summaryRows) },
    { name: "xl/worksheets/sheet6.xml", data: sheetXml(historyRows) },
    { name: "xl/worksheets/sheet7.xml", data: sheetXml(missingRows) },
    { name: "xl/worksheets/sheet8.xml", data: sheetXml(errorRows) },
  ]);
}

function buildTemplateWorkbook() {
  const rows = [
    ["cliente", "ruc", "tipo_cliente", "razon_social", "unidad", "issi", "observacion"],
    ["CELEPSA", "20512481125", "PRIVADO", "COMPANIA ELECTRICA EL PLATANAL S.A.", "F456", "34679", ""],
    ["CELEPSA", "20171827656", "CONTRATISTA", "CONDORCOCHA SOCIEDAD ANONIMA CERRADA", "Contratista", "34677", ""],
  ];

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="NMS" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  return createZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml(rows) },
  ]);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendStatic(response, requestPath) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream";

    response.writeHead(200, { "Content-Type": contentType });
    response.end(data);
  });
}

let legacyMigration;
try {
  legacyMigration = migrateLegacyJsonCache();
} catch (error) {
  legacyMigration = { imported: 0, error: error.message };
  console.error(`No se pudo importar data/cpe-cache.json: ${error.message}`);
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function millisecondsUntilNextMidnight(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - now.getTime());
}

let scheduledWorker = null;
let scheduledScanPending = false;
let dailyTimer = null;

function runCentralIndexInBackground(trigger = "scheduled") {
  if (scheduledWorker && scheduledWorker.exitCode == null) {
    if (trigger !== "manual") scheduledScanPending = true;
    console.log(`Indice central ya esta en curso${trigger === "manual" ? "" : `; se deja pendiente la ejecucion ${trigger}`}`);
    return false;
  }

  console.log(`Iniciando indice central (${trigger}): ${CENTRAL_ROOT}`);
  scheduledWorker = fork(path.join(__dirname, "scripts", "update-central-index.js"), [], {
    env: { ...process.env, CPE_CENTRAL_ROOT: CENTRAL_ROOT, CPE_DB_FILE: DATABASE_FILE },
    stdio: "inherit",
  });
  scheduledWorker.once("exit", (code) => {
    console.log(`Indice central finalizado con codigo ${code}`);
    scheduledWorker = null;
    if (scheduledScanPending) {
      scheduledScanPending = false;
      runCentralIndexInBackground("pending");
    }
  });
  return true;
}

function scheduleNextCentralScan() {
  const delay = millisecondsUntilNextMidnight();
  const next = new Date(Date.now() + delay);
  console.log(`Proximo indice central: ${next.toLocaleString()} (${CENTRAL_ROOT})`);
  dailyTimer = setTimeout(() => {
    runCentralIndexInBackground("midnight");
    scheduleNextCentralScan();
  }, delay);
}

function startDailyCentralScheduler() {
  const latest = database.status(CENTRAL_ROOT).latestScan;
  const activeScan = latest && !latest.finishedAt &&
    Date.now() - new Date(latest.startedAt).getTime() < 24 * 60 * 60 * 1000;
  if (!activeScan && (!latest?.finishedAt || localDateKey(latest.finishedAt) !== localDateKey(new Date()))) {
    runCentralIndexInBackground("startup-catchup");
  }
  scheduleNextCentralScan();
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === "POST" && requestUrl.pathname === "/api/scan") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (!payload.path || typeof payload.path !== "string") {
          sendJson(response, 400, { error: "Indica una ruta valida" });
          return;
        }
        sendJson(response, 200, scanPath(payload.path));
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/index") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        JSON.parse(body || "{}");
        const started = runCentralIndexInBackground("manual");
        sendJson(response, 202, {
          started,
          alreadyRunning: !started,
          message: started ? "Actualizacion iniciada en segundo plano" : "El indice central ya esta en curso",
          database: database.status(CENTRAL_ROOT),
        });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/export-xlsx") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const workbook = buildWorkbook(payload);
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename=\"fleet_map.xlsx\"",
          "Content-Length": workbook.length,
        });
        response.end(workbook);
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/fleet-map") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 80 * 1024 * 1024) request.destroy();
    });
    request.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (!payload.masterFileBase64 || typeof payload.masterFileBase64 !== "string") {
          sendJson(response, 400, { error: "Carga el Excel maestro de ISSIs" });
          return;
        }
        sendJson(response, 200, buildFleetMap(CENTRAL_ROOT, payload.masterFileBase64));
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, database: database.status(), legacyMigration, centralRoot: CENTRAL_ROOT });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/db-status") {
    const rootPath = requestUrl.searchParams.get("rootPath") || "";
    sendJson(response, 200, { ...database.status(rootPath), legacyMigration, centralRoot: CENTRAL_ROOT });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/diagnostics") {
    const reports = [
      "error-report-by-cps-length.json",
      "cp-error-analysis.json",
      "cp-layout-discovery.json",
      "cp-layout-scores.json",
    ].map((name) => {
      const filePath = path.join(__dirname, "data", name);
      const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
      return { name, path: filePath, exists: Boolean(stat), size: stat?.size || 0 };
    });
    sendJson(response, 200, {
      ...database.diagnostics(),
      status: database.status(CENTRAL_ROOT),
      centralRoot: CENTRAL_ROOT,
      reports,
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/radio-search") {
    const term = requestUrl.searchParams.get("term") || "";
    sendJson(response, 200, searchRadio(term));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/template-xlsx") {
    const workbook = buildTemplateWorkbook();
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename=\"plantilla_fleet_map.xlsx\"",
      "Content-Length": workbook.length,
    });
    response.end(workbook);
    return;
  }

  sendStatic(response, requestUrl.pathname);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`CPE Dashboard: http://${HOST}:${PORT}`);
    console.log(`SQLite: ${DATABASE_FILE}`);
    startDailyCentralScheduler();
  });
  const shutdown = () => {
    if (dailyTimer) clearTimeout(dailyTimer);
    server.close(() => {
      database.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = {
  buildFleetMap,
  buildTemplateWorkbook,
  buildWorkbook,
  database,
  extractCodeplugFile,
  LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE,
  LAYOUTS_BY_CPS_SIZE,
  migrateLegacyJsonCache,
  millisecondsUntilNextMidnight,
  parseCpeSections,
  readZip,
  scanPath,
  server,
};
