const { createHash } = require("node:crypto");
const { references } = require("./validated-user-report-emergency");

// Configuraciones leidas de User Reports o verificadas directamente en CPS.
// Se aplican exclusivamente a huellas CPS validadas; nunca se heredan por ISSI,
// familia o version para evitar atribuir a una programacion datos de otra.
function broadcastEvidence(overrides = {}) {
  return {
    state: "Inactivo",
    alias: "",
    gssi: 0,
    canInitiate: false,
    indicatorActive: false,
    destinationConfigured: false,
    announcementPriority: 0,
    announcementAlias: "",
    groupInvisible: null,
    continuousTracking: null,
    ...overrides,
  };
}

const byIssi = {
  "44310": {
    scan: { state: "Inactivo", lists: [] },
    dmo: {
      state: "Activo",
      groups: [{ alias: "ALPAMARCA 01", gssi: 2000, folder: "MODO DIRECTO", frequency: "394.90000" }],
    },
    broadcast: broadcastEvidence(),
    gps: { state: "Activo", destinationIssi: 10066, carrier: "", protocol: "LIP" },
    otap: { state: "Activo", targets: [] },
  },
  "45140": {
    scan: { state: "Estado no verificado", activeList: "", lists: [] },
    dmo: {
      state: "Inactivo",
      groups: [{ alias: "DMO", gssi: 7163, folder: "DMO" }],
    },
    broadcast: broadcastEvidence({
      state: "No disponible",
      canInitiate: null,
      indicatorActive: null,
      destinationConfigured: null,
      announcementPriority: null,
    }),
    gps: { state: "Activo", destinationIssi: 10551, carrier: "", protocol: "LIP" },
    otap: {
      state: "No disponible",
      targets: [110, 210, 310, 410, 510, 511, 810, 811, 910, 911, 45060, 45061]
        .map((issi) => ({ mcc: 638, mnc: 99, issi })),
    },
  },
  "35500": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence({ state: "Inactivo", indicatorActive: true, announcementPriority: 10, announcementAlias: "BROADCAST" }),
    gps: { state: "Activo", destinationIssi: 10031, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  },
  "36709": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Activo", groups: [{ alias: "GRUPO DMO", gssi: 90101, frequency: "394.97500" }] },
    broadcast: broadcastEvidence({ state: "Inactivo", indicatorActive: true, announcementPriority: 10, announcementAlias: "BROADCAST" }),
    gps: { state: "Activo", destinationIssi: 10023, carrier: "SDS", protocol: "LIP" },
    otap: {
      state: "Activo",
      targets: [
        { mcc: 638, mnc: 99, issi: 110 },
        { mcc: 638, mnc: 99, issi: 210 },
      ],
    },
  },
  "55391": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence({ state: "Inactivo", indicatorActive: true }),
    gps: { state: "Activo", destinationIssi: 10064, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  },
  "56562": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence({
      state: "Solo escucha",
      alias: "SCR-BROADCAS",
      gssi: 9976,
      indicatorActive: true,
      destinationConfigured: true,
      announcementPriority: 10,
      announcementAlias: "BROADCAST",
      groupInvisible: true,
      continuousTracking: true,
    }),
    gps: { state: "Activo", destinationIssi: 10067, carrier: "SDS", protocol: "LIP" },
    otap: {
      state: "Inactivo",
      targets: [
        { mcc: 638, mnc: 99, issi: 310 },
        { mcc: 638, mnc: 99, issi: 410 },
      ],
    },
  },
  "74633": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence({ announcementPriority: 10, announcementAlias: "Broadcast/Emerge" }),
    gps: { state: "Activo", destinationIssi: 10024, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  },
  "89469": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence({ announcementPriority: 10, announcementAlias: "BROADCAST" }),
    gps: { state: "Activo", destinationIssi: 10006, carrier: "SDS", protocol: "LIP" },
    otap: { state: "Inactivo", targets: [] },
  },
  "90374": {
    scan: {
      state: "Activo",
      activeList: "Scan List1",
      lists: [{ name: "Scan List1", groups: [{ alias: "ALERTA", gssi: 10010042, priority: "Alto" }] }],
    },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence(),
    gps: { state: "Activo", destinationIssi: 100, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  },
  "92271": {
    scan: {
      state: "Activo",
      activeList: "Scan List1",
      lists: [{ name: "Scan List1", groups: [{ alias: "ALERTA", gssi: 10010042, priority: "Alto" }] }],
    },
    dmo: {
      state: "Activo",
      groups: [
        { alias: "CECOM DMO", gssi: 8288624, frequency: "417.00000" },
        { alias: "INTERNO1 DMO", gssi: 8288625, frequency: "415.00000" },
        { alias: "COORPLANTDMO", gssi: 8388623, frequency: "409.00000" },
      ],
    },
    broadcast: broadcastEvidence(),
    gps: { state: "Activo", destinationIssi: 100, carrier: "", protocol: "" },
    otap: { state: "No disponible", targets: [] },
  },
  "96547": {
    scan: {
      state: "Activo",
      activeList: "Scan List1",
      lists: [{ name: "Scan List1", groups: [{ alias: "ALERTA", gssi: 10010042, priority: "Alto" }] }],
    },
    dmo: {
      state: "Inactivo",
      groups: [
        { alias: "EMERGEN DMO", gssi: 8388624, frequency: "417.00000" },
        { alias: "COORPLANTDMO", gssi: 8388623, frequency: "409.00000" },
      ],
    },
    broadcast: broadcastEvidence(),
    gps: { state: "Activo", destinationIssi: 10004, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  },
  "99125": {
    scan: { state: "Inactivo", lists: [] },
    dmo: { state: "Inactivo", groups: [] },
    broadcast: broadcastEvidence(),
    gps: { state: "Activo", destinationIssi: 10011, carrier: "SDS", protocol: "LIP" },
    otap: { state: "No disponible", targets: [] },
  },
};

const featureReferences = [
  ...references,
  {
    issi: "44310",
    cpsLength: 2848576,
    reportSha256: "e23034d1caf491b4445350b7aaee335fc0dc767434169aa4d70da6c9e1fdd0ad",
    hashes: ["f051282011d673bafa65b7d63e4ec05526e9bca7e649d174a5c743e4c5773b5f"],
  },
  {
    issi: "45140",
    cpsLength: 2728576,
    source: "user-observation-exact",
    hashes: ["0607b11ebb14d693634e517c452b0135e8c000b104c71e1f3da04e2a2fb5ee0e"],
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function featuresFromValidatedReport(cps) {
  const candidates = featureReferences.filter((reference) => reference.cpsLength === cps.length && byIssi[reference.issi]);
  if (!candidates.length) return null;
  const hash = createHash("sha256").update(cps).digest("hex");
  const reference = candidates.find((candidate) => candidate.hashes.includes(hash));
  if (!reference) return null;
  return { source: reference.source || "user-report-exact", ...clone(byIssi[reference.issi]) };
}

module.exports = { byIssi, featuresFromValidatedReport };
