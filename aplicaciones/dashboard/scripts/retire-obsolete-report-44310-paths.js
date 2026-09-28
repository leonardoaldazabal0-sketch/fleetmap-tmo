// Retire only verified renamed paths discovered by this repair, without deleting
// files or stored history. Requires the consistent pre-repair backup.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const paths = require('../lib/runtime-paths');
const reportDir = process.argv[2];
if (!reportDir) throw new Error('Required: report directory');
const summary = JSON.parse(fs.readFileSync(path.join(reportDir,'summary.json'),'utf8'));
const applied = JSON.parse(fs.readFileSync(path.join(reportDir,'applied.json'),'utf8'));
assert.ok(fs.statSync(applied.backup).size > 0);
const db = new Database(paths.dataFile('cpe-dashboard.sqlite'),{fileMustExist:true});
const retired = [];
try {
  for (const failure of summary.details.filter(r => r.error)) {
    assert.ok([10845,10846,10847].includes(failure.id), 'Unexpected missing record');
    const old = db.prepare('SELECT * FROM scanned_files WHERE id=?').get(failure.id);
    assert.equal(old.path,failure.path);
    assert.throws(() => fs.statSync(old.path), e => e.code==='ENOENT');
    const replacementPath = old.path.replace('\\REPSOL\\PAMPILLA\\','\\REPSOL\\REFINERIA PAMPILLA\\');
    assert.notEqual(replacementPath,old.path);
    const replacement = db.prepare('SELECT * FROM scanned_files WHERE path=? AND existsFlag=1').get(replacementPath);
    assert.ok(replacement);
    for (const key of ['serial','tei','issi','codeplug','size','mtimeMs']) assert.equal(replacement[key],old[key],key);
    const stat = fs.statSync(replacementPath);
    assert.equal(stat.size,replacement.size); assert.equal(stat.mtimeMs,replacement.mtimeMs);
    assert.equal(replacement.parserVersion,summary.parserVersion);
    assert.equal(replacement.emergencySupported,1);
    retired.push({id:old.id,path:old.path,replacementId:replacement.id,replacementPath});
  }
  assert.equal(retired.length,3);
  db.transaction(() => {
    for (const record of retired) db.prepare('UPDATE scanned_files SET existsFlag=0 WHERE id=? AND path=?').run(record.id,record.path);
  })();
  fs.writeFileSync(path.join(reportDir,'retired-paths.json'),JSON.stringify(retired,null,2));
  console.log(JSON.stringify({retired:retired.length,originalsDeleted:0}));
} finally { db.close(); }
