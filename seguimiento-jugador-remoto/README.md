# Seguimiento Jugador Remoto

Proyecto nuevo, separado del resto.

Archivos:

- `ogame-seguimiento-jugador-remoto.user.js`
- `tracker-server.js`

## Idea

- `master`: marca jugadores objetivo, captura coords a mano y abre historial.
- `slave`: hace el escaneo en galaxia y sube observaciones.
- `VPS`: guarda todo el estado y el historial.

El `master` puede estar cerrado.  
Si el `slave` sigue abierto y el servidor sigue vivo, el escaneo continuo sigue funcionando.

## Dónde se guardan los datos

Por defecto, el servidor guarda todo en este archivo:

- `seguimiento-jugador-remoto/tracker-store.json`

Ahí quedan:

- objetivos
- coords de cada objetivo
- plan activo de escaneo
- estado del `slave`
- historial por jugador y por día

Si quieres mover ese fichero a otra ruta en la VPS, usa la variable `DATA_FILE`.

Ejemplo:

```powershell
$env:DATA_FILE="C:\tracker-ogame\tracker-store.json"
```

o en Linux:

```bash
DATA_FILE=/opt/tracker-ogame/tracker-store.json
```

## Token

El token es opcional.

- Si `SYNC_TOKEN` está vacío: no hay protección.
- Si `SYNC_TOKEN` tiene valor: `master` y `slave` deben usar el mismo token.

## Arrancar servidor

### Windows VPS

```powershell
cd C:\ruta\al\proyecto\seguimiento-jugador-remoto
$env:HOST="0.0.0.0"
$env:PORT="8790"
$env:API_BASE="/tracker"
$env:SYNC_TOKEN="ponlo-si-quieres"
$env:DATA_FILE="C:\tracker-ogame\tracker-store.json"
node .\tracker-server.js
```

Quedará escuchando en:

```text
http://IP_DE_TU_VPS:8790/tracker
```

### Linux VPS

```bash
cd /ruta/al/proyecto/seguimiento-jugador-remoto
HOST=0.0.0.0 \
PORT=8790 \
API_BASE=/tracker \
SYNC_TOKEN=ponlo-si-quieres \
DATA_FILE=/opt/tracker-ogame/tracker-store.json \
node tracker-server.js
```

## Configurar userscript

Instala en Tampermonkey:

- `ogame-seguimiento-jugador-remoto.user.js`

Luego pulsa `Sync...`.

### En master

- modo: `master`
- endpoint: `http://IP_DE_TU_VPS:8790/tracker`
- token: el mismo del servidor, o vacío si no usas token

### En slave

- modo: `slave`
- endpoint: `http://IP_DE_TU_VPS:8790/tracker`
- token: el mismo del servidor, o vacío si no usas token

## Uso

1. En `master`, abre galaxia.
2. Pulsa `◎` al lado del nombre del jugador para marcarlo como objetivo.
3. En el panel, selecciónalo en el desplegable.
4. Pulsa `Iniciar captura coords`.
5. Ve pasando por galaxia por sus planetas.
6. Cada vez que el jugador aparezca visible, esa coord se guarda.
7. Pulsa `Parar captura`.
8. Elige frecuencia del ciclo completo.
9. Elige velocidad entre cambios.
10. Pulsa `Iniciar escaneo`.
11. El `slave` hará el recorrido y subirá actividad y escombros.
12. Pulsa `Abrir historial` para ver la tabla.

## Qué registra el slave

Por cada observación válida:

- hora exacta del escaneo
- actividad de planeta
- actividad de luna
- si había escombros o no

## Cómo se visualiza el historial

La tabla se pinta por bloques de 5 minutos:

- `00:00`
- `00:05`
- `00:10`

Si el escaneo real fue a `00:02`, se guarda la hora exacta y se muestra dentro del bloque `00:00`.

## Notas prácticas

- `Borrar historial` borra solo el historial del jugador. No borra el objetivo.
- Si quitas un objetivo desde galaxia, el historial viejo no se borra.
- Si añades coords nuevas mientras hay un escaneo activo de ese jugador, el plan remoto se rehace con la cola nueva.
- Para que las fechas te cuadren bien, conviene que el navegador del `slave` use la misma zona horaria que tú.
