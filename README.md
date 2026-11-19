# herdr-customization

Layouts and mods for the [Herdr app](https://herdr.dev). Each folder is one item, laid out like `~/.config/herdr-app`, with a `RECIPE.md` and a `preview.png`.

| Item | Type | What it does |
|---|---|---|
| [`mods/context`](mods/context) | mod | Context-window use for each Claude Code agent, in a strip, plus a toast at 80% |
| [`layouts/herdr-context`](layouts/herdr-context) | layout | Herdr's `main` with the context meter in the status bar and in every agent pane's header |

## Install

Ask your agent, for example:

> Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/elrincondeisma/herdr-customization/tree/main/mods/context

Or copy the folders by hand: `layouts/*.json` → `~/.config/herdr-app/layouts/`, `mods/*` → `~/.config/herdr-app/mods/`. Then run `herdr-app check` on each mod.

The `context` mod reads `~/.claude/projects` and runs `sh` (`ls`, `tail`, `grep`, `sed`), on remote machines too. It makes no network calls.
