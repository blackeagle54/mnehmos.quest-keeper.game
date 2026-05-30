# Tauri Sidecar Binary Deployment Guide

> **Platform note:** The procedure below is the **Windows production** path (a compiled
> `rpg-mcp-win.exe` sidecar). On **Linux dev** the engine runs as a Node wrapper instead —
> see [Linux (dev) Deployment](#linux-dev-deployment) at the bottom. The Windows `.exe`
> currently lives at `src-tauri/` root (not a `binaries/` subdir, which does not exist in
> this repo layout).

## Critical Path Discovery

**Problem Discovered:** 2024-12-14

When deploying updated MCP server binaries during development, the app was still loading old versions because Tauri dev mode uses a different path than expected.

## Binary Locations

| Location                             | Purpose                            |
| ------------------------------------ | ---------------------------------- |
| `src-tauri/binaries/`                | Source files for production builds |
| `src-tauri/target/debug/binaries/`   | Runtime location for `tauri dev`   |
| `src-tauri/target/release/binaries/` | Runtime location for `tauri build` |

## Deployment Procedure

When updating `rpg-mcp-server`:

1. Build the new binary:

   ```bash
   cd rpg-mcp
   npm run build:binaries
   ```

2. Copy to **BOTH** locations:

   ```powershell
   # Production source
   Copy-Item -Force bin/rpg-mcp-win.exe src-tauri/binaries/rpg-mcp-server-x86_64-pc-windows-msvc.exe

   # Dev runtime (Tauri dev loads from here!)
   Copy-Item -Force bin/rpg-mcp-win.exe src-tauri/target/debug/binaries/rpg-mcp-server-x86_64-pc-windows-msvc.exe
   ```

3. Kill any running server processes:

   ```powershell
   taskkill /F /IM rpg-mcp-server* /T
   ```

4. Restart the app (`npm run tauri dev`)

## The `prepare-mcp.js` Script

This script only copies `better_sqlite3.node`, NOT the main server executable. A future enhancement could be to add server binary copying to this script.

> **Known mismatch (bundled builds):** the bridge resolves the native module at
> `binaries/better_sqlite3.node` (`src/services/mcpClient.ts`), but `tauri.conf.json`
> bundles it at the resource **root** (`better_sqlite3.node`). This only affects a real
> `tauri build` bundle — the Linux dev wrapper below uses the engine's own
> `node_modules` `better-sqlite3`, so dev is unaffected. Flagged as a follow-up.

## Linux (dev) Deployment

The shipped Tauri sidecar (`externalBin: rpg-mcp-server`) is **Windows-only**
(`…-x86_64-pc-windows-msvc.exe`). On Linux the dev app instead spawns a tiny **wrapper
script** that runs the compiled engine over stdio:

- **Wrapper:** `src-tauri/target/debug/rpg-mcp-server` — a 185-byte launcher that does
  `exec node "…/mnehmos.rpg.mcp/dist/server/index.js" "$@"`. It uses the engine repo's own
  `better-sqlite3` (loads fine under Node 24) — no `pkg`/`build:binaries` cross-compile needed.

- **Deploying an engine update = rebuilding `dist/`.** There is no binary to copy:

  ```bash
  cd ../mnehmos.rpg.mcp && npm run build   # tsc → dist/ ; the wrapper runs dist/server/index.js
  ```

- **Launching:** `scripts/launch-quest-keeper.sh` (idempotent — starts the Vite dev server
  on :1420 if down, then `exec env GDK_BACKEND=x11 src-tauri/target/debug/temp_init`).
  WebKitGTK is more stable on XWayland, hence `GDK_BACKEND=x11`. The `.desktop` launcher is
  pinned via `gsettings org.gnome.shell favorite-apps`.

- **Engine DB:** `~/.local/share/rpg-mcp/rpg.db`. To play, add an LLM API key (OpenRouter by
  default) in in-app Settings — the engine runs without it, but the AI DM stays silent.
