const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFile, fork } = require("child_process");
const { URL } = require("url");
const { CpeDatabase } = require("./lib/cpe-database");
const { isExcludedCodeplugFile } = require("./lib/cpe-file-filter");
const septemberLayouts = require("./lib/validated-september-layouts");
const runtimePaths = require("./lib/runtime-paths");
const { emergencyFromValidatedReport } = require("./lib/validated-user-report-emergency");
const reportGroupLayouts = require("./lib/validated-user-report-group-layouts").groupLayouts;
const { extractCpeFeatures, unavailableFeatures } = require("./lib/cpe-features");
const { extractCpeContacts, compareContactAgendas, canonicalizeContacts } = require("./lib/cpe-contacts");
const { parseProjectCpeSheets } = require("./lib/project-cpe");
const { validateProjectCpeModel } = require("./lib/project-cpe-model-validator");
const { validateProjectCpeRadio } = require("./lib/project-cpe-radio-validator");
const { ProjectCpePublisher, normalizePublicationRoute } = require("./lib/project-cpe-publisher");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATABASE_FILE = process.env.CPE_DB_FILE
  ? path.resolve(process.env.CPE_DB_FILE)
  : runtimePaths.dataFile("cpe-dashboard.sqlite");
const LEGACY_CACHE_FILE = runtimePaths.dataFile("cpe-cache.json");
const SERVER_LOG_FILE = process.env.CPE_LOG_FILE || runtimePaths.dataFile("server.log");
const PROJECTS_ROOT = path.join(runtimePaths.dir("programaciones"), "proyecto-cpe");
const PROJECT_TEMPLATE_FILE = runtimePaths.docFile("Plantilla_Solicitud_Cliente_CPE.xlsx");
const PROJECT_TEMPLATE_GENERATOR = path.join(__dirname, "scripts", "generate-project-cpe-template.py");
const PROJECT_TEMPLATE_CACHE = runtimePaths.docFile("plantillas-proyecto-cpe");
const PROJECT_TEMPLATE_REVISION = "2";
const PROJECT_TEMPLATE_PYTHON = [
  process.env.CPE_PYTHON_LAUNCHER,
  String.raw`C:\Users\usrdolphin\AppData\Local\Programs\Python\Python313\python.exe`,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Launcher", "py.exe") : "",
  String.raw`C:\Users\usrdolphin\AppData\Local\Programs\Python\Launcher\py.exe`,
  String.raw`C:\Windows\py.exe`,
].find((candidate) => candidate && fs.existsSync(candidate)) || "py";
const PROJECT_TEMPLATE_PYTHON_ARGS = path.basename(PROJECT_TEMPLATE_PYTHON).toLowerCase() === "py.exe" ? ["-3"] : [];
const PARSER_VERSION = "24";
const BATCH_SIZE = 200;
const WEB_TECHNICAL_ROW_LIMIT = 500;
const CENTRAL_ROOT = process.env.CPE_CENTRAL_ROOT || String.raw`\\192.168.7.252\tic\002 Programacion`;
const NODE_MODE = String(process.env.CPE_NODE_MODE || "central").trim().toLowerCase() === "field" ? "field" : "central";
const database = new CpeDatabase(DATABASE_FILE, PARSER_VERSION);
const projectPublisher = new ProjectCpePublisher({
  database,
  projectsRoot: PROJECTS_ROOT,
  deliveriesRoot: runtimePaths.dir("entregas"),
  configDirectory: runtimePaths.dir("publicacion"),
});
const SERVER_STARTED_AT_MS = Date.now();
const exportActivity = {
  running: 0,
  completed: 0,
  failed: 0,
  last: null,
};
const projectTemplateJobs = new Map();
let publicationWorkerRunning = false;
let fieldSyncRunning = false;
let lastFieldSync = null;
let publicationTimer = null;
let fieldSyncTimer = null;

function projectTemplateCapacity(searchParams) {
  const rawGroups = searchParams.get("groups") ?? "10";
  const rawDmoGroups = searchParams.get("dmoGroups") ?? "10";
  if (!/^\d+$/.test(rawGroups) || Number(rawGroups) < 1 || Number(rawGroups) > 100) {
    throw new Error("La cantidad de grupos TMO debe estar entre 1 y 100");
  }
  if (!/^\d+$/.test(rawDmoGroups) || Number(rawDmoGroups) < 0 || Number(rawDmoGroups) > 50) {
    throw new Error("La cantidad de grupos DMO debe estar entre 0 y 50");
  }
  return { groups: Number(rawGroups), dmoGroups: Number(rawDmoGroups) };
}

function projectTemplateFile(groups, dmoGroups) {
  if (groups === 10 && dmoGroups === 10 && fs.existsSync(PROJECT_TEMPLATE_FILE)) {
    return Promise.resolve(PROJECT_TEMPLATE_FILE);
  }
  fs.mkdirSync(PROJECT_TEMPLATE_CACHE, { recursive: true });
  const output = path.join(PROJECT_TEMPLATE_CACHE, `Plantilla_CPE_V7R${PROJECT_TEMPLATE_REVISION}_TMO${groups}_DMO${dmoGroups}.xlsx`);
  if (fs.existsSync(output)) return Promise.resolve(output);
  const key = `${groups}:${dmoGroups}`;
  if (projectTemplateJobs.has(key)) return projectTemplateJobs.get(key);
  const job = new Promise((resolve, reject) => {
    execFile(
      PROJECT_TEMPLATE_PYTHON,
      [
        ...PROJECT_TEMPLATE_PYTHON_ARGS,
        PROJECT_TEMPLATE_GENERATOR,
        "--groups", String(groups),
        "--dmo-groups", String(dmoGroups),
        "--output", output,
        "--no-deploy",
      ],
      { cwd: __dirname, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 },
      (error) => {
        if (error) {
          reject(new Error(`No se pudo generar la plantilla dinámica: ${error.message}`));
          return;
        }
        if (!fs.existsSync(output)) {
          reject(new Error("El generador no produjo la plantilla solicitada"));
          return;
        }
        resolve(output);
      },
    );
  });
  projectTemplateJobs.set(key, job);
  job.then(
    () => projectTemplateJobs.delete(key),
    () => projectTemplateJobs.delete(key),
  );
  return job;
}
let centralRootProbe = null;
let centralRootProbePromise = null;

function logRuntimeEvent(event, details = {}) {
  try {
    fs.mkdirSync(path.dirname(SERVER_LOG_FILE), { recursive: true });
    fs.appendFileSync(
      SERVER_LOG_FILE,
      `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`,
      "utf8",
    );
  } catch {
    // Un fallo de logging nunca debe interrumpir el dashboard.
  }
}

function recordExportResult(status, startedAt, details = {}) {
  const completedAt = new Date().toISOString();
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (status === "completed") exportActivity.completed += 1;
  else exportActivity.failed += 1;
  exportActivity.last = { status, completedAt, elapsedMs, ...details };
}

async function probeCentralRoot(force = false) {
  const cacheAgeMs = centralRootProbe ? Date.now() - Date.parse(centralRootProbe.checkedAt) : Infinity;
  if (!force && centralRootProbe && cacheAgeMs < 30_000) return centralRootProbe;
  if (centralRootProbePromise) return centralRootProbePromise;

  centralRootProbePromise = (async () => {
    const startedAt = Date.now();
    let timeoutId;
    try {
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Tiempo de espera agotado al consultar el TIC NAS")), 5000);
      });
      const stat = await Promise.race([fs.promises.stat(CENTRAL_ROOT), timeout]);
      if (!stat.isDirectory()) throw new Error("La ruta central no es una carpeta");
      centralRootProbe = {
        ok: true,
        status: "Disponible",
        checkedAt: new Date().toISOString(),
        responseMs: Date.now() - startedAt,
        error: "",
      };
    } catch (error) {
      centralRootProbe = {
        ok: false,
        status: "Sin conexion",
        checkedAt: new Date().toISOString(),
        responseMs: Date.now() - startedAt,
        error: String(error.message || error),
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    return centralRootProbe;
  })();

  try {
    return await centralRootProbePromise;
  } finally {
    centralRootProbePromise = null;
  }
}

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
    // CP1315/CP1330 R36 almacena los grupos DMO en una tabla independiente
    // aunque los grupos TMO utilicen la estructura de asignaciones. Validado
    // con el par controlado BASE TODO INACTIVO / SOLO DMO ACTIVO y su User
    // Report: primer registro "GRUPO DMO", GSSI 90101, estado programado 1.
    dmo: {
      offset: 1649984,
      recordSize: 60,
      maxRecords: 2000,
      aliasBytes: 32,
      gssiOffset: 36,
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
  "1726": {
    3222528: {
      main: { offset: 815692, recordSize: 68, maxRecords: 1000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1 },
      // Estado 2: grupo normal asignado. Estado 7: BROADCAST asignado.
      assignment: { stateOffset: 42, activeValues: [2, 7], positionOffset: 48, confidence: "high" },
      // CP1726 R65: ocho CPE operativos coinciden en la tabla de 2000
      // registros y en su frontera exacta con Scan List1. ISEG 001 (2300)
      // aparece programado en la posicion 125 de todos ellos.
      dmo: { offset: 1527692, recordSize: 64, maxRecords: 2000, aliasBytes: 32, gssiOffset: 36 },
    },
  },
  "1315": {
    2848576: {
      // CPS User Report 44310: 24-byte name, state at +24; +26 is the
      // default folder, which is zero for the valid invisible group 9908.
      main: { offset: 814728, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: 26, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 24, activeValues: [1, 2], positionOffset: 42, preserveState: true, confidence: "high" },
      // User Report 44310 and a full CP1315/R27 audit confirm the DMO table.
      dmo: { offset: 1414728, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28 },
    },
  },
  "0865": {
    2487104: {
      main: { offset: 751776, recordSize: 56, maxRecords: 10000, aliasBytes: 20, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null, requireAlias: true, minGssi: 1, maxGssi: 999999 },
      assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42, confidence: "high" },
    },
  },
  "0405": {
    1045696: reportGroupLayouts[1045696],
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
  ...septemberLayouts.groupLayouts,
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
    // CP7492 R13: User Report SOLO DMO ACTIVO confirma DMO1 (2000).
    // La tabla tiene 1024 registros; inmediatamente despues inicia Scan List1.
    dmo: { offset: 366940, recordSize: 52, maxRecords: 1024, aliasBytes: 24, gssiOffset: 28 },
  },
  1065536: {
    main: { offset: 245400, recordSize: 52, maxRecords: 1000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    assignment: { stateOffset: 34, activeValue: 2, positionOffset: 40 },
  },
  1079232: {
    main: { offset: 245452, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 349452, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
    // CP7715 R13: User Report SOLO DMO ACTIVO confirma COORPLANTDMO
    // (8388623) y el inicio de escaneo despues de 1024 registros.
    dmo: { offset: 367896, recordSize: 52, maxRecords: 1024, aliasBytes: 24, gssiOffset: 28 },
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
    // CP1274 R55: User Report SOLO DMO ACTIVO confirma YAULI 01 (5000).
    // Scan List1 comienza al terminar los 2000 registros DMO.
    dmo: { offset: 1416328, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28 },
    assignment: { activeU16Offset: 26, activeValue: 1, positionByteOffset: 42 },
  },
  3087360: {
    main: { offset: 815372, recordSize: 64, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: null },
    folder: { offset: 1455372, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2 },
  },
  3159936: {
    // User Report 55391: 10,000 main records; use real folder membership.
    main: { offset: 815628, recordSize: 68, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: 34 },
    folder: { offset: 1495628, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2, validStatuses: [1, 2], validateIndex: true },
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
    // User Report 56562 confirms folder state 2 = Invisible (SCR-BROADCAS).
    main: { offset: 990468, recordSize: 68, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36, networkIndexOffset: null, defaultZoneOffset: 34 },
    folder: { offset: 1670468, recordSize: 4, maxRecords: 10000, statusOffset: 0, tgIndexOffset: 2, validStatuses: [1, 2], validateIndex: true },
  },
  ...reportGroupLayouts,
};

// Layouts validados con parejas CPS tactico/no tactico. El bit de modo es la
// fuente de verdad: varios formatos conservan un grupo fijo aun en modo tactico.
// MTP3550/CP1726 tambien se contrasto con SN[121TCD2918] / ISSI[57947].
const EMERGENCY_LAYOUTS_BY_CPS_SIZE = {
  ...septemberLayouts.emergencyLayouts,
  // MTM5400 CP1315/1330, exact CPS size. Cross-checked with the CPS User
  // Report for 44310 (ALP-EMERG, 9901, non-tactical). Not the portable layout.
  2848576: {
    modeOffset: 2708,
    addressTypeOffset: 158108,
    groupAddressValue: 1,
    gssiOffset: 158116,
    aliasOffset: 158120,
    aliasBytes: 32,
    attachmentOffset: 158196,
    confidence: "report-44310",
  },
  982144: {
    modeOffset: 2492,
    addressTypeOffset: 28896,
    groupAddressValue: 1,
    gssiOffset: 28904,
    aliasOffset: 28908,
    aliasBytes: 32,
    confidence: "high",
  },
  1064192: {
    modeOffset: 2684,
    addressTypeOffset: 37024,
    groupAddressValue: 1,
    gssiOffset: 37032,
    aliasOffset: 37036,
    aliasBytes: 32,
    confidence: "high",
  },
  1079232: {
    modeOffset: 2632,
    addressTypeOffset: 38048,
    groupAddressValue: 1,
    gssiOffset: 38056,
    aliasOffset: 38060,
    aliasBytes: 32,
    confidence: "high",
  },
  1787200: {
    modeOffset: 2636,
    addressTypeOffset: 42464,
    groupAddressValue: 1,
    gssiOffset: 42472,
    aliasOffset: 42476,
    aliasBytes: 32,
    confidence: "high",
  },
  1855040: {
    modeOffset: 2636,
    addressTypeOffset: 52384,
    groupAddressValue: 1,
    gssiOffset: 52392,
    aliasOffset: 52396,
    aliasBytes: 32,
    confidence: "high",
  },
  2487104: {
    modeOffset: 2680,
    addressTypeOffset: 210972,
    groupAddressValue: 1,
    gssiOffset: 210980,
    aliasOffset: 210984,
    aliasBytes: 32,
    confidence: "high",
  },
  2535552: {
    modeOffset: 2680,
    addressTypeOffset: 210972,
    groupAddressValue: 1,
    gssiOffset: 210980,
    aliasOffset: 210984,
    aliasBytes: 32,
    confidence: "high",
  },
  2548224: {
    modeOffset: 2704,
    addressTypeOffset: 211036,
    groupAddressValue: 1,
    gssiOffset: 211044,
    aliasOffset: 211048,
    aliasBytes: 32,
    confidence: "high",
  },
  2626688: {
    modeOffset: 2704,
    addressTypeOffset: 235100,
    groupAddressValue: 1,
    gssiOffset: 235108,
    aliasOffset: 235112,
    aliasBytes: 32,
    confidence: "high",
  },
  2728576: {
    modeOffset: 2704,
    addressTypeOffset: 235100,
    groupAddressValue: 1,
    gssiOffset: 235108,
    aliasOffset: 235112,
    aliasBytes: 32,
    confidence: "high",
  },
  2849088: {
    modeOffset: 2704,
    addressTypeOffset: 158940,
    groupAddressValue: 1,
    gssiOffset: 158948,
    aliasOffset: 158952,
    aliasBytes: 32,
    confidence: "high",
  },
  3021888: {
    modeOffset: 2704,
    addressTypeOffset: 159708,
    groupAddressValue: 1,
    gssiOffset: 159716,
    aliasOffset: 159720,
    aliasBytes: 32,
    confidence: "high",
  },
  3144064: {
    modeOffset: 2708,
    addressTypeOffset: 158684,
    groupAddressValue: 1,
    gssiOffset: 158692,
    aliasOffset: 158696,
    aliasBytes: 32,
    confidence: "high",
  },
  3222528: {
    modeOffset: 2708,
    addressTypeOffset: 159068,
    groupAddressValue: 1,
    gssiOffset: 159076,
    aliasOffset: 159080,
    aliasBytes: 32,
    confidence: "high",
  },
  4859968: {
    modeOffset: 2708,
    addressTypeOffset: 158364,
    groupAddressValue: 1,
    gssiOffset: 158372,
    aliasOffset: 158376,
    aliasBytes: 32,
    confidence: "high",
  },
  4862464: {
    modeOffset: 2708,
    addressTypeOffset: 158684,
    groupAddressValue: 1,
    gssiOffset: 158692,
    aliasOffset: 158696,
    aliasBytes: 32,
    confidence: "high",
  },
  4997184: {
    modeOffset: 2708,
    addressTypeOffset: 176732,
    groupAddressValue: 1,
    gssiOffset: 176740,
    aliasOffset: 176744,
    aliasBytes: 32,
    confidence: "high",
  },
  5066880: {
    modeOffset: 2708,
    addressTypeOffset: 176924,
    groupAddressValue: 1,
    gssiOffset: 176932,
    aliasOffset: 176936,
    aliasBytes: 32,
    attachmentOffset: 177012,
    confidence: "high",
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

function readFileInChunksSync(filePath, chunkSize = 64 * 1024, attempts = 4) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const file = Buffer.alloc(size);
    let cursor = 0;
    while (cursor < size) {
      const blockEnd = Math.min(size, cursor + chunkSize);
      let attempt = 0;
      while (cursor < blockEnd) {
        try {
          const bytesRead = fs.readSync(fd, file, cursor, blockEnd - cursor, cursor);
          if (!bytesRead) throw new Error(`Archivo truncado en el byte ${cursor}`);
          cursor += bytesRead;
          attempt = 0;
        } catch (error) {
          attempt += 1;
          if (attempt >= attempts) {
            const failure = new Error(`No se pudo leer el CPE desde el byte ${cursor}: ${error.message}`);
            failure.code = error.code;
            failure.cause = error;
            throw failure;
          }
        }
      }
    }
    return file;
  } finally {
    fs.closeSync(fd);
  }
}

function readFileSyncResilient(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (!new Set(["UNKNOWN", "EIO"]).has(error?.code)) throw error;
    return readFileInChunksSync(filePath);
  }
}

function parseCpeSections(filePath) {
  const file = readFileSyncResilient(filePath);
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

function extractEmergencyConfig(cps) {
  const reported = emergencyFromValidatedReport(cps);
  if (reported) return reported;
  const layout = EMERGENCY_LAYOUTS_BY_CPS_SIZE[cps.length];
  if (!layout) {
    return {
      emergencySupported: false,
      emergencyAddressType: "",
      emergencyMode: "No disponible",
      emergencyAlias: "",
      emergencyGssi: 0,
      emergencyAttachment: false,
      emergencyConfidence: "",
    };
  }

  const addressTypeValue = cps.readUInt32LE(layout.addressTypeOffset);
  const rawGssi = cps.readUInt32LE(layout.gssiOffset);
  const alias = decodeUtf16Le(
    cps.subarray(layout.aliasOffset, layout.aliasOffset + layout.aliasBytes)
  );
  const isGroupAddress = addressTypeValue === layout.groupAddressValue;
  const modeValue = layout.modeOffset == null ? null : (cps[layout.modeOffset] & 1);
  const isTactical = isGroupAddress && (
    modeValue === 0 || (modeValue == null && rawGssi <= 1 && !alias)
  );
  const isNonTactical = isGroupAddress && (
    modeValue === 1 || (modeValue == null && (rawGssi > 1 || Boolean(alias)))
  );

  return {
    emergencySupported: true,
    emergencyAddressType: isGroupAddress ? "Grupo" : `Tipo ${addressTypeValue}`,
    emergencyMode: isTactical ? "Táctico" : (isNonTactical ? "No táctico" : "Sin configurar"),
    emergencyAlias: isTactical ? "Grupo actual" : alias,
    emergencyGssi: isTactical ? 0 : rawGssi,
    emergencyAttachment: layout.attachmentOffset == null
      ? false
      : Boolean(cps.readUInt32LE(layout.attachmentOffset)),
    emergencyConfidence: layout.confidence,
  };
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
    codeplug: read("CP") || name.match(/^CP(\d{4})(?:_|\(|\.)/i)?.[1] || "",
    software: read("SW"),
  };
}

function layoutFor(meta, cps) {
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

  // A file without CP in its name can still use an unambiguous validated
  // structure. Do not guess a CP or apply a family layout to a different size.
  const candidates = Object.values(LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE)
    .map((layouts) => layouts[cps.length]).filter(Boolean);
  if (candidates.length && candidates.every((layout) => JSON.stringify(layout) === JSON.stringify(candidates[0]))) {
    return candidates[0];
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
  if (index <= 0 || index > main.maxRecords || base < 0 || base + main.recordSize > cps.length) {
    return null;
  }

  const aliasOffset = Number(main.aliasOffset || 0);
  const alias = decodeUtf16Le(cps.subarray(base + aliasOffset, base + aliasOffset + main.aliasBytes));
  const gssi = cps.readUInt32LE(base + main.gssiOffset);
  if (gssi === 0 || gssi > 16777215) return null;
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

  const emergency = extractEmergencyConfig(cps);
  const agenda = extractCpeContacts(cps);
  let layout;
  try {
    layout = layoutFor(meta, cps);
  } catch (error) {
    if (emergency.emergencySupported && /no soportado todavia/i.test(error.message)) {
      return { meta, rows: [], emergency, features: extractCpeFeatures(cps), agenda };
    }
    throw error;
  }
  const rows = [];
  if (layout.folder) {
    const folder = layout.folder;
    const seenSlots = new Set();
    for (let rowIndex = 0; rowIndex < folder.maxRecords; rowIndex += 1) {
      const base = folder.offset + rowIndex * folder.recordSize;
      if (base + folder.recordSize > cps.length) break;

      const status = cps[base + folder.statusOffset];
      if (![0, 1, 2].includes(status)) continue;
      const tgIndex = cps.readUInt16LE(base + folder.tgIndexOffset);
      if (folder.validStatuses && !folder.validStatuses.includes(status)) continue;
      if (folder.validateIndex && (tgIndex < 1 || tgIndex > layout.main.maxRecords)) continue;
      if (tgIndex === 0 && status === 0) {
        continue;
      }

      const group = readMainGroup(cps, layout, tgIndex);
      if (!group) {
        continue;
      }
      if (folder.deduplicateSlots && seenSlots.has(group.slot)) continue;
      seenSlots.add(group.slot);

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
      const activeValues = assignment.activeValues || [assignment.activeValue];
      if (!activeValues.includes(state) || position === 0) {
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
        status: assignment.preserveState ? state : 1,
        statusText: statusText(assignment.preserveState ? state : 1),
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

  const features = extractCpeFeatures(cps, { layout, talkgroups: rows });
  return { meta, rows, emergency, features, agenda };
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
    ...extracted.emergency,
    features: extracted.features || unavailableFeatures(),
    agenda: extracted.agenda || { supported: false, state: "No disponible", count: 0, hash: "", contacts: [] },
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
    emergencySupported: Boolean(codeplug.emergencySupported),
    emergencyAddressType: codeplug.emergencyAddressType || "",
    emergencyMode: codeplug.emergencyMode || "No disponible",
    emergencyAlias: codeplug.emergencyAlias || "",
    emergencyGssi: Number(codeplug.emergencyGssi || 0),
    emergencyAttachment: Boolean(codeplug.emergencyAttachment),
    emergencyConfidence: codeplug.emergencyConfidence || "",
    features: codeplug.features || unavailableFeatures(),
    agenda: codeplug.agenda || { supported: false, state: "No disponible", count: 0, hash: "", contacts: [] },
  };
}

function storedFeatures(file) {
  if (file?.features && typeof file.features === "object") return file.features;
  try {
    return file?.featuresJson ? JSON.parse(file.featuresJson) : unavailableFeatures();
  } catch {
    return unavailableFeatures();
  }
}

function resolveFileFeatures(file, options = {}) {
  const refreshStale = options.refreshStale !== false;
  const hasStoredFeatures = Boolean(
    (file?.features && typeof file.features === "object") || file?.featuresJson,
  );
  const isStale = file?.parserVersion != null
    && String(file.parserVersion) !== PARSER_VERSION;
  if (hasStoredFeatures && (!refreshStale || !isStale)) return storedFeatures(file);
  // Los archivos ya clasificados con error no deben releerse desde el NAS en
  // cada consulta. El reproceso se realiza de forma explicita en mantenimiento.
  if (file?.errorMessage) return hasStoredFeatures ? storedFeatures(file) : unavailableFeatures();
  if (!file?.path || !fs.existsSync(file.path)) {
    return hasStoredFeatures ? storedFeatures(file) : unavailableFeatures();
  }
  try {
    const features = extractCodeplugFile(file.path).features || unavailableFeatures();
    if (file.id) database.updateFeatures(file.id, features);
    file.features = features;
    file.featuresJson = JSON.stringify(features);
    file.parserVersion = PARSER_VERSION;
    return features;
  } catch (error) {
    logRuntimeEvent("feature-on-demand-failed", { file: file.path, error: error.message });
    return unavailableFeatures();
  }
}

function resolveFileAgenda(file) {
  if (file?.agendaHash) return database.hydrateAgenda(file);
  if (file?.errorMessage || !file?.path || !fs.existsSync(file.path)) {
    return { supported: false, state: "No disponible", count: 0, hash: "", confidence: "", contacts: [] };
  }
  try {
    const cps = parseCpeSections(file.path).sections.CPS;
    const agenda = extractCpeContacts(cps);
    if (file.id) database.updateAgenda(file.id, agenda);
    file.agendaHash = agenda.supported ? agenda.hash : "";
    file.agendaState = agenda.state;
    file.agendaConfidence = agenda.confidence || "";
    return agenda;
  } catch (error) {
    logRuntimeEvent("agenda-on-demand-failed", { file: file.path, error: error.message });
    return { supported: false, state: "No disponible", count: 0, hash: "", confidence: "", contacts: [] };
  }
}

function broadcastAudit(broadcastValue) {
  const broadcast = broadcastValue || unavailableFeatures().broadcast;
  const gssi = Number(broadcast.gssi || 0);
  const alias = String(broadcast.alias || "").trim();
  const indicatorActive = typeof broadcast.indicatorActive === "boolean"
    ? broadcast.indicatorActive
    : broadcast.state === "Solo escucha" ? true
      : ["Inactivo", "Sin configurar"].includes(broadcast.state) ? false : null;
  const destinationConfigured = typeof broadcast.destinationConfigured === "boolean"
    ? broadcast.destinationConfigured
    : gssi > 0 ? true : null;
  const announcementPriority = Number.isFinite(Number(broadcast.announcementPriority))
    && broadcast.announcementPriority !== null && broadcast.announcementPriority !== ""
    ? Number(broadcast.announcementPriority) : null;
  const groupInvisible = typeof broadcast.groupInvisible === "boolean" ? broadcast.groupInvisible : null;
  const continuousTracking = typeof broadcast.continuousTracking === "boolean" ? broadcast.continuousTracking : null;
  const priorityTen = announcementPriority === 10;
  const listening = indicatorActive === true
    && destinationConfigured === true
    && gssi > 0
    && priorityTen;
  const review = indicatorActive === true
    && destinationConfigured === true
    && gssi > 0
    && !priorityTen;
  const result = listening ? "Escucha"
    : review ? "Revisar"
      : indicatorActive === true || indicatorActive === false ? "Inactivo" : "Pendiente de validación";
  const issues = [];
  if (review) {
    if (!priorityTen) issues.push(announcementPriority == null ? "Prioridad de anuncio no verificada" : `Prioridad de anuncio ${announcementPriority}; debe ser 10`);
    if (destinationConfigured === true && !alias) issues.push("El GSSI destino no tiene label de grupo validado");
  }
  const showConfiguration = listening || review;
  return {
    result,
    summary: listening ? `ESCUCHA — ${alias} (${gssi})` : review ? "REVISAR" : result === "Pendiente de validación" ? "PENDIENTE DE VALIDACIÓN" : "",
    alias: showConfiguration ? alias : "",
    gssi: showConfiguration ? gssi : 0,
    indicatorActive,
    destinationConfigured,
    announcementPriority: showConfiguration ? announcementPriority : null,
    announcementAlias: showConfiguration ? String(broadcast.announcementAlias || "").trim() : "",
    groupInvisible: showConfiguration ? groupInvisible : null,
    continuousTracking: showConfiguration ? continuousTracking : null,
    priorityTen,
    issues,
  };
}

function indicatorState(feature) {
  return feature?.state === "Activo" || feature?.state === "Inactivo"
    ? feature.state
    : "No disponible";
}

function featureSummaries(featuresValue) {
  const features = featuresValue || unavailableFeatures();
  const scanActive = features.scan?.state === "Activo";
  const scanGroups = scanActive
    ? (features.scan?.lists || []).reduce((sum, list) => sum + (list.groups || []).length, 0)
    : 0;
  const dmoState = indicatorState(features.dmo);
  const dmoActive = dmoState === "Activo";
  const dmoGroups = dmoActive ? (features.dmo?.groups || []).length : 0;
  const otapActive = features.otap?.state === "Activo";
  const otapTargets = otapActive ? (features.otap?.targets || []).length : 0;
  const broadcast = broadcastAudit(features.broadcast);
  const gpsState = indicatorState(features.gps);
  const gpsActive = gpsState === "Activo";
  const gpsDestination = gpsActive ? Number(features.gps?.destinationIssi || 0) : 0;
  return {
    scanSummary: `${indicatorState(features.scan)}${scanGroups ? ` · ${scanGroups}` : ""}`,
    dmoSummary: `${dmoState}${dmoGroups ? ` · ${dmoGroups}` : ""}`,
    broadcastSummary: broadcast.summary,
    gpsSummary: gpsDestination ? `${gpsState} · ${gpsDestination}` : gpsState,
    otapSummary: `${features.otap?.state || "No disponible"}${otapTargets ? ` · ${otapTargets}` : ""}`,
  };
}

function activeFeatureFlag(feature) {
  return feature?.state === "Activo" ? "X" : "";
}

function fleetFeatureFlags(featuresValue) {
  const features = featuresValue || unavailableFeatures();
  return {
    scanFlag: activeFeatureFlag(features.scan),
    dmoFlag: activeFeatureFlag(features.dmo),
    otapFlag: activeFeatureFlag(features.otap),
  };
}

function databaseFileSummary(file) {
  const features = storedFeatures(file);
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
    emergencySupported: Boolean(file.emergencySupported),
    emergencyAddressType: file.emergencyAddressType || "",
    emergencyMode: file.emergencyMode || "No disponible",
    emergencyAlias: file.emergencyAlias || "",
    emergencyGssi: Number(file.emergencyGssi || 0),
    emergencyAttachment: Boolean(file.emergencyAttachment),
    emergencyConfidence: file.emergencyConfidence || "",
    features,
    ...featureSummaries(features),
  };
}

function rowsForPathFleetMap(files, rows) {
  const fileByPath = new Map(files.map((file) => [comparablePath(file.path), file]));
  const filesWithRows = new Set();
  const enrichedRows = rows.map((row) => {
    const file = fileByPath.get(comparablePath(row.file)) || {};
    if (file.path) filesWithRows.add(comparablePath(file.path));
    return {
      ...file,
      ...row,
      file: row.file || file.path || "",
      fileName: row.fileName || file.fileName || "",
      programDate: row.programDate || file.programDate || "",
      programmer: row.programmer || file.programmer || "",
      emergencySupported: Boolean(file.emergencySupported ?? row.emergencySupported),
      emergencyAddressType: file.emergencyAddressType || row.emergencyAddressType || "",
      emergencyMode: file.emergencyMode || row.emergencyMode || "No disponible",
      emergencyAlias: file.emergencyAlias || row.emergencyAlias || "",
      emergencyGssi: Number(file.emergencyGssi || row.emergencyGssi || 0),
      emergencyAttachment: Boolean(file.emergencyAttachment ?? row.emergencyAttachment),
      emergencyConfidence: file.emergencyConfidence || row.emergencyConfidence || "",
      features: file.features || row.features || unavailableFeatures(),
      ...featureSummaries(file.features || row.features),
    };
  });

  for (const file of files) {
    if (filesWithRows.has(comparablePath(file.path))) continue;
    enrichedRows.push({
      ...file,
      file: file.path,
      folderRow: "",
      slot: 0,
      alias: "",
      gssi: 0,
      status: 0,
      statusText: "Sin grupos de conversación validados",
      assignmentConfidence: "",
      networkIndex: 0,
      defaultZone: 0,
    });
  }
  return sortRowsByRadioAndGssi(enrichedRows);
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
    if (resolved.toLowerCase().endsWith(".cpe") && !isExcludedCodeplugFile(resolved)) yield resolved;
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
      } else if (item.isFile() && item.name.toLowerCase().endsWith(".cpe") && !isExcludedCodeplugFile(item.name)) {
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
          result.errors.push({ file, issi: indexed.issi || "", message: indexed.errorMessage, errorType: indexed.errorType });
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
        result.errors.push({ file, issi: meta.issi || "", message: error.message, errorType: error.name });
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

  result.rows = rowsForPathFleetMap(result.files, result.rows);
  result.matrix = buildWebFleetMatrix(result.rows, [], result.errors);
  result.mode = "path-fleet-map";
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
  const maxExpanded = 256 * 1024 * 1024;
  let expanded = 0;
  const requireRange = (offset, size, end = buffer.length) => {
    if (offset < 0 || size < 0 || offset + size > end) throw new Error("Excel invalido: ZIP truncado");
  };
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
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || entries === 65535) {
    throw new Error("Excel invalido: ZIP multidisco o ZIP64 no soportado");
  }
  for (let entry = 0; entry < entries; entry += 1) {
    requireRange(cursor, 46, eocd);
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
    requireRange(cursor, 46 + nameLength + extraLength + commentLength, eocd);
    requireRange(localOffset, 30, cursor);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50 || buffer.readUInt16LE(cursor + 8) & 1) {
      throw new Error("Excel invalido: cabecera ZIP corrupta o archivo cifrado");
    }
    if (expanded + uncompressedSize > maxExpanded) throw new Error("Excel demasiado grande al descomprimir (limite 256 MB)");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(dataOffset, compressedSize, cursor);
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, maxExpanded - expanded) });
      } catch (error) {
        throw new Error(`Excel invalido: datos ZIP corruptos o demasiado grandes (${error.message})`);
      }
    } else {
      throw new Error(`Excel invalido: metodo ZIP no soportado ${method}`);
    }
    if (data.length !== uncompressedSize || crc32(data) !== buffer.readUInt32LE(cursor + 16)) {
      throw new Error("Excel invalido: datos ZIP corruptos");
    }
    expanded += data.length;
    files.set(name.replace(/\\/g, "/"), data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unescapeXml(value) {
  return String(value ?? "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, code) => {
      const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
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
  const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1], unescapeXml(m[3])]));
  const relRegex = /<Relationship\b[^>]*>/g;
  let relMatch;
  while ((relMatch = relRegex.exec(rels))) {
    const attr = attributes(relMatch[0]);
    if (attr.Id && attr.Target && attr.TargetMode !== "External") relMap.set(attr.Id, attr.Target.replace(/^\/?xl\//, ""));
  }

  const sheets = [];
  const sheetRegex = /<sheet\b[^>]*>/g;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(workbook))) {
    const attr = attributes(sheetMatch[0]);
    const target = relMap.get(attr['r:id'] || attr.id);
    if (target) {
      sheets.push({ name: attr.name || '', path: path.posix.normalize(`xl/${target}`) });
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
  const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml))) {
    const row = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1]))) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || "";
      const ref = attrs.match(/\br=(["'])(.*?)\1/)?.[2] || "";
      const type = attrs.match(/\bt=(["'])(.*?)\1/)?.[2] || "";
      const idx = columnIndex(ref);
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= 16384) throw new Error("Excel invalido: columna fuera de rango");
      let value = "";
      if (type === "s") {
        const sharedIndex = Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || 0);
        value = sharedStrings[sharedIndex] || "";
      } else if (type === "inlineStr") {
        value = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join('');
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
  const orderedSheets = [...sheets].sort((a, b) => Number(normalizeHeader(b.name) === "nms") - Number(normalizeHeader(a.name) === "nms"));
  const hasIssiHeader = (row) => row.some((cell) => /^(issi(?:_|$)|tetraaddress_nms1$)/.test(normalizeHeader(cell)));
  const preferred = orderedSheets.find((sheet) => {
    const xml = files.get(sheet.path)?.toString("utf8");
    return xml && parseSheetRows(xml, sharedStrings).some(hasIssiHeader);
  });
  if (!preferred) {
    throw new Error("No encontre una hoja con columna ISSI en el Excel maestro");
  }

  const xml = files.get(preferred.path)?.toString("utf8");
  if (!xml) {
    throw new Error(`No se pudo leer la hoja ${preferred.name}`);
  }

  const rows = parseSheetRows(xml, sharedStrings);
  const headerIndex = rows.findIndex(hasIssiHeader);
  if (headerIndex < 0) {
    throw new Error("No encontre una columna ISSI en el Excel maestro");
  }

  const headers = rows[headerIndex].map(normalizeHeader);
  const indexOf = (...names) => {
    for (const name of names) {
      const normalized = normalizeHeader(name);
      const exact = headers.indexOf(normalized);
      if (exact >= 0) return exact;
    }
    for (const name of names) {
      const normalized = normalizeHeader(name);
      const partial = headers.findIndex((header) => header === normalized || header.includes(normalized));
      if (partial >= 0) return partial;
    }
    return -1;
  };

  const issiCol = indexOf("issi_SIG", "issi", "TetraAddress_NMS1");
  const records = [];
  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const rawIssi = String(row[issiCol] ?? "").trim();
    const issi = /^\d+\.0+$/.test(rawIssi) ? rawIssi.split('.')[0] : rawIssi;
    if (issi && !/^\d+$/.test(issi)) throw new Error(`ISSI invalido en fila ${r + 1}: ${rawIssi}`);
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

function parseProjectCpeWorkbook(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ""), "base64");
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("El archivo no es un Excel XLSX válido");
  }
  if (buffer.length > 15 * 1024 * 1024) {
    throw new Error("La plantilla supera el límite de 15 MB");
  }
  const files = readZip(buffer);
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const workbookSheets = parseWorkbookSheets(files);
  const sheetRows = new Map();
  for (const sheet of workbookSheets) {
    const xml = files.get(sheet.path)?.toString("utf8");
    if (xml) sheetRows.set(sheet.name, parseSheetRows(xml, sharedStrings));
  }
  return parseProjectCpeSheets(sheetRows);
}

function parseAgendaIssiWorkbook(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input || ""), "base64");
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("La plantilla de ISSI no es un archivo XLSX válido");
  }
  if (buffer.length > 5 * 1024 * 1024) throw new Error("La plantilla de ISSI supera el límite de 5 MB");
  const files = readZip(buffer);
  const sharedStrings = parseSharedStrings(files.get("xl/sharedStrings.xml")?.toString("utf8") || "");
  const sheets = parseWorkbookSheets(files);
  for (const sheet of sheets) {
    const xml = files.get(sheet.path)?.toString("utf8");
    if (!xml) continue;
    const rows = parseSheetRows(xml, sharedStrings);
    const headerRow = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === "issi"));
    if (headerRow < 0) continue;
    const issiColumn = rows[headerRow].findIndex((cell) => normalizeHeader(cell) === "issi");
    const issis = [];
    for (let index = headerRow + 1; index < rows.length; index += 1) {
      const raw = String(rows[index][issiColumn] ?? "").trim();
      const value = /^\d+\.0+$/.test(raw) ? raw.split(".")[0] : raw;
      if (!value) continue;
      if (!/^\d{1,8}$/.test(value) || Number(value) < 1 || Number(value) > 16777215) {
        throw new Error(`ISSI inválido en la fila ${index + 1}: ${raw}`);
      }
      issis.push(value);
    }
    const unique = [...new Set(issis)];
    if (!unique.length) throw new Error("La plantilla no contiene ISSI para consultar");
    if (unique.length > 300) throw new Error("La plantilla admite hasta 300 ISSI");
    return unique;
  }
  throw new Error("No se encontró una columna llamada ISSI en la plantilla");
}

function registerCpeProject(payload) {
  const responsible = String(payload?.responsible || "").trim();
  const sourceFileName = path.basename(String(payload?.fileName || "solicitud-cliente.xlsx"));
  const base64 = String(payload?.fileBase64 || "");
  if (!responsible) throw new Error("Indica el nombre del programador responsable");
  if (responsible.length > 120) throw new Error("El nombre del responsable es demasiado largo");
  if (!/\.xlsx$/i.test(sourceFileName)) throw new Error("Selecciona la plantilla Excel .xlsx del Proyecto CPE");
  if (!base64) throw new Error("Selecciona la plantilla completada por el cliente");

  const buffer = Buffer.from(base64, "base64");
  const validation = parseProjectCpeWorkbook(buffer);
  if (!validation.valid) return { registered: false, validation };
  const fileSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const existing = database.findCpeProjectByHash(fileSha256);
  if (existing) {
    return { registered: true, duplicate: true, project: existing, validation };
  }

  const code = database.nextCpeProjectCode(new Date());
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  const projectDirectory = path.resolve(PROJECTS_ROOT, code);
  const relativeDirectory = path.relative(path.resolve(PROJECTS_ROOT), projectDirectory);
  if (!relativeDirectory || relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory)) {
    throw new Error("No se pudo preparar la carpeta segura del proyecto");
  }
  fs.mkdirSync(projectDirectory, { recursive: false });
  const sourceFilePath = path.join(projectDirectory, "solicitud-cliente.xlsx");
  fs.writeFileSync(sourceFilePath, buffer, { flag: "wx" });

  const summary = validation.summary || {};
  let project;
  try {
    project = database.createCpeProject({
      code,
      responsible,
      sourceFileName,
      sourceFilePath,
      fileSha256,
      schemaVersion: validation.schemaVersion,
      razonSocial: summary.razonSocial,
      ruc: summary.ruc,
      contractRef: summary.contractRef,
      radioCount: summary.radios,
      groupCount: summary.groups,
      warnings: validation.warnings,
      request: validation.request,
    });
  } catch (error) {
    try {
      fs.unlinkSync(sourceFilePath);
      fs.rmdirSync(projectDirectory);
    } catch {
      // Si la limpieza falla, el archivo queda aislado y nunca se publica como proyecto registrado.
    }
    throw error;
  }
  logRuntimeEvent("cpe-project-received", {
    code,
    responsible,
    razonSocial: project.razonSocial,
    radios: project.radioCount,
    groups: project.groupCount,
    warnings: project.warningCount,
  });
  return { registered: true, duplicate: false, project, validation };
}

function validateCpeProjectModel(payload = {}) {
  const projectCode = String(payload.projectCode || "").trim().toUpperCase();
  const sourceFileName = path.basename(String(payload.fileName || "modelo.cpe"));
  const base64 = String(payload.fileBase64 || "");
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) throw new Error("Indica un código de Proyecto CPE válido");
  if (!/\.cpe$/i.test(sourceFileName)) throw new Error("Selecciona un archivo CPE modelo");
  if (!base64) throw new Error("Selecciona el CPE modelo que deseas validar");
  const project = database.getCpeProject(projectCode);
  if (!project) throw new Error(`No existe el proyecto ${projectCode}`);

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 16 || buffer.subarray(0, 7).toString("ascii") !== "CPDFile") {
    throw new Error("El archivo seleccionado no parece un CPE Motorola válido");
  }
  if (buffer.length > 15 * 1024 * 1024) throw new Error("El CPE modelo supera el límite de 15 MB");

  const safeFileName = sourceFileName.replace(/[^A-Za-z0-9._\-\[\]]+/g, "_").slice(-180);
  const temporaryRoot = path.resolve(runtimePaths.dir("temporales"));
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporaryFile = path.resolve(temporaryRoot, `modelo-${crypto.randomUUID()}-${safeFileName}`);
  const relativeTemporary = path.relative(temporaryRoot, temporaryFile);
  if (!relativeTemporary || relativeTemporary === ".." || relativeTemporary.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTemporary)) {
    throw new Error("No se pudo preparar el archivo temporal del modelo");
  }

  fs.writeFileSync(temporaryFile, buffer, { flag: "wx" });
  let approvedFilePath = "";
  try {
    const model = extractCodeplugFile(temporaryFile);
    const result = validateProjectCpeModel(project, model);
    const approved = result.status === "APROBADO";
    if (approved) {
      const projectDirectory = projectStorageDirectory(project);
      const modelsDirectory = path.resolve(projectDirectory, "modelos-aprobados");
      const relativeModelsDirectory = path.relative(projectDirectory, modelsDirectory);
      if (!relativeModelsDirectory || relativeModelsDirectory === ".." || relativeModelsDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeModelsDirectory)) {
        throw new Error("No se pudo preparar la carpeta segura de modelos");
      }
      fs.mkdirSync(modelsDirectory, { recursive: true });
      approvedFilePath = path.join(modelsDirectory, `${Date.now()}-${safeFileName}`);
      fs.copyFileSync(temporaryFile, approvedFilePath, fs.constants.COPYFILE_EXCL);
    }

    const modelSummary = {
      fileName: sourceFileName,
      codeplug: model.codeplug || "",
      software: model.software || "",
      groupCount: Number(model.groupCount || 0),
      emergencyMode: model.emergencyMode || "No disponible",
      emergencyGssi: Number(model.emergencyGssi || 0),
    };
    result.model = modelSummary;
    const fileSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const projectStatus = approved
      ? result.profileCount === 1 ? "MODELO_APROBADO" : "MODELO_APROBADO_PARCIAL"
      : "MODELO_NO_APROBADO";
    const updatedProject = database.updateCpeProjectModelValidation(projectCode, {
      projectStatus,
      fileName: sourceFileName,
      filePath: approvedFilePath,
      fileSha256,
      result,
    });
    logRuntimeEvent("cpe-project-model-validated", {
      code: projectCode,
      status: result.status,
      failedCount: result.failedCount,
      codeplug: modelSummary.codeplug,
      software: modelSummary.software,
    });
    return { result, project: updatedProject };
  } finally {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // La limpieza del temporal no cambia el resultado de la validación.
    }
  }
}

function projectStorageDirectory(project) {
  const projectsRoot = path.resolve(PROJECTS_ROOT);
  const candidate = project?.sourceFilePath
    ? path.resolve(path.dirname(project.sourceFilePath))
    : path.resolve(projectsRoot, String(project?.code || ""));
  const relative = path.relative(projectsRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("No se pudo resolver la carpeta segura del Proyecto CPE");
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

function validateCpeProjectRadio(payload = {}) {
  const projectCode = String(payload.projectCode || "").trim().toUpperCase();
  const programmer = String(payload.programmer || "").trim();
  const requestedSource = String(payload.source || (NODE_MODE === "field" ? "DASHBOARD_CAMPO" : "DASHBOARD")).trim().toUpperCase();
  const source = ["DASHBOARD", "DASHBOARD_CAMPO", "CARGADOR_TMO"].includes(requestedSource)
    ? requestedSource : "DASHBOARD";
  const sourceFileName = path.basename(String(payload.fileName || "radio.cpe"));
  const base64 = String(payload.fileBase64 || "");
  if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) throw new Error("Indica un código de Proyecto CPE válido");
  if (!programmer) throw new Error("Indica el nombre del programador responsable");
  if (!/\.cpe$/i.test(sourceFileName)) throw new Error("Selecciona un archivo CPE de una radio programada");
  if (!base64) throw new Error("Selecciona el CPE que deseas validar");
  const project = database.getCpeProject(projectCode);
  if (!project) throw new Error(`No existe el proyecto ${projectCode}`);
  if (project.modelValidation?.status !== "APROBADO") {
    throw new Error("Primero debes aprobar el CPE modelo en el paso 3");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 16 || buffer.subarray(0, 7).toString("ascii") !== "CPDFile") {
    throw new Error("El archivo seleccionado no parece un CPE Motorola válido");
  }
  if (buffer.length > 15 * 1024 * 1024) throw new Error("El CPE supera el límite de 15 MB");
  const fileSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const existing = database.findCpeProjectRadioValidationByHash(projectCode, fileSha256);
  if (existing?.status === "APROBADO") {
    return {
      validation: existing,
      summary: database.cpeProjectRadioValidationSummary(projectCode),
      project: database.getCpeProject(projectCode),
      duplicate: true,
    };
  }

  const safeFileName = sourceFileName.replace(/[^A-Za-z0-9._\-\[\]]+/g, "_").slice(-180);
  const temporaryRoot = path.resolve(runtimePaths.dir("temporales"));
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const temporaryFile = path.resolve(temporaryRoot, `radio-${crypto.randomUUID()}-${safeFileName}`);
  const relativeTemporary = path.relative(temporaryRoot, temporaryFile);
  if (!relativeTemporary || relativeTemporary === ".." || relativeTemporary.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTemporary)) {
    throw new Error("No se pudo preparar el archivo temporal de la radio");
  }

  fs.writeFileSync(temporaryFile, buffer, { flag: "wx" });
  let approvedFilePath = "";
  try {
    const radio = extractCodeplugFile(temporaryFile);
    const result = validateProjectCpeRadio(project, radio);
    const approved = result.status === "APROBADO";
    if (approved) {
      const projectDirectory = projectStorageDirectory(project);
      const approvedDirectory = path.resolve(projectDirectory, "radios-aprobadas");
      const relativeApprovedDirectory = path.relative(projectDirectory, approvedDirectory);
      if (!relativeApprovedDirectory || relativeApprovedDirectory === ".." || relativeApprovedDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeApprovedDirectory)) {
        throw new Error("No se pudo preparar la carpeta segura de radios aprobadas");
      }
      fs.mkdirSync(approvedDirectory, { recursive: true });
      const identity = result.expectedIssi || result.actual?.issi || "SIN-ISSI";
      approvedFilePath = path.join(approvedDirectory, `${identity}-${Date.now()}-${safeFileName}`);
      fs.copyFileSync(temporaryFile, approvedFilePath, fs.constants.COPYFILE_EXCL);
    }

    result.file = {
      fileName: sourceFileName,
      codeplug: radio.codeplug || "",
      software: radio.software || "",
      groupCount: Number(radio.groupCount || 0),
    };
    const validatedAt = new Date().toISOString();
    const stored = database.recordCpeProjectRadioValidation(projectCode, {
      expectedIssi: result.expectedIssi,
      actualIssi: result.actual?.issi,
      actualSerial: result.actual?.serial,
      actualTei: result.actual?.tei,
      fileName: sourceFileName,
      filePath: approvedFilePath,
      fileSha256,
      validatedAt,
      programmer,
      source,
      status: result.status,
      failedCount: result.failedCount,
      result,
    });
    logRuntimeEvent("cpe-project-radio-validated", {
      projectCode,
      programmer,
      source,
      expectedIssi: result.expectedIssi,
      actualIssi: result.actual?.issi || "",
      status: result.status,
      failedCount: result.failedCount,
    });
    if (NODE_MODE === "central" && stored.summary.allApproved && stored.project.publicationRoute) {
      stored.publication = database.queueCpeProjectPublication(projectCode);
      setImmediate(() => processPublicationQueue().catch(() => {}));
    }
    return stored;
  } finally {
    try { fs.unlinkSync(temporaryFile); } catch {}
  }
}

function compareCodeplugFreshness(a, b) {
  const dateDiff = (b.dateKey || 0) - (a.dateKey || 0);
  if (dateDiff !== 0) return dateDiff;
  const timeDiff = (b.modifiedTime || b.mtimeMs || 0) - (a.modifiedTime || a.mtimeMs || 0);
  if (timeDiff !== 0) return timeDiff;
  return Number(b.codeplug || 0) - Number(a.codeplug || 0);
}

function compareRadioAgendas(payload = {}) {
  const projectCode = String(payload.projectCode || "").trim();
  const project = projectCode ? database.getCpeProject(projectCode) : null;
  if (projectCode && !project) throw new Error(`No existe el proyecto ${projectCode}`);
  if (project && !["CLIENTE_CPE_V5", "CLIENTE_CPE_V6", "CLIENTE_CPE_V7"].includes(project.schemaVersion)) {
    throw new Error(`El proyecto ${project.code} usa ${project.schemaVersion || "una plantilla antigua"} y no contiene la agenda esperada. Regístralo nuevamente con la plantilla vigente.`);
  }

  const uploadedIssis = payload.fileBase64 ? parseAgendaIssiWorkbook(payload.fileBase64) : [];
  let issis = uploadedIssis.length
    ? uploadedIssis
    : Array.isArray(payload.issis) ? payload.issis : String(payload.issis || "").split(/[\s,;]+/);
  let expectedContacts = null;
  if (project) {
    const radios = Array.isArray(project.request?.radios) ? project.request.radios : [];
    issis = radios.map((radio) => radio.issi);
    expectedContacts = canonicalizeContacts(radios
      .filter((radio) => String(radio.contactName || "").trim())
      .map((radio) => ({ name: radio.contactName, issi: radio.issi })));
  }
  issis = [...new Set(issis.map((value) => String(value || "").trim()).filter((value) => /^\d{1,8}$/.test(value)))];
  if (!issis.length) throw new Error("Indica un código de Proyecto CPE o una lista de ISSI");
  if (issis.length > 300) throw new Error("La comparación admite hasta 300 radios por vez");

  const byIssi = new Map();
  for (const file of database.getFilesForIssis(issis)) {
    if (!byIssi.has(file.issi)) byIssi.set(file.issi, []);
    byIssi.get(file.issi).push(file);
  }
  const results = issis.map((issi) => {
    const file = (byIssi.get(issi) || []).sort(compareCodeplugFreshness)[0] || null;
    if (!file) return { issi, status: "NO ENCONTRADO", agenda: null, file: "", differences: null };
    const agenda = resolveFileAgenda(file);
    return {
      issi,
      status: agenda.supported ? "LEÍDO" : "NO VERIFICABLE",
      agenda,
      file: file.path,
      fileName: file.fileName,
      date: file.folderDate || "",
      differences: null,
    };
  });

  const mode = project ? "project" : issis.length === 1 ? "individual" : "group";
  let referenceSource = project ? "PROYECTO CPE" : mode === "individual" ? "CONSULTA INDIVIDUAL" : "AGENDA MÁS FRECUENTE";
  if (!project) {
    const frequencies = new Map();
    for (const result of results.filter((item) => item.agenda?.supported)) {
      frequencies.set(result.agenda.hash, (frequencies.get(result.agenda.hash) || 0) + 1);
    }
    const referenceHash = [...frequencies].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    expectedContacts = results.find((item) => item.agenda?.hash === referenceHash)?.agenda.contacts || [];
    if (!referenceHash) referenceSource = "SIN REFERENCIA";
  }

  for (const result of results) {
    if (!result.agenda?.supported) continue;
    if (mode === "individual") {
      result.status = "LEÍDO";
      continue;
    }
    result.differences = compareContactAgendas(expectedContacts || [], result.agenda.contacts);
    result.status = result.differences.approved ? "APROBADO" : "NO APROBADO";
  }
  const summary = results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});
  return {
    project: project ? { code: project.code, razonSocial: project.razonSocial, radioCount: project.radioCount } : null,
    mode,
    referenceSource,
    expectedContacts: expectedContacts || [],
    count: results.length,
    summary,
    results,
  };
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
  const validNonTacticalIssis = new Set();
  for (const [issi, matches] of byIssi.entries()) {
    const latestValid = [...matches].sort(compareCodeplugFreshness)[0];
    if (latestValid?.emergencyMode === "No táctico" && Number(latestValid.emergencyGssi || 0) > 0) {
      validNonTacticalIssis.add(issi);
    }
  }
  const errors = database.getErrorsForIssis([...wantedIssis])
    .filter((entry) => isPathInside(resolvedRoot, entry.file))
    // El CPS puede marcar visualmente un GSSI no táctico como inconsistente.
    // Si el CPE vigente sí entrega modo y GSSI, conservamos el dato binario y
    // evitamos que un CPE histórico fallido marque la ISSI actual como error.
    .filter((entry) => !validNonTacticalIssis.has(String(entry.issi || "")));
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

    // El Fleet Map debe seguir siendo inmediato. El indice central actualiza
    // versiones antiguas en segundo plano; una consulta individual si puede
    // refrescar su CPE en el momento.
    const latestFeatures = resolveFileFeatures(matches[0], { refreshStale: false });
    matches.forEach((codeplug, index) => {
      const features = index === 0 ? latestFeatures : storedFeatures(codeplug);
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
        emergencySupported: Boolean(codeplug.emergencySupported),
        emergencyAddressType: codeplug.emergencyAddressType || "",
        emergencyMode: codeplug.emergencyMode || "No disponible",
        emergencyAlias: codeplug.emergencyAlias || "",
        emergencyGssi: Number(codeplug.emergencyGssi || 0),
        emergencyAttachment: Boolean(codeplug.emergencyAttachment),
        emergencyConfidence: codeplug.emergencyConfidence || "",
        features,
        ...featureSummaries(features),
      });
    });

    const latest = database.hydrateFile(matches[0]);
    latest.features = latestFeatures;
    const latestRows = latest.rows.length ? latest.rows : [{
      file: latest.path,
      fileName: latest.fileName,
      serial: latest.serial,
      tei: latest.tei,
      issi: latest.issi,
      codeplug: latest.codeplug,
      software: latest.software,
      cpuId: latest.cpuId,
      folderRow: "",
      slot: 0,
      alias: "",
      gssi: 0,
      status: 0,
      statusText: "Sin grupos de conversación validados",
      assignmentConfidence: "",
      networkIndex: 0,
      defaultZone: 0,
      emergencySupported: latest.emergencySupported,
      emergencyAddressType: latest.emergencyAddressType,
      emergencyMode: latest.emergencyMode,
      emergencyAlias: latest.emergencyAlias,
      emergencyGssi: latest.emergencyGssi,
      emergencyAttachment: latest.emergencyAttachment,
      emergencyConfidence: latest.emergencyConfidence,
      features: latest.features || unavailableFeatures(),
      ...featureSummaries(latest.features),
    }];
    for (const group of latestRows) {
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

  const orderedRows = sortRowsByRadioAndGssi(rows);
  const matrix = buildWebFleetMatrix(orderedRows, missing, errors);
  return {
    mode: "fleet-map",
    masterSheet: master.sheetName,
    scannedPath: resolvedRoot,
    files: fileRows.map(databaseFileSummary),
    fileCount: indexedUnderRoot.length,
    rows: orderedRows,
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
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
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
  if (maxCols > 16384 || rows.length > 1048576) throw new Error('El resultado supera los limites de filas o columnas de Excel');
  const ref = `A1:${columnName(maxCols - 1)}${Math.max(rows.length, 1)}`;
  const xmlRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      const style = Number(options.styleForCell?.(rowIndex, colIndex, value) || 0);
      const styleAttribute = style > 0 ? ` s="${style}"` : "";
      if (typeof value === "number" && Number.isFinite(value)) {
        return `<c r="${ref}"${styleAttribute}><v>${value}</v></c>`;
      }
      return `<c r="${ref}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
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
    const gssi = Number(row.gssi || 0);
    const alias = String(row.alias || "").trim();
    if (gssi > 0 && alias) map.get(key).groups.push({ gssi, alias });
  }
  return [...map.values()].map((radio) => ({
    ...radio,
    groups: radio.groups
      .sort((left, right) => left.gssi - right.gssi || left.alias.localeCompare(right.alias, undefined, { numeric: true }))
      .map((group) => `${group.alias} (${group.gssi})`),
  }));
}

function sortRowsByRadioAndGssi(rows) {
  const radios = new Map();
  for (const row of rows) {
    const key = `${row.file || row.path || ""}|${row.issi || ""}|${row.serial || ""}|${row.fileName || ""}`;
    if (!radios.has(key)) radios.set(key, []);
    radios.get(key).push(row);
  }
  return [...radios.values()].flatMap((radioRows) => radioRows.sort((left, right) => {
    const leftGssi = Number(left.gssi || 0);
    const rightGssi = Number(right.gssi || 0);
    if (leftGssi <= 0 && rightGssi > 0) return 1;
    if (rightGssi <= 0 && leftGssi > 0) return -1;
    return leftGssi - rightGssi
      || String(left.alias || "").localeCompare(String(right.alias || ""), undefined, { numeric: true })
      || Number(left.folderRow || left.slot || 0) - Number(right.folderRow || right.slot || 0);
  }));
}

function buildFleetMatrix(rows, options = {}) {
  const includeSheetRows = options.includeSheetRows !== false;
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
  })).sort((left, right) => left.gssi - right.gssi || left.alias.localeCompare(right.alias, undefined, { numeric: true }));
  if (groups.length > 16374) {
    throw new Error(`La matriz supera el limite de Excel: ${groups.length} grupos unicos`);
  }

  const fixedHeaders = ["Razón social", "RUC", "Unidad", "Fecha programacion", "Archivo", "Serial", "TEI", "ISSI", "CP", "SW", "Modo emergencia", "Destino emergencia", "Escaneo", "DMO", "Broadcast", "GPS", "OTAP"];
  const matrixRows = includeSheetRows ? [
    ["Datos del radio", ...Array(fixedHeaders.length - 1).fill(""), ...groups.map((group) => group.gssi)],
    [...fixedHeaders, ...groups.map((group) => group.alias)],
    ...[...radioMap.values()].map((radio) => {
      const summaries = featureSummaries(radio.features);
      const flags = fleetFeatureFlags(radio.features);
      return [
      radio.razonSocial || radio.cliente || radio.organizacion || radio.label || "",
      radio.ruc || "",
      radio.unidad || "",
      radio.programDate || "",
      radio.fileName || "",
      radio.serial || "",
      radio.tei || "",
      radio.issi || "",
      radio.codeplug || "",
      radio.software || "",
      radio.emergencyMode || "No disponible",
      emergencyGroupLabel(radio),
      flags.scanFlag,
      flags.dmoFlag,
      summaries.broadcastSummary,
      summaries.gpsSummary,
      flags.otapFlag,
      ...groups.map((group) => radio.groupGssis.has(group.key) ? "X" : ""),
      ];
    }),
  ] : [];

  const dictionaryRows = includeSheetRows ? [
    ["GSSI", "Alias", "Cantidad de radios que lo tienen", "Lista de unidades donde aparece", "Lista de ISSI o seriales"],
    ...groups.map((group) => [
      group.gssi,
      group.alias,
      group.radios.size,
      [...group.units].sort((left, right) => left.localeCompare(right)).join(", "),
      [...group.identities].sort((left, right) => left.localeCompare(right, undefined, { numeric: true })).join(", "),
    ]),
  ] : [];

  return { groups, radios: [...radioMap.values()], matrixRows, dictionaryRows, fixedColumnCount: fixedHeaders.length };
}

function emergencyGroupLabel(radio) {
  // emergencyGssi is the existing persisted SSI field: private destinations
  // are ISSIs, not talkgroups. Never show an old group alias for a private call.
  if (radio.emergencyAddressType === "Llamada privada") return `ISSI ${Number(radio.emergencyGssi || 0)}`;
  if (radio.emergencyMode === "Táctico") return "Grupo actual";
  const alias = String(radio.emergencyAlias || "").trim();
  const gssi = Number(radio.emergencyGssi || 0);
  if (alias && gssi > 0) return `${alias} (${gssi})`;
  return alias || (gssi > 0 ? String(gssi) : "");
}

function buildWebFleetMatrix(rows, missing, errors) {
  // La web solo necesita radios y grupos. Crear todas las celdas de Excel para
  // el producto radios x grupos consumia CPU aunque esas celdas se descartaban.
  const matrix = buildFleetMatrix(rows, { includeSheetRows: false });
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
    emergencySupported: Boolean(radio.emergencySupported),
    emergencyAddressType: radio.emergencyAddressType || "",
    emergencyMode: radio.emergencyMode || "No disponible",
    emergencyAlias: radio.emergencyAlias || "",
    emergencyGssi: Number(radio.emergencyGssi || 0),
    emergencyGroup: emergencyGroupLabel(radio),
    emergencyAttachment: Boolean(radio.emergencyAttachment),
    emergencyConfidence: radio.emergencyConfidence || "",
    features: radio.features || unavailableFeatures(),
    ...featureSummaries(radio.features),
    scanSummary: activeFeatureFlag(radio.features?.scan),
    dmoSummary: activeFeatureFlag(radio.features?.dmo),
    observacion: "",
    hasCodeplug: true,
    hasError: errorIssis.has(String(radio.issi || "")),
    groupGssis: [...radio.groupGssis].sort((left, right) => Number(left) - Number(right)),
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
      emergencySupported: false,
      emergencyAddressType: "",
      emergencyMode: "Sin codeplug",
      emergencyAlias: "",
      emergencyGssi: 0,
      emergencyGroup: "",
      emergencyAttachment: false,
      emergencyConfidence: "",
      features: unavailableFeatures(),
      ...featureSummaries(unavailableFeatures()),
      scanSummary: "",
      dmoSummary: "",
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

function stripRepeatedFeatures(item) {
  if (!item || typeof item !== "object") return item;
  const { features, ...rest } = item;
  return rest;
}

function buildFleetWebPayload(fleet) {
  const rows = Array.isArray(fleet?.rows) ? fleet.rows : [];
  return {
    ...fleet,
    totalRows: rows.length,
    // La tabla tecnica muestra hasta 500 filas. El XLSX se genera nuevamente
    // desde el maestro y conserva el conjunto completo sin este recorte web.
    rows: rows.slice(0, WEB_TECHNICAL_ROW_LIMIT).map(stripRepeatedFeatures),
    history: (fleet.history || []).map(stripRepeatedFeatures),
    files: (fleet.files || []).map(stripRepeatedFeatures),
  };
}

function searchRadio(filters) {
  const legacyTerm = typeof filters === "string" ? String(filters).trim() : "";
  const criteria = legacyTerm
    ? null
    : {
        issi: String(filters?.issi ?? "").trim(),
        serial: String(filters?.serial ?? "").trim(),
        tei: String(filters?.tei ?? "").trim(),
      };
  const activeCriteria = criteria
    ? Object.entries(criteria).filter(([, value]) => value)
    : [];
  const label = legacyTerm || activeCriteria.map(([field, value]) => `${field.toUpperCase()}: ${value}`).join(" · ");
  if ((legacyTerm && legacyTerm.length < 3) || (!legacyTerm && (!activeCriteria.length || activeCriteria.some(([, value]) => value.length < 3)))) {
    return { term: label, criteria: criteria || {}, results: [], count: 0 };
  }

  const foundFiles = legacyTerm
    ? database.searchRadios(legacyTerm, 25)
    : database.searchRadiosByFields(criteria, 25);
  const matches = foundFiles.map((file) => {
    const hydrated = database.hydrateFile(file);
    const features = resolveFileFeatures(file);
    const agenda = resolveFileAgenda(file);
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
    groups.sort((left, right) => left.gssi - right.gssi || left.alias.localeCompare(right.alias, undefined, { numeric: true }));

    const matchTypes = [];
    const valuesToCheck = legacyTerm
      ? [["serial", legacyTerm], ["tei", legacyTerm], ["issi", legacyTerm]]
      : activeCriteria;
    for (const [field, searchedValue] of valuesToCheck) {
      const actualValue = String(file[field] || "").toLowerCase();
      const normalized = String(searchedValue).toLowerCase();
      const compact = normalized.replace(/[\s\-_./\\]+/g, "");
      const compactValue = actualValue.replace(/[\s\-_./\\]+/g, "");
      if (actualValue === normalized || compactValue === compact || actualValue.includes(normalized) || compactValue.includes(compact)) {
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
      emergencySupported: Boolean(file.emergencySupported),
      emergencyAddressType: file.emergencyAddressType || "",
      emergencyMode: file.emergencyMode || "No disponible",
      emergencyAlias: file.emergencyAlias || "",
      emergencyGssi: Number(file.emergencyGssi || 0),
      emergencyGroup: emergencyGroupLabel(file),
      emergencyAttachment: Boolean(file.emergencyAttachment),
      emergencyConfidence: file.emergencyConfidence || "",
      features,
      agenda,
      ...featureSummaries(features),
      errorType: file.errorType || "",
      errorMessage: file.errorMessage || "",
      hasGroups: groups.length > 0,
      groups,
      matchTypes,
    };
  });

  return {
    term: label,
    criteria: criteria || {},
    count: matches.length,
    results: matches,
    database: database.status(CENTRAL_ROOT),
  };
}

function buildWorkbook(payload) {
  const safeRows = Array.isArray(payload) ? payload : (Array.isArray(payload?.rows) ? payload.rows : []);
  const orderedRows = sortRowsByRadioAndGssi(safeRows);
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const missing = Array.isArray(payload?.missing) ? payload.missing : [];
  const scanErrors = Array.isArray(payload?.errors) ? payload.errors : [];
  const matrix = buildFleetMatrix(safeRows);
  const radios = groupRowsByRadio(orderedRows);
  const fleetRows = [
    ["RUC", "Tipo cliente", "Razon social", "Unidad", "Label", "Serial", "TEI", "ISSI", "CP", "SW", "Modo emergencia", "Alias emergencia", "ISSI/GSSI emergencia", "Adjunto emergencia", "Fecha", "Programador", "Archivo", "Ruta", "Fila", "Grupo", "GSSI", "Estado"],
    ...orderedRows.map((row) => [
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
      row.emergencyMode,
      row.emergencyAlias,
      Number(row.emergencyGssi || 0),
      row.emergencyAttachment ? "Si" : "No",
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
    ["RUC", "Tipo cliente", "Razon social", "Unidad", "Serial", "TEI", "ISSI", "CP", "SW", "Modo emergencia", "Destino emergencia", "Escaneo", "DMO", "Broadcast", "GPS", "OTAP", "Fecha", "Archivo", "Cantidad grupos", "Grupos"],
    ...radios.map((row) => {
      const summaries = featureSummaries(row.features);
      const flags = fleetFeatureFlags(row.features);
      return [
      row.ruc,
      row.tipoCliente,
      row.razonSocial,
      row.unidad,
      row.serial,
      row.tei,
      row.issi,
      row.codeplug,
      row.software,
      row.emergencyMode,
      emergencyGroupLabel(row),
      flags.scanFlag,
      flags.dmoFlag,
      summaries.broadcastSummary,
      summaries.gpsSummary,
      flags.otapFlag,
      row.programDate,
      row.fileName,
      row.groups.length,
      row.groups.join(", "),
      ];
    }),
  ];

  const scanRows = [["ISSI", "Serial", "Estado", "Lista activa", "Lista", "Grupo", "GSSI", "Prioridad", "Fuente"]];
  const dmoRows = [["ISSI", "Serial", "Estado", "Carpeta DMO", "Grupo DMO", "GSSI", "Frecuencia", "Fuente"]];
  const broadcastRows = [[
    "ISSI", "Serial", "Resultado", "Grupo", "GSSI", "Indicador llamada de anuncio",
    "Destino configurado", "Grupo invisible", "Rastreo continuo", "Prioridad anuncio",
    "Prioridad = 10", "Alias de anuncio", "Fuente", "Observaciones",
  ]];
  const gpsRows = [["ISSI", "Serial", "Estado", "Gateway ISSI", "Portador", "Protocolo", "Fuente"]];
  const otapRows = [["ISSI", "Serial", "Estado", "MCC", "MNC", "ISSI autorizado", "Fuente"]];
  for (const radio of radios) {
    const features = radio.features || unavailableFeatures();
    const scanLists = features.scan?.state === "Activo" ? (features.scan?.lists || []) : [];
    const scanItems = scanLists.flatMap((list) => (list.groups || []).map((group) => ({ list: list.name || "", ...group })));
    if (scanItems.length) {
      for (const item of scanItems) scanRows.push([radio.issi, radio.serial, features.scan.state, features.scan.activeList || "", item.list, item.alias, item.gssi, item.priority, features.source || ""]);
    } else scanRows.push([radio.issi, radio.serial, indicatorState(features.scan), "", "", "", 0, "", features.source || ""]);

    const dmoState = indicatorState(features.dmo);
    const dmoGroups = dmoState === "Activo" ? (features.dmo?.groups || []) : [];
    if (dmoGroups.length) {
      for (const group of dmoGroups) dmoRows.push([radio.issi, radio.serial, dmoState, group.folder || "", group.alias, group.gssi, group.frequency || "", features.source || ""]);
    } else dmoRows.push([radio.issi, radio.serial, dmoState, "", "", 0, "", features.source || ""]);

    const broadcast = broadcastAudit(features.broadcast);
    const checkLabel = (value) => value == null ? "No verificado" : (value ? "Si" : "No");
    broadcastRows.push([
      radio.issi,
      radio.serial,
      broadcast.result,
      broadcast.alias,
      broadcast.gssi,
      checkLabel(broadcast.indicatorActive),
      checkLabel(broadcast.destinationConfigured),
      checkLabel(broadcast.groupInvisible),
      checkLabel(broadcast.continuousTracking),
      broadcast.announcementPriority == null ? "No verificado" : broadcast.announcementPriority,
      checkLabel(broadcast.announcementPriority == null ? null : broadcast.priorityTen),
      broadcast.announcementAlias,
      features.source || "",
      broadcast.issues.join("; "),
    ]);
    const gpsState = indicatorState(features.gps);
    const gpsActive = gpsState === "Activo";
    gpsRows.push([
      radio.issi,
      radio.serial,
      gpsState,
      gpsActive ? Number(features.gps?.destinationIssi || 0) : 0,
      gpsActive ? (features.gps?.carrier || "") : "",
      gpsActive ? (features.gps?.protocol || "") : "",
      features.source || "",
    ]);

    const targets = features.otap?.state === "Activo" ? (features.otap?.targets || []) : [];
    if (targets.length) {
      for (const target of targets) otapRows.push([radio.issi, radio.serial, features.otap.state, target.mcc, target.mnc, target.issi, features.source || ""]);
    } else otapRows.push([radio.issi, radio.serial, features.otap?.state || "No disponible", 0, 0, 0, features.source || ""]);
  }

  const historyRows = [
    ["ISSI", "Estado", "RUC", "Tipo cliente", "Razon social", "Unidad", "Serial", "TEI", "CP", "SW", "Modo emergencia", "Destino emergencia", "Fecha", "Programador", "Archivo", "Ruta", "Cantidad grupos"],
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
      row.emergencyMode,
      emergencyGroupLabel(row),
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
    ["Radios", radios.length],
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

  const fixedColumnCount = matrix.fixedColumnCount || 17;
  const matrixLastColumn = columnName(Math.max(matrix.matrixRows[0].length, fixedColumnCount) - 1);
  const matrixColumns = [18, 14, 18, 17, 34, 16, 20, 12, 10, 18, 16, 26, 18, 18, 18, 20, 18]
    .map((width, index) => ({ min: index + 1, max: index + 1, width }));
  if (matrix.groups.length > 0) {
    matrixColumns.push({ min: fixedColumnCount + 1, max: fixedColumnCount + matrix.groups.length, width: 11 });
  }
  const matrixOptions = {
    freeze: { columns: 12, rows: 2, topLeftCell: "M3" },
    autoFilter: `A2:${matrixLastColumn}${Math.max(matrix.matrixRows.length, 2)}`,
    merges: [`A1:${columnName(fixedColumnCount - 1)}1`],
    columns: matrixColumns,
    rowHeights: { 0: 24, 1: 42 },
    styleForCell: (rowIndex, colIndex, value) => {
      if (rowIndex === 0) return 1;
      if (rowIndex === 1) return colIndex < fixedColumnCount ? 3 : 2;
      return colIndex >= fixedColumnCount && value === "X" ? 4 : 0;
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
    <sheet name="Escaneo" sheetId="9" r:id="rId9"/>
    <sheet name="DMO" sheetId="10" r:id="rId10"/>
    <sheet name="Broadcast" sheetId="11" r:id="rId11"/>
    <sheet name="GPS" sheetId="12" r:id="rId12"/>
    <sheet name="OTAP" sheetId="13" r:id="rId13"/>
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
  <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet9.xml"/>
  <Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet10.xml"/>
  <Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet11.xml"/>
  <Relationship Id="rId12" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet12.xml"/>
  <Relationship Id="rId13" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet13.xml"/>
  <Relationship Id="rId14" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
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
  <Override PartName="/xl/worksheets/sheet9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet10.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet11.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet12.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet13.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
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
    { name: "xl/worksheets/sheet9.xml", data: sheetXml(scanRows) },
    { name: "xl/worksheets/sheet10.xml", data: sheetXml(dmoRows) },
    { name: "xl/worksheets/sheet11.xml", data: sheetXml(broadcastRows) },
    { name: "xl/worksheets/sheet12.xml", data: sheetXml(gpsRows) },
    { name: "xl/worksheets/sheet13.xml", data: sheetXml(otapRows) },
  ]);
}

function buildSingleSheetWorkbook(rows, sheetName) {
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
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

function buildTemplateWorkbook() {
  return buildSingleSheetWorkbook([
    ["cliente", "ruc", "tipo_cliente", "razon_social", "unidad", "issi", "observacion"],
    ["CELEPSA", "20512481125", "PRIVADO", "COMPANIA ELECTRICA EL PLATANAL S.A.", "F456", "34679", ""],
    ["CELEPSA", "20171827656", "CONTRATISTA", "CONDORCOCHA SOCIEDAD ANONIMA CERRADA", "Contratista", "34677", ""],
  ], "NMS");
}

function buildAgendaIssiTemplate() {
  return buildSingleSheetWorkbook([["ISSI", "OBSERVACIÓN (OPCIONAL)"]], "ISSI A REVISAR");
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
  const relative = path.relative(PUBLIC_DIR, fullPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
let dailyRetryTimer = null;

function scheduleCentralRetry(reason, delayMs = 5 * 60 * 1000) {
  if (dailyRetryTimer) clearTimeout(dailyRetryTimer);
  const delay = Math.max(1000, Number(delayMs) || 0);
  const next = new Date(Date.now() + delay);
  console.error(`Fallo el indice central (${reason}); reintento programado para ${next.toLocaleString()}`);
  dailyRetryTimer = setTimeout(() => {
    dailyRetryTimer = null;
    try {
      runCentralIndexInBackground("retry");
    } catch (error) {
      console.error(`No se pudo reiniciar el indice central: ${error.message}`);
      scheduleCentralRetry("retry-failed", delay * 2);
    }
  }, delay);
}

function runCentralIndexInBackground(trigger = "scheduled") {
  if (scheduledWorker && scheduledWorker.exitCode == null) {
    if (trigger !== "manual") scheduledScanPending = true;
    console.log(`Indice central ya esta en curso${trigger === "manual" ? "" : `; se deja pendiente la ejecucion ${trigger}`}`);
    return false;
  }

  console.log(`Iniciando indice central (${trigger}): ${CENTRAL_ROOT}`);
  try {
    scheduledWorker = fork(path.join(__dirname, "scripts", "update-central-index.js"), [], {
      env: { ...process.env, CPE_CENTRAL_ROOT: CENTRAL_ROOT, CPE_DB_FILE: DATABASE_FILE },
      stdio: "inherit",
    });
  } catch (error) {
    scheduledWorker = null;
    console.error(`No se pudo iniciar el indice central (${trigger}): ${error.message}`);
    if (trigger !== "manual") scheduleCentralRetry(trigger);
    return false;
  }
  scheduledWorker.once("error", (error) => {
    console.error(`Error del proceso de indice central: ${error.message}`);
  });
  scheduledWorker.once("close", (code) => {
    console.log(`Indice central finalizado con codigo ${code}`);
    scheduledWorker = null;
    if (scheduledScanPending) {
      scheduledScanPending = false;
      runCentralIndexInBackground("pending");
      return;
    }
    if (code !== 0 && trigger !== "manual") {
      scheduleCentralRetry(`exit-${code}`);
    }
  });
  return true;
}

function scheduleNextCentralScan() {
  const delay = millisecondsUntilNextMidnight();
  const next = new Date(Date.now() + delay);
  console.log(`Proximo indice central: ${next.toLocaleString()} (${CENTRAL_ROOT})`);
  dailyTimer = setTimeout(() => {
    try {
      runCentralIndexInBackground("midnight");
    } catch (error) {
      console.error(`Error inesperado al iniciar el indice de medianoche: ${error.message}`);
      scheduleCentralRetry("midnight-crash");
    } finally {
      scheduleNextCentralScan();
    }
  }, delay);
}

function startDailyCentralScheduler() {
  const latest = database.status(CENTRAL_ROOT).latestScan;
  const activeScan = scheduledWorker && scheduledWorker.exitCode == null;
  if (!activeScan && (!latest?.finishedAt || localDateKey(latest.finishedAt) !== localDateKey(new Date()))) {
    runCentralIndexInBackground("startup-catchup");
  }
  scheduleNextCentralScan();
}

async function buildHealthPanel(forceNasProbe = false) {
  const status = database.status(CENTRAL_ROOT);
  const codeplugs = database.healthSummary();
  const nas = await probeCentralRoot(forceNasProbe);
  const indexRunning = Boolean(scheduledWorker && scheduledWorker.exitCode == null);
  const latestScan = status.latestScan;
  const nextScanAt = new Date(Date.now() + millisecondsUntilNextMidnight()).toISOString();
  let tone = "ok";
  let overallStatus = "Operativo";
  let overallDetail = "Servicio, TIC NAS e indice disponibles";

  if (!nas.ok) {
    tone = "error";
    overallStatus = "Atencion requerida";
    overallDetail = "El dashboard responde, pero el TIC NAS no esta disponible";
  } else if (Number(codeplugs.corruptFiles) > 0 || Number(codeplugs.unsupportedFiles) > 0) {
    tone = "warning";
    overallStatus = "Operativo con observaciones";
    overallDetail = `${Number(codeplugs.corruptFiles)} CPE corruptos y ${Number(codeplugs.unsupportedFiles)} pendientes de soporte`;
  } else if (indexRunning) {
    tone = "running";
    overallStatus = "Actualizando indice";
    overallDetail = "El dashboard permanece disponible durante el escaneo";
  }

  return {
    generatedAt: new Date().toISOString(),
    overall: { tone, status: overallStatus, detail: overallDetail },
    service: {
      ok: true,
      status: "Operativo",
      startedAt: new Date(SERVER_STARTED_AT_MS).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT_MS) / 1000),
    },
    nas: { ...nas, rootPath: CENTRAL_ROOT },
    codeplugs,
    index: {
      running: indexRunning,
      pending: scheduledScanPending,
      workerPid: indexRunning ? scheduledWorker.pid : null,
      nextScanAt,
      latestScan,
    },
    exports: { ...exportActivity },
  };
}

async function processPublicationQueue() {
  if (NODE_MODE !== "central" || publicationWorkerRunning) return false;
  publicationWorkerRunning = true;
  try {
    const job = database.claimNextCpeProjectPublication();
    if (!job) return false;
    const destinationStatus = projectPublisher.status();
    if (destinationStatus.googleDrive.enabled && !destinationStatus.googleDrive.configured) {
      database.deferCpeProjectPublication(
        job.projectCode,
        destinationStatus.googleDrive.error || "Google Drive pendiente de acceso",
        Date.now() + 10 * 60_000,
      );
      return true;
    }
    try {
      const details = await projectPublisher.publish(job.projectCode, async (progress) => {
        database.updateCpeProjectPublicationProgress(job.projectCode, progress);
      });
      database.completeCpeProjectPublication(job.projectCode, details);
      logRuntimeEvent("cpe-project-published", {
        projectCode: job.projectCode,
        deliveryId: details.deliveryId,
        nasPath: details.nas?.path || "",
        driveFolderId: details.drive?.folderId || "",
      });
    } catch (error) {
      const retryMinutes = Math.min(60, Math.max(2, 2 ** Math.min(job.attempts, 5)));
      database.failCpeProjectPublication(job.projectCode, error.message, Date.now() + retryMinutes * 60_000);
      logRuntimeEvent("cpe-project-publication-pending", {
        projectCode: job.projectCode,
        attempt: job.attempts,
        retryMinutes,
        error: error.message,
      });
    }
    return true;
  } finally {
    publicationWorkerRunning = false;
  }
}

function queueReadyCpeProjects() {
  if (NODE_MODE !== "central") return 0;
  let queued = 0;
  for (const project of database.listCpeProjects(200)) {
    if (database.getCpeProjectPublication(project.code)) continue;
    if (!project.publicationRoute) continue;
    const summary = database.cpeProjectRadioValidationSummary(project.code);
    if (!summary.allApproved) continue;
    database.queueCpeProjectPublication(project.code);
    queued += 1;
  }
  return queued;
}

function fieldSyncMetaKey(projectCode, fileSha256) {
  return `field-sync:${projectCode}:${fileSha256}`;
}

function fieldPendingValidations() {
  if (NODE_MODE !== "field") return [];
  const pending = [];
  for (const project of database.listCpeProjects(200)) {
    const summary = database.cpeProjectRadioValidationSummary(project.code);
    for (const validation of summary.validations) {
      if (validation.status !== "APROBADO" || !validation.filePath || !fs.existsSync(validation.filePath)) continue;
      if (database.getMeta(fieldSyncMetaKey(project.code, validation.fileSha256))) continue;
      pending.push({ project, validation });
    }
  }
  return pending;
}

async function syncFieldQueue() {
  if (NODE_MODE !== "field" || fieldSyncRunning) return false;
  const centralUrl = projectPublisher.config.field.centralUrl;
  if (!centralUrl) return false;
  fieldSyncRunning = true;
  const state = { at: new Date().toISOString(), centralUrl, uploaded: 0, pending: 0, error: "" };
  try {
    const pending = fieldPendingValidations();
    state.pending = pending.length;
    for (const item of pending) {
      const fileBuffer = fs.readFileSync(item.validation.filePath);
      const response = await fetch(`${centralUrl}/api/cpe-projects/radio-validation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectCode: item.project.code,
          programmer: item.validation.programmer,
          source: "DASHBOARD_CAMPO",
          fileName: item.validation.fileName,
          fileBase64: fileBuffer.toString("base64"),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.validation?.status !== "APROBADO") {
        throw new Error(payload.error || `La VM rechazo ${item.validation.fileName}`);
      }
      database.setMeta(fieldSyncMetaKey(item.project.code, item.validation.fileSha256), new Date().toISOString());
      state.uploaded += 1;
    }
    state.pending = fieldPendingValidations().length;
  } catch (error) {
    state.error = error.message;
    state.pending = fieldPendingValidations().length;
  } finally {
    lastFieldSync = state;
    fieldSyncRunning = false;
  }
  return !state.error;
}

async function prepareFieldProject(projectCode) {
  if (NODE_MODE !== "field") throw new Error("Esta operacion solo esta disponible en el Dashboard de campo");
  const code = String(projectCode || "").trim().toUpperCase();
  if (!/^CPE-\d{8}-\d{3}$/.test(code)) throw new Error("Indica un codigo de Proyecto CPE valido");
  const centralUrl = projectPublisher.config.field.centralUrl;
  if (!centralUrl) throw new Error("Falta configurar la URL del dashboard central");
  const response = await fetch(`${centralUrl}/api/cpe-projects/offline-bundle?projectCode=${encodeURIComponent(code)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "No se pudo descargar el proyecto desde la VM");
  const project = database.importCpeProjectBundle(payload);
  logRuntimeEvent("cpe-field-project-prepared", { projectCode: code, centralUrl });
  return { project, prepared: true };
}

const server = http.createServer((request, response) => {
  try {
  const requestUrl = new URL(request.url, `http://${HOST}:${PORT}`);
  if (request.method === "GET" && requestUrl.pathname === "/api/runtime") {
    const publication = projectPublisher.status();
    sendJson(response, 200, {
      mode: NODE_MODE,
      centralUrl: projectPublisher.config.field.centralUrl,
      publication,
      fieldSync: NODE_MODE === "field" ? {
        running: fieldSyncRunning,
        pending: fieldPendingValidations().length,
        last: lastFieldSync,
      } : null,
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cpe-projects/offline-bundle") {
    if (NODE_MODE !== "central") {
      sendJson(response, 400, { error: "El paquete offline solo se obtiene desde el dashboard central" });
      return;
    }
    const projectCode = String(requestUrl.searchParams.get("projectCode") || "").trim().toUpperCase();
    try {
      const project = database.getCpeProject(projectCode);
      if (!project) throw new Error(`No existe el proyecto ${projectCode}`);
      if (project.modelValidation?.status !== "APROBADO") throw new Error("Primero debes aprobar el CPE modelo");
      const { sourceFilePath: _source, modelFilePath: _model, ...portableProject } = project;
      sendJson(response, 200, { schema: "PROYECTO_CPE_CAMPO_V1", exportedAt: new Date().toISOString(), project: portableProject });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cpe-projects/publication") {
    const projectCode = String(requestUrl.searchParams.get("projectCode") || "").trim().toUpperCase();
    try {
      const project = database.getCpeProject(projectCode);
      if (!project) throw new Error(`No existe el proyecto ${projectCode}`);
      sendJson(response, 200, {
        projectCode,
        project: {
          razonSocial: project.razonSocial,
          responsible: project.responsible,
          publicationRoute: project.publicationRoute,
        },
        publication: database.getCpeProjectPublication(projectCode),
        destinations: projectPublisher.status(),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cpe-projects/publication-route") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 100_000) request.destroy(); });
    request.on("end", () => {
      try {
        if (NODE_MODE !== "central") throw new Error("La ruta final se registra solamente en la VM central");
        const payload = JSON.parse(body || "{}");
        const projectCode = String(payload.projectCode || "").trim().toUpperCase();
        if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) throw new Error("Indica un codigo de Proyecto CPE valido");
        const route = normalizePublicationRoute(payload.route || {});
        const project = database.updateCpeProjectPublicationRoute(projectCode, route);
        const summary = database.cpeProjectRadioValidationSummary(projectCode);
        let publication = database.getCpeProjectPublication(projectCode);
        if (summary.allApproved) {
          publication = database.queueCpeProjectPublication(projectCode);
          setImmediate(() => processPublicationQueue().catch(() => {}));
        }
        sendJson(response, 200, { project, route, publication, queued: summary.allApproved });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/field/prepare-project") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 100_000) request.destroy(); });
    request.on("end", () => {
      prepareFieldProject(JSON.parse(body || "{}").projectCode)
        .then((payload) => sendJson(response, 200, payload))
        .catch((error) => sendJson(response, 400, { error: error.message }));
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/field/sync") {
    syncFieldQueue()
      .then(() => sendJson(response, 200, {
        running: fieldSyncRunning,
        pending: fieldPendingValidations().length,
        last: lastFieldSync,
      }))
      .catch((error) => sendJson(response, 400, { error: error.message }));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cpe-projects/publication/retry") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 100_000) request.destroy(); });
    request.on("end", () => {
      try {
        if (NODE_MODE !== "central") throw new Error("La publicacion se realiza solamente desde la VM central");
        const projectCode = String(JSON.parse(body || "{}").projectCode || "").trim().toUpperCase();
        const publication = database.queueCpeProjectPublication(projectCode);
        setImmediate(() => processPublicationQueue().catch(() => {}));
        sendJson(response, 202, { publication });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cpe-projects") {
    sendJson(response, 200, { projects: database.listCpeProjects(50) });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cpe-projects/radio-validations") {
    const projectCode = String(requestUrl.searchParams.get("projectCode") || "").trim().toUpperCase();
    if (!/^CPE-\d{8}-\d{3}$/.test(projectCode)) {
      sendJson(response, 400, { error: "Indica un código de Proyecto CPE válido" });
      return;
    }
    try {
      const project = database.getCpeProject(projectCode);
      if (!project) throw new Error(`No existe el proyecto ${projectCode}`);
      const { request: _request, modelValidation: _modelValidation, ...projectSummary } = project;
      sendJson(response, 200, {
        project: projectSummary,
        summary: database.cpeProjectRadioValidationSummary(projectCode),
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/cpe-projects/template") {
    let capacity;
    try {
      capacity = projectTemplateCapacity(requestUrl.searchParams);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    projectTemplateFile(capacity.groups, capacity.dmoGroups)
      .then((templatePath) => {
        const workbook = fs.readFileSync(templatePath);
        const filename = `Plantilla_Solicitud_CPE_TMO${capacity.groups}_DMO${capacity.dmoGroups}.xlsx`;
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename=\"${filename}\"`,
          "Content-Length": workbook.length,
        });
        response.end(workbook);
      })
      .catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: error.message });
        else response.destroy();
      });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/agendas/compare") {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 8 * 1024 * 1024) tooLarge = true;
    });
    request.on("end", () => {
      try {
        if (tooLarge) {
          sendJson(response, 413, { error: "La plantilla supera el límite permitido" });
          return;
        }
        sendJson(response, 200, compareRadioAgendas(JSON.parse(body || "{}")));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cpe-projects/import") {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 22 * 1024 * 1024) tooLarge = true;
    });
    request.on("end", () => {
      try {
        if (tooLarge) {
          sendJson(response, 413, { error: "La solicitud supera el límite permitido" });
          return;
        }
        const result = registerCpeProject(JSON.parse(body || "{}"));
        sendJson(response, result.registered ? 201 : 422, result);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cpe-projects/model-validation") {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 22 * 1024 * 1024) tooLarge = true;
    });
    request.on("end", () => {
      try {
        if (tooLarge) {
          sendJson(response, 413, { error: "El CPE modelo supera el límite permitido" });
          return;
        }
        sendJson(response, 200, validateCpeProjectModel(JSON.parse(body || "{}")));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/cpe-projects/radio-validation") {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 22 * 1024 * 1024) tooLarge = true;
    });
    request.on("end", () => {
      try {
        if (tooLarge) {
          sendJson(response, 413, { error: "El CPE supera el límite permitido" });
          return;
        }
        sendJson(response, 200, validateCpeProjectRadio(JSON.parse(body || "{}")));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }

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
    const startedAt = Date.now();
    let body = "";
    let requestBytes = 0;
    let bodyTooLarge = false;
    request.on("data", (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes > 80 * 1024 * 1024) {
        bodyTooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (bodyTooLarge) {
        recordExportResult("failed", startedAt, { error: "Solicitud de exportacion mayor de 80 MB" });
        logRuntimeEvent("fleet-export-failed", {
          requestBytes,
          elapsedMs: Date.now() - startedAt,
          error: "Solicitud de exportacion mayor de 80 MB",
        });
        sendJson(response, 413, { error: "La solicitud de exportacion es demasiado grande" });
        return;
      }
      exportActivity.running += 1;
      try {
        const payload = JSON.parse(body || "{}");
        const fleet = payload.masterFileBase64
          ? buildFleetMap(CENTRAL_ROOT, payload.masterFileBase64)
          : payload;
        const workbook = buildWorkbook(fleet);
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": "attachment; filename=\"fleet_map.xlsx\"",
          "Content-Length": workbook.length,
        });
        response.end(workbook);
        recordExportResult("completed", startedAt, {
          rows: fleet.rows?.length || 0,
          workbookBytes: workbook.length,
        });
        logRuntimeEvent("fleet-export-complete", {
          requestBytes,
          rows: fleet.rows?.length || 0,
          history: fleet.history?.length || 0,
          missing: fleet.missing?.length || 0,
          errors: fleet.errors?.length || 0,
          workbookBytes: workbook.length,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        recordExportResult("failed", startedAt, { error: error.message });
        logRuntimeEvent("fleet-export-failed", {
          requestBytes,
          elapsedMs: Date.now() - startedAt,
          error: error.message,
        });
        sendJson(response, 500, { error: error.message });
      } finally {
        exportActivity.running = Math.max(0, exportActivity.running - 1);
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
        const fleet = buildFleetMap(CENTRAL_ROOT, payload.masterFileBase64);
        sendJson(response, 200, buildFleetWebPayload(fleet));
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, database: database.status(CENTRAL_ROOT), legacyMigration, centralRoot: CENTRAL_ROOT });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health-panel") {
    buildHealthPanel(requestUrl.searchParams.get("refresh") === "1")
      .then((payload) => sendJson(response, 200, payload))
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/db-status") {
    const rootPath = requestUrl.searchParams.get("rootPath") || CENTRAL_ROOT;
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
      const filePath = runtimePaths.dataFile(name);
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
    const filters = {
      issi: requestUrl.searchParams.get("issi") || "",
      serial: requestUrl.searchParams.get("serial") || "",
      tei: requestUrl.searchParams.get("tei") || "",
    };
    sendJson(response, 200, searchRadio(term || filters));
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

  if (request.method === "GET" && requestUrl.pathname === "/api/agendas/template") {
    const workbook = buildAgendaIssiTemplate();
    response.writeHead(200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": "attachment; filename=\"Plantilla_ISSI_Agendas.xlsx\"",
      "Content-Length": workbook.length,
    });
    response.end(workbook);
    return;
  }

  sendStatic(response, requestUrl.pathname);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
    else response.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`CPE Dashboard: http://${HOST}:${PORT}`);
    console.log(`Modo: ${NODE_MODE === "field" ? "campo sin conexion" : "central VM"}`);
    console.log(`SQLite: ${DATABASE_FILE}`);
    if (NODE_MODE === "central") {
      startDailyCentralScheduler();
      publicationTimer = setInterval(() => processPublicationQueue().catch(() => {}), 60_000);
      queueReadyCpeProjects();
      setImmediate(() => processPublicationQueue().catch(() => {}));
    } else {
      const intervalMs = projectPublisher.config.field.syncIntervalSeconds * 1000;
      fieldSyncTimer = setInterval(() => syncFieldQueue().catch(() => {}), intervalMs);
      setImmediate(() => syncFieldQueue().catch(() => {}));
    }
  });
  const shutdown = () => {
    if (dailyTimer) clearTimeout(dailyTimer);
    if (dailyRetryTimer) clearTimeout(dailyRetryTimer);
    if (publicationTimer) clearInterval(publicationTimer);
    if (fieldSyncTimer) clearInterval(fieldSyncTimer);
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
  buildFleetWebPayload,
  buildTemplateWorkbook,
  buildAgendaIssiTemplate,
  buildHealthPanel,
  buildWorkbook,
  database,
  EMERGENCY_LAYOUTS_BY_CPS_SIZE,
  extractCodeplugFile,
  extractEmergencyConfig,
  LAYOUTS_BY_CODEPLUG_AND_CPS_SIZE,
  LAYOUTS_BY_CPS_SIZE,
  migrateLegacyJsonCache,
  millisecondsUntilNextMidnight,
  parseCpeSections,
  parseProjectCpeWorkbook,
  parseAgendaIssiWorkbook,
  readFileSyncResilient,
  registerCpeProject,
  validateCpeProjectModel,
  validateCpeProjectRadio,
  processPublicationQueue,
  syncFieldQueue,
  resolveFileFeatures,
  readZip,
  createZip,
  parseMasterWorkbook,
  scanPath,
  server,
};
