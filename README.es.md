# TeamAI

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh-CN.md) · **Español**

TeamAI es un relé local multicuenta para **Claude Code** y la CLI oficial de **Codex**. Mantiene un grupo de cuentas independiente para cada proveedor y reintenta la solicitud con otra cuenta cuando la suscripción seleccionada no está disponible o se quedó sin cuota.

![Panel de TeamAI](docs/dashboard.png)

<sub>El panel de arriba no es una captura: lo genera <a href="docs/render-dashboard.py">docs/render-dashboard.py</a>, de modo que no queden nombres de cuentas reales en este repositorio.</sub>

> TeamAI es un proyecto de código abierto independiente. No está afiliado a Anthropic, a OpenAI ni al servicio no relacionado de teamai.com.

## Requisitos

- Node.js 20 o superior
- macOS o Linux
- `claude` y/o `codex` instalados por separado
- Tus propias cuentas de suscripción Claude Pro/Max o ChatGPT Codex

## Instalación

```bash
git clone https://github.com/soulduse/team-ai.git
cd team-ai
./scripts/install.sh
```

`install.sh` instala las dependencias, compila, enlaza los comandos
`teamai`/`tai`/`tac`/`tax` y ofrece agregar el bloque de shell. Es idempotente:
vuelve a ejecutarlo para actualizar. Usa `--no-shell` para omitir el bloque de
shell, o `--dry-run` para ver qué haría sin aplicar cambios.

Para hacer lo mismo a mano:

```bash
npm install
npm run build          # obligatorio: dist/ no está versionado
npm link
```

¿Quieres automatizar esto desde un agente de IA? Consulta [AGENTS.md](AGENTS.md),
que expone los mismos pasos como comandos deterministas con verificación y
ramas de error.

## Inicio rápido

```bash
teamai login
tai
```

`login` pregunta si quieres agregar `[1] Claude` o `[2] Codex`. Repítelo para sumar más cuentas. `tai` es el comando corto de sesión y equivale a `teamai start`: levanta el relé local y abre el panel. Desde la TUI, pulsa `1` para lanzar Claude Code o `2` para lanzar Codex. Cuando el cliente termina, vuelves al panel.

Para iniciar una sesión directa con un proveedor, usa los lanzadores dedicados. Inician el relé de TeamAI automáticamente cuando hace falta y pasan todos los argumentos finales al cliente oficial:

```bash
tac                   # Claude Code a través del grupo de cuentas de TeamAI
tac --resume          # equivale a: teamai claude --resume
tax                   # Codex a través del grupo de cuentas de TeamAI
tax resume            # equivale a: teamai codex resume
teamai claude         # forma larga de tac
teamai codex          # forma larga de tax
teamai session        # elige [1] Claude o [2] Codex de forma interactiva
```

Los nombres evitan deliberadamente reemplazar una función de shell `tc` existente de TeamClaude. `tc` puede seguir apuntando a TeamClaude mientras `tac` y `tax` apuntan a TeamAI.

## Configuración del shell

```bash
./scripts/install-shell.sh            # agrega un bloque delimitado a ~/.zshrc
./scripts/install-shell.sh --dry-run  # muestra el diff, no escribe nada
./scripts/install-shell.sh --uninstall
```

Define `cl` (Claude Code) y `co` (Codex) a través del grupo, además de `tai`,
`tais` y `taistart`/`tairestart`/`taistop` para el LaunchAgent, y desactiva
cualquier `ANTHROPIC_BASE_URL` fijada globalmente: TeamAI apunta cada sesión a
su propio puerto, así que un valor global obsoleto solo enruta el tráfico hacia
un proxy que quizá ya no esté en ejecución. El bloque está delimitado por
marcadores y se reescribe en su lugar, de modo que volver a ejecutarlo actualiza
en vez de acumular; cada escritura deja una copia de seguridad con marca de
tiempo, y los ciclos de instalación/desinstalación restauran el archivo byte a
byte.

El supervisor es opcional: `cl`, `co`, `tai` y `teamai run` levantan el relé por
su cuenta cuando no hay nada escuchando, así que siguen funcionando aunque el
LaunchAgent esté descargado, falle o nunca se haya instalado. Un `server.json`
obsoleto dejado por un proceso terminado se ignora y se reemplaza. Cuando el
arranque sí falla, se informa el motivo que devuelve el servidor (un puerto ya
en uso, un archivo de credenciales ilegible) en lugar de un escueto "did not
start", y la salida completa queda en
`~/.config/teamai/server-start.log`.

### Ejecutar el relé como elemento de inicio de sesión

Esto es opcional. Los alias `taistart`/`tairestart`/`taistop` instalados arriba
controlan un LaunchAgent con la etiqueta `com.teamai.proxy`, así que usa
exactamente esa etiqueta:

```xml
<!-- ~/Library/LaunchAgents/com.teamai.proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.teamai.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/team-ai/dist/src/cli.js</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardErrorPath</key> <string>/tmp/teamai.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.teamai.proxy.plist
```

Usa `command -v node` para obtener la ruta real de Node; un LaunchAgent no
hereda el PATH de tu shell.

## Cuentas

Codex usa su flujo habitual de inicio de sesión por navegador. TeamAI no requiere que esté habilitada la opción de autenticación por código de dispositivo de ChatGPT.

Importar credenciales es opcional y solo funciona cuando existe un archivo de credenciales exportable:

```bash
# Importa todas las cuentas desde una configuración existente de TeamClaude.
teamai import claude --from ~/.config/teamclaude.json

# Importa el inicio de sesión actual basado en archivos de la CLI de Codex, si existe.
teamai import codex
```

Las versiones recientes de Claude Code pueden guardar las credenciales en el Llavero de macOS en lugar de en `~/.claude/.credentials.json`; en ese caso usa `teamai login`. `import` nunca modifica los archivos originales de TeamClaude, Claude Code ni Codex. TeamAI usa un directorio de Codex aislado y persistente para las sesiones que pasan por el relé, de modo que el `~/.codex` original del usuario queda intacto.

## Operación

```bash
teamai status                                  # estado del servidor + tabla de cuentas
teamai accounts [claude|codex]                 # solo la tabla de cuentas
teamai start                                   # inicia el relé y abre el panel
teamai stop                                    # detiene el relé
teamai restart                                 # detiene, inicia y abre el panel
teamai server                                  # ejecuta el relé en primer plano
teamai tui                                     # solo el panel, sin inicio automático
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1      # o bien: auto
```

Las cuentas se ordenan según la cuota que les queda, de menor consumo a mayor,
tanto en el panel como en la propia selección del grupo, así que la fila
superior es la cuenta a la que iría la siguiente solicitud. Claude se evalúa por
su ventana semanal por modelo (Fable) en vez de la general, porque es esa la que
en la práctica rechaza primero el modelo superior. Cuando todas las cuentas
están agotadas, quedan empatadas y el orden pasa a depender de cuál se libera
antes: en una flota donde hoy nadie puede atender una solicitud, el tiempo hasta
el reinicio es lo único que las diferencia (Claude por su ventana Fable, Codex
por la semanal). Una cuenta sin medir se ordena al final (desconocido no es lo
mismo que vacío), una prioridad fijada sigue teniendo precedencia, y `c` alterna
de vuelta al orden configurado.

La TUI a pantalla completa agrupa las cuentas de Claude y de Codex, y mantiene anclada la cuenta seleccionada aunque cambie el uso. Las filas de Claude muestran de forma independiente las ventanas `5h session`, `7d overall` y la ventana por modelo `7d Fable`; las filas de Codex muestran su ventana primaria y secundaria, cada una titulada con el periodo que esa cuenta realmente reporta (`1w limit`). Las cuotas se aprenden de las respuestas del cliente oficial y se conservan entre reinicios.

El pie de página ofrece el mismo flujo de trabajo de cuentas que TeamClaude: lanzar Claude/Codex, seleccionar, cambiar, habilitar/deshabilitar, ordenar, eliminar, agregar/iniciar sesión, volver a medir (`R`) y salir. `switch` fija la cuenta seleccionada al frente del grupo de su proveedor; el modo de orden permite asignar un puesto o devolver una cuenta a la programación automática. Al actualizar el perfil de Claude se muestra el nivel del plan y, en rojo, los estados de suscripción problemáticos como `past_due`.

`R` vuelve a medir la cuota de toda la flota. La cuota nunca se consulta desde un endpoint aparte: se aprende de los encabezados de límite de tasa que devuelve el upstream, así que una cuenta que no ha atendido tráfico muestra `-` hasta que algo la mida. `R` reproduce en paralelo una forma de solicitud que ya se sabe aceptada contra cada cuenta inactiva (incluidas las ya medidas y las limitadas, cuyos 429 igualmente traen encabezados autoritativos) e informa un recuento honesto de `measured/targets`. Esa forma de solicitud solo se fija a partir de un 2xx real que haya pasado por el proxy, de modo que hasta que una solicitud no haya tenido éxito, `R` informa que todavía no existe una plantilla de sondeo en lugar de adivinar una carga útil. Las cuentas a las que les falta la ventana semanal por modelo (Fable) reciben un sondeo complementario adicional, porque esa ventana solo aparece en las respuestas a solicitudes de nivel Fable.

El servidor además hace un calentamiento por su cuenta cada cinco minutos (`warmupIntervalMs`, `0` para desactivarlo): limpia las ventanas de cuota que el upstream ya reinició y mide únicamente las cuentas sin medir, de modo que una flota estable no cuesta nada por ciclo y una ventana que se renueva se rellena sin que nadie pulse `R`. Una cuenta cuyo upstream nunca reporta cuota se descarta tras tres intentos infructuosos, y ese presupuesto se renueva cada vez que su ventana se reinicia o pulsas `R`.

El valor de suscripción `~D-N` es una estimación, no una fecha de vencimiento autoritativa: el endpoint de perfil de Anthropic expone el estado de la suscripción y la fecha de creación, pero no el fin del periodo de facturación actual. Por eso TeamAI estima el siguiente aniversario mensual de facturación y lo marca con `~`. El estado del perfil se actualiza al arrancar el servidor y cada seis horas.

## Configuración

La configuración y las credenciales viven en `$TEAMAI_HOME`, con respaldo en
`$XDG_CONFIG_HOME/teamai` y luego en `~/.config/teamai`. Los proxies se enlazan
a `127.0.0.1` y exigen un token de cliente local generado.

`config.json` se crea en la primera ejecución con estos valores por defecto:

| Clave | Valor por defecto | Significado |
| --- | --- | --- |
| `proxy.host` | `127.0.0.1` | Dirección de enlace. Solo loopback, por diseño. |
| `proxy.claudePort` | `3456` | Puerto del relé de Claude. |
| `proxy.codexPort` | `3457` | Puerto del relé de Codex. |
| `proxy.controlPort` | `3556` | Canal de control con el que habla la TUI. |
| `proxy.clientToken` | generado | Token local que debe enviar todo cliente que pase por el relé. |
| `switchThreshold` | `0.98` | Proporción de uso por encima de la cual una cuenta deja de seleccionarse. |
| `warmupIntervalMs` | `300000` | Intervalo de remedición en segundo plano. `0` lo desactiva. |
| `maxConcurrentPerAccount` | `3` | Solicitudes en curso permitidas por cuenta. |

Cambia un puerto si otro proceso ya lo ocupa: esa es la causa habitual de un
arranque fallido, y el motivo aparece en `server-start.log`.

## Alcance y cumplimiento

La versión 0.1 apunta a cuentas OAuth de suscripción y a sesiones de CLI lanzadas mediante un wrapper. No expone una API pública compatible con OpenAI, no convierte solicitudes de Claude en solicitudes de Codex, no da soporte a Codex Desktop ni agrupa credenciales de personas distintas. La responsabilidad de cumplir los términos y las políticas de los proveedores es tuya. Las cargas de trabajo de API en producción o con fines comerciales deberían usar los mecanismos oficiales de facturación de API de los proveedores.

## Desarrollo

```bash
npm run typecheck
npm test
npm run lint
```

Consulta [NOTICE](NOTICE) para lo relativo a obra derivada y [SECURITY.md](SECURITY.md) para el modelo de seguridad local.
