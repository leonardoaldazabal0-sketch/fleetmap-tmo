// Validated against the 51 A/B and tactical/non-tactical samples supplied
// on 2026-09-07. Exact decoded CPS lengths, independent of optional sections.
const definitions = [
  // CPS bytes, main table, record bytes, record count, mode byte, emergency alias
  [945344, 235528, 48, 2048, 2500, 28268], // CP0229
  [1065280, 245336, 52, 2048, 2632, 37996], // CP0520 / CP0525
  [1905728, 335508, 56, 10000, 2636, 52396], // CP0743, both wrappers
  [2599808, 752024, 56, 10000, 2704, 211048], // CP0930
  [2626688, 776088, 56, 10000, 2704, 235112], // CP1059
  [3020864, 815624, 56, 10000, 2704, 159016], // CP1211
  [3086976, 815052, 64, 10000, 2708, 158440], // CP1511
  [3276480, 816012, 64, 10000, 2708, 159400], // CP1649
  [3346368, 816204, 68, 10000, 2708, 159592], // CP1726 MXP
  [917248, 219328, 48, 2048, 2504, 25900], // CP6880
  [959360, 235996, 48, 2048, 2504, 28844], // CP7084 / CP7085, both wrappers
  [603456, 236360, 48, 2048, 3592, 29164], // CP7282
  [604224, 236488, 48, 2048, 3572, 29228], // CP7432
];

const groupLayouts = {};
const emergencyLayouts = {};
for (const [size, offset, recordSize, maxRecords, modeOffset, aliasOffset] of definitions) {
  groupLayouts[size] = {
    main: {
      offset, recordSize, maxRecords,
      aliasBytes: recordSize >= 64 ? 32 : 24,
      gssiOffset: recordSize >= 64 ? 36 : 28,
      networkIndexOffset: null, defaultZoneOffset: null,
      requireAlias: true, minGssi: 1, maxGssi: 16777215,
    },
    folder: {
      offset: offset + recordSize * maxRecords,
      recordSize: 4, maxRecords, statusOffset: 0, tgIndexOffset: 2,
      validStatuses: [1, 2], validateIndex: true,
    },
  };
  emergencyLayouts[size] = {
    modeOffset, addressTypeOffset: aliasOffset - 12, groupAddressValue: 1,
    gssiOffset: aliasOffset - 4, aliasOffset, aliasBytes: 32, confidence: 'high',
  };
}

module.exports = { groupLayouts, emergencyLayouts };
