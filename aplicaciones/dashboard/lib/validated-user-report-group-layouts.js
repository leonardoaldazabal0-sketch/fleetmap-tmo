// Complete TMO tables cross-checked against the eight supplied User Reports,
// 2026-09-09. These are exact decoded sizes, not CP-family-wide overrides.
const definitions=[
  [1045696,244740,52,2048], // CP0405 / 99125
  [1787008,272628,56,10000], // CP0652 / 92271
  [2538688,751776,56,10000], // CP0865+0886 / 90374+96547
  [2849984,816200,56,10000], // CP1274 / 35500
  [3087360,815372,64,10000], // CP1649 / 74633
  [4738944,970624,56,10000], // CP1211 / 89469 (old table start was 23 rows early)
  [4861952,970116,64,10000], // CP1407 / 36709
];
const groupLayouts=Object.fromEntries(definitions.map(([size,offset,recordSize,maxRecords])=>[size,{
  main:{offset,recordSize,maxRecords,aliasBytes:recordSize>=64?32:24,gssiOffset:recordSize>=64?36:28,networkIndexOffset:null,defaultZoneOffset:recordSize>=64?34:26,requireAlias:true,minGssi:1,maxGssi:16777215},
  folder:{offset:offset+recordSize*maxRecords,recordSize:4,maxRecords,statusOffset:0,tgIndexOffset:2,validStatuses:[1,2],validateIndex:true,deduplicateSlots:true},
}]));
module.exports={groupLayouts};
