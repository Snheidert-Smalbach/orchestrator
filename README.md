# Back Orchestrator

Desktop app local para descubrir, configurar y arrancar microservicios desde una sola interfaz.

## Stack
- Tauri + Rust
- React + TypeScript + Vite
- SCSS + Radix
- Zustand
- SQLite local con rusqlite

## Lo que ya implementa este scaffold
- Scan de roots configurables por sistema operativo
- Importacion de proyectos detectados desde `package.json`, `.env*` y `docker-compose.yml`
- Persistencia local de proyectos, overrides, dependencias y estado
- Arranque por fases con readiness por puerto o delay
- Resolucion automatica de comandos por SO:
  Windows usa `cmd.exe` / `powershell.exe` y binarios `npm.cmd` / `pnpm.cmd` / `yarn.cmd`
  macOS y Linux usan `sh -lc` y binarios `npm` / `pnpm` / `yarn`
- Stop de procesos con `taskkill /T /F` en Windows y `kill` / `kill -9` en macOS y Linux
- Logs en vivo por eventos Tauri
- Fallback mock para correr el frontend sin Tauri mientras se integra UI

## Requisitos locales
- Node.js 20+
- Rust toolchain con `cargo` y `rustc`
- Tauri prerequisites para tu SO
- `lsof` disponible en macOS/Linux para deteccion y liberacion de puertos

## Comandos de desarrollo
Windows:
```powershell
npm install
npm run tauri dev
```

macOS / Linux:
```bash
npm install
npm run tauri dev
```

## Builds de macOS
- El workflow `Build macOS App` genera dos `.dmg`: uno para Apple Silicon y otro para Intel.
- Cada corrida sube esos archivos como artifacts del run en GitHub Actions.
- Ademas, el workflow publica o actualiza una prerelease llamada `macOS Preview` en GitHub Releases para compartir una URL mas estable.
- Si el build no esta firmado por Apple, macOS puede pedir abrir con clic derecho `Open` o habilitar `Open Anyway` en `Privacy & Security`.

## Builds de Windows
- El workflow `Build Windows App` genera un instalador NSIS `.exe` para Windows x64.
- Cada corrida sube ese archivo como artifact del run en GitHub Actions.
- Ademas, el workflow publica o actualiza una prerelease llamada `Windows Preview` en GitHub Releases.
- Como el build no esta firmado, Windows SmartScreen puede mostrar una advertencia; en ese caso usa `More info` y luego `Run anyway`.

## Builds de Linux
- El workflow `Build Linux App` genera un `AppImage` y un paquete `.deb` para Linux x64.
- Cada corrida sube ambos archivos como artifacts del run en GitHub Actions.
- Ademas, el workflow publica o actualiza una prerelease llamada `Linux Preview` en GitHub Releases.
- Para ejecutar el `AppImage`, normalmente hay que darle permisos con `chmod +x archivo.AppImage`.

## Notas
- En este sandbox no fue posible compilar ni instalar dependencias porque `cargo` no esta en PATH y `npm`/`pnpm` intentan resolver el home del usuario de una forma bloqueada aqui.
- La carpeta `Microsoft/` y `.codex-*` fue generada por el sandbox; esta ignorada en `.gitignore`.
- La configuracion real de proyectos, estados y overrides se guarda en la base SQLite local de Tauri dentro del directorio de datos de la app, no dentro del repo.
- El scanner usa profundidad 1 por defecto para evitar ruido en carpetas como `tech_*` y `webextensions-*`; puedes activar modo recursivo desde la UI.
