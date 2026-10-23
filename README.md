# Bookmarks for pi

Bookmark anything you or the model said in a [pi](https://pi.dev) conversation (or a tool call: a command and its output), keep the bookmarks in a side pane, and **act on them**: ask the model to explain one further, summarize it, find it in the code, verify it, or save it to `AGENTS.md`. **Pin** the ones that matter and the model keeps them in context, even after `/compact`.

A port of [Bookmarks for Claude Code](https://github.com/thrishma/claude-mod-bookmarks), with the same prompts and the same card layout, driven from the keyboard.

## Install

Needs pi 1.4 or later (`@earendil-works/pi-coding-agent`).

```
pi install git:github.com/thrishma/pi-bookmarks
```

To try it for one session without installing: `pi -e git:github.com/thrishma/pi-bookmarks`.

## Bookmarking

| How | What gets bookmarked |
| --- | --- |
| `/bm` or **Alt+M** | The model's last reply |
| `/bm me` | Your last message |
| `/bm tool` | The last tool call and what came back |
| `/bm <words>` | The latest message containing those words |
| `… -- #tag a note` | Adds tags and a note, e.g. `/bm -- #gotcha check the cache keys` |
| `/bm-tag gotcha decision` | Tags your newest bookmark |
| `/bm-group Auth refactor` | Puts the ticked bookmarks, or your newest, in a group. No name takes them out. |
| `/bookmarks` or **Alt+O** | Opens the pane |

Bookmarked messages get a `★` label in `/tree`, so you can find them there too.

## The pane

```
Bookmarks                 2 bookmarks · 1 group · 1 pinned here
All  🐛 #gotcha 1
▾ Fish 1
▎▾ 🙋 You 1m · 📌                                             ☐
▎ Which file builds the key?
▎ Ask   e Explain · t TL;DR · c In code · v Verify · r Remember
▎ Card               p Unpin · y Copy · g Group · o Color · x ✕
▾ Ungrouped 1
▎▸ 🤖 Assistant 1m                                            ☐
▎ It is built in src/cache/key.ts, in makeKey(). Run `npm test
▎ 🐛 #gotcha cache keys
↑↓ move · ⏎ open · space tick · f filter · esc close
```

Move with **↑ ↓** (or `j` `k`) and press **Enter** to open a card; one card is open at a time. The open card's keys:

| Key | Ask (sends the bookmark to the model) | Key | Card |
| --- | --- | --- | --- |
| `e` | **Explain**: go deeper, with an example | `p` | **Pin / Unpin**: keep it in the system prompt in this project |
| `t` | **TL;DR**: 3 bullets at most | `y` | **Copy**: the command, else the first code block, else the text |
| `c` | **In code**: where it lives, as file:line | `g` | **Group**: pick a group, make a new one, or ungroup |
| `v` | **Verify**: check each claim, change nothing | `o` | **Color**: cycle the card's color |
| `r` | **Remember**: add the lesson to `AGENTS.md` | `x` | **Remove** |

**Several at once:** **Space** ticks a card. With cards ticked, `C` **Connect** (how they relate), `L` **Checklist**, `D` **Design note**, `G` **Group**, `u` clear.

**Groups:** Enter on a heading folds it, `R` renames it. **Tags:** `f` cycles the filter through your tags.

An ask closes the pane and sends the prompt; while the model is busy it waits its turn. A button already asked shows as `Explain…` and stays locked until its answer ends, so a double press does not send it twice.

## Good to know

- **Bookmarks are saved** in `~/.pi/agent/bookmarks.json` (readable only by you), shared by every project and session. Up to 500 are kept.
- **Pins are per project:** they ride along in the system prompt of every turn in the folder they were made in, up to 12,000 characters in all (3,000 each). The footer shows `📌 N` while any are pinned here.
- **Emoji:** `/bm-emoji off` swaps them for plain marks if your terminal draws them badly.
- **No mouse:** pi has no hover or selection hooks, so bookmarking goes through `/bm` and Alt+M.

## Developing

```
npm install
npm run check   # tsc against pi's types
npm test        # node --test
pi -e ./extensions/bookmarks/index.ts
```

`extensions/bookmarks/core.ts` holds the logic with no pi imports (data, prompts, parsing); `index.ts` wires it to pi: commands, the pane, the pin hook.

## License

MIT. See [LICENSE](LICENSE).
