// Targeted index repair. Never writes source CPE files. Prepare first, review
// summary.json, then stop the dashboard and run --apply with the same directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const paths = require('../lib/runtime-paths');
const apply = process.argv.includes('--apply');
const argument = process.argv.find(a => a.startsWith('--report-dir='));
if (!argument) throw new Error('Required: --report-dir=<directory>');
const reportDir = path.resolve(argument.slice(13));
const livePath = paths.dataFile('cpe-dashboard.sqlite');
const spool = path.join(reportDir, 'repairs.ndjson');
fs.mkdirSync(reportDir, {recursive: true});
process.env.CPE_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-report-44310-')), 'parser.sqlite');
const app = require('../server');
const source = new Database(livePath, {readonly: true, fileMustExist: true});
const signature = r => [r.id, r.size, r.mtimeMs, r.parserVersion, r.lastParsedAt, r.existsFlag];

function validateReference() {
  const reportPath = 'C:/Users/usrdolphin/Pictures/44310/user report.html';
  const raw = fs.readFileSync(reportPath);
  const html = raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8');
  const clean = s => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const tables = [...html.matchAll(/<TABLE\b[^>]*>[\s\S]*?<\/TABLE>/gi)].map(m => m[0]);
  const groupTable = tables.find(t => /ROM-OPERACIO/.test(t) && /Carpeta predeterminada/.test(t));
  assert.ok(groupTable, 'Missing TMO group table in CPS report');
  const rows = [...groupTable.matchAll(/<TR\b[^>]*>[\s\S]*?<\/TR>/gi)].map(m =>
    [...m[0].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>/gi)].map(c => clean(c[1])));
  const expected = rows.filter(r => ['Programado', 'Invisible'].includes(r[4]))
    .map(r => [r[1], Number(r[2]), r[4]]).sort((a,b) => a[1]-b[1]);
  assert.equal(expected.length, 4, 'Unexpected CPS reference group count');
  const row = source.prepare("SELECT * FROM scanned_files WHERE existsFlag=1 AND issi='44310' AND serial='938TWZFA10' AND size=2848662 ORDER BY dateKey DESC,mtimeMs DESC LIMIT 1").get();
  assert.ok(row, 'Reference CPE not indexed');
  const actual = app.extractCodeplugFile(row.path);
  const emergencyTable = tables.find(t => /Tipo de grupo de emergencia/.test(t) && /ALP-EMERG/.test(t));
  assert.ok(emergencyTable);
  assert.match(clean(emergencyTable), /No táctica.*ALP-EMERG.*9901/);
  assert.deepEqual(actual.rows.map(r => [r.alias,r.gssi,r.statusText]).sort((a,b) => a[1]-b[1]), expected);
  assert.equal(actual.issi, '44310');
  assert.equal(actual.serial, '938TWZFA10');
  assert.equal(actual.tei, '00016C220092140');
  assert.equal(actual.emergencyMode, 'No táctico');
  assert.equal(actual.emergencyGssi, 9901);
  assert.equal(actual.emergencyAlias, 'ALP-EMERG');
  assert.equal(actual.emergencyAttachment, true);
  return {reportPath, sourcePath: row.path, groups: expected, emergencyMode: actual.emergencyMode, emergencyGssi: actual.emergencyGssi};
}

async function main() {
  if (apply) {
    const summary = JSON.parse(fs.readFileSync(path.join(reportDir,'summary.json'),'utf8'));
    assert.equal(summary.parserVersion, app.database.parserVersion, 'Parser changed after preparation');
    const repairs = fs.readFileSync(spool,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(repairs.length, summary.stats.prepared);
    const records = [];
    const skipped = [];
    for (const repair of repairs) {
      const current = source.prepare('SELECT * FROM scanned_files WHERE path=?').get(repair.path);
      if (!current || JSON.stringify(signature(current)) !== JSON.stringify(repair.previous)) {
        skipped.push({path:repair.path, reason:'Index signature changed'}); continue;
      }
      try {
        const stat = fs.statSync(repair.path);
        assert.equal(stat.size, repair.size);
        assert.equal(stat.mtimeMs, repair.mtimeMs);
        records.push(repair);
      } catch (e) { skipped.push({path:repair.path, reason:e.message}); }
    }
    // Online SQLite backup is consistent even when WAL pages have not checkpointed.
    const backup = paths.dataFile(`before-report-44310-${Date.now()}.sqlite`);
    fs.mkdirSync(path.dirname(backup), {recursive:true});
    await source.backup(backup);
    const check = new Database(backup, {readonly:true, fileMustExist:true});
    try { assert.equal(check.pragma('integrity_check', {simple:true}), 'ok'); } finally { check.close(); }
    const {CpeDatabase} = require('../lib/cpe-database');
    const live = new CpeDatabase(livePath, app.database.parserVersion);
    try {
      live.db.transaction(() => {
        for (const record of records) {
          assert.deepEqual(signature(live.getFile(record.path)), record.previous, 'Concurrent index update; retry');
          live.storeOne(record);
        }
        live.setMeta('report-44310-repair', JSON.stringify({backup, applied:records.length, at:new Date().toISOString()}));
      })();
      assert.equal(live.db.pragma('integrity_check', {simple:true}), 'ok');
      assert.deepEqual(live.db.pragma('foreign_key_check'), []);
    } finally { live.close(); }
    const result = {applied:records.length, skipped, backup};
    fs.writeFileSync(path.join(reportDir,'applied.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
    return;
  }
  const reference = validateReference();
  console.log(JSON.stringify({reference}));
  // Two observed wrapper sizes. Always verify decoded CPS length as well.
  const candidates = source.prepare('SELECT * FROM scanned_files WHERE existsFlag=1 AND size IN (2848662,2979741) ORDER BY id').all();
  const stats = {candidates:candidates.length, prepared:0, skipped:0, oldGroups:0, newGroups:0, recoveredEmergency:0, addedInvisible:0, changedNames:0, byCp:{}};
  const details = [];
  const fd = fs.openSync(spool,'wx');
  try {
    for (const row of candidates) {
      try {
        const stat = fs.statSync(row.path);
        assert.equal(stat.size, row.size, 'Source size changed');
        assert.equal(stat.mtimeMs, row.mtimeMs, 'Source mtime changed');
        const parsed = app.parseCpeSections(row.path);
        assert.equal(parsed.sections.CPS?.length, 2848576, 'Not the validated structure');
        const codeplug = app.extractCodeplugFile(row.path);
        const after = fs.statSync(row.path);
        assert.equal(after.size, stat.size);
        assert.equal(after.mtimeMs, stat.mtimeMs, 'Source changed during extraction');
        const before = source.prepare('SELECT alias,gssi,status FROM talkgroups WHERE fileId=?').all(row.id);
        const addedInvisible = codeplug.rows.filter(r => r.status===2 && !before.some(old => old.gssi===r.gssi && old.status===2)).length;
        const changedNames = codeplug.rows.filter(r => before.some(old => old.gssi===r.gssi && old.alias!==r.alias)).length;
        stats.oldGroups += row.groupCount; stats.newGroups += codeplug.rows.length;
        stats.recoveredEmergency += Number(!row.emergencySupported && codeplug.emergencySupported);
        stats.addedInvisible += addedInvisible; stats.changedNames += changedNames;
        const cp = row.codeplug || '(sin CP en nombre)';
        stats.byCp[cp] = (stats.byCp[cp] || 0) + 1;
        const record = {path:row.path, previous:signature(row), size:stat.size, mtimeMs:stat.mtimeMs, codeplug};
        fs.writeSync(fd,JSON.stringify(record)+'\n'); stats.prepared++;
        details.push({id:row.id, issi:row.issi, cp:row.codeplug, oldGroups:row.groupCount, newGroups:codeplug.rows.length, addedInvisible, changedNames, mode:codeplug.emergencyMode, emergencyGssi:codeplug.emergencyGssi});
      } catch (e) { stats.skipped++; details.push({id:row.id,path:row.path,error:e.message}); }
      if ((stats.prepared+stats.skipped)%50===0) console.log(JSON.stringify(stats));
    }
  } finally { fs.closeSync(fd); }
  fs.writeFileSync(path.join(reportDir,'summary.json'),JSON.stringify({parserVersion:app.database.parserVersion,reference,stats,details},null,2));
  console.log(JSON.stringify({reportDir,stats}));
}
main().catch(e => {console.error(e.stack);process.exitCode=1;}).finally(() => {source.close();app.database.close();});
