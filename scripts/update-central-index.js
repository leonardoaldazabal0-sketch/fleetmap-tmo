const path = require("path");

const rootPath = process.env.CPE_CENTRAL_ROOT;
if (!rootPath) {
  console.error("Falta la variable CPE_CENTRAL_ROOT");
  process.exit(1);
}

const app = require(path.join(__dirname, "..", "server"));
try {
  const result = app.scanPath(rootPath, { includeRows: false, includeFiles: false });
  console.log(JSON.stringify({
    event: "central-index-complete",
    rootPath: result.scannedPath,
    found: result.fileCount,
    analyzed: result.cache.analyzed,
    cached: result.cache.reused,
    errors: result.errors.length,
    deleted: result.cache.removed,
    groups: result.database.storedGroups,
    finishedAt: new Date().toISOString(),
  }));
} catch (error) {
  console.error(JSON.stringify({
    event: "central-index-error",
    rootPath,
    message: error.message,
    finishedAt: new Date().toISOString(),
  }));
  process.exitCode = 1;
} finally {
  app.database.close();
}
