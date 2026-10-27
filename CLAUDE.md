# appshot

A Claude Code mod (`hooks/register.tsx`, pure helpers in `hooks/core.ts`) plus a
Hammerspoon helper (`hammerspoon/appshot.lua`). The helper renames each finished
capture into `~/Library/Application Support/AppShot/inbox/<id>/`; the mod polls
that folder and claims a capture by `mv` to `claimed/<id>/`.

## How the Claude desktop app behaves (learned the hard way)

- A session's engine starts only when its first message is sent. A session the
  person just opened runs no mod, so it can't claim or draw anything yet.
- `session.start`'s `isInteractive` is `false` for every desktop Code-tab
  session. Never use it to decide whether a person is there (0.3.1 broke on this).
- `$.session.surfaces()` is non-empty only while a window shows the session.
- A `UserMessage` render's `requestId` is the row uuid `session.append` stores.
- Nothing may send a message the person didn't send; only `/appshot <question>` does.

## Capture speed

- Capture with `screencapture -l<windowID>`. `hs.window:snapshot()` +
  `saveToFile` took ~2.4 s per Retina window. Each `meta.json` holds `timingsMs`.
- Don't measure through the `hs` CLI: long `hs -c` calls hung Hammerspoon and
  broke its `print`. Trigger with `open -g hammerspoon://appshot` instead.

## Checking a change

- `claude plugin validate .` and `claude plugin test .` (tests in
  `tests/appshot.test.tsx`; the `world()` stub stands in for files and `mv`).
- Type-check with a tsconfig outside the repo that includes the API types file
  the plugin-authoring skill names; the repo's `tsconfig.json` extends one the
  engine writes only into a dev folder.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Commit and push `main`; tag `vX.Y.Z` (annotated) and push the tag.
3. `gh release create vX.Y.Z --title "appshot X.Y.Z" --notes-file … --latest`.
4. `claude plugin marketplace update claude-appshot`, then
   `claude plugin update appshot@claude-appshot`, then restart the Claude app.

This repo is the only source. The installed copy under
`~/.claude/plugins/cache/claude-appshot/` is a snapshot of a release; edits
there don't last.
