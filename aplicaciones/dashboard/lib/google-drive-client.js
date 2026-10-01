const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function escapeDriveQuery(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function md5File(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

class GoogleDriveClient {
  constructor(options = {}) {
    this.folderId = String(options.folderId || "").trim();
    this.credentialsFile = path.resolve(String(options.credentialsFile || ""));
    this.fetch = options.fetch || globalThis.fetch;
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    if (typeof this.fetch !== "function") throw new Error("Esta version de Node.js no incluye fetch");
  }

  status() {
    if (!this.folderId) return { configured: false, error: "Falta folderId de Google Drive" };
    if (!fs.existsSync(this.credentialsFile)) {
      return { configured: false, error: `Falta la clave de cuenta de servicio: ${this.credentialsFile}` };
    }
    try {
      const credentials = JSON.parse(fs.readFileSync(this.credentialsFile, "utf8").replace(/^\uFEFF/, ""));
      if (!credentials.client_email || !credentials.private_key) throw new Error("La clave no contiene client_email/private_key");
      return { configured: true, account: credentials.client_email, folderId: this.folderId };
    } catch (error) {
      return { configured: false, error: `Clave de Drive invalida: ${error.message}` };
    }
  }

  credentials() {
    const state = this.status();
    if (!state.configured) throw new Error(state.error);
    return JSON.parse(fs.readFileSync(this.credentialsFile, "utf8").replace(/^\uFEFF/, ""));
  }

  async token() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    const credentials = this.credentials();
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), credentials.private_key).toString("base64url");
    const response = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new Error(`Google no entrego un token: ${payload.error_description || payload.error || response.status}`);
    }
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    return this.accessToken;
  }

  async request(url, options = {}) {
    const token = await this.token();
    const response = await this.fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error?.message || `Google Drive respondio ${response.status}`);
    }
    return response;
  }

  async findChild(parentId, name, mimeType = "") {
    const clauses = [
      `'${escapeDriveQuery(parentId)}' in parents`,
      `name='${escapeDriveQuery(name)}'`,
      "trashed=false",
    ];
    if (mimeType) clauses.push(`mimeType='${escapeDriveQuery(mimeType)}'`);
    const query = new URLSearchParams({
      q: clauses.join(" and "),
      fields: "files(id,name,mimeType,md5Checksum,size)",
      pageSize: "10",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const response = await this.request(`https://www.googleapis.com/drive/v3/files?${query}`);
    const payload = await response.json();
    return payload.files?.[0] || null;
  }

  async ensureFolder(parentId, name) {
    const mimeType = "application/vnd.google-apps.folder";
    const existing = await this.findChild(parentId, name, mimeType);
    if (existing) return existing;
    const response = await this.request("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType, parents: [parentId] }),
    });
    return response.json();
  }

  async uploadFile(parentId, name, filePath, mimeType = "application/octet-stream") {
    const existing = await this.findChild(parentId, name);
    if (existing) {
      if (String(existing.md5Checksum || "").toLowerCase() === md5File(filePath)) {
        return { ...existing, alreadyUploaded: true };
      }
      throw new Error(`Ya existe un archivo diferente en Google Drive: ${name}`);
    }
    const boundary = `cpe-${crypto.randomUUID()}`;
    const metadata = { name, parents: [parentId] };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      fs.readFileSync(filePath),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const target = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,md5Checksum,size";
    const response = await this.request(target, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return response.json();
  }

  async uploadTree(rootDirectory, remotePathSegments) {
    const segments = Array.isArray(remotePathSegments)
      ? remotePathSegments.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (!segments.length || segments.some((item) => item === "." || item === ".." || /[\\/]/.test(item))) {
      throw new Error("La ruta remota de Google Drive no es valida");
    }
    let targetFolder = { id: this.folderId };
    for (const segment of segments) targetFolder = await this.ensureFolder(targetFolder.id, segment);
    let uploaded = 0;
    const walk = async (localDirectory, remoteParentId) => {
      const entries = fs.readdirSync(localDirectory, { withFileTypes: true })
        .sort((a, b) => Number(/^MANIFIESTO-/i.test(a.name)) - Number(/^MANIFIESTO-/i.test(b.name)) || a.name.localeCompare(b.name, "es"));
      for (const entry of entries) {
        const localPath = path.join(localDirectory, entry.name);
        if (entry.isDirectory()) {
          const folder = await this.ensureFolder(remoteParentId, entry.name);
          await walk(localPath, folder.id);
        } else if (entry.isFile()) {
          const mimeType = /\.json$/i.test(entry.name) ? "application/json"
            : /\.xlsx$/i.test(entry.name) ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "application/octet-stream";
          const result = await this.uploadFile(remoteParentId, entry.name, localPath, mimeType);
          if (!result.alreadyUploaded) uploaded += 1;
        }
      }
    };
    await walk(rootDirectory, targetFolder.id);
    return { folderId: targetFolder.id, uploaded };
  }
}

module.exports = { GoogleDriveClient, escapeDriveQuery };
