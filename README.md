# Back Orchestrator

Desktop app local para descubrir, configurar y arrancar microservicios desde una sola interfaz.

## Stack
- Tauri + Rust
- React + TypeScript + Vite
- Tailwind + Radix
- Zustand
- SQLite local con rusqlite

## Lo que ya implementa este scaffold
- Scan de roots como `C:\workspace\apps\BACK`
- Importacion de proyectos detectados desde `package.json`, `.env*` y `docker-compose.yml`
- Persistencia local de proyectos, overrides, dependencias y estado
- Arranque por fases con readiness por puerto o delay
- Stop de procesos con `taskkill /T /F` en Windows
- Logs en vivo por eventos Tauri
- Fallback mock para correr el frontend sin Tauri mientras se integra UI

## Requisitos locales
- Node.js 20+
- Rust toolchain con `cargo` y `rustc`
- Tauri prerequisites para Windows

## Comandos esperados
```powershell
npm install
npm run tauri dev
```

## Notas
- En este sandbox no fue posible compilar ni instalar dependencias porque `cargo` no esta en PATH y `npm`/`pnpm` intentan resolver el home del usuario de una forma bloqueada aqui.
- La carpeta `Microsoft/` y `.codex-*` fue generada por el sandbox; esta ignorada en `.gitignore`.
- La configuracion real de proyectos, estados y overrides se guarda en la base SQLite local de Tauri dentro del directorio de datos de la app, no dentro del repo.
- El scanner usa profundidad 1 por defecto para evitar ruido en carpetas como `tech_*` y `webextensions-*`; puedes activar modo recursivo desde la UI.
