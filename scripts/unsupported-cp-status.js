const path = require("path");
const Database = require("better-sqlite3");

const databasePath = process.env.CPE_DB_FILE || path.join(__dirname, "..", "data", "cpe-dashboard.sqlite");
const db = new Database(databasePath, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT CASE WHEN codeplug='' THEN '(desconocido)' ELSE codeplug END AS codeplug,
         COUNT(1) AS cantidad
  FROM scanned_files
  WHERE existsFlag=1 AND errorMessage LIKE 'Codeplug % no soportado todavia'
  GROUP BY codeplug
  ORDER BY cantidad DESC, codeplug
`).all();
const unreadable = db.prepare(`
  SELECT errorType, errorMessage, COUNT(1) AS cantidad,
         MIN(path) AS ejemplo, MIN(size) AS tamanoMinimo, MAX(size) AS tamanoMaximo
  FROM scanned_files
  WHERE existsFlag=1 AND errorMessage<>''
    AND errorMessage NOT LIKE 'Codeplug % no soportado todavia'
  GROUP BY errorType, errorMessage
  ORDER BY cantidad DESC, errorMessage
`).all();

console.log(JSON.stringify({
  familias: rows.length,
  archivos: rows.reduce((sum, row) => sum + row.cantidad, 0),
  rows,
  erroresLectura: unreadable,
}, null, 2));
db.close();
