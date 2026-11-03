const fs = require("fs");
const runtimePaths = require("../lib/runtime-paths");
const path = require("path");
const zlib = require("zlib");

const projectRoot = path.join(__dirname, "..");
const outputPath = runtimePaths.docFile("plan-implementacion-flujo-codeplugs-tmo.docx");

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function run(text, options = {}) {
  const properties = [];
  if (options.bold) properties.push("<w:b/>");
  if (options.italic) properties.push("<w:i/>");
  if (options.color) properties.push(`<w:color w:val="${options.color}"/>`);
  if (options.size) properties.push(`<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>`);
  if (options.font) properties.push(`<w:rFonts w:ascii="${escapeXml(options.font)}" w:hAnsi="${escapeXml(options.font)}"/>`);
  return `<w:r>${properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(content = "", options = {}) {
  const pPr = [];
  if (options.style) pPr.push(`<w:pStyle w:val="${options.style}"/>`);
  if (options.align) pPr.push(`<w:jc w:val="${options.align}"/>`);
  if (options.keepNext) pPr.push("<w:keepNext/>");
  if (options.pageBreakBefore) pPr.push("<w:pageBreakBefore/>");
  if (options.shading) pPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${options.shading}"/>`);
  if (options.indent) pPr.push(`<w:ind w:left="${options.indent}"/>`);
  if (options.before || options.after || options.line) {
    pPr.push(`<w:spacing${options.before ? ` w:before="${options.before}"` : ""}${options.after ? ` w:after="${options.after}"` : ""}${options.line ? ` w:line="${options.line}" w:lineRule="auto"` : ""}/>`);
  }
  const body = Array.isArray(content) ? content.join("") : run(content, options.run || {});
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${body}</w:p>`;
}

function bullet(text, level = 0) {
  return paragraph([run("• ", { bold: true, color: "005F73" }), run(text)], {
    style: "Normal",
    indent: 360 + level * 360,
    after: 70,
  });
}

function numbered(text, number) {
  return paragraph([run(`${number}. `, { bold: true, color: "005F73" }), run(text)], {
    style: "Normal",
    indent: 240,
    after: 90,
  });
}

function codeBlock(lines) {
  return lines.map((line) => paragraph(line, {
    style: "Code",
    shading: "F4F7F8",
    after: 0,
  })).join("");
}

function cell(content, options = {}) {
  const paragraphs = Array.isArray(content)
    ? content.map((item) => paragraph(item, { style: options.header ? "TableHeader" : "TableText", after: 30 })).join("")
    : paragraph(content, { style: options.header ? "TableHeader" : "TableText", after: 30 });
  const tcPr = [
    `<w:tcW w:w="${options.width || 2400}" w:type="dxa"/>`,
    `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill || (options.header ? "005F73" : "FFFFFF")}"/>`,
    "<w:tcMar><w:top w:w=\"100\" w:type=\"dxa\"/><w:left w:w=\"120\" w:type=\"dxa\"/><w:bottom w:w=\"100\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/></w:tcMar>",
  ];
  return `<w:tc><w:tcPr>${tcPr.join("")}</w:tcPr>${paragraphs}</w:tc>`;
}

function table(headers, rows, widths) {
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  const borders = "<w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"D7E1E5\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"D7E1E5\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"D7E1E5\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"D7E1E5\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"D7E1E5\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"D7E1E5\"/></w:tblBorders>";
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  const headerRow = `<w:tr>${headers.map((header, index) => cell(header, { header: true, width: widths[index] })).join("")}</w:tr>`;
  const bodyRows = rows.map((row, rowIndex) => `<w:tr>${row.map((value, index) => cell(value, {
    width: widths[index],
    fill: rowIndex % 2 ? "F4F7F8" : "FFFFFF",
  })).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblLayout w:type="fixed"/>${borders}<w:tblCellMar><w:top w:w="70" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`;
}

function pageBreak() {
  return "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>";
}

const parts = [];

parts.push(paragraph("PLAN DE IMPLEMENTACIÓN", { style: "Title", align: "center", before: 1900, after: 180 }));
parts.push(paragraph("Flujo automático de entrega, organización e indexación de codeplugs TMO", { style: "Subtitle", align: "center", after: 500 }));
parts.push(paragraph("Laptop de campo → Google Drive → VM puente → NAS → FleetMap TMO", { style: "Callout", align: "center", shading: "E9F1F3", after: 700 }));
parts.push(table(
  ["Documento", "Valor"],
  [
    ["Versión", "1.0"],
    ["Fecha", "31 de julio de 2026"],
    ["Estado", "Propuesta para piloto controlado"],
    ["Ruta central", "\\\\192.168.7.252\\tic\\002 Programacion"],
    ["Aplicación", "FleetMap TMO / cpe-dashboard"],
  ],
  [2500, 6500],
));
parts.push(paragraph("Documento complementario", { style: "Heading2", before: 500, after: 100 }));
parts.push(paragraph("Diagrama ejecutivo: docs\\flujo-ejecutivo-fleetmap.drawio", { style: "Normal" }));

parts.push(pageBreak());
parts.push(paragraph("1. Resumen ejecutivo", { style: "Heading1" }));
parts.push(paragraph("El proyecto implementará un flujo controlado para que los técnicos envíen los archivos .cpe desde campo sin ingresar directamente al NAS. Un cargador portátil construirá las carpetas de forma automática, Google Drive transportará el envío y una VM puente validará y copiará los archivos al repositorio oficial. FleetMap actualizará su índice SQLite utilizando el escaneo incremental existente.", { style: "Normal" }));
parts.push(paragraph("Resultado esperado", { style: "Heading2" }));
parts.push(bullet("Todas las programaciones nuevas siguen una estructura única y verificable."));
parts.push(bullet("El técnico selecciona datos de un catálogo; no escribe nombres de clientes o unidades libremente."));
parts.push(bullet("Google Drive funciona como canal de entrega, no como repositorio histórico."));
parts.push(bullet("El NAS continúa siendo la fuente oficial de codeplugs."));
parts.push(bullet("FleetMap detecta automáticamente los archivos nuevos o modificados."));
parts.push(bullet("Los archivos duplicados, incompletos o inconsistentes nunca sobrescriben información existente."));

parts.push(paragraph("2. Alcance", { style: "Heading1" }));
parts.push(table(
  ["Incluido", "No incluido en la primera etapa"],
  [
    ["Catálogo de clientes, unidades y contratistas", "Reorganización masiva de archivos históricos"],
    ["Cargador portátil para laptop", "Carga de los 686 GB históricos a Google Drive"],
    ["Recepción mediante Google Drive", "Acceso directo de técnicos al NAS"],
    ["Servicio automático en VM puente", "Cambios al parser de grupos TMO"],
    ["Copia segura y verificada al NAS", "Eliminación automática de respaldos históricos"],
    ["Actualización incremental de FleetMap", "Exposición de FleetMap directamente a Internet"],
  ],
  [4500, 4500],
));

parts.push(paragraph("3. Arquitectura y responsabilidades", { style: "Heading1" }));
parts.push(paragraph("Flujo principal", { style: "Heading2" }));
parts.push(paragraph("LAPTOP DEL TÉCNICO  →  GOOGLE DRIVE  →  VM PUENTE  →  NAS  →  FLEETMAP TMO", { style: "Callout", align: "center", shading: "E9F1F3" }));
parts.push(table(
  ["Componente", "Responsabilidad", "Control principal"],
  [
    ["Laptop del técnico", "Seleccionar datos y archivos mediante el cargador TMO.", "Sin credenciales ni acceso directo al NAS."],
    ["Google Drive", "Transportar envíos y distribuir el catálogo.", "Carpetas ENTRADA, PROCESADOS, RECHAZADOS y CONFIG."],
    ["VM puente", "Validar, verificar y copiar archivos.", "Hash SHA-256, registro SQLite, reintentos y no sobrescritura."],
    ["NAS", "Conservar la estructura y los archivos oficiales.", "Permisos, snapshots y backups."],
    ["VM FleetMap", "Indexar y presentar información a usuarios.", "SQLite local, escaneo incremental y reconciliación nocturna."],
  ],
  [2200, 4100, 2700],
));

parts.push(pageBreak());
parts.push(paragraph("4. Estructura oficial de carpetas", { style: "Heading1" }));
parts.push(paragraph("La estructura se generará automáticamente. Los elementos entre corchetes son opcionales y no se escribirán literalmente.", { style: "Normal" }));
parts.push(codeBlock([
  "Plantillas x Clientes AÑO",
  "\\TIPO DE CLIENTE",
  "\\CLIENTE",
  "\\[UNIDAD]",
  "\\[CONTRATISTAS\\CONTRATISTA]",
  "\\TIPO DE PROGRAMACION",
  "\\FORM NUMERO",
  "\\AAAAMMDD_INICIALES",
  "\\DESPUES",
  "\\archivo.cpe",
]));
parts.push(paragraph("Ejemplos", { style: "Heading2" }));
parts.push(codeBlock([
  "PRIVADAS\\ATU\\ADICION\\FORM 1389\\20260130_LA\\DESPUES",
  "PRIVADAS CON CONTRATISTAS\\VOLCAN\\ANDAYCHAGUA\\ADICION\\FORM 1389\\20260130_LA\\DESPUES",
  "PRIVADAS CON CONTRATISTAS\\REPSOL\\REFINERIA PAMPILLA\\CONTRATISTAS\\AGEFRED\\CAMBIO\\FORM 598\\20260220_LA\\DESPUES",
]));
parts.push(paragraph("Reglas obligatorias", { style: "Heading2" }));
parts.push(bullet("Nombres de carpetas en mayúsculas y sin caracteres inválidos."));
parts.push(bullet("Código corto y estable para la carpeta del cliente; razón social completa en el catálogo."));
parts.push(bullet("Formulario con formato FORM número."));
parts.push(bullet("Fecha con formato AAAAMMDD_INICIALES."));
parts.push(bullet("Carpeta final escrita exactamente como DESPUES."));
parts.push(bullet("Nunca crear carpetas denominadas Nueva carpeta."));
parts.push(bullet("No sobrescribir un archivo existente con contenido diferente."));

parts.push(paragraph("5. Fases del proyecto", { style: "Heading1" }));
parts.push(table(
  ["Fase", "Resultado", "Condición para avanzar"],
  [
    ["1. Gobierno y catálogo", "Estándar aprobado y catálogo inicial.", "ATU, VOLCAN y REPSOL validados."],
    ["2. Google Drive", "Carpetas y permisos configurados.", "Prueba de subida y descarga exitosa."],
    ["3. Cargador laptop", "Aplicación portátil funcional.", "Genera rutas y manifiestos correctos."],
    ["4. VM puente", "Importador automático y trazable.", "Copia verificada sin sobrescrituras."],
    ["5. Integración FleetMap", "Índice actualizado automáticamente.", "Radio localizable por ISSI, TEI y serial."],
    ["6. Piloto", "Un técnico trabaja durante un periodo controlado.", "Sin pérdida, duplicados ni rutas incorrectas."],
    ["7. Despliegue", "Uso extendido a técnicos autorizados.", "Capacitación y monitoreo activos."],
    ["8. Histórico", "Reorganización gradual de carpetas antiguas.", "Plan separado, hashes y backup aprobados."],
  ],
  [1900, 3900, 3200],
));

parts.push(pageBreak());
parts.push(paragraph("6. Paso a paso de implementación", { style: "Heading1" }));

parts.push(paragraph("Paso 1. Aprobar el estándar y responsables", { style: "Heading2" }));
parts.push(numbered("Designar un responsable funcional del catálogo de clientes.", 1));
parts.push(numbered("Aprobar categorías, tipos de programación e iniciales de técnicos.", 2));
parts.push(numbered("Definir si unidad y contratista son opcionales u obligatorios para cada cliente.", 3));
parts.push(numbered("Establecer que el nuevo estándar aplica desde una fecha definida, sin mover históricos todavía.", 4));
parts.push(paragraph("Criterio de aceptación: existe una norma escrita y un responsable para aprobar altas y cambios.", { style: "Callout", shading: "E3F3F0" }));

parts.push(paragraph("Paso 2. Generar y depurar el catálogo", { style: "Heading2" }));
parts.push(numbered("Extraer clientes, unidades y contratistas de Plantillas x Clientes 2026.", 1));
parts.push(numbered("Separar DEMO y PRUEBAS del catálogo productivo.", 2));
parts.push(numbered("Unificar alias y corregir nombres dudosos sin renombrar carpetas históricas.", 3));
parts.push(numbered("Registrar código, razón social, RUC, nombre de carpeta, unidades y contratistas.", 4));
parts.push(numbered("Publicar catalogo-clientes.json con versión y fecha.", 5));
parts.push(paragraph("Criterio de aceptación: el técnico puede escoger ATU, VOLCAN y REPSOL sin escribir nombres manualmente.", { style: "Callout", shading: "E3F3F0" }));

parts.push(paragraph("Paso 3. Configurar Google Drive", { style: "Heading2" }));
parts.push(codeBlock([
  "FleetMap-TMO\\CONFIG",
  "FleetMap-TMO\\ENTRADA\\INICIALES_TECNICO",
  "FleetMap-TMO\\PROCESADOS",
  "FleetMap-TMO\\RECHAZADOS",
]));
parts.push(numbered("Usar una cuenta corporativa con recuperación y autenticación de dos pasos.", 1));
parts.push(numbered("Dar a cada técnico acceso solamente a las carpetas necesarias.", 2));
parts.push(numbered("Reservar CONFIG para lectura y administración central.", 3));
parts.push(numbered("Definir retención de archivos procesados; propuesta inicial: 90 días.", 4));
parts.push(paragraph("Criterio de aceptación: una laptop sube un archivo y la VM puente puede leerlo sin usar credenciales del NAS en la laptop.", { style: "Callout", shading: "E3F3F0" }));

parts.push(paragraph("Paso 4. Construir el cargador portátil", { style: "Heading2" }));
parts.push(numbered("Crear interfaz para tipo de cliente, cliente, unidad, contratista, tipo, formulario, fecha e iniciales.", 1));
parts.push(numbered("Permitir seleccionar uno o varios .cpe.", 2));
parts.push(numbered("Mostrar la ruta completa antes de confirmar.", 3));
parts.push(numbered("Calcular tamaño y SHA-256 de cada archivo.", 4));
parts.push(numbered("Copiar, no mover, los originales de la laptop.", 5));
parts.push(numbered("Crear manifiesto del envío y el marcador _ENVIO_LISTO.json al final.", 6));
parts.push(numbered("Mantener una cola local cuando no exista Internet.", 7));
parts.push(paragraph("Criterio de aceptación: ningún dato de carpeta depende de escritura libre del técnico.", { style: "Callout", shading: "E3F3F0" }));

parts.push(pageBreak());
parts.push(paragraph("Paso 5. Preparar la VM puente", { style: "Heading2" }));
parts.push(numbered("Confirmar versión de Windows, espacio local y conectividad hacia Google y NAS.", 1));
parts.push(numbered("Crear una cuenta técnica dedicada y restringir sus permisos.", 2));
parts.push(numbered("Definir recepción por Google Drive para escritorio durante el piloto o por Google Drive API en producción.", 3));
parts.push(numbered("No colocar la carpeta sincronizada directamente sobre SMB; usar disco local y copiar al NAS.", 4));
parts.push(numbered("Guardar credenciales fuera del repositorio y protegerlas mediante permisos de Windows.", 5));
parts.push(paragraph("Recomendación: para producción, usar Google Drive API para que el importador funcione como servicio y no dependa de una sesión gráfica abierta.", { style: "Callout", shading: "FFF3D6" }));

parts.push(paragraph("Paso 6. Construir el importador automático", { style: "Heading2" }));
parts.push(numbered("Buscar únicamente envíos con _ENVIO_LISTO.json.", 1));
parts.push(numbered("Validar manifiesto, catálogo, extensión, tamaño y hash.", 2));
parts.push(numbered("Comprobar que la ruta de destino esté dentro de Plantillas x Clientes AÑO.", 3));
parts.push(numbered("Registrar el envío en ingestion.sqlite.", 4));
parts.push(numbered("Copiar al NAS usando primero la extensión temporal .partial.", 5));
parts.push(numbered("Recalcular el hash en el NAS y renombrar a .cpe solamente si coincide.", 6));
parts.push(numbered("Mover el envío a PROCESADOS o RECHAZADOS con una explicación.", 7));
parts.push(numbered("Reintentar automáticamente cuando el NAS o Internet no estén disponibles.", 8));
parts.push(paragraph("Criterio de aceptación: reiniciar la VM durante una copia no produce archivos válidos incompletos ni pérdida del envío.", { style: "Callout", shading: "E3F3F0" }));

parts.push(paragraph("Paso 7. Configurar el NAS", { style: "Heading2" }));
parts.push(numbered("Crear la cuenta svc_cpe_ingest con escritura limitada a la carpeta del año.", 1));
parts.push(numbered("Crear o utilizar una cuenta svc_fleetmap con lectura de la ruta general.", 2));
parts.push(numbered("Activar snapshots o backup antes de automatizar.", 3));
parts.push(numbered("Bloquear acceso directo de técnicos a la ruta central.", 4));
parts.push(numbered("Confirmar que el importador no tenga permiso de borrado masivo.", 5));
parts.push(paragraph("Criterio de aceptación: la VM puente puede crear y verificar un archivo de prueba sin modificar otros archivos.", { style: "Callout", shading: "E3F3F0" }));

parts.push(paragraph("Paso 8. Integrar FleetMap TMO", { style: "Heading2" }));
parts.push(numbered("Mantener fija la ruta \\\\192.168.7.252\\tic\\002 Programacion.", 1));
parts.push(numbered("Agregar un aviso interno protegido desde la VM puente hacia FleetMap.", 2));
parts.push(numbered("Ejecutar el escaneo incremental después de cada lote, no por cada archivo.", 3));
parts.push(numbered("Evitar escaneos simultáneos mediante un bloqueo de ejecución.", 4));
parts.push(numbered("Mantener el escaneo nocturno como reconciliación completa.", 5));
parts.push(numbered("Conservar cpe-dashboard.sqlite en el disco local de la VM FleetMap.", 6));
parts.push(paragraph("Criterio de aceptación: el nuevo radio aparece en búsqueda por serial, TEI o ISSI y sus grupos se consultan sin reanalizar todo el NAS.", { style: "Callout", shading: "E3F3F0" }));

parts.push(paragraph("Paso 9. Configurar continuidad del servicio", { style: "Heading2" }));
parts.push(numbered("Ejecutar importador y FleetMap como servicios o tareas de inicio automático.", 1));
parts.push(numbered("Configurar reinicio automático ante fallas.", 2));
parts.push(numbered("Crear logs rotativos y alertas de último procesamiento.", 3));
parts.push(numbered("Probar reinicio de ambas VM y caída temporal del NAS.", 4));
parts.push(numbered("Restringir el puerto 8787 a la red interna.", 5));

parts.push(pageBreak());
parts.push(paragraph("7. Plan de pruebas", { style: "Heading1" }));
parts.push(table(
  ["Prueba", "Escenario", "Resultado esperado"],
  [
    ["ATU", "Cliente sin unidad ni contratista.", "Ruta ATU/ADICION/FORM/FECHA/DESPUES."],
    ["VOLCAN", "Cliente con unidad ANDAYCHAGUA.", "La unidad aparece en la posición correcta."],
    ["REPSOL", "Unidad REFINERIA PAMPILLA y contratista AGEFRED.", "Se genera CONTRATISTAS/AGEFRED antes del tipo."],
    ["Sin Internet", "Laptop desconectada durante el envío.", "Queda pendiente y continúa al reconectar."],
    ["Archivo duplicado", "Mismo destino y mismo hash.", "Se registra como duplicado sin volver a copiar."],
    ["Colisión", "Mismo nombre y diferente hash.", "Se rechaza; nunca sobrescribe."],
    ["NAS no disponible", "Interrupción temporal del recurso SMB.", "El envío permanece pendiente y se reintenta."],
    ["Reinicio VM", "Reinicio durante una transferencia.", "El proceso continúa desde ingestion.sqlite."],
    ["FleetMap apagado", "NAS recibe archivo con la app detenida.", "FleetMap lo incorpora al volver o en el escaneo nocturno."],
    ["Catálogo antiguo", "Laptop usa una versión no vigente.", "Se solicita actualización antes de aceptar valores nuevos."],
  ],
  [1800, 3400, 3800],
));

parts.push(paragraph("Criterios generales de aceptación", { style: "Heading2" }));
parts.push(bullet("Cero archivos sobrescritos involuntariamente."));
parts.push(bullet("Cero archivos válidos incompletos en el NAS."));
parts.push(bullet("Todos los envíos tienen técnico, fecha, formulario y SHA-256."));
parts.push(bullet("La estructura generada coincide con el catálogo aprobado."));
parts.push(bullet("Los nuevos radios aparecen en FleetMap sin escaneo manual del usuario."));
parts.push(bullet("Los reinicios de las VM no dejan el flujo detenido permanentemente."));

parts.push(paragraph("8. Puesta en producción", { style: "Heading1" }));
parts.push(numbered("Ejecutar piloto con una laptop y tres estructuras: ATU, VOLCAN y REPSOL.", 1));
parts.push(numbered("Mantener el piloto durante un periodo controlado y revisar logs diariamente.", 2));
parts.push(numbered("Corregir catálogo, interfaz y reglas antes de agregar técnicos.", 3));
parts.push(numbered("Instalar el cargador en laptops autorizadas.", 4));
parts.push(numbered("Capacitar a cada técnico con una prueba real de envío.", 5));
parts.push(numbered("Establecer una fecha desde la cual el cargador será obligatorio.", 6));
parts.push(numbered("Revisar semanalmente rechazos, duplicados y nuevas solicitudes de catálogo.", 7));

parts.push(paragraph("9. Migración histórica", { style: "Heading1" }));
parts.push(paragraph("La reorganización de las carpetas existentes se ejecutará como un proyecto separado, después de estabilizar el flujo nuevo.", { style: "Normal" }));
parts.push(bullet("Generar equivalencias entre carpetas antiguas y códigos aprobados."));
parts.push(bullet("Identificar fechas, formularios, unidades y contratistas ausentes."));
parts.push(bullet("Calcular hashes antes de mover."));
parts.push(bullet("Crear backup o snapshot del NAS."));
parts.push(bullet("Preparar una simulación de movimientos."));
parts.push(bullet("Aprobar cada lote antes de ejecutarlo."));
parts.push(bullet("Reescanear FleetMap y comparar resultados."));

parts.push(pageBreak());
parts.push(paragraph("10. Riesgos y controles", { style: "Heading1" }));
parts.push(table(
  ["Riesgo", "Control"],
  [
    ["El técnico pierde conexión", "Cola local y sincronización posterior."],
    ["Drive recibe un archivo incompleto", "Marcador _ENVIO_LISTO creado solamente al finalizar."],
    ["Dos archivos tienen el mismo nombre", "Comparación SHA-256 y rechazo de colisiones."],
    ["El NAS no responde", "Reintentos; el envío no se elimina de Drive."],
    ["La VM se reinicia", "Registro transaccional en ingestion.sqlite y arranque automático."],
    ["Catálogo inconsistente", "Versiones, responsable de aprobación y eliminación de texto libre."],
    ["Borrado accidental", "Permisos limitados, snapshots y ausencia de sincronización bidireccional."],
    ["Base FleetMap dañada por sincronización", "SQLite permanece en el disco local y se respalda por separado."],
    ["Ruta demasiado larga", "Códigos cortos para carpetas y razón social completa solo como metadato."],
  ],
  [3700, 5300],
));

parts.push(paragraph("11. Información requerida antes de comenzar", { style: "Heading1" }));
parts.push(table(
  ["Dato", "Estado / decisión"],
  [
    ["Tipo de cuenta Google", "Pendiente: personal o Google Workspace."],
    ["Cuenta propietaria del repositorio Drive", "Pendiente."],
    ["Windows de la VM puente", "Pendiente."],
    ["Espacio libre de la VM puente", "Pendiente."],
    ["Credenciales restringidas del NAS", "Pendiente."],
    ["Técnico de prueba, correo e iniciales", "Pendiente."],
    ["Tipos de programación aprobados", "Pendiente."],
    ["Retención en Drive", "Propuesta: 90 días."],
    ["Método de recepción de producción", "Recomendado: Google Drive API."],
    ["Responsable del catálogo", "Pendiente."],
  ],
  [4300, 4700],
));

parts.push(paragraph("12. Aprobación del piloto", { style: "Heading1" }));
parts.push(table(
  ["Rol", "Nombre", "Fecha", "Aprobación"],
  [
    ["Gerencia / patrocinador", "", "", ""],
    ["Responsable de programación TMO", "", "", ""],
    ["Infraestructura / NAS", "", "", ""],
    ["Administrador Google Drive", "", "", ""],
    ["Responsable FleetMap", "", "", ""],
  ],
  [2700, 2600, 1700, 2000],
));
parts.push(paragraph("Fin del documento", { style: "Caption", align: "center", before: 500 }));

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${parts.join("\n")}
    <w:sectPr>
      <w:footerReference w:type="default" r:id="rId1"/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>
      <w:cols w:space="708"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="es-PE"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="172326"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:color w:val="005F73"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/><w:jc w:val="center"/></w:pPr><w:rPr><w:color w:val="5B6970"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="005F73"/><w:sz w:val="31"/><w:szCs w:val="31"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="172326"/><w:sz w:val="25"/><w:szCs w:val="25"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Callout"><w:name w:val="Callout"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="180"/><w:ind w:left="180" w:right="180"/></w:pPr><w:rPr><w:b/><w:color w:val="005F73"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="240" w:right="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="172326"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:color w:val="172326"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr><w:rPr><w:i/><w:color w:val="5B6970"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
</w:styles>`;

const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80"/></w:pPr>
    <w:r><w:rPr><w:color w:val="5B6970"/><w:sz w:val="16"/></w:rPr><w:t>Plan de implementación FleetMap TMO  |  Página </w:t></w:r>
    <w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:color w:val="5B6970"/><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>
  </w:p>
</w:ftr>`;

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const packageRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:zoom w:percent="100"/>
  <w:defaultTabStop w:val="720"/>
  <w:characterSpacingControl w:val="doNotCompress"/>
  <w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;

const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Plan de implementación - Flujo automático de codeplugs TMO</dc:title>
  <dc:subject>Google Drive, VM puente, NAS y FleetMap TMO</dc:subject>
  <dc:creator>FleetMap TMO</dc:creator>
  <cp:lastModifiedBy>FleetMap TMO</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-07-31T12:00:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2026-07-31T12:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office Word</Application>
  <AppVersion>16.0000</AppVersion>
  <Company>FleetMap TMO</Company>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
</Properties>`;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime(new Date(2026, 6, 31, 7, 0, 0));

  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.dosTime, 10);
    local.writeUInt16LE(stamp.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.dosTime, 12);
    central.writeUInt16LE(stamp.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

const files = [
  { name: "[Content_Types].xml", data: contentTypesXml },
  { name: "_rels/.rels", data: packageRelsXml },
  { name: "docProps/core.xml", data: coreXml },
  { name: "docProps/app.xml", data: appXml },
  { name: "word/document.xml", data: documentXml },
  { name: "word/styles.xml", data: stylesXml },
  { name: "word/settings.xml", data: settingsXml },
  { name: "word/footer1.xml", data: footerXml },
  { name: "word/_rels/document.xml.rels", data: documentRelsXml },
];

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, createZip(files));
console.log(JSON.stringify({ outputPath, bytes: fs.statSync(outputPath).size, sections: 12 }, null, 2));
