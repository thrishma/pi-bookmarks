// Bookmarks for pi: save what you or the model said, keep it in a pane, and act on it.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type Ask,
	ASKS,
	addTags,
	ago,
	askPrompt,
	type Bookmark,
	BUSY_MAX_MS,
	clip,
	colorOf,
	copyTextOf,
	cycleColor,
	GROUP_ASKS,
	type GroupAsk,
	groupName,
	groupPrompt,
	groupsOf,
	labelOf,
	MAX,
	newId,
	nextColor,
	paint,
	pick,
	pinnedSection,
	rowsOf,
	type Store,
	tagLabel,
	tagsOf,
	toTags,
	treeLabel,
	UNGROUPED,
	withGroup,
	wrapLines,
} from "./core.ts";

// ── Store: one JSON file for every project and session, like pi's own settings ──

const STORE = join(getAgentDir(), "bookmarks.json");

const load = async (): Promise<Store> => {
	try {
		const data = JSON.parse(await readFile(STORE, "utf8")) as Partial<Store>;
		return { list: Array.isArray(data.list) ? data.list : [], emoji: data.emoji !== false };
	} catch {
		return { list: [], emoji: true };
	}
};

// Read, change, write: another pi window may have saved since this one last read.
const save = async (fn: (s: Store) => Store) => {
	const next = fn(await load());
	next.list = next.list.slice(-MAX);
	await mkdir(dirname(STORE), { recursive: true });
	const tmp = `${STORE}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
	await rename(tmp, STORE);
	await chmod(STORE, 0o600).catch(() => {});
	return next;
};

const change = (id: string, fn: (b: Bookmark) => Bookmark) => (s: Store) => ({
	...s,
	list: s.list.map((b) => (b.id === id ? fn(b) : b)),
});

// ── Pane state that outlives one opening of the pane ──

let openId = ""; // the card showing its actions; '' for the newest
let ticked: string[] = [];
let filterTag = "";
let folded: string[] = [];

/** Asks sent and not yet answered: the same button stays locked until its answer ends. */
const busy = new Map<string, { text: string; at: number }>();
const isBusy = (key: string) => {
	const a = busy.get(key);
	return a !== undefined && Date.now() - a.at < BUSY_MAX_MS;
};

type PaneResult =
	| { kind: "close" }
	| { kind: "ask"; key: string; text: string }
	| { kind: "group"; ids: string[] }
	| { kind: "rename"; group: string };

type Item = { kind: "heading"; group: string; count: number } | { kind: "card"; b: Bookmark };

/** What the pane lists, in order: groups newest first with their cards, then the rest. */
const itemsOf = (all: readonly Bookmark[]): Item[] => {
	const shown = [...all].reverse().filter((b) => filterTag === "" || tagsOf(b).includes(filterTag));
	const groups = groupsOf(all);
	if (groups.length === 0) return shown.map((b) => ({ kind: "card", b }));
	const items: Item[] = [];
	for (const g of [...groups, UNGROUPED]) {
		const cards = shown.filter((b) => (b.group ?? UNGROUPED) === g);
		if (cards.length === 0) continue;
		items.push({ kind: "heading", group: g, count: cards.length });
		if (!folded.includes(g)) for (const b of cards) items.push({ kind: "card", b });
	}
	return items;
};

class Pane {
	private cursor = 0;
	private flash = "";
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly ctx: ExtensionContext;
	private store: Store;
	private readonly done: (r: PaneResult) => void;

	constructor(tui: TUI, theme: Theme, ctx: ExtensionContext, store: Store, done: (r: PaneResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.ctx = ctx;
		this.store = store;
		this.done = done;
		const items = itemsOf(store.list);
		const at = items.findIndex((i) => i.kind === "card" && i.b.id === openId);
		this.cursor = Math.max(0, at === -1 ? items.findIndex((i) => i.kind === "card") : at);
	}

	invalidate() {}

	private redraw() {
		this.tui.requestRender();
	}

	private async apply(fn: (s: Store) => Store, flash = "") {
		this.store = await save(fn);
		this.flash = flash;
		const n = itemsOf(this.store.list).length;
		this.cursor = Math.min(this.cursor, Math.max(0, n - 1));
		this.redraw();
	}

	private current(): Item | undefined {
		return itemsOf(this.store.list)[this.cursor];
	}

	handleInput(data: string) {
		const items = itemsOf(this.store.list);
		const item = items[this.cursor];
		const b = item?.kind === "card" ? item.b : undefined;
		this.flash = "";

		if (matchesKey(data, Key.escape) || data === "q") return this.done({ kind: "close" });
		if (matchesKey(data, Key.up) || data === "k") {
			this.cursor = Math.max(0, this.cursor - 1);
			return this.redraw();
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.cursor = Math.min(items.length - 1, this.cursor + 1);
			return this.redraw();
		}
		if (matchesKey(data, Key.enter)) {
			if (item?.kind === "heading") {
				folded = folded.includes(item.group) ? folded.filter((g) => g !== item.group) : [...folded, item.group];
			} else if (b) openId = this.openCard()?.id === b.id ? "-" : b.id;
			return this.redraw();
		}
		if (data === "f") {
			const tags = [...new Set(this.store.list.flatMap(tagsOf))];
			const all = ["", ...tags];
			filterTag = all[(all.indexOf(filterTag) + 1) % all.length] ?? "";
			this.cursor = 0;
			return this.redraw();
		}
		if (data === "R" && item?.kind === "heading" && item.group !== UNGROUPED) {
			return this.done({ kind: "rename", group: item.group });
		}

		// The ticked set: Connect, Checklist, Design note, Group, Clear.
		if (ticked.length > 0) {
			const chosen = this.store.list.filter((x) => ticked.includes(x.id));
			for (const [kind, a] of Object.entries(GROUP_ASKS) as [GroupAsk, (typeof GROUP_ASKS)[GroupAsk]][]) {
				if (data !== a.key) continue;
				const key = `group:${kind}:${[...ticked].sort().join(",")}`;
				if (isBusy(key)) return this.note(`${a.label} is still being answered`);
				ticked = [];
				return this.done({ kind: "ask", key, text: groupPrompt(chosen, kind) });
			}
			if (data === "G") return this.done({ kind: "group", ids: [...ticked] });
			if (data === "u") {
				ticked = [];
				return this.redraw();
			}
		}

		if (!b) return;
		if (matchesKey(data, Key.space)) {
			ticked = ticked.includes(b.id) ? ticked.filter((id) => id !== b.id) : [...ticked, b.id];
			return this.redraw();
		}

		// The open card's rows.
		const open = this.openCard();
		if (open?.id !== b.id) return;
		for (const [kind, a] of Object.entries(ASKS) as [Ask, (typeof ASKS)[Ask]][]) {
			if (data !== a.key) continue;
			const key = `${kind}:${b.id}`;
			if (isBusy(key)) return this.note(`${a.label} is still being answered`);
			return this.done({ kind: "ask", key, text: askPrompt(b, kind) });
		}
		if (data === "p") {
			void this.apply(
				change(b.id, (x) => ({ ...x, pinned: !x.pinned })),
				b.pinned ? "Unpinned" : "Pinned: the model sees it in this project",
			);
		} else if (data === "y") {
			copyToClipboard(copyTextOf(b)).then(
				() => this.note("Copied"),
				() => this.note("Could not reach the clipboard"),
			);
		} else if (data === "g") {
			this.done({ kind: "group", ids: [b.id] });
		} else if (data === "o") {
			void this.apply(change(b.id, (x) => ({ ...x, color: cycleColor(x) })));
		} else if (data === "x" || matchesKey(data, Key.delete)) {
			ticked = ticked.filter((id) => id !== b.id);
			unlabel(this.ctx, b);
			void this.apply((s) => ({ ...s, list: s.list.filter((x) => x.id !== b.id) }), "Removed");
		}
	}

	private note(text: string) {
		this.flash = text;
		this.redraw();
	}

	/** The card showing its actions: the one picked, else the newest shown. */
	private openCard() {
		if (openId === "-") return undefined;
		const cards = itemsOf(this.store.list).flatMap((i) => (i.kind === "card" ? [i.b] : []));
		return cards.find((b) => b.id === openId) ?? cards[0];
	}

	render(width: number): string[] {
		const th = this.theme;
		const fit = (s: string) => truncateToWidth(s, width);
		const right = (left: string, r: string) => {
			const gap = width - visibleWidth(left) - visibleWidth(r);
			return gap >= 1 ? left + " ".repeat(gap) + r : fit(left);
		};
		const emoji = this.store.emoji;
		const all = this.store.list;
		const items = itemsOf(all);
		const cwd = this.ctx.cwd;

		// Header: the counts, then the tag chips.
		const groups = groupsOf(all).length;
		const pinsHere = all.filter((b) => b.pinned && b.cwd === cwd).length;
		const summary = [
			`${all.length} bookmark${all.length === 1 ? "" : "s"}`,
			...(groups > 0 ? [`${groups} group${groups === 1 ? "" : "s"}`] : []),
			...(pinsHere > 0 ? [`${pinsHere} pinned here`] : []),
		].join(" · ");
		const head = [right(th.bold("Bookmarks"), th.fg("dim", summary))];
		const tagCounts = new Map<string, number>();
		for (const b of all) for (const t of tagsOf(b)) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
		if (tagCounts.size > 0) {
			const chip = (tag: string, text: string) =>
				tag === filterTag ? th.fg("accent", th.bold(text)) : th.fg("muted", text);
			const chips = [chip("", "All"), ...[...tagCounts].map(([t, n]) => chip(t, `${tagLabel(emoji, t)} ${n}`))];
			head.push(fit(chips.join("  ")));
		}
		if (ticked.length > 0) {
			const acts = [
				...Object.values(GROUP_ASKS).map((a) => `${th.fg("accent", a.key)} ${a.label}`),
				`${th.fg("accent", "G")} Group`,
				`${th.fg("accent", "u")} Clear`,
			];
			head.push(...this.row(th.bold(`${ticked.length} ticked`), acts, width));
		}
		head.push("");

		// Body: each item's lines, kept apart so the window can follow the cursor.
		const open = this.openCard();
		const blocks: string[][] = items.map((item, i) => {
			const here = i === this.cursor;
			if (item.kind === "heading") {
				const caret = folded.includes(item.group) ? "▸" : "▾";
				const line = `${caret} ${th.bold(item.group)} ${th.fg("dim", String(item.count))}`;
				const hint = here && item.group !== UNGROUPED ? th.fg("dim", "R rename") : "";
				const l = right(line, hint);
				return [here ? th.bg("selectedBg", truncateToWidth(l, width, "…", true)) : l];
			}
			const b = item.b;
			const isOpen = open?.id === b.id;
			const bar = paint(colorOf(b), "▎");
			const inner = width - 2;
			const pin = b.pinned ? th.fg("accent", emoji ? " · 📌" : " · pinned") : "";
			const top = `${bar}${isOpen ? "▾" : "▸"} ${th.bold(labelOf(b, emoji))} ${th.fg("dim", ago(Date.now(), b.savedAt))}${pin}`;
			const tick = ticked.includes(b.id) ? th.fg("accent", "☑") : th.fg("dim", "☐");
			const first = right(top, tick);
			const lines = [here ? th.bg("selectedBg", truncateToWidth(first, width, "…", true)) : first];
			for (const l of wrapLines(b.text, inner, isOpen ? 8 : 2)) lines.push(fit(`${bar} ${l}`));
			const tags = tagsOf(b);
			const rest = b.note.replace(/#[\p{L}\p{N}_-]+/gu, "").trim();
			if (tags.length > 0 || rest) {
				const t = tags.map((x) => th.fg("accent", tagLabel(emoji, x))).join(" ");
				lines.push(fit(`${bar} ${[t, th.fg("muted", rest)].filter(Boolean).join(" ")}`));
			}
			if (isOpen) {
				const asks = (Object.entries(ASKS) as [Ask, (typeof ASKS)[Ask]][]).map(([kind, a]) =>
					isBusy(`${kind}:${b.id}`) ? th.fg("dim", `${a.label}…`) : `${th.fg("accent", a.key)} ${a.label}`,
				);
				const card = [
					`${th.fg("accent", "p")} ${b.pinned ? "Unpin" : "Pin"}`,
					`${th.fg("accent", "y")} Copy`,
					`${th.fg("accent", "g")} Group`,
					`${th.fg("accent", "o")} Color`,
					`${th.fg("accent", "x")} ${th.fg("error", "✕")}`,
				];
				for (const l of this.row(th.fg("dim", "Ask "), asks, inner)) lines.push(`${bar} ${l}`);
				for (const l of this.row(th.fg("dim", "Card"), card, inner)) lines.push(`${bar} ${l}`);
			}
			lines.push("");
			return lines;
		});

		const foot = [
			this.flash
				? th.fg("accent", this.flash)
				: th.fg("dim", fit("↑↓ move · ⏎ open · space tick · f filter · esc close")),
		];

		if (items.length === 0) {
			const empty = all.length === 0 ? "Nothing yet. /bm bookmarks the last reply." : "Nothing has this tag.";
			return [...head, th.fg("muted", fit(empty)), "", ...foot];
		}

		// Show the cursor's block whole, then as much around it as the screen holds.
		const room = Math.max(6, Math.floor(this.tui.terminal.rows * 0.9) - head.length - foot.length - 2);
		let from = this.cursor;
		let to = this.cursor + 1;
		let used = blocks[this.cursor]?.length ?? 0;
		while (true) {
			const below = blocks[to];
			if (below && used + below.length <= room) {
				used += below.length;
				to++;
				continue;
			}
			const above = blocks[from - 1];
			if (above && used + above.length <= room) {
				used += above.length;
				from--;
				continue;
			}
			break;
		}
		const body = blocks.slice(from, to).flat().slice(0, room);
		const more = th.fg("dim", "  ⋯");
		return [...head, ...(from > 0 ? [more] : []), ...body, ...(to < blocks.length ? [more] : []), ...foot];
	}

	/** A label and its actions, right-aligned, wrapping onto more lines when they do not fit. */
	private row(label: string, acts: string[], width: number) {
		const sep = this.theme.fg("dim", " · ");
		const lines: string[] = [];
		let line = "";
		for (const a of acts) {
			const next = line ? line + sep + a : a;
			if (line && visibleWidth(label) + 2 + visibleWidth(next) > width) {
				lines.push(line);
				line = a;
			} else line = next;
		}
		if (line) lines.push(line);
		return lines.map((l, i) => {
			const lead = i === 0 ? label : "";
			const gap = Math.max(1, width - visibleWidth(lead) - visibleWidth(l));
			return truncateToWidth(lead + " ".repeat(gap) + l, width);
		});
	}
}

// ── Labels in /tree ──

let setLabel: ExtensionAPI["setLabel"] = () => {};

const label = (ctx: ExtensionContext, b: Bookmark) => {
	if (b.entryId && b.sessionFile === ctx.sessionManager.getSessionFile()) setLabel(b.entryId, treeLabel(b));
};
const unlabel = (ctx: ExtensionContext, b: Bookmark) => {
	if (b.entryId && b.sessionFile === ctx.sessionManager.getSessionFile()) setLabel(b.entryId, undefined);
};

const showPins = (ctx: ExtensionContext, store: Store) => {
	const n = store.list.filter((b) => b.pinned && b.cwd === ctx.cwd).length;
	ctx.ui.setStatus("bookmarks", n > 0 ? ctx.ui.theme.fg("dim", `${store.emoji ? "📌" : "pinned"} ${n}`) : undefined);
};

export default function bookmarks(pi: ExtensionAPI) {
	setLabel = (id, l) => pi.setLabel(id, l);

	const send = (ctx: ExtensionContext, key: string, text: string) => {
		busy.set(key, { text, at: Date.now() });
		if (ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "followUp" });
	};

	const chooseGroup = async (ctx: ExtensionContext, ids: string[]) => {
		const store = await load();
		const chosen = store.list.filter((b) => ids.includes(b.id));
		const mine = new Set(chosen.map((b) => b.group).filter(Boolean));
		const others = groupsOf(store.list).filter((g) => !(mine.size === 1 && mine.has(g)));
		const NEW = "+ New group";
		const OUT = "Ungroup";
		const options = [...others, NEW, ...(mine.size > 0 ? [OUT] : [])];
		const what = chosen.length === 1 ? `"${clip(chosen[0]?.text ?? "", 40)}"` : `${chosen.length} bookmarks`;
		const pickd = options.length === 1 ? NEW : await ctx.ui.select(`Group ${what}`, options);
		if (pickd === undefined) return;
		let name = pickd === OUT ? "" : pickd;
		if (pickd === NEW) {
			const typed = await ctx.ui.input("New group name", "e.g. Auth refactor");
			if (typed === undefined || groupName(typed) === "") return;
			name = groupName(typed);
		}
		await save((s) => ({ ...s, list: s.list.map((b) => (ids.includes(b.id) ? withGroup(b, name) : b)) }));
		ticked = [];
		ctx.ui.notify(name ? `Grouped under ${name}` : "Ungrouped", "info");
	};

	const renameGroup = async (ctx: ExtensionContext, group: string) => {
		const typed = await ctx.ui.input(`Rename "${group}"`, group);
		const name = typed === undefined ? "" : groupName(typed);
		if (name === "" || name === group) return;
		await save((s) => ({ ...s, list: s.list.map((b) => (b.group === group ? withGroup(b, name) : b)) }));
		folded = folded.map((g) => (g === group ? name : g));
	};

	const openPane = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		// Nothing running and nothing queued: no ask is being answered, whatever became of it (a run can fail
		// before agent_end, e.g. with no model logged in). The grace covers an ask sent a moment ago.
		if (ctx.isIdle() && !ctx.hasPendingMessages()) {
			for (const [key, a] of busy) if (Date.now() - a.at > 3000) busy.delete(key);
		}
		while (true) {
			const store = await load();
			const result = await ctx.ui.custom<PaneResult>(
				(tui, theme, _keys, done) => new Pane(tui, theme, ctx, store, done),
				{
					overlay: true,
					overlayOptions: { anchor: "right-center", width: "42%", minWidth: 46, maxHeight: "90%", margin: 1 },
				},
			);
			showPins(ctx, await load());
			if (!result || result.kind === "close") return;
			if (result.kind === "ask") return send(ctx, result.key, result.text);
			if (result.kind === "group") await chooseGroup(ctx, result.ids);
			if (result.kind === "rename") await renameGroup(ctx, result.group);
		}
	};

	const bookmark = async (args: string, ctx: ExtensionContext) => {
		const { found, note, query } = pick(rowsOf(ctx.sessionManager.getBranch()), args);
		if (!found) {
			const what = query === "" ? "reply" : query === "me" ? "message of yours" : query === "tool" ? "tool call" : `message with "${query}"`;
			return ctx.ui.notify(`No ${what} to bookmark yet`, "warning");
		}
		const tags = toTags(note.match(/#[\p{L}\p{N}_-]+/gu)?.join(" ") ?? "");
		let made: Bookmark | undefined;
		const store = await save((s) => {
			const same = s.list.find((b) => b.text === found.text && b.cwd === ctx.cwd);
			if (same) {
				made = note ? addTags({ ...same, note: same.note || note }, tags) : same;
				return change(same.id, () => made as Bookmark)(s);
			}
			const now = Date.now();
			made = {
				id: newId(now),
				role: found.role,
				...(found.tool ? { tool: found.tool } : {}),
				...(found.copy ? { copy: found.copy } : {}),
				text: found.text,
				note,
				cwd: ctx.cwd,
				savedAt: now,
				entryId: found.entryId,
				...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
				color: nextColor(s.list),
			};
			return { ...s, list: [...s.list, made] };
		});
		if (!made) return;
		label(ctx, made);
		openId = made.id;
		showPins(ctx, store);
		ctx.ui.notify(`Bookmarked: "${clip(found.text, 70)}"`, "info");
	};

	pi.registerCommand("bm", {
		description: "Bookmark the last reply (/bm me: yours, /bm tool, /bm <words>; add -- #tag note)",
		handler: async (args, ctx) => bookmark(args, ctx),
	});

	pi.registerCommand("bm-tag", {
		description: "Tag your newest bookmark: /bm-tag gotcha decision",
		handler: async (args, ctx) => {
			const tags = toTags(args);
			if (tags.length === 0) return ctx.ui.notify("Name a tag: /bm-tag gotcha", "warning");
			const store = await load();
			const last = store.list.at(-1);
			if (!last) return ctx.ui.notify("No bookmarks yet", "warning");
			await save(change(last.id, (b) => addTags(b, tags)));
			label(ctx, addTags(last, tags));
			ctx.ui.notify(`Tagged ${tags.join(" ")}`, "info");
		},
	});

	pi.registerCommand("bm-group", {
		description: "Group the ticked bookmarks, or your newest: /bm-group Auth refactor (no name ungroups)",
		handler: async (args, ctx) => {
			const store = await load();
			const ids = ticked.length > 0 ? ticked : store.list.slice(-1).map((b) => b.id);
			if (ids.length === 0) return ctx.ui.notify("No bookmarks yet", "warning");
			const name = groupName(args);
			await save((s) => ({ ...s, list: s.list.map((b) => (ids.includes(b.id) ? withGroup(b, name) : b)) }));
			ticked = [];
			ctx.ui.notify(name ? `Grouped under ${name}` : "Ungrouped", "info");
		},
	});

	pi.registerCommand("bm-emoji", {
		description: "Turn the pane's emoji on or off: /bm-emoji off",
		handler: async (args, ctx) => {
			const on = !/^(off|no|false|0)$/i.test(args.trim());
			const store = await save((s) => ({ ...s, emoji: on }));
			showPins(ctx, store);
			ctx.ui.notify(`Emoji ${on ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("bookmarks", {
		description: "Open the bookmarks pane",
		handler: async (_args, ctx) => openPane(ctx),
	});

	pi.registerShortcut("alt+m", {
		description: "Bookmark the last reply",
		handler: async (ctx) => bookmark("", ctx),
	});
	pi.registerShortcut("alt+o", {
		description: "Open the bookmarks pane",
		handler: async (ctx) => openPane(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		const store = await load();
		showPins(ctx, store);
		// Labels are per session: give this session's bookmarked entries theirs back.
		const file = ctx.sessionManager.getSessionFile();
		for (const b of store.list) {
			if (b.entryId && b.sessionFile === file && !ctx.sessionManager.getLabel(b.entryId)) label(ctx, b);
		}
	});

	// Pins ride along in the system prompt of every turn in their project.
	pi.on("before_agent_start", async (event, ctx) => {
		const section = pinnedSection((await load()).list, ctx.cwd);
		if (!section) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});

	// An ask's lock lets go once the run that answered it ends.
	pi.on("agent_end", async (event) => {
		const asked = new Set(
			event.messages.flatMap((m) => {
				if (m.role !== "user") return [];
				const c = m.content;
				return [typeof c === "string" ? c : c.map((x) => (x.type === "text" ? x.text : "")).join("")];
			}),
		);
		for (const [key, a] of busy) if (asked.has(a.text) || Date.now() - a.at >= BUSY_MAX_MS) busy.delete(key);
	});
}
