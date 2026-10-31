# Handover / 交付说明

**中文完整说明见 [`交付说明.md`](交付说明.md)**（源码结构、环境变量、演示当天清单、已知边界）。

## Quick start

| OS | File |
|---|---|
| Windows | double-click **`启动服务.cmd`** (wrapper) or **`start.cmd`** |
| macOS / Linux | `bash start.sh` |
| self check | double-click **`自检.cmd`** or `npm test && npm run smoke && npm run verify` |

Default URL: `http://127.0.0.1:3080/` （端口可用 `PORT` 环境变量改）

## Where things live

- `src/` server (entry `src/server.js`, HTTP `src/api/`, MCP `src/mcp/`, business `src/services/`)
- `static/` zero-build frontend (6 pages, css/js, local vendor assets)
- `pano/` 8 x 360-degree panoramas + `manifest.json`
- `config/` `fixtures/` data; `tools/stitch-pano.py` stitches phone captures into 360 images
- `tests/` `scripts/` 161 tests + smoke + integration verify

> The `.cmd` files are deliberately ASCII-only: cmd.exe parses batch files in the console
> code page, and Chinese bytes can collide with cmd control characters and break the script.
