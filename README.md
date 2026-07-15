# CPE TMO Dashboard

Servidor local para indexar archivos `.cpe`, extraer grupos TMO sin Motorola CPS y
generar Fleet Map. Soporta CP 1020, CP 1330 y CP 1407, además de variantes históricas
detectadas por la estructura y el tamaño interno de su sección CPS. La aplicación no
depende de CPS para extraer los grupos TMO.

Los layouts históricos solo se habilitan después de validarlos contra aliases y GSSI
de archivos conocidos. Los formatos todavía no comprobados permanecen visibles en
`Errores de Escaneo` y no se interpretan con un layout aproximado.

Las variantes CP 1274 con secciones CPS de 2.849.984, 3.021.888 y 4.739.776 bytes
están soportadas mediante layouts verificados con archivos reales y muestras
controladas de alias, GSSI, posición y estado.

El parser v7 agrega de forma conservadora variantes exactas para CP 1315
(CPS 2.848.576), CP 0865 (CPS 2.487.104), CP 0405 (CPS 1.045.696), CP 0232
(CPS 945.600) y CP 7472 (CPS 613.248). Se seleccionan por la combinación CP y
longitud CPS; no reemplazan variantes que ya funcionaban. La confianza de la
asignación se guarda en `talkgroups.assignmentConfidence`. CP 0232 se marca
`medium`; los otros cuatro layouts se marcan `high`.

Se ignoraron deliberadamente el layout propuesto para CP 1211 y las variantes
CP 0865/1315 ya operativas porque no corregían errores nuevos o discrepaban en la
interpretación de carpeta. También permanecen sin implementar CP 1059, 0743,
0639, 7438, 1726 y 0930 por falta de evidencia suficiente.

El indice omite backups con nombres `SERIAL_CP_HEX.cpe` o
`SERIAL_CP_HEX_HEX.cpe` (por ejemplo `121TAB1301_1511_9840_...cpe`). Los archivos
no se borran; simplemente no se consideran parte del indice activo ni de Fleet Map.

## Requisitos e instalacion

- Windows o Linux con Node.js 20 o posterior (se recomienda una version LTS).
- Acceso de lectura desde la VM a la ruta historica de `.cpe`.
- No requiere CPS.

Desde la carpeta de la aplicacion:

```powershell
npm install
node server.js
```

En Windows tambien se puede usar:

- `run.bat`: inicia el servidor y abre el navegador local.
- `start-server.bat`: inicia solamente el servidor, apropiado para una VM.

La aplicacion escucha en `0.0.0.0:8787`. Desde otra PC se abre:

```text
http://IP_DE_LA_VM:8787
```

## Interfaz de usuario

La pantalla inicial es **Fleet Map**: el usuario selecciona el Excel maestro,
genera la matriz comparativa en pantalla y descarga el XLSX completo solo cuando
lo necesita. La ruta central se toma de `CPE_CENTRAL_ROOT` o de la configuración
interna y no es editable desde el navegador.

La navegación separa **Fleet Map**, **Índice de Codeplugs**, **Escaneo rápido** y
**Diagnóstico**. Actualizar el índice central se ejecuta en un proceso de fondo
para no bloquear la atención de Fleet Map. Escaneo rápido conserva una ruta
editable porque está destinado a carpetas o archivos CPE puntuales.

La matriz web limita el render inicial a 200 radios y 250 grupos para mantener el
navegador fluido; los filtros permiten reducir la vista y el Excel siempre conserva
el conjunto completo.

## SQLite y escaneo incremental

La base se crea automaticamente en `data/cpe-dashboard.sqlite`. Usa modo WAL,
indices y transacciones por lotes. Las tablas principales son `scanned_files`,
`talkgroups` y `scan_runs`.

Al actualizar un indice, un archivo se vuelve a analizar solamente si su ruta,
tamano o fecha de modificacion cambio. Los archivos que desaparecieron debajo de
la ruta escaneada quedan con `existsFlag=0`; sus datos no participan en Fleet Map.
Los errores se registran por archivo sin detener el resto del recorrido.

La ubicacion puede cambiarse antes de iniciar el servidor:

```powershell
$env:CPE_DB_FILE = "D:\DatosCPE\cpe-dashboard.sqlite"
node server.js
```

## Flujo recomendado

1. Abre **Fleet Map**.
2. Indica la ruta general de codeplugs.
3. Pulsa **Actualizar indice**. El primer recorrido analiza los CPE; los siguientes
   reutilizan SQLite salvo para archivos nuevos o modificados.
4. Carga el Excel maestro de ISSIs.
5. Pulsa **Generar Fleet Map**. Este paso consulta SQLite y no vuelve a recorrer los
   archivos.

**Escaneo rapido** sigue disponible para una carpeta o archivo directo y tambien
actualiza/reutiliza la misma base SQLite.

## Actualizacion automatica diaria

Al iniciar el servidor queda programado un escaneo diario a las `00:00`, usando la
hora local de la VM, sobre esta ruta central predeterminada:

```text
\\192.168.7.252\tic\002 Programacion
```

El trabajo se ejecuta en un proceso separado para mantener disponible la interfaz
web. Si la VM estuvo apagada a medianoche y todavia no existe un escaneo terminado
del dia actual, se ejecuta una actualizacion de recuperacion al iniciar el servidor.

Para consultar el avance directamente desde consola:

```powershell
npm run status
```

La ruta puede cambiarse antes de arrancar:

```powershell
$env:CPE_CENTRAL_ROOT = "\\servidor\recurso\carpeta"
node server.js
```

Configura la zona horaria de la VM como `America/Lima` para que medianoche coincida
con la hora de Peru. El servidor debe permanecer encendido para ejecutar la tarea.

El XLSX exportado contiene: Matriz Fleet Map, Fleet Map, Grupos por Radio,
Diccionario Grupos, Resumen, Historial ISSI, ISSI sin Codeplug y Errores de
Escaneo. La matriz es la primera hoja, presenta un radio por fila y una columna
por GSSI, con `X` donde existe el grupo. Mantiene fijas las diez columnas de datos
del radio y los dos niveles de encabezado.

## Migracion del cache JSON

Si existe `data/cpe-cache.json`, al primer inicio se importa una sola vez a SQLite.
El JSON no se elimina ni modifica y queda como respaldo. El estado de la migracion
se guarda en `app_meta` dentro de la base.

Para reconstruir todo desde cero:

1. Deten el servidor.
2. Mueve o elimina `data/cpe-dashboard.sqlite` y, si existen,
   `data/cpe-dashboard.sqlite-wal` y `data/cpe-dashboard.sqlite-shm`.
3. Si quieres volver a importar el respaldo JSON, conserva `data/cpe-cache.json`.
4. Inicia el servidor y pulsa **Actualizar indice**.

## Firewall de Windows en la VM

En PowerShell ejecutado como administrador:

```powershell
New-NetFirewallRule -DisplayName "CPE Dashboard 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow
```

Limita el perfil o las direcciones remotas segun las politicas de tu red.

## Backup

Para un backup consistente, deten `node server.js` y copia:

```powershell
Copy-Item .\data\cpe-dashboard.sqlite D:\Backups\cpe-dashboard.sqlite
```

Si necesitas copiarla con el servidor encendido, copia juntos los archivos
`.sqlite`, `.sqlite-wal` y `.sqlite-shm` del directorio `data`.

## Comandos de verificacion

```powershell
node --check server.js
npm test
node scripts\audit-conservative-layouts.js
node scripts\error-report-by-cps-length.js
```

El último comando escribe `data/error-report-by-cps-length.json`, agrupado por CP
y longitud real de la sección CPS. Los archivos cuya cabecera no puede leerse se
informan como `cpsLength: null` junto con la causa.

### Auditoría del parser v7 (2026-07-14)

El reproceso controlado redujo los errores activos de 2.579 a 1.414 y recuperó
1.165 archivos. Los cinco layouts nuevos guardaron 10.819 grupos: no se detectaron
GSSI fuera de rango, alias vacíos ni pares alias/GSSI duplicados dentro del mismo
archivo. CP 0232 usa un fallback de confianza media solamente cuando no aparece
ninguna asignación segura; conserva alias/GSSI válidos y elimina duplicados exactos.

Próximas familias pendientes por cantidad de errores: CP 1059 (340), CP 0743
(208), CP 1211 (205), CP 1726 (138), CP 7438 (109), CP 0930 (96) y CP 0639
(60). Además hay 160 archivos sin CP identificable en el nombre. El detalle por
familia y `cps.length` queda en `data/error-report-by-cps-length.json`.
