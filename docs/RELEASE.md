# Mac builds and releases

## Two meerCADs on the maintainer's Mac

| | meerCAD RC | meerCAD WIP |
| --- | --- | --- |
| What | The stable build the maintainer works with | Whatever is being tried right now |
| Built from | a clean `main`, only together with an upload (below) | any working tree, any time |
| Command | `pnpm rc` | `pnpm wip` |
| Who rebuilds it | the release flow, never an agent on its own | agents and threads, whenever they need it |
| App id | `dev.meercad.app.rc` | `dev.meercad.app.wip` |
| App data | `~/Library/Application Support/meerCAD RC` | `~/Library/Application Support/meerCAD WIP` |
| MCP port | 47822 | 47823 |
| MCP entry in Claude | `meercad-rc` (tools `mcp__meercad-rc__…`) | `meercad-wip` (tools `mcp__meercad-wip__…`) |

All builds that can be on one Mac, each with its own port and its own entry in Claude, added next to
the others (the plug icon in the app adds only its own entry and never replaces another):

| Build | Port | Claude entry |
| --- | --- | --- |
| App Store (prod) | 47821 | `meercad` |
| meerCAD RC | 47822 | `meercad-rc` |
| meerCAD WIP | 47823 | `meercad-wip` |
| TestFlight on the Mac | 47824 | `meercad-testflight` |

The App Store build tells TestFlight from the store by its receipt and hands Claude Desktop the
matching extension (`meercad.mcpb` or `meercad-testflight.mcpb`, both built by `pnpm mas`).

Both install to `/Applications`, run at the same time, work on the same projects folder (the
iCloud folder shared with the iPhone and iPad), never self-update and do not claim `.meercad` files.
Each build ships its port in `Contents/Resources/mcp/server.json`; the app and the MCP server
started from its bundle both use it, so an assistant set up for one build never drives the other
(see `CHANNEL_PORTS` in `packages/mcp/src/protocol.ts`). `pnpm claude-config` adds `meercad-rc` and `meercad-wip`
to Claude Desktop's configuration (every other server stays, `meercad` too; a `.bak` is kept); restart Claude Desktop
afterwards. In the app the plug icon shows the entry of the build it runs in.

On its first start a build takes over the other's projects folder, thumbnails and preferences
(settings.json, thumbnails, Local Storage), so switching loses nothing. Quit the other build first
for an exact copy of the preferences.

Agents test in the WIP (`pnpm wip`, then `mcp__meercad-wip__…` or `scripts/drive-app.mjs`), never in
the RC. Several threads at once each use their own WIP copy (see docs/TESTING.md).

## Release: upload and RC together

"Upload" means every platform at once, and the RC follows the uploaded state, so the maintainer
works with what the testers get:

1. On a clean, up-to-date `main`: `pnpm typecheck` and `pnpm test:quick` (TestFlight), or
   `pnpm test:release` for a production release.
2. `pnpm testflight` (iPhone and iPad) and `pnpm mas` (Mac App Store / TestFlight on the Mac).
3. `pnpm rc` (quits a running RC, which saves, installs the new one and opens it).

`pnpm rc` refuses another branch or uncommitted changes; `--force` is only for trying the script.
