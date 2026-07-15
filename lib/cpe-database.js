const fs = require("fs");
const path = require("path");
let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  throw new Error(`No se pudo cargar SQLite. Ejecuta npm install (${error.message})`);
}

const SCHEMA_VERSION = 2;

class CpeDatabase {
  constructor(filePath, parserVersion) {
    this.filePath = path.resolve(filePath);
    this.parserVersion = String(parserVersion);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    this.db = new Database(this.filePath, { timeout: 10000 });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 10000");
    this.createSchema();
    this.prepareStatements();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scanned_files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        fileName TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtimeMs REAL NOT NULL,
        existsFlag INTEGER NOT NULL DEFAULT 1,
        folderDate TEXT,
        dateKey INTEGER NOT NULL DEFAULT 0,
        sourceFolder TEXT,
        programmer TEXT,
        serial TEXT,
        tei TEXT,
        issi TEXT,
        codeplug TEXT,
        software TEXT,
        cpuId TEXT,
        cpeVersion TEXT,
        groupCount INTEGER NOT NULL DEFAULT 0,
        lastParsedAt TEXT,
        errorType TEXT,
        errorMessage TEXT,
        parserVersion TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS talkgroups (
        id INTEGER PRIMARY KEY,
        fileId INTEGER NOT NULL REFERENCES scanned_files(id) ON DELETE CASCADE,
        folderRow INTEGER,
        slot INTEGER,
        alias TEXT,
        gssi INTEGER,
        status INTEGER,
        statusText TEXT,
        codeplug TEXT,
        software TEXT,
        serial TEXT,
        issi TEXT,
        assignmentConfidence TEXT,
        networkIndex INTEGER,
        defaultZone INTEGER
      );

      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY,
        rootPath TEXT NOT NULL,
        startedAt TEXT NOT NULL,
        finishedAt TEXT,
        foundCount INTEGER NOT NULL DEFAULT 0,
        parsedCount INTEGER NOT NULL DEFAULT 0,
        cachedCount INTEGER NOT NULL DEFAULT 0,
        errorCount INTEGER NOT NULL DEFAULT 0,
        deletedCount INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scanned_files_exists ON scanned_files(existsFlag);
      CREATE INDEX IF NOT EXISTS idx_scanned_files_issi_freshness
        ON scanned_files(issi, existsFlag, dateKey DESC, mtimeMs DESC);
      CREATE INDEX IF NOT EXISTS idx_talkgroups_file ON talkgroups(fileId, folderRow, slot);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_root ON scan_runs(rootPath, id DESC);
    `);
    const talkgroupColumns = new Set(
      this.db.prepare("PRAGMA table_info(talkgroups)").all().map((column) => column.name)
    );
    if (!talkgroupColumns.has("assignmentConfidence")) {
      this.db.exec("ALTER TABLE talkgroups ADD COLUMN assignmentConfidence TEXT");
    }
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  prepareStatements() {
    this.findFile = this.db.prepare("SELECT * FROM scanned_files WHERE path = ?");
    this.findFileById = this.db.prepare("SELECT * FROM scanned_files WHERE id = ?");
    this.findTalkgroups = this.db.prepare(`
      SELECT * FROM talkgroups WHERE fileId = ? ORDER BY folderRow, slot, id
    `);
    this.upsertFile = this.db.prepare(`
      INSERT INTO scanned_files (
        path, fileName, size, mtimeMs, existsFlag, folderDate, dateKey,
        sourceFolder, programmer, serial, tei, issi, codeplug, software,
        cpuId, cpeVersion, groupCount, lastParsedAt, errorType, errorMessage,
        parserVersion
      ) VALUES (
        @path, @fileName, @size, @mtimeMs, 1, @folderDate, @dateKey,
        @sourceFolder, @programmer, @serial, @tei, @issi, @codeplug, @software,
        @cpuId, @cpeVersion, @groupCount, @lastParsedAt, @errorType, @errorMessage,
        @parserVersion
      )
      ON CONFLICT(path) DO UPDATE SET
        fileName=excluded.fileName, size=excluded.size, mtimeMs=excluded.mtimeMs,
        existsFlag=1, folderDate=excluded.folderDate, dateKey=excluded.dateKey,
        sourceFolder=excluded.sourceFolder, programmer=excluded.programmer,
        serial=excluded.serial, tei=excluded.tei, issi=excluded.issi,
        codeplug=excluded.codeplug, software=excluded.software, cpuId=excluded.cpuId,
        cpeVersion=excluded.cpeVersion, groupCount=excluded.groupCount,
        lastParsedAt=excluded.lastParsedAt, errorType=excluded.errorType,
        errorMessage=excluded.errorMessage, parserVersion=excluded.parserVersion
      RETURNING id
    `);
    this.deleteTalkgroups = this.db.prepare("DELETE FROM talkgroups WHERE fileId = ?");
    this.insertTalkgroup = this.db.prepare(`
      INSERT INTO talkgroups (
        fileId, folderRow, slot, alias, gssi, status, statusText, codeplug,
        software, serial, issi, assignmentConfidence, networkIndex, defaultZone
      ) VALUES (
        @fileId, @folderRow, @slot, @alias, @gssi, @status, @statusText,
        @codeplug, @software, @serial, @issi, @assignmentConfidence,
        @networkIndex, @defaultZone
      )
    `);
    this.setExists = this.db.prepare("UPDATE scanned_files SET existsFlag = ? WHERE id = ?");
    this.startRunStatement = this.db.prepare(`
      INSERT INTO scan_runs(rootPath, startedAt) VALUES (?, ?)
    `);
    this.finishRunStatement = this.db.prepare(`
      UPDATE scan_runs SET finishedAt=@finishedAt, foundCount=@foundCount,
        parsedCount=@parsedCount, cachedCount=@cachedCount, errorCount=@errorCount,
        deletedCount=@deletedCount WHERE id=@id
    `);
    this.progressRunStatement = this.db.prepare(`
      UPDATE scan_runs SET foundCount=@foundCount, parsedCount=@parsedCount,
        cachedCount=@cachedCount, errorCount=@errorCount, deletedCount=@deletedCount
      WHERE id=@id
    `);
    this.getMetaStatement = this.db.prepare("SELECT value FROM app_meta WHERE key = ?");
    this.setMetaStatement = this.db.prepare(`
      INSERT INTO app_meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `);

    this.storeTransaction = this.db.transaction((records) => {
      for (const record of records) this.storeOne(record);
    });
    this.setExistsTransaction = this.db.transaction((ids, flag) => {
      for (const id of ids) this.setExists.run(flag, id);
    });
  }

  getFile(filePath) {
    return this.findFile.get(path.resolve(filePath)) || null;
  }

  signatureMatches(fileRow, stat) {
    return Boolean(
      fileRow &&
      fileRow.size === stat.size &&
      fileRow.mtimeMs === stat.mtimeMs &&
      (fileRow.parserVersion === this.parserVersion || !fileRow.errorMessage)
    );
  }

  storeOne(record) {
    const codeplug = record.codeplug || {};
    const meta = record.meta || codeplug;
    const error = record.error || null;
    const values = {
      path: path.resolve(record.path),
      fileName: meta.fileName || path.basename(record.path),
      size: record.size,
      mtimeMs: record.mtimeMs,
      folderDate: codeplug.date || meta.date || "",
      dateKey: Number(codeplug.dateKey || meta.dateKey || 0),
      sourceFolder: codeplug.sourceFolder || meta.sourceFolder || "",
      programmer: codeplug.programmer || meta.programmer || "",
      serial: codeplug.serial || meta.serial || "",
      tei: codeplug.tei || meta.tei || "",
      issi: codeplug.issi || meta.issi || "",
      codeplug: codeplug.codeplug || meta.codeplug || "",
      software: codeplug.software || meta.software || "",
      cpuId: codeplug.cpuId || meta.cpuId || "",
      cpeVersion: codeplug.cpeVersion || meta.cpeVersion || "",
      groupCount: error ? 0 : Number(codeplug.rows?.length || codeplug.groupCount || 0),
      lastParsedAt: record.lastParsedAt || new Date().toISOString(),
      errorType: error ? String(error.name || "Error") : "",
      errorMessage: error ? String(error.message || error) : "",
      parserVersion: this.parserVersion,
    };
    const fileId = Number(this.upsertFile.get(values).id);
    this.deleteTalkgroups.run(fileId);

    if (!error) {
      for (const row of codeplug.rows || []) {
        this.insertTalkgroup.run({
          fileId,
          folderRow: row.folderRow === "" ? null : Number(row.folderRow || 0),
          slot: Number(row.slot || 0),
          alias: row.alias || "",
          gssi: Number(row.gssi || 0),
          status: Number(row.status || 0),
          statusText: row.statusText || "",
          codeplug: row.codeplug || values.codeplug,
          software: row.software || values.software,
          serial: row.serial || values.serial,
          issi: row.issi || values.issi,
          assignmentConfidence: row.assignmentConfidence || "",
          networkIndex: Number(row.networkIndex || 0),
          defaultZone: Number(row.defaultZone || 0),
        });
      }
    }
  }

  storeBatch(records) {
    if (records.length > 0) this.storeTransaction(records);
  }

  markExisting(ids) {
    if (ids.length > 0) this.setExistsTransaction(ids, 1);
  }

  markDeleted(ids) {
    if (ids.length > 0) this.setExistsTransaction(ids, 0);
  }

  listExistingFiles() {
    return this.db.prepare("SELECT id, path FROM scanned_files WHERE existsFlag = 1").all();
  }

  hydrateFile(fileOrId) {
    const file = typeof fileOrId === "object" ? fileOrId : this.findFileById.get(fileOrId);
    if (!file) return null;
    const rows = this.findTalkgroups.all(file.id).map((row) => ({
      file: file.path,
      fileName: file.fileName,
      serial: file.serial || "",
      tei: file.tei || "",
      issi: file.issi || "",
      codeplug: row.codeplug || file.codeplug || "",
      software: row.software || file.software || "",
      cpuId: file.cpuId || "",
      folderRow: row.folderRow ?? "",
      slot: row.slot || 0,
      alias: row.alias || "",
      gssi: row.gssi || 0,
      status: row.status || 0,
      statusText: row.statusText || "",
      assignmentConfidence: row.assignmentConfidence || "",
      networkIndex: row.networkIndex || 0,
      defaultZone: row.defaultZone || 0,
      programDate: file.folderDate || "",
      dateKey: file.dateKey || 0,
      programmer: file.programmer || "",
      sourceFolder: file.sourceFolder || "",
    }));
    return {
      path: file.path,
      fileName: file.fileName,
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
      rows,
    };
  }

  startScan(rootPath) {
    return Number(this.startRunStatement.run(path.resolve(rootPath), new Date().toISOString()).lastInsertRowid);
  }

  finishScan(id, stats) {
    this.finishRunStatement.run({
      id,
      finishedAt: new Date().toISOString(),
      foundCount: stats.discovered || 0,
      parsedCount: stats.analyzed || 0,
      cachedCount: stats.reused || 0,
      errorCount: stats.errorCount || 0,
      deletedCount: stats.removed || 0,
    });
  }

  updateScan(id, stats) {
    this.progressRunStatement.run({
      id,
      foundCount: stats.discovered || 0,
      parsedCount: stats.analyzed || 0,
      cachedCount: stats.reused || 0,
      errorCount: stats.errorCount || 0,
      deletedCount: stats.removed || 0,
    });
  }

  getFilesForIssis(issis) {
    const values = [...new Set(issis.map(String).filter(Boolean))];
    const rows = [];
    for (let index = 0; index < values.length; index += 500) {
      const chunk = values.slice(index, index + 500);
      const placeholders = chunk.map(() => "?").join(",");
      rows.push(...this.db.prepare(`
        SELECT * FROM scanned_files
        WHERE existsFlag=1 AND errorMessage='' AND issi IN (${placeholders})
        ORDER BY issi, dateKey DESC, mtimeMs DESC
      `).all(...chunk));
    }
    return rows;
  }

  listErrors() {
    return this.db.prepare(`
      SELECT path AS file, errorType, errorMessage AS message
      FROM scanned_files WHERE existsFlag=1 AND errorMessage<>'' ORDER BY path
    `).all();
  }

  getErrorsForIssis(issis) {
    const values = [...new Set(issis.map(String).filter(Boolean))];
    const rows = [];
    for (let index = 0; index < values.length; index += 500) {
      const chunk = values.slice(index, index + 500);
      const placeholders = chunk.map(() => "?").join(",");
      rows.push(...this.db.prepare(`
        SELECT path AS file, errorType, errorMessage AS message, issi
        FROM scanned_files
        WHERE existsFlag=1 AND errorMessage<>'' AND issi IN (${placeholders})
        ORDER BY path
      `).all(...chunk));
    }
    return rows;
  }

  searchRadios(term, limit = 25) {
    const raw = String(term ?? "").trim();
    if (!raw) return [];
    const lower = raw.toLowerCase();
    const compact = lower.replace(/[\s\-_./\\]+/g, "");
    const compactLike = `%${compact}%`;
    const like = `%${lower}%`;
    return this.db.prepare(`
      SELECT * FROM scanned_files
      WHERE existsFlag=1 AND errorMessage='' AND (
        LOWER(COALESCE(serial,'')) LIKE @like OR
        LOWER(COALESCE(tei,'')) LIKE @like OR
        LOWER(COALESCE(issi,'')) LIKE @like OR
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(serial,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', '') LIKE @compactLike OR
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(tei,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', '') LIKE @compactLike OR
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(issi,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', '') LIKE @compactLike
      )
      ORDER BY
        CASE
          WHEN LOWER(COALESCE(serial,'')) = @lower OR LOWER(COALESCE(tei,'')) = @lower OR LOWER(COALESCE(issi,'')) = @lower THEN 0
          WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(serial,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', '') = @compact THEN 1
          WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(tei,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', '') = @compact THEN 1
          WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(issi,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', '') = @compact THEN 1
          ELSE 2
        END,
        dateKey DESC, mtimeMs DESC
      LIMIT @limit
    `).all({
      like,
      lower,
      compact,
      compactLike,
      limit: Math.max(1, Math.min(100, Number(limit) || 25)),
    });
  }

  diagnostics() {
    const pendingByCodeplug = this.db.prepare(`
      SELECT COALESCE(NULLIF(codeplug,''), 'Sin CP identificable') AS codeplug,
        COUNT(*) AS count
      FROM scanned_files
      WHERE existsFlag=1 AND errorMessage<>''
      GROUP BY COALESCE(NULLIF(codeplug,''), 'Sin CP identificable')
      ORDER BY count DESC, codeplug
    `).all();
    const errorsByType = this.db.prepare(`
      SELECT COALESCE(NULLIF(errorMessage,''), NULLIF(errorType,''), 'Error') AS error,
        COUNT(*) AS count
      FROM scanned_files
      WHERE existsFlag=1 AND errorMessage<>''
      GROUP BY COALESCE(NULLIF(errorMessage,''), NULLIF(errorType,''), 'Error')
      ORDER BY count DESC, error
      LIMIT 30
    `).all();
    return { pendingByCodeplug, errorsByType };
  }

  status(rootPath = "") {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS indexedFiles,
        COALESCE(SUM(groupCount), 0) AS storedGroups,
        COALESCE(SUM(CASE WHEN errorMessage<>'' THEN 1 ELSE 0 END), 0) AS errorFiles
      FROM scanned_files WHERE existsFlag=1
    `).get();
    const latest = rootPath
      ? this.db.prepare("SELECT * FROM scan_runs WHERE rootPath=? ORDER BY id DESC LIMIT 1").get(path.resolve(rootPath))
      : this.db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get();
    return {
      ...totals,
      databasePath: this.filePath,
      journalMode: "WAL",
      latestScan: latest || null,
    };
  }

  getMeta(key) {
    return this.getMetaStatement.get(key)?.value || "";
  }

  setMeta(key, value) {
    this.setMetaStatement.run(key, String(value));
  }

  close() {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // El cierre sigue siendo seguro aunque otro lector impida truncar el WAL.
    }
    this.db.close();
  }
}

module.exports = { CpeDatabase };
