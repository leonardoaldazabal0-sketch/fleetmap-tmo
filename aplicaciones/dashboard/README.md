# CPE TMO Dashboard

> Desde el 8 de septiembre de 2026 esta aplicacion forma parte de `F:\CPE-TMO`.
> Las rutas operativas se resuelven con `lib/runtime-paths.js` desde
> `configuracion/rutas.json` en la raiz de la plataforma. La base activa esta en
> `datos/bases`, los logs en `registros` y los informes en `reportes`.
> Las referencias a `data`, `docs` y `tools` de las notas historicas siguientes
> corresponden a la estructura anterior. Consulta `F:\CPE-TMO\README.md`.

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

El parser v10 agrega la configuración de destino de emergencia TMO validada con
parejas táctico/no táctico para CP0778, CP0865, CP1020, CP1274, CP1315, CP1330,
CP1511, CP1649, CP1726, CP7492 y CP7715. Fleet Map y el buscador muestran el modo **Táctico**
cuando la alerta se envía al grupo actual, o **No táctico** junto con el alias y
GSSI del grupo fijo. La matriz y el XLSX incluyen ambos datos.

El parser v11 agrega emergencia validada para variantes exactas de CP1059, CP0743,
CP1211, CP7438, CP0930 y CP0639. Si la tabla de grupos de conversación todavía no
está validada, conserva la radio, el modo y el GSSI de emergencia sin inventar
membresías de grupos ni registrar el CPE como no soportado.

Las demás variantes de CP0743, CP1211, CP1726 y CP0930 permanecen sin implementar
hasta contar con parejas controladas de sus tamaños CPS exactos. Los grupos de
conversación de las variantes de emergencia agregadas en v11 también requieren
una referencia explícita de alias, GSSI, posición y estado antes de habilitarse.

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
Diccionario Grupos, Resumen, Historial ISSI, ISSI sin Codeplug, Errores de
Escaneo, Escaneo, DMO, Broadcast, GPS y OTAP. La matriz es la primera hoja,
presenta un radio por fila y una columna por GSSI, con `X` donde existe el grupo.
Las columnas Escaneo y DMO tambien usan `X`, pero solo cuando el indicador de
funcion correspondiente esta activo. Sus listas y grupos se conservan con detalle
en las hojas Escaneo y DMO. Broadcast muestra `ESCUCHA — LABEL (GSSI)` solo si
la llamada de anuncio esta activa, el destino tiene prioridad 10 y el grupo esta
invisible con rastreo continuo. Una configuracion activa incompleta muestra
`REVISAR`; las radios sin escucha configurada quedan en blanco. La hoja Broadcast
expone cada comprobacion y no intenta inferir radios de habla.

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

## Programacion de Radios: carpetas, campo y publicacion

El paso 4 permite seleccionar una carpeta completa desde la laptop. El navegador
envia solamente los archivos `.cpe` de esa carpeta y sus subcarpetas; los demas
archivos se omiten. Cada CPE se valida individualmente y solo los aprobados se
conservan en la carpeta controlada del proyecto.

Cuando se aprueba la ultima radio, el paso 5 solicita la ruta operativa, numero
de FORM, fecha e iniciales. La VM crea una entrega determinista con la solicitud,
el modelo, los CPE aprobados y un manifiesto de hashes SHA-256. Todo se publica
en la misma carpeta `DESPUES`, respetando la estructura historica:

```text
Plantillas x Clientes AÑO\...\FORM ####\AAAAMMDD_INICIALES\DESPUES
```

La publicacion se hace primero en Google Drive y despues en el TIC NAS. El
dashboard registra y muestra por separado el estado y la ruta exacta de ambos
destinos. Los reintentos son idempotentes y no crean entregas duplicadas ni
sobrescriben un archivo diferente que ya exista en el destino.

La configuracion esta en:

```text
F:\CPE-TMO\configuracion\publicacion\publicacion.json
```

Google Drive puede usar una cuenta de servicio o la unidad montada por Google
Drive para escritorio. El API tiene prioridad cuando existe `service-account.json`;
en caso contrario se usa `googleDrive.desktopRoot`. La clave, cuando se habilite,
debe permanecer exclusivamente en la VM y la carpeta debe compartirse con su
`client_email`. Si ninguna modalidad esta disponible, el proyecto queda en
`PENDIENTE DE ACCESO` y se reintenta sin copiar aun la entrega al NAS.

La edicion de campo se genera con:

```powershell
.\scripts\build-field-dashboard.ps1
```

Es el mismo dashboard y parser ejecutados localmente en la laptop. Antes de salir
se descarga el proyecto aprobado desde la VM. Sin Internet valida y conserva los
CPE aprobados en una cola local. Al recuperar Internet y VPN, intenta sincronizar
cada 60 segundos; la publicacion final en Drive y NAS siempre la realiza la VM.

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
