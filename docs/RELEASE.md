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
| MCP entry in Claude | `meercad` (tools `mcp__meercad__…`) | `meercad-wip` (tools `mcp__meercad-wip__…`) |

Both install to `/Applications`, run at the same time, work on the same projects folder (the
iCloud folder shared with the iPhone and iPad), never self-update and do not claim `.meercad` files.
The App Store build (TestFlight, `pnpm mas`) keeps the default port 47821 and its own extension.

Each build ships its port in `Contents/Resources/mcp/server.json`; the app and the MCP server
started from its bundle both use it, so an assistant set up for one build never drives the other
(see `CHANNEL_PORTS` in `packages/mcp/src/protocol.ts`). `pnpm claude-config` writes both entries
into Claude Desktop's configuration (other servers stay, a `.bak` is kept); restart Claude Desktop
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
