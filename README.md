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

 
 
 
