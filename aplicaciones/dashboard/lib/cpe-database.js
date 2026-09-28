const fs = require("fs");
const path = require("path");
let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  throw new Error(`No se pudo cargar SQLite. Ejecuta npm install (${error.message})`);
}

const SCHEMA_VERSION = 9;

function parseFeatures(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

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
        emergencySupported INTEGER NOT NULL DEFAULT 0,
        emergencyAddressType TEXT,
        emergencyMode TEXT,
        emergencyAlias TEXT,
        emergencyGssi INTEGER NOT NULL DEFAULT 0,
        emergencyAttachment INTEGER NOT NULL DEFAULT 0,
        emergencyConfidence TEXT,
        featuresJson TEXT,
        agendaHash TEXT,
        agendaState TEXT,
        agendaConfidence TEXT,
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

      CREATE TABLE IF NOT EXISTS contact_agendas (
        hash TEXT PRIMARY KEY,
        contactCount INTEGER NOT NULL DEFAULT 0,
        contactsJson TEXT NOT NULL,
        confidence TEXT,
        parserVersion TEXT NOT NULL,
        createdAt TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS cpe_projects (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'RECIBIDO',
        responsible TEXT NOT NULL,
        sourceFileName TEXT NOT NULL,
        sourceFilePath TEXT NOT NULL,
        fileSha256 TEXT NOT NULL,
        schemaVersion TEXT NOT NULL,
        razonSocial TEXT,
        ruc TEXT,
        contractRef TEXT,
        radioCount INTEGER NOT NULL DEFAULT 0,
        groupCount INTEGER NOT NULL DEFAULT 0,
        warningCount INTEGER NOT NULL DEFAULT 0,
        warningsJson TEXT,
        requestJson TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cpe_project_radio_validations (
        id INTEGER PRIMARY KEY,
        projectCode TEXT NOT NULL REFERENCES cpe_projects(code) ON DELETE CASCADE,
        expectedIssi TEXT,
        actualIssi TEXT,
        actualSerial TEXT,
        actualTei TEXT,
        fileName TEXT NOT NULL,
        filePath TEXT,
        fileSha256 TEXT NOT NULL,
        validatedAt TEXT NOT NULL,
        programmer TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'DASHBOARD',
        status TEXT NOT NULL,
        failedCount INTEGER NOT NULL DEFAULT 0,
        resultJson TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cpe_project_publications (
        id INTEGER PRIMARY KEY,
        projectCode TEXT NOT NULL UNIQUE REFERENCES cpe_projects(code) ON DELETE CASCADE,
        requestedAt TEXT NOT NULL,
        startedAt TEXT,
        completedAt TEXT,
        nextAttemptAt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDIENTE',
        attempts INTEGER NOT NULL DEFAULT 0,
        errorMessage TEXT,
        detailsJson TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scanned_files_exists ON scanned_files(existsFlag);
      CREATE INDEX IF NOT EXISTS idx_scanned_files_status
        ON scanned_files(existsFlag, groupCount, errorMessage);
      CREATE INDEX IF NOT EXISTS idx_scanned_files_issi_freshness
        ON scanned_files(issi, existsFlag, dateKey DESC, mtimeMs DESC);
      CREATE INDEX IF NOT EXISTS idx_scanned_files_issi_lookup
        ON scanned_files(existsFlag, LOWER(issi), dateKey DESC, mtimeMs DESC);
      CREATE INDEX IF NOT EXISTS idx_scanned_files_serial_lookup
        ON scanned_files(existsFlag, LOWER(serial), dateKey DESC, mtimeMs DESC);
      CREATE INDEX IF NOT EXISTS idx_scanned_files_tei_lookup
        ON scanned_files(existsFlag, LOWER(tei), dateKey DESC, mtimeMs DESC);
      CREATE INDEX IF NOT EXISTS idx_talkgroups_file ON talkgroups(fileId, folderRow, slot);
      CREATE INDEX IF NOT EXISTS idx_scan_runs_root ON scan_runs(rootPath, id DESC);
      CREATE INDEX IF NOT EXISTS idx_cpe_projects_created ON cpe_projects(createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_cpe_projects_hash ON cpe_projects(fileSha256);
      CREATE INDEX IF NOT EXISTS idx_cpe_project_radio_validations
        ON cpe_project_radio_validations(projectCode, expectedIssi, id DESC);
      CREATE INDEX IF NOT EXISTS idx_cpe_project_publications_pending
        ON cpe_project_publications(status, nextAttemptAt, id);
    `);
    const talkgroupColumns = new Set(
      this.db.prepare("PRAGMA table_info(talkgroups)").all().map((column) => column.name)
    );
    if (!talkgroupColumns.has("assignmentConfidence")) {
      this.db.exec("ALTER TABLE talkgroups ADD COLUMN assignmentConfidence TEXT");
    }
    const scannedFileColumns = new Set(
      this.db.prepare("PRAGMA table_info(scanned_files)").all().map((column) => column.name)
    );
    const scannedFileMigrations = [
      ["emergencySupported", "INTEGER NOT NULL DEFAULT 0"],
      ["emergencyAddressType", "TEXT"],
      ["emergencyMode", "TEXT"],
      ["emergencyAlias", "TEXT"],
      ["emergencyGssi", "INTEGER NOT NULL DEFAULT 0"],
      ["emergencyAttachment", "INTEGER NOT NULL DEFAULT 0"],
      ["emergencyConfidence", "TEXT"],
      ["featuresJson", "TEXT"],
      ["agendaHash", "TEXT"],
      ["agendaState", "TEXT"],
      ["agendaConfidence", "TEXT"],
    ];
    for (const [column, definition] of scannedFileMigrations) {
      if (!scannedFileColumns.has(column)) {
        this.db.exec(`ALTER TABLE scanned_files ADD COLUMN ${column} ${definition}`);
      }
    }
    const projectColumns = new Set(
      this.db.prepare("PRAGMA table_info(cpe_projects)").all().map((column) => column.name)
    );
    const projectMigrations = [
      ["modelFileName", "TEXT"],
      ["modelFilePath", "TEXT"],
      ["modelFileSha256", "TEXT"],
      ["modelValidatedAt", "TEXT"],
      ["modelValidationJson", "TEXT"],
    ];
    for (const [column, definition] of projectMigrations) {
      if (!projectColumns.has(column)) {
        this.db.exec(`ALTER TABLE cpe_projects ADD COLUMN ${column} ${definition}`);
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_scanned_files_agenda ON scanned_files(agendaHash)");
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  prepareStatements() {
    this.findFile = this.db.prepare("SELECT * FROM scanned_files WHERE path = ?");
    this.findFileById = this.db.prepare("SELECT * FROM scanned_files WHERE id = ?");
    this.findTalkgroups = this.db.prepare(`
      SELECT * FROM talkgroups WHERE fileId = ?
      ORDER BY CASE WHEN gssi > 0 THEN 0 ELSE 1 END, gssi, alias, folderRow, slot, id
    `);
    this.findAgenda = this.db.prepare("SELECT * FROM contact_agendas WHERE hash = ?");
    this.upsertAgenda = this.db.prepare(`
      INSERT INTO contact_agendas(hash, contactCount, contactsJson, confidence, parserVersion, createdAt)
      VALUES (@hash, @contactCount, @contactsJson, @confidence, @parserVersion, @createdAt)
      ON CONFLICT(hash) DO UPDATE SET
        contactCount=excluded.contactCount, contactsJson=excluded.contactsJson,
        confidence=excluded.confidence, parserVersion=excluded.parserVersion
    `);
    this.upsertFile = this.db.prepare(`
      INSERT INTO scanned_files (
        path, fileName, size, mtimeMs, existsFlag, folderDate, dateKey,
        sourceFolder, programmer, serial, tei, issi, codeplug, software,
        cpuId, cpeVersion, emergencySupported, emergencyAddressType,
        emergencyMode, emergencyAlias, emergencyGssi, emergencyAttachment,
        emergencyConfidence, featuresJson, agendaHash, agendaState, agendaConfidence,
        groupCount, lastParsedAt, errorType, errorMessage,
        parserVersion
      ) VALUES (
        @path, @fileName, @size, @mtimeMs, 1, @folderDate, @dateKey,
        @sourceFolder, @programmer, @serial, @tei, @issi, @codeplug, @software,
        @cpuId, @cpeVersion, @emergencySupported, @emergencyAddressType,
        @emergencyMode, @emergencyAlias, @emergencyGssi, @emergencyAttachment,
        @emergencyConfidence, @featuresJson, @agendaHash, @agendaState, @agendaConfidence,
        @groupCount, @lastParsedAt, @errorType,
        @errorMessage, @parserVersion
      )
      ON CONFLICT(path) DO UPDATE SET
        fileName=excluded.fileName, size=excluded.size, mtimeMs=excluded.mtimeMs,
        existsFlag=1, folderDate=excluded.folderDate, dateKey=excluded.dateKey,
        sourceFolder=excluded.sourceFolder, programmer=excluded.programmer,
        serial=excluded.serial, tei=excluded.tei, issi=excluded.issi,
        codeplug=excluded.codeplug, software=excluded.software, cpuId=excluded.cpuId,
        cpeVersion=excluded.cpeVersion, emergencySupported=excluded.emergencySupported,
        emergencyAddressType=excluded.emergencyAddressType,
        emergencyMode=excluded.emergencyMode, emergencyAlias=excluded.emergencyAlias,
        emergencyGssi=excluded.emergencyGssi,
        emergencyAttachment=excluded.emergencyAttachment,
        emergencyConfidence=excluded.emergencyConfidence,
        featuresJson=excluded.featuresJson,
        agendaHash=excluded.agendaHash, agendaState=excluded.agendaState,
        agendaConfidence=excluded.agendaConfidence,
        groupCount=excluded.groupCount,
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
    this.updateFeaturesStatement = this.db.prepare(`
      UPDATE scanned_files
      SET featuresJson=?, parserVersion=?, lastParsedAt=?
      WHERE id=?
    `);
    this.updateAgendaStatement = this.db.prepare(`
      UPDATE scanned_files
      SET agendaHash=?, agendaState=?, agendaConfidence=?, parserVersion=?, lastParsedAt=?
      WHERE id=?
    `);
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
      fileRow.parserVersion === this.parserVersion
    );
  }

  storeOne(record) {
    const codeplug = record.codeplug || {};
    const meta = record.meta || codeplug;
    const error = record.error || null;
    const agenda = !error && codeplug.agenda && typeof codeplug.agenda === "object"
      ? codeplug.agenda : null;
    if (agenda?.supported && agenda.hash) {
      this.upsertAgenda.run({
        hash: agenda.hash,
        contactCount: Number(agenda.count || agenda.contacts?.length || 0),
        contactsJson: JSON.stringify(agenda.contacts || []),
        confidence: agenda.confidence || "",
        parserVersion: this.parserVersion,
        createdAt: new Date().toISOString(),
      });
    }
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
      emergencySupported: codeplug.emergencySupported ? 1 : 0,
      emergencyAddressType: codeplug.emergencyAddressType || "",
      emergencyMode: codeplug.emergencyMode || "No disponible",
      emergencyAlias: codeplug.emergencyAlias || "",
      emergencyGssi: Number(codeplug.emergencyGssi || 0),
      emergencyAttachment: codeplug.emergencyAttachment ? 1 : 0,
      emergencyConfidence: codeplug.emergencyConfidence || "",
      featuresJson: codeplug.features ? JSON.stringify(codeplug.features) : "",
      agendaHash: agenda?.supported ? agenda.hash || "" : "",
      agendaState: agenda?.supported ? agenda.state || "Sin contactos" : "No disponible",
      agendaConfidence: agenda?.supported ? agenda.confidence || "" : "",
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

  updateFeatures(id, features) {
    this.updateFeaturesStatement.run(
      features ? JSON.stringify(features) : "",
      this.parserVersion,
      new Date().toISOString(),
      Number(id),
    );
  }

  updateAgenda(id, agenda) {
    const supported = Boolean(agenda?.supported && agenda.hash);
    if (supported) {
      this.upsertAgenda.run({
        hash: agenda.hash,
        contactCount: Number(agenda.count || agenda.contacts?.length || 0),
        contactsJson: JSON.stringify(agenda.contacts || []),
        confidence: agenda.confidence || "",
        parserVersion: this.parserVersion,
        createdAt: new Date().toISOString(),
      });
    }
    this.updateAgendaStatement.run(
      supported ? agenda.hash : "",
      supported ? agenda.state || "Sin contactos" : "No disponible",
      supported ? agenda.confidence || "" : "",
      this.parserVersion,
      new Date().toISOString(),
      Number(id),
    );
  }

  hydrateAgenda(fileOrId) {
    const file = typeof fileOrId === "object" ? fileOrId : this.findFileById.get(fileOrId);
    if (!file || !file.agendaHash) {
      return { supported: false, state: file?.agendaState || "No disponible", count: 0, hash: "", confidence: "", contacts: [] };
    }
    const row = this.findAgenda.get(file.agendaHash);
    if (!row) {
      return { supported: false, state: "No disponible", count: 0, hash: "", confidence: "", contacts: [] };
    }
    let contacts = [];
    try { contacts = JSON.parse(row.contactsJson || "[]"); } catch { contacts = []; }
    return {
      supported: true,
      state: file.agendaState || (contacts.length ? "Con contactos" : "Sin contactos"),
      count: contacts.length,
      hash: row.hash,
      confidence: file.agendaConfidence || row.confidence || "",
      contacts,
    };
  }

  listExistingFiles() {
    return this.db.prepare("SELECT id, path FROM scanned_files WHERE existsFlag = 1").all();
  }

  hydrateFile(fileOrId) {
    const file = typeof fileOrId === "object" ? fileOrId : this.findFileById.get(fileOrId);
    if (!file) return null;
    // Un codeplug comparte la misma configuracion funcional en todos sus grupos.
    // Decodificar featuresJson por cada fila multiplicaba CPU y memoria en Fleet Map.
    const features = parseFeatures(file.featuresJson);
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
      emergencySupported: Boolean(file.emergencySupported),
      emergencyAddressType: file.emergencyAddressType || "",
      emergencyMode: file.emergencyMode || "No disponible",
      emergencyAlias: file.emergencyAlias || "",
      emergencyGssi: Number(file.emergencyGssi || 0),
      emergencyAttachment: Boolean(file.emergencyAttachment),
      emergencyConfidence: file.emergencyConfidence || "",
      features,
      agenda: this.hydrateAgenda(file),
    }));
    return {
      id: file.id,
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
      emergencySupported: Boolean(file.emergencySupported),
      emergencyAddressType: file.emergencyAddressType || "",
      emergencyMode: file.emergencyMode || "No disponible",
      emergencyAlias: file.emergencyAlias || "",
      emergencyGssi: Number(file.emergencyGssi || 0),
      emergencyAttachment: Boolean(file.emergencyAttachment),
      emergencyConfidence: file.emergencyConfidence || "",
      features,
      featuresJson: file.featuresJson || "",
      parserVersion: file.parserVersion || "",
      errorMessage: file.errorMessage || "",
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
    if (!compact) return [];
    const escapeLike = (value) => value.replace(/[!%_]/g, "!$&");
    const compactLike = `%${escapeLike(compact)}%`;
    const like = `%${escapeLike(lower)}%`;
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const exact = this.db.prepare(`
      SELECT * FROM scanned_files
      WHERE existsFlag=1 AND (
        LOWER(serial)=@lower OR LOWER(tei)=@lower OR LOWER(issi)=@lower
      )
      ORDER BY dateKey DESC, mtimeMs DESC
      LIMIT @limit
    `).all({ lower, limit: safeLimit });
    if (exact.length) return exact;
    return this.db.prepare(`
      SELECT * FROM scanned_files
      WHERE existsFlag=1 AND (
        LOWER(COALESCE(serial,'')) LIKE @like ESCAPE '!' OR
        LOWER(COALESCE(tei,'')) LIKE @like ESCAPE '!' OR
        LOWER(COALESCE(issi,'')) LIKE @like ESCAPE '!' OR
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(serial,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', ''), '.', '') LIKE @compactLike ESCAPE '!' OR
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(tei,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', ''), '.', '') LIKE @compactLike ESCAPE '!' OR
        REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(issi,'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', ''), '.', '') LIKE @compactLike ESCAPE '!'
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
      limit: safeLimit,
    });
  }

  searchRadiosByFields(filters = {}, limit = 25) {
    const fields = ["issi", "serial", "tei"];
    const params = { limit: Math.max(1, Math.min(100, Number(limit) || 25)) };
    const conditions = [];
    const exactConditions = [];
    const exactRanks = [];
    const compactSql = (field) => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(${field},'')), ' ', ''), '-', ''), '_', ''), '/', ''), '\\', ''), '.', '')`;
    const escapeLike = (value) => value.replace(/[!%_]/g, "!$&");

    for (const field of fields) {
      const raw = String(filters[field] ?? "").trim();
      if (!raw) continue;
      const lower = raw.toLowerCase();
      const compact = lower.replace(/[\s\-_./\\]+/g, "");
      if (!compact) return [];
      params[`${field}Like`] = `%${escapeLike(lower)}%`;
      params[`${field}CompactLike`] = `%${escapeLike(compact)}%`;
      params[`${field}Lower`] = lower;
      params[`${field}Compact`] = compact;
      exactConditions.push(`LOWER(${field}) = @${field}Lower`);
      conditions.push(`(
        LOWER(COALESCE(${field},'')) LIKE @${field}Like ESCAPE '!' OR
        ${compactSql(field)} LIKE @${field}CompactLike ESCAPE '!'
      )`);
      exactRanks.push(`CASE WHEN LOWER(COALESCE(${field},'')) = @${field}Lower OR ${compactSql(field)} = @${field}Compact THEN 0 ELSE 1 END`);
    }

    if (!conditions.length) return [];
    const exact = this.db.prepare(`
      SELECT * FROM scanned_files
      WHERE existsFlag=1 AND ${exactConditions.join(" AND ")}
      ORDER BY dateKey DESC, mtimeMs DESC
      LIMIT @limit
    `).all(params);
    if (exact.length) return exact;
    return this.db.prepare(`
      SELECT * FROM scanned_files
      WHERE existsFlag=1 AND ${conditions.join(" AND ")}
      ORDER BY ${exactRanks.join(" + ")}, dateKey DESC, mtimeMs DESC
      LIMIT @limit
    `).all(params);
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

  healthSummary() {
    return this.db.prepare(`
      SELECT
        COUNT(*) AS indexedFiles,
        COALESCE(SUM(CASE WHEN COALESCE(errorMessage,'')='' THEN 1 ELSE 0 END), 0) AS correctFiles,
        COALESCE(SUM(CASE
          WHEN COALESCE(errorMessage,'')<>'' AND LOWER(errorMessage) LIKE '%no soportado%' THEN 1
          ELSE 0
        END), 0) AS unsupportedFiles,
        COALESCE(SUM(CASE
          WHEN COALESCE(errorMessage,'')<>'' AND LOWER(errorMessage) NOT LIKE '%no soportado%' THEN 1
          ELSE 0
        END), 0) AS corruptFiles
      FROM scanned_files
      WHERE existsFlag=1
    `).get();
  }

  getMeta(key) {
    return this.getMetaStatement.get(key)?.value || "";
  }

  setMeta(key, value) {
    this.setMetaStatement.run(key, String(value));
  }

  nextCpeProjectCode(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const prefix = `CPE-${year}${month}${day}-`;
    const latest = this.db.prepare(`
      SELECT code FROM cpe_projects
      WHERE code LIKE ?
      ORDER BY code DESC
      LIMIT 1
    `).get(`${prefix}%`);
    const lastSequence = Number(String(latest?.code || "").slice(prefix.length)) || 0;
    return `${prefix}${String(lastSequence + 1).padStart(3, "0")}`;
  }

  findCpeProjectByHash(fileSha256) {
    const row = this.db.prepare(`
      SELECT * FROM cpe_projects WHERE fileSha256=? ORDER BY id DESC LIMIT 1
    `).get(String(fileSha256 || ""));
    return row ? this.hydrateCpeProject(row, true) : null;
  }

  createCpeProject(project) {
    const now = project.createdAt || new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO cpe_projects (
        code, createdAt, updatedAt, status, responsible, sourceFileName,
        sourceFilePath, fileSha256, schemaVersion, razonSocial, ruc,
        contractRef, radioCount, groupCount, warningCount, warningsJson, requestJson
      ) VALUES (
        @code, @createdAt, @updatedAt, @status, @responsible, @sourceFileName,
        @sourceFilePath, @fileSha256, @schemaVersion, @razonSocial, @ruc,
        @contractRef, @radioCount, @groupCount, @warningCount, @warningsJson, @requestJson
      )
    `).run({
      code: project.code,
      createdAt: now,
      updatedAt: now,
      status: project.status || "RECIBIDO",
      responsible: project.responsible,
      sourceFileName: project.sourceFileName,
      sourceFilePath: project.sourceFilePath,
      fileSha256: project.fileSha256,
      schemaVersion: project.schemaVersion,
      razonSocial: project.razonSocial || "",
      ruc: project.ruc || "",
      contractRef: project.contractRef || "",
      radioCount: Number(project.radioCount || 0),
      groupCount: Number(project.groupCount || 0),
      warningCount: Number(project.warnings?.length || 0),
      warningsJson: JSON.stringify(project.warnings || []),
      requestJson: JSON.stringify(project.request || {}),
    });
    return this.hydrateCpeProject(this.db.prepare("SELECT * FROM cpe_projects WHERE id=?").get(result.lastInsertRowid), true);
  }

  hydrateCpeProject(row, includeRequest = false) {
    if (!row) return null;
    const project = {
      id: row.id,
      code: row.code,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.status,
      responsible: row.responsible,
      sourceFileName: row.sourceFileName,
      sourceFilePath: row.sourceFilePath,
      fileSha256: row.fileSha256,
      schemaVersion: row.schemaVersion,
      razonSocial: row.razonSocial || "",
      ruc: row.ruc || "",
      contractRef: row.contractRef || "",
      radioCount: Number(row.radioCount || 0),
      groupCount: Number(row.groupCount || 0),
      warningCount: Number(row.warningCount || 0),
      warnings: parseFeatures(row.warningsJson) || [],
      modelFileName: row.modelFileName || "",
      modelFilePath: row.modelFilePath || "",
      modelFileSha256: row.modelFileSha256 || "",
      modelValidatedAt: row.modelValidatedAt || "",
    };
    if (includeRequest) {
      project.request = parseFeatures(row.requestJson) || {};
      project.modelValidation = parseFeatures(row.modelValidationJson) || null;
    }
    return project;
  }

  listCpeProjects(limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.db.prepare(`
      SELECT * FROM cpe_projects ORDER BY createdAt DESC, id DESC LIMIT ?
    `).all(safeLimit).map((row) => this.hydrateCpeProject(row, false));
  }

  getCpeProject(code) {
    const row = this.db.prepare("SELECT * FROM cpe_projects WHERE code=?").get(String(code || ""));
    return this.hydrateCpeProject(row, true);
  }

  updateCpeProjectModelValidation(code, validation) {
    const updatedAt = validation.validatedAt || new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE cpe_projects SET
        updatedAt=?, status=?, modelFileName=?, modelFilePath=?,
        modelFileSha256=?, modelValidatedAt=?, modelValidationJson=?
      WHERE code=?
    `).run(
      updatedAt,
      validation.projectStatus,
      validation.fileName || "",
      validation.filePath || "",
      validation.fileSha256 || "",
      updatedAt,
      JSON.stringify(validation.result || {}),
      String(code || ""),
    );
    if (!result.changes) throw new Error(`No existe el proyecto ${code}`);
    return this.getCpeProject(code);
  }

  hydrateCpeProjectRadioValidation(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      projectCode: row.projectCode,
      expectedIssi: row.expectedIssi || "",
      actualIssi: row.actualIssi || "",
      actualSerial: row.actualSerial || "",
      actualTei: row.actualTei || "",
      fileName: row.fileName,
      filePath: row.filePath || "",
      fileSha256: row.fileSha256,
      validatedAt: row.validatedAt,
      programmer: row.programmer,
      source: row.source,
      status: row.status,
      failedCount: Number(row.failedCount || 0),
      result: parseFeatures(row.resultJson) || {},
    };
  }

  listCpeProjectRadioValidations(code, latestOnly = true) {
    const rows = this.db.prepare(`
      SELECT * FROM cpe_project_radio_validations
      WHERE projectCode=? ORDER BY id DESC
    `).all(String(code || ""));
    if (!latestOnly) return rows.map((row) => this.hydrateCpeProjectRadioValidation(row));
    const seen = new Set();
    const latest = [];
    for (const row of rows) {
      const key = row.expectedIssi ? `ISSI:${row.expectedIssi}` : `ARCHIVO:${row.fileSha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(this.hydrateCpeProjectRadioValidation(row));
    }
    return latest;
  }

  cpeProjectRadioValidationSummary(code) {
    const project = this.getCpeProject(code);
    if (!project) throw new Error(`No existe el proyecto ${code}`);
    const validations = this.listCpeProjectRadioValidations(code, true);
    const matched = validations.filter((item) => item.expectedIssi);
    const approved = matched.filter((item) => item.status === "APROBADO").length;
    const notApproved = validations.filter((item) => item.status !== "APROBADO").length;
    const validated = new Set(matched.map((item) => item.expectedIssi)).size;
    const total = Number(project.radioCount || project.request?.radios?.length || 0);
    return {
      total,
      validated,
      approved,
      notApproved,
      pending: Math.max(0, total - validated),
      allApproved: total > 0 && approved === total,
      validations,
    };
  }

  recordCpeProjectRadioValidation(code, validation) {
    const projectCode = String(code || "");
    if (!this.getCpeProject(projectCode)) throw new Error(`No existe el proyecto ${projectCode}`);
    const result = this.db.prepare(`
      INSERT INTO cpe_project_radio_validations (
        projectCode, expectedIssi, actualIssi, actualSerial, actualTei,
        fileName, filePath, fileSha256, validatedAt, programmer, source,
        status, failedCount, resultJson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectCode,
      validation.expectedIssi || "",
      validation.actualIssi || "",
      validation.actualSerial || "",
      validation.actualTei || "",
      validation.fileName,
      validation.filePath || "",
      validation.fileSha256,
      validation.validatedAt || new Date().toISOString(),
      validation.programmer,
      validation.source || "DASHBOARD",
      validation.status,
      Number(validation.failedCount || 0),
      JSON.stringify(validation.result || {}),
    );
    const summary = this.cpeProjectRadioValidationSummary(projectCode);
    const projectStatus = summary.allApproved ? "RADIOS_APROBADAS" : "RADIOS_EN_VALIDACION";
    this.db.prepare("UPDATE cpe_projects SET status=?, updatedAt=? WHERE code=?")
      .run(projectStatus, new Date().toISOString(), projectCode);
    return {
      validation: this.hydrateCpeProjectRadioValidation(
        this.db.prepare("SELECT * FROM cpe_project_radio_validations WHERE id=?").get(result.lastInsertRowid),
      ),
      summary: this.cpeProjectRadioValidationSummary(projectCode),
      project: this.getCpeProject(projectCode),
    };
  }

  importCpeProjectBundle(bundle) {
    const project = bundle?.project;
    if (!project || !/^CPE-\d{8}-\d{3}$/.test(String(project.code || ""))) {
      throw new Error("Paquete de Proyecto CPE invalido");
    }
    if (!project.request || project.modelValidation?.status !== "APROBADO") {
      throw new Error("El proyecto debe incluir una solicitud y un modelo aprobado");
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO cpe_projects (
        code, createdAt, updatedAt, status, responsible, sourceFileName,
        sourceFilePath, fileSha256, schemaVersion, razonSocial, ruc,
        contractRef, radioCount, groupCount, warningCount, warningsJson,
        requestJson, modelFileName, modelFilePath, modelFileSha256,
        modelValidatedAt, modelValidationJson
      ) VALUES (
        @code, @createdAt, @updatedAt, @status, @responsible, @sourceFileName,
        @sourceFilePath, @fileSha256, @schemaVersion, @razonSocial, @ruc,
        @contractRef, @radioCount, @groupCount, @warningCount, @warningsJson,
        @requestJson, @modelFileName, @modelFilePath, @modelFileSha256,
        @modelValidatedAt, @modelValidationJson
      )
      ON CONFLICT(code) DO UPDATE SET
        updatedAt=excluded.updatedAt, status=excluded.status,
        responsible=excluded.responsible, sourceFileName=excluded.sourceFileName,
        fileSha256=excluded.fileSha256, schemaVersion=excluded.schemaVersion,
        razonSocial=excluded.razonSocial, ruc=excluded.ruc,
        contractRef=excluded.contractRef, radioCount=excluded.radioCount,
        groupCount=excluded.groupCount, warningCount=excluded.warningCount,
        warningsJson=excluded.warningsJson, requestJson=excluded.requestJson,
        modelFileName=excluded.modelFileName,
        modelFileSha256=excluded.modelFileSha256,
        modelValidatedAt=excluded.modelValidatedAt,
        modelValidationJson=excluded.modelValidationJson
    `).run({
      code: project.code,
      createdAt: project.createdAt || now,
      updatedAt: now,
      status: "MODELO_APROBADO",
      responsible: project.responsible || "",
      sourceFileName: project.sourceFileName || "solicitud-cliente.xlsx",
      sourceFilePath: "",
      fileSha256: project.fileSha256 || "",
      schemaVersion: project.schemaVersion || "",
      razonSocial: project.razonSocial || "",
      ruc: project.ruc || "",
      contractRef: project.contractRef || "",
      radioCount: Number(project.radioCount || project.request?.radios?.length || 0),
      groupCount: Number(project.groupCount || 0),
      warningCount: Number(project.warnings?.length || 0),
      warningsJson: JSON.stringify(project.warnings || []),
      requestJson: JSON.stringify(project.request),
      modelFileName: project.modelFileName || "modelo-aprobado.cpe",
      modelFilePath: "",
      modelFileSha256: project.modelFileSha256 || "",
      modelValidatedAt: project.modelValidatedAt || now,
      modelValidationJson: JSON.stringify(project.modelValidation),
    });
    return this.getCpeProject(project.code);
  }

  findCpeProjectRadioValidationByHash(code, fileSha256) {
    const row = this.db.prepare(`
      SELECT * FROM cpe_project_radio_validations
      WHERE projectCode=? AND fileSha256=?
      ORDER BY id DESC LIMIT 1
    `).get(String(code || ""), String(fileSha256 || ""));
    return this.hydrateCpeProjectRadioValidation(row);
  }

  queueCpeProjectPublication(code) {
    const projectCode = String(code || "");
    const summary = this.cpeProjectRadioValidationSummary(projectCode);
    if (!summary.allApproved) throw new Error("No se puede publicar un proyecto con radios pendientes o no aprobadas");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO cpe_project_publications (
        projectCode, requestedAt, nextAttemptAt, status, attempts, errorMessage, detailsJson
      ) VALUES (?, ?, ?, 'PENDIENTE', 0, '', '')
      ON CONFLICT(projectCode) DO UPDATE SET
        nextAttemptAt=CASE WHEN status='PUBLICADO' THEN nextAttemptAt ELSE excluded.nextAttemptAt END,
        status=CASE WHEN status='PUBLICADO' THEN status ELSE 'PENDIENTE' END,
        errorMessage=CASE WHEN status='PUBLICADO' THEN errorMessage ELSE '' END
    `).run(projectCode, now, now);
    this.db.prepare("UPDATE cpe_projects SET status=?, updatedAt=? WHERE code=? AND status<>'PUBLICADO'")
      .run("PUBLICACION_PENDIENTE", now, projectCode);
    return this.getCpeProjectPublication(projectCode);
  }

  hydrateCpeProjectPublication(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      projectCode: row.projectCode,
      requestedAt: row.requestedAt,
      startedAt: row.startedAt || "",
      completedAt: row.completedAt || "",
      nextAttemptAt: row.nextAttemptAt,
      status: row.status,
      attempts: Number(row.attempts || 0),
      errorMessage: row.errorMessage || "",
      details: parseFeatures(row.detailsJson) || null,
    };
  }

  getCpeProjectPublication(code) {
    return this.hydrateCpeProjectPublication(
      this.db.prepare("SELECT * FROM cpe_project_publications WHERE projectCode=?").get(String(code || "")),
    );
  }

  listCpeProjectPublications(limit = 50) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.db.prepare("SELECT * FROM cpe_project_publications ORDER BY id DESC LIMIT ?")
      .all(safeLimit).map((row) => this.hydrateCpeProjectPublication(row));
  }

  claimNextCpeProjectPublication(now = new Date()) {
    const iso = now.toISOString();
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM cpe_project_publications
        WHERE status IN ('PENDIENTE','ERROR','ESPERANDO_ACCESO') AND nextAttemptAt<=?
        ORDER BY id LIMIT 1
      `).get(iso);
      if (!row) return null;
      this.db.prepare(`
        UPDATE cpe_project_publications
        SET status='PUBLICANDO', startedAt=?, attempts=attempts+1, errorMessage=''
        WHERE id=?
      `).run(iso, row.id);
      return this.db.prepare("SELECT * FROM cpe_project_publications WHERE id=?").get(row.id);
    });
    return this.hydrateCpeProjectPublication(transaction());
  }

  completeCpeProjectPublication(code, details) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE cpe_project_publications
      SET status='PUBLICADO', completedAt=?, nextAttemptAt=?, errorMessage='', detailsJson=?
      WHERE projectCode=?
    `).run(now, now, JSON.stringify(details || {}), String(code || ""));
    this.db.prepare("UPDATE cpe_projects SET status='PUBLICADO', updatedAt=? WHERE code=?")
      .run(now, String(code || ""));
    return this.getCpeProjectPublication(code);
  }

  failCpeProjectPublication(code, errorMessage, nextAttemptAt) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE cpe_project_publications
      SET status='ERROR', completedAt='', nextAttemptAt=?, errorMessage=?
      WHERE projectCode=?
    `).run(new Date(nextAttemptAt).toISOString(), String(errorMessage || "Error de publicacion").slice(0, 2000), String(code || ""));
    this.db.prepare("UPDATE cpe_projects SET status='PUBLICACION_PENDIENTE', updatedAt=? WHERE code=?")
      .run(now, String(code || ""));
    return this.getCpeProjectPublication(code);
  }

  deferCpeProjectPublication(code, message, nextAttemptAt) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE cpe_project_publications
      SET status='ESPERANDO_ACCESO', completedAt='', nextAttemptAt=?, errorMessage=?
      WHERE projectCode=?
    `).run(new Date(nextAttemptAt).toISOString(), String(message || "Acceso externo pendiente").slice(0, 2000), String(code || ""));
    this.db.prepare("UPDATE cpe_projects SET status='PUBLICACION_PENDIENTE', updatedAt=? WHERE code=?")
      .run(now, String(code || ""));
    return this.getCpeProjectPublication(code);
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
