CARGADOR TMO - OPERACION CONTROLADA
===================================

ESTRUCTURA CENTRAL DESDE 2026-09-08
Abrir preferentemente con F:\CPE-TMO\Abrir-Cargador-TMO.vbs para no mostrar
ninguna consola. El archivo Abrir-Cargador-TMO.bat tambien cierra su ventana
inmediatamente y deja visible unicamente la interfaz grafica.
Configuracion: F:\CPE-TMO\configuracion\cargador-tmo\piloto.json
Catalogo local: F:\CPE-TMO\configuracion\catalogos\catalogo-clientes.json
Cola local: F:\CPE-TMO\datos\programaciones\pendientes
Las rutas se definen en F:\CPE-TMO\configuracion\rutas.json.
El catalogo de Drive sigue teniendo prioridad si esta disponible.
No se cambia el destino de Drive ni se envian paquetes por esta migracion.
El filtro de aprobacion esta integrado con el Proyecto CPE del dashboard.
Dashboard configurado: http://192.168.15.219:8787
Fuera de la oficina se requiere la VPN de TI para alcanzar esa direccion.

Tecnico configurado: OSCAR SANCHEZ (OS)
Catalogo: todos los clientes activos aprobados.

Uso:
1. Mantener juntas esta carpeta, el script y la carpeta config.
2. Ejecutar Abrir-Cargador-TMO.bat.
3. Buscar un cliente por RUC, razon social o nombre de carpeta y seleccionarlo.
4. Completar unidad, contratista, tipo, formulario y fecha.
5. Escribir el codigo del Proyecto CPE recibido al registrar la solicitud.
6. Seleccionar uno o varios archivos .cpe leidos despues de programar.
7. Pulsar Validar con Dashboard. Todas las radios deben quedar APROBADAS.
8. Crear el paquete local. Este boton permanece bloqueado hasta la aprobacion.
9. Pulsar Enviar a Google Drive.

Cuando un cliente tiene unidades o contratistas historicos aprobados, el cargador
los muestra para seleccionarlos. Si no los tiene, la programacion se registra
directamente bajo el cliente.

El paquete se guarda en cola\pendientes con manifest.json, el codigo del
Proyecto CPE, los resultados de validacion, los hashes SHA-256 y el marcador
_ENVIO_LISTO.json. Los .cpe originales se copian, no se mueven.
El envio se copia a G:\Mi unidad\PROGRAMACION\ENTRADA\OS y Google Drive para
escritorio lo sincroniza. El cargador no tiene acceso al NAS.
