# Plataforma CPE-TMO

Ubicacion activa desde el 8 de septiembre de 2026: `F:\CPE-TMO`.
Dashboard CPE y herramientas TMO en un solo repositorio, con datos separados del codigo.

## Uso diario

- `Abrir-Dashboard.bat`: abre el dashboard existente en el navegador.
- `Abrir-Cargador-TMO.bat`: abre el cargador de escritorio.
- Servicio: tarea de Windows `CPE Dashboard`, con inicio al arrancar la VM.
- URL local: `http://127.0.0.1:8787`. El puerto y acceso de red no cambian.
- `npm test`: pruebas de la aplicacion. `npm run status`: estado de SQLite.
- `npm start`: arranque manual, SOLO si la tarea del servicio esta detenida.

## Estructura

| Carpeta | Contenido |
| --- | --- |
| `aplicaciones/dashboard` | Servidor Node, interfaz, lector CPE, pruebas y herramientas de mantenimiento |
| `aplicaciones/cargador-tmo` | Aplicacion PowerShell de escritorio |
| `aplicaciones/puente-envios` | Fuentes de recepcion, registro y copia hacia NAS |
| `configuracion/rutas.json` | Mapa central de rutas locales |
| `configuracion/catalogos` | Catalogos operativos y relaciones aprobadas |
| `configuracion/cargador-tmo` | Configuracion del tecnico y destinos existentes |
| `configuracion/reglas-validacion` | Reservada para el futuro filtro; no hay reglas aprobadas aun |
| `datos/bases` | SQLite activo, fuera del codigo y de Google Drive |
| `datos/programaciones/pendientes` | Cola existente del cargador, sin reinterpretar estados |
| `datos/temporales` | Bases de analisis y paquetes de diagnostico |
| `registros` | Logs operativos |
| `reportes` | Informes generados y evidencia de auditorias |
| `documentacion` | Planes, auditorias y notas historicas |
| `distribuciones` | Paquetes historicos; NO son instaladores actualizados con filtro |

Respaldos locales: `F:\CPE-TMO-Respaldos`. Estan fuera del proyecto, pero siguen
en el mismo disco/VM. No sustituyen un respaldo externo; coordinarlo con TI.

Las rutas se calculan con `aplicaciones/dashboard/lib/runtime-paths.js`.
`CPE_HOME` permite indicar otra raiz de plataforma y `CPE_DB_FILE` sigue permitiendo
usar una base temporal para pruebas. `CPE_LOG_FILE` permite aislar el log.
Las configuraciones reales, bases, envios, reportes y credenciales no se versionan.
Los ejemplos de configuracion no deben contener credenciales.

## Limites de esta reorganizacion

No se modificaron CPE originales, carpetas historicas del NAS, reglas de red ni
destinos de Google Drive. No se envio ni aprobo ningun paquete.

El filtro posterior a programacion, usuarios y aprobaciones AUN NO estan implementados.
El cargador conserva su funcion anterior de envio manual. El estado READY de los
paquetes antiguos no es una aprobacion de calidad. La siguiente fase es el piloto VOLCAN.

Los scripts de `puente-envios` conservan sus parametros de despliegue originales
(`C:\ProgramacionBackup`). Esta reorganizacion mueve sus fuentes, no instala ni modifica
el servicio del puente en otra maquina. No se ha creado una VPN; corresponde a TI.

## Mantenimiento y recuperacion

Ejecutar mantenimiento desde `aplicaciones/dashboard`. Los scripts que antes escribian
en `data` y `docs` ahora utilizan las rutas centrales. No ejecutar scripts de renombrado
del NAS ni reprocesos solo para comprobar esta estructura: pueden modificar datos.

La copia anterior y el XML de la tarea se conservan en
`F:\CPE-TMO-Respaldos\migracion-20260908`. Antes de una futura restauracion, respaldar
la base ACTUAL con la API de backup de SQLite para no perder trabajo posterior.
No copiar o mover a mano una base SQLite abierta ignorando sus archivos WAL/SHM.

Las rutas mencionadas en auditorias antiguas son evidencia historica y no se reescribieron.
El Git original y los cambios pendientes se conservaron; no se hicieron commits ni pushes.
