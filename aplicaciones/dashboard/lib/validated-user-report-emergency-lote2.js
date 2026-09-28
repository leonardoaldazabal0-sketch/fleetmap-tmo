// Exact CPS evidence from the eight additional reports, 2026-09-09.
// This does not infer an emergency layout from a CP number or decoded size.
const records=[
  ['35500',2849984,'4d614050929b370023656d0c745e186e31ded64006caac3d5078b3406806a0e4',['2acdfaf989544848ca07d9c30fa81a9fb2d62d1868c4eb42b32fe78fff48f273'],'EMER_TOTAL',7226],
  ['36709',4861952,'f0e6b8da81b12c09af1e270beccbb84cd00a389fb52c48b46af115d47a479dc7',['f01cc5a0904cb693d9c8d1e40cf9e8710c8506255e019b30c7d3d58fdb2096ed'],'EMER_TOTAL',7226],
  ['74633',3087360,'e2736388467797fa91a94bf2ff8ab13b09280411e621c2ae4b1e74c76185a72a',['d7b34a4e7a4e6da04446419272048c802df73074af0aadf8b5e830b1349b1efd'],'EMERGENCIA',8070],
  ['89469',4738944,'20a2f900420afc50f659ebae0261543aa777f22eae43e13946074b82d5913f0d',['71e177f397809f414fab21ea22d721ab58b17a969cd451e677def9764dc31df6'],'EMERGENCIA',8485],
  ['90374',2538688,'2b4377a929544ffd27ee1c6cbf704b0fa80592b23892e500dbeb34e6f67febeb',['1c6f74ef3d8592b0a9dd766980f51ec43a0cb738ba7aba3f172cb6814abbd4f2','8b1826e8831d7dcc9851e5f2137b5d8d3ef2422a66a6ddbc295ceee96e930183'],'URGENCIA',10010043],
  ['92271',1787008,'f11af9db155bbf7eb1d7586da9556123c5815beb76e6601cd70decb5b5c801ca',['5282e258eb9a3773b49c62c3d3965c7086da37e62e1123a635e577cbe9ebec03'],'URGENCIA',10010043],
  ['96547',2538688,'acc9d5012f29814795e630dc06c3f6e33b6d891dd985df9865cefe45f29a0741',['6ca04d360a1533f631a061494b3ee6fdfffdebac5bb864e3f48203a1a38ddbba'],'DOLPHIN',10010040],
  ['99125',1045696,'844258de01046a5886f2f9d44999b7668382dc816c3aca216515fe2a791fb4af',['5766f2e39f23aee87779d0abc711b675470af7181fa4ad11a639dc62215932e1'],'Grupo actual',0],
];
module.exports=records.map(([issi,cpsLength,reportSha256,hashes,alias,gssi])=>({
  issi,cpsLength,reportSha256,hashes,
  emergency:{emergencySupported:true,emergencyAddressType:'Grupo',emergencyMode:gssi===0?'Táctico':'No táctico',emergencyAlias:alias,emergencyGssi:gssi,emergencyAttachment:gssi!==0,emergencyConfidence:'user-report-exact'},
}));
