const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BROADCAST_LAYOUTS,
  DMO_INDICATOR_OFFSETS,
  GPS_INDICATOR_OFFSETS,
  OTAP_INDICATOR_OFFSETS,
  OTAP_TABLES,
  SCAN_INDICATOR_OFFSETS,
  deriveDmoLayout,
  extractCpeFeatures,
} = require("../lib/cpe-features");
const { byIssi } = require("../lib/validated-user-report-features");

test("conserva la validacion exacta GPS y DMO del User Report 44310", () => {
  assert.equal(byIssi["44310"].gps.state, "Activo");
  assert.equal(byIssi["44310"].gps.destinationIssi, 10066);
  assert.deepEqual(byIssi["44310"].dmo, {
    state: "Activo",
    groups: [{ alias: "ALPAMARCA 01", gssi: 2000, folder: "MODO DIRECTO", frequency: "394.90000" }],
  });
  assert.equal(byIssi["44310"].broadcast.state, "Inactivo");
  assert.equal(byIssi["44310"].broadcast.indicatorActive, false);
  assert.equal(byIssi["44310"].broadcast.gssi, 0);
});

test("Broadcast sin GSSI destino se considera inactivo aunque el indicador este encendido", () => {
  assert.deepEqual({
    state: byIssi["56562"].broadcast.state,
    indicatorActive: byIssi["56562"].broadcast.indicatorActive,
    destinationConfigured: byIssi["56562"].broadcast.destinationConfigured,
    priority: byIssi["56562"].broadcast.announcementPriority,
    groupInvisible: byIssi["56562"].broadcast.groupInvisible,
    continuousTracking: byIssi["56562"].broadcast.continuousTracking,
  }, {
    state: "Solo escucha",
    indicatorActive: true,
    destinationConfigured: true,
    priority: 10,
    groupInvisible: true,
    continuousTracking: true,
  });
  for (const issi of ["35500", "36709", "55391"]) {
    assert.equal(byIssi[issi].broadcast.state, "Inactivo");
    assert.equal(byIssi[issi].broadcast.indicatorActive, true);
    assert.equal(byIssi[issi].broadcast.destinationConfigured, false);
  }
});

test("usa indicadores aislados con pares controlados CPE y User Report", () => {
  assert.deepEqual(SCAN_INDICATOR_OFFSETS, {
    1064192: 2718,
    1079232: 2668,
    2535552: 2716,
    2728576: 2742,
    3021888: 2742,
    4859968: 2746,
    4862464: 2746,
    4997184: 2746,
    5066880: 2746,
  });
  assert.equal(DMO_INDICATOR_OFFSETS[1064192], 2712);
  assert.equal(DMO_INDICATOR_OFFSETS[1079232], 2662);
  assert.deepEqual(Object.fromEntries([
    1064192, 1079232, 2535552, 2728576, 3021888,
    4859968, 4862464, 4997184, 5066880,
  ].map((length) => [length, GPS_INDICATOR_OFFSETS[length]])), {
    1064192: 2836,
    1079232: 2840,
    2535552: 2886,
    2728576: 2912,
    3021888: 2912,
    4859968: 2916,
    4862464: 2920,
    4997184: 2920,
    5066880: 2924,
  });
  assert.equal(OTAP_INDICATOR_OFFSETS[3021888], 2839);
  for (const length of [4859968, 4862464, 4997184, 5066880]) {
    assert.equal(OTAP_INDICATOR_OFFSETS[length], 2843);
  }
  assert.equal(BROADCAST_LAYOUTS[3021888].indicatorOffset, 2794);
  assert.equal(BROADCAST_LAYOUTS[3021888].activeIndicatorValue, 1);
});

test("45140 conserva DMO inactivo con grupo y doce destinos OTAP", () => {
  assert.deepEqual(byIssi["45140"].dmo, {
    state: "Inactivo",
    groups: [{ alias: "DMO", gssi: 7163, folder: "DMO" }],
  });
  assert.deepEqual(byIssi["45140"].otap.targets.map((target) => target.issi), [
    110, 210, 310, 410, 510, 511, 810, 811, 910, 911, 45060, 45061,
  ]);
  assert.equal(byIssi["45140"].otap.state, "No disponible");
  assert.equal(byIssi["45140"].gps.state, "Activo");
  assert.equal(byIssi["45140"].gps.destinationIssi, 10551);
});

test("extrae identidades OTAP de la estructura CP1020", () => {
  assert.equal(OTAP_INDICATOR_OFFSETS[2728576], 2839);
  const cps = Buffer.alloc(2728576);
  cps[OTAP_INDICATOR_OFFSETS[2728576]] = 1;
  cps.writeUInt16LE(638, 218692);
  cps.writeUInt16LE(99, 218694);
  cps.writeUInt32LE(45060, 218696);
  const features = extractCpeFeatures(cps);
  assert.equal(features.source, "cpe-layout-validated");
  assert.equal(features.otap.state, "Activo");
  assert.deepEqual(features.otap.targets, [{ mcc: 638, mnc: 99, issi: 45060 }]);
});

test("normaliza OTAP con SDS y OTAP LMR leyendo ITSI autorizadas en todas las estructuras validadas", () => {
  const expectedOffsets = {
    2728576: 218692,
    3021888: 143264,
    3144064: 142272,
    3276480: 142956,
    3346368: 143124,
    4739776: 143260,
    4859968: 141948,
    4861952: 142100,
    4862464: 142248,
    4997184: 160296,
    5066880: 160464,
    5263232: 162392,
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(OTAP_TABLES).map(([length, layout]) => [length, layout.offset])),
    expectedOffsets,
  );
  assert.deepEqual(Object.keys(OTAP_INDICATOR_OFFSETS).map(Number).sort((a, b) => a - b), [
    2728576, 3021888, 4859968, 4862464, 4997184, 5066880,
  ]);

  for (const [lengthText, offset] of Object.entries(expectedOffsets)) {
    const cps = Buffer.alloc(Number(lengthText));
    const indicatorOffset = OTAP_INDICATOR_OFFSETS[lengthText];
    if (indicatorOffset != null) cps[indicatorOffset] = 1;
    cps.writeUInt16LE(638, offset);
    cps.writeUInt16LE(99, offset + 2);
    cps.writeUInt32LE(110, offset + 4);
    cps.writeUInt16LE(638, offset + 8);
    cps.writeUInt16LE(99, offset + 10);
    cps.writeUInt32LE(210, offset + 12);

    const features = extractCpeFeatures(cps);
    assert.equal(features.source, "cpe-layout-validated", `CPS ${lengthText}`);
    assert.equal(features.otap.state, indicatorOffset == null ? "No disponible" : "Activo", `CPS ${lengthText}`);
    assert.deepEqual(features.otap.targets, [
      { mcc: 638, mnc: 99, issi: 110 },
      { mcc: 638, mnc: 99, issi: 210 },
    ], `CPS ${lengthText}`);
  }
});

test("OTAP inactivo conserva evidencia interna pero no se considera habilitado", () => {
  const cps = Buffer.alloc(5066880);
  cps[OTAP_INDICATOR_OFFSETS[5066880]] = 0;
  cps.writeUInt16LE(638, OTAP_TABLES[5066880].offset);
  cps.writeUInt16LE(99, OTAP_TABLES[5066880].offset + 2);
  cps.writeUInt32LE(110, OTAP_TABLES[5066880].offset + 4);

  const features = extractCpeFeatures(cps);
  assert.equal(features.otap.state, "Inactivo");
  assert.deepEqual(features.otap.targets, [{ mcc: 638, mnc: 99, issi: 110 }]);
});

test("OTAP con SDS inactivo conserva ITSIs pero informa Inactivo", () => {
  const cps = Buffer.alloc(2728576);
  cps[OTAP_INDICATOR_OFFSETS[2728576]] = 0;
  cps.writeUInt16LE(638, OTAP_TABLES[2728576].offset);
  cps.writeUInt16LE(99, OTAP_TABLES[2728576].offset + 2);
  cps.writeUInt32LE(310, OTAP_TABLES[2728576].offset + 4);

  const features = extractCpeFeatures(cps);
  assert.equal(features.otap.state, "Inactivo");
  assert.deepEqual(features.otap.targets, [{ mcc: 638, mnc: 99, issi: 310 }]);
});

test("extrae Broadcast escucha CP1726 con indicador, destino y prioridad 10", () => {
  const cps = Buffer.alloc(5066880);
  const layout = {
    main: { offset: 988548, recordSize: 68, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36 },
    folder: { offset: 1668548, recordSize: 4, maxRecords: 10000 },
  };
  const destination = { folderRow: 6, slot: 14, alias: "ROM-BROADCAS", gssi: 6078, status: 2, statusText: "Invisible" };
  cps[2798] = 1;
  cps.writeUInt32LE(6, 9814);
  cps[9825] = 10;
  Buffer.from("BROADCAST\0", "utf16le").copy(cps, 9868);
  const groupBase = layout.main.offset + (destination.slot - 1) * layout.main.recordSize;
  cps[groupBase + layout.main.aliasBytes + 10] = 7;

  const features = extractCpeFeatures(cps, { layout, talkgroups: [destination] });
  assert.deepEqual(features.broadcast, {
    state: "Solo escucha",
    alias: "ROM-BROADCAS",
    gssi: 6078,
    canInitiate: false,
    indicatorActive: true,
    destinationConfigured: true,
    announcementPriority: 10,
    announcementAlias: "BROADCAST",
    groupInvisible: true,
    continuousTracking: true,
  });

  cps[2798] = 0;
  const inactive = extractCpeFeatures(cps, { layout, talkgroups: [destination] });
  assert.equal(inactive.broadcast.state, "Inactivo");
  assert.equal(inactive.broadcast.indicatorActive, false);

  cps[2798] = 1;
  cps[9825] = 5;
  const wrongPriority = extractCpeFeatures(cps, { layout, talkgroups: [destination] });
  assert.equal(wrongPriority.broadcast.state, "Revisar");
  assert.equal(wrongPriority.broadcast.announcementPriority, 5);
});

test("CP1274 R55 resuelve el destino Broadcast invisible aunque no este asignado a carpeta", () => {
  const cps = Buffer.alloc(3021888);
  const layout = {
    main: { offset: 816720, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28 },
  };
  cps[2794] = 1;
  cps.writeUInt32LE(1, 9786);
  cps[9797] = 10;
  const groupBase = layout.main.offset + 3 * layout.main.recordSize;
  Buffer.from("SCR-BROADCAS\0", "utf16le").copy(cps, groupBase);
  cps[groupBase + 24] = 2;
  cps.writeUInt32LE(9976, groupBase + 28);
  cps[groupBase + 34] = 7;

  const features = extractCpeFeatures(cps, { layout, talkgroups: [] });
  assert.equal(features.broadcast.state, "Solo escucha");
  assert.equal(features.broadcast.gssi, 9976);
  assert.equal(features.broadcast.alias, "SCR-BROADCAS");
});

test("conserva evidencia sin inferir indicadores GPS u OTAP no validados", () => {
  const cps = Buffer.alloc(4861952);
  const layout = {
    main: { offset: 1000, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28 },
    folder: { offset: 561000, recordSize: 4, maxRecords: 10000 },
  };
  const dmo = deriveDmoLayout(layout, cps.length);
  Buffer.from("DMO PRUEBA\0", "utf16le").copy(cps, dmo.offset);
  cps[dmo.offset + 24] = 1;
  cps.writeUInt32LE(8388623, dmo.offset + 28);
  Buffer.from("NO PROGRAMADO\0", "utf16le").copy(cps, dmo.offset + 52);
  cps.writeUInt32LE(8388624, dmo.offset + 52 + 28);

  const scan = dmo.offset + dmo.recordSize * dmo.maxRecords;
  Buffer.from("Lista campo\0", "utf16le").copy(cps, scan);
  cps[scan + 24] = 1;
  cps[scan + 25] = 1;
  cps.writeUInt32LE(2, scan + 28);
  cps.writeUInt16LE(5, scan + 32);
  cps.writeUInt16LE(1, scan + 34);
  cps.writeUInt32LE(10010042, scan + 36);

  cps.writeUInt32LE(10031, 2404932);
  cps[DMO_INDICATOR_OFFSETS[cps.length]] = 1;
  cps.writeUInt16LE(638, 142100);
  cps.writeUInt16LE(99, 142102);
  cps.writeUInt32LE(110, 142104);

  const features = extractCpeFeatures(cps, {
    layout,
    talkgroups: [{ alias: "ALERTA", gssi: 10010042 }],
  });
  assert.equal(features.source, "cpe-layout-validated");
  assert.match(features.scan.state, /no verificado/);
  assert.equal(features.dmo.state, "Activo");
  assert.deepEqual(features.scan.lists[0].groups, [{ alias: "ALERTA", gssi: 10010042, priority: "Alto" }]);
  assert.deepEqual(features.dmo.groups, [{ alias: "DMO PRUEBA", gssi: 8388623 }]);
  assert.equal(features.gps.destinationIssi, 10031);
  assert.equal(features.gps.state, "No disponible");
  assert.deepEqual(features.otap.targets, [{ mcc: 638, mnc: 99, issi: 110 }]);
  assert.equal(features.otap.state, "No disponible");
});

test("DMO inactivo y GPS no validado conservan evidencia sin reportarse activos", () => {
  const cps = Buffer.alloc(4861952);
  const layout = {
    main: { offset: 1000, recordSize: 56, maxRecords: 10000, aliasBytes: 24, gssiOffset: 28 },
    folder: { offset: 561000, recordSize: 4, maxRecords: 10000 },
  };
  const dmo = deriveDmoLayout(layout, cps.length);
  Buffer.from("DMO GUARDADO\0", "utf16le").copy(cps, dmo.offset);
  cps[dmo.offset + 24] = 1;
  cps.writeUInt32LE(2000, dmo.offset + 28);
  cps.writeUInt32LE(10031, 2404932);
  cps[DMO_INDICATOR_OFFSETS[cps.length]] = 0;

  const features = extractCpeFeatures(cps, { layout });
  assert.equal(features.dmo.state, "Inactivo");
  assert.deepEqual(features.dmo.groups, [{ alias: "DMO GUARDADO", gssi: 2000 }]);
  assert.equal(features.gps.state, "No disponible");
  assert.equal(features.gps.destinationIssi, 10031);
});

test("Broadcast sin GSSI destino permanece inactivo aunque exista un grupo continuo", () => {
  const cps = Buffer.alloc(1064192);
  const layout = {
    main: { offset: 244496, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28 },
    folder: { offset: 348496, recordSize: 4, maxRecords: 10000 },
  };
  const destination = {
    folderRow: 617,
    slot: 4,
    alias: "Broadcast",
    gssi: 8172,
    status: 1,
    statusText: "Programado",
  };
  cps[5261] = 10;
  Buffer.from("BROADCAST\0", "utf16le").copy(cps, 5300);
  const groupBase = layout.main.offset + (destination.slot - 1) * layout.main.recordSize;
  cps[2769] = 1;
  cps[groupBase + layout.main.aliasBytes] = 2;
  cps[groupBase + layout.main.aliasBytes + 10] = 7;

  const features = extractCpeFeatures(cps, { layout, talkgroups: [destination] });
  assert.equal(features.broadcast.state, "Inactivo");
  assert.equal(features.broadcast.indicatorActive, true);
  assert.equal(features.broadcast.gssi, 0);
});

test("Broadcast con GSSI pero sin invisible y rastreo continuo permanece inactivo", () => {
  const cps = Buffer.alloc(4859968);
  const layout = {
    main: { offset: 969984, recordSize: 64, maxRecords: 10000, aliasBytes: 32, gssiOffset: 36 },
    folder: { offset: 1610308, recordSize: 4, maxRecords: 10000 },
  };
  const destination = { folderRow: 10, slot: 1, alias: "BROADCAST", gssi: 7216, status: 1, statusText: "Programado" };
  cps[2798] = 1;
  cps.writeUInt32LE(destination.folderRow, 9794);
  cps[9805] = 10;
  Buffer.from("BROADCAST\0", "utf16le").copy(cps, 9848);
  const groupBase = layout.main.offset;
  Buffer.from(`${destination.alias}\0`, "utf16le").copy(cps, groupBase);
  cps[groupBase + layout.main.aliasBytes] = 1;
  cps.writeUInt32LE(destination.gssi, groupBase + layout.main.gssiOffset);
  cps[groupBase + layout.main.aliasBytes + 10] = 1;

  const features = extractCpeFeatures(cps, { layout, talkgroups: [destination] });
  assert.equal(features.broadcast.state, "Inactivo");
  assert.equal(features.broadcast.gssi, 7216);
});

test("CP7492 resuelve la referencia Broadcast indirecta al grupo invisible continuo", () => {
  const cps = Buffer.alloc(1064192);
  const layout = {
    main: { offset: 244496, recordSize: 52, maxRecords: 2000, aliasBytes: 24, gssiOffset: 28 },
    folder: { offset: 348496, recordSize: 4, maxRecords: 10000 },
  };
  const destination = { slot: 2, alias: "G.Ejecutivo", gssi: 8150, status: 2, statusText: "Invisible" };
  cps[2769] = 1;
  cps.writeUInt32LE(3, 5250);
  cps[5261] = 10;
  Buffer.from("BROADCAST\0", "utf16le").copy(cps, 5300);
  const groupBase = layout.main.offset + (destination.slot - 1) * layout.main.recordSize;
  Buffer.from(`${destination.alias}\0`, "utf16le").copy(cps, groupBase);
  cps[groupBase + layout.main.aliasBytes] = 2;
  cps.writeUInt32LE(destination.gssi, groupBase + layout.main.gssiOffset);
  cps[groupBase + layout.main.aliasBytes + 10] = 7;

  const features = extractCpeFeatures(cps, { layout, talkgroups: [destination] });
  assert.equal(features.broadcast.state, "Solo escucha");
  assert.equal(features.broadcast.alias, "G.Ejecutivo");
  assert.equal(features.broadcast.gssi, 8150);
  assert.equal(features.broadcast.announcementPriority, 10);
  assert.equal(features.broadcast.groupInvisible, true);
  assert.equal(features.broadcast.continuousTracking, true);
});
