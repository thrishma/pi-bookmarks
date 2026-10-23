// What the bookmarks extension does, free of pi: the data, the prompts, finding messages.
// Kept apart from index.ts so the tests can run it without a pi session.

export type Role = "user" | "assistant" | "tool";

export type Bookmark = {
	id: string;
	role: Role;
	/** For a tool result: which tool (`bash`, `edit`, …). */
	tool?: string;
	/** What Copy puts on the clipboard when it is not the text itself (a bash command). */
	copy?: string;
	/** Kept in the system prompt in this project, so it survives /compact. */
	pinned?: boolean;
	text: string;
	note: string;
	cwd: string;
	savedAt: number;
	/** The session entry it came from, and that session's file: where its /tree label sits. */
	entryId?: string;
	sessionFile?: string;
	/** The group it sits under in the pane; absent for Ungrouped. */
	group?: string;
	/** Its color, one of the palette's. */
	color?: Color;
};

export type Store = { list: Bookmark[]; emoji: boolean };

export const MAX = 500;
export const GROUP_MAX = 40;
export const PIN_BUDGET = 12_000;
export const PIN_EACH = 3_000;
export const TOOL_TEXT = 8_000;
/** A locked ask lets go on its own after this long, whatever became of its turn. */
export const BUSY_MAX_MS = 15 * 60_000;
export const UNGROUPED = "Ungrouped";

export const PALETTE = ["yellow", "cyan", "magenta", "green", "blue", "red"] as const;
export type Color = (typeof PALETTE)[number];
const ANSI: Record<Color, number> = { yellow: 33, cyan: 36, magenta: 35, green: 32, blue: 34, red: 31 };
export const paint = (color: Color, text: string) => `\x1b[${ANSI[color]}m${text}\x1b[39m`;

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export const clip = (text: string, max: number) => {
	const flat = oneLine(text);
	return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
};

// Word-wraps into at most `max` lines of `width`, the last ending in … when text is left over.
export const wrapLines = (text: string, width: number, max: number) => {
	const w = Math.max(4, width);
	const lines: string[] = [];
	let line = "";
	for (const word of oneLine(text).split(" ")) {
		const next = line ? `${line} ${word}` : word;
		if (next.length <= w) {
			line = next;
			continue;
		}
		if (line) lines.push(line);
		line = word.length > w ? word.slice(0, w) : word;
		if (lines.length === max) break;
	}
	if (line && lines.length < max) lines.push(line);
	const isCut = lines.join(" ").length < oneLine(text).length;
	if (isCut && lines.length > 0) {
		const last = lines.length - 1;
		lines[last] = `${(lines[last] ?? "").slice(0, w - 1)}…`;
	}
	return lines.slice(0, max);
};

export const ago = (now: number, then: number) => {
	const s = Math.max(0, Math.round((now - then) / 1000));
	if (s < 60) return "now";
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return `${Math.round(s / 86400)}d`;
};

// Tags live in the note as #words, so `/bm -- #gotcha why` and `/bm-tag` share one source.
export const tagsOf = (b: Bookmark) => [
	...new Set((b.note.match(/#[\p{L}\p{N}_-]+/gu) ?? []).map((t) => t.toLowerCase())),
];

export const toTags = (words: string) =>
	words
		.split(/[\s,]+/)
		.map((w) => w.replace(/^#+/, "").toLowerCase())
		.filter((w) => /^[\p{L}\p{N}_-]+$/u.test(w))
		.map((w) => `#${w}`);

export const addTags = (b: Bookmark, tags: readonly string[]): Bookmark => {
	const have = new Set(tagsOf(b));
	const add = tags.filter((t) => !have.has(t));
	return add.length === 0 ? b : { ...b, note: oneLine(`${b.note} ${add.join(" ")}`) };
};

export const colorOf = (b: Bookmark): Color => {
	if (b.color !== undefined && PALETTE.includes(b.color)) return b.color;
	let n = 0;
	for (const ch of b.id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
	return PALETTE[n % PALETTE.length] ?? "yellow";
};

export const nextColor = (all: readonly Bookmark[]): Color => PALETTE[all.length % PALETTE.length] ?? "yellow";

export const cycleColor = (b: Bookmark): Color => PALETTE[(PALETTE.indexOf(colorOf(b)) + 1) % PALETTE.length] ?? "yellow";

// A group name as typed, tidied; '' takes the bookmark out of its group.
export const groupName = (typed: string) => oneLine(typed).slice(0, GROUP_MAX);

export const withGroup = (b: Bookmark, name: string): Bookmark => {
	const { group: _old, ...rest } = b;
	return name === "" ? rest : { ...rest, group: name };
};

// Group names, the one holding the newest bookmark first.
export const groupsOf = (all: readonly Bookmark[]) => {
	const newest = new Map<string, number>();
	for (const b of all) if (b.group) newest.set(b.group, Math.max(newest.get(b.group) ?? 0, b.savedAt));
	return [...newest.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
};

export const newId = (now: number) => `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── Messages ────────────────────────────────────────────────────────────────

/** A session message reduced to what a bookmark needs. */
export type Row = { entryId: string; role: Role; text: string; tool?: string; copy?: string };

type Block = { type?: string; text?: string; name?: string; id?: string; arguments?: Record<string, unknown> };

const textOf = (content: unknown) => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
};

// A tool call as one bookmark: what was called, then what came back.
export const toolText = (tool: string, args: Record<string, unknown>, output: string) => {
	const what = [args.command, args.path, args.file_path, args.pattern, args.url, args.query].find(
		(v): v is string => typeof v === "string" && v !== "",
	);
	const call = what ?? clip(JSON.stringify(args) ?? "", 300);
	const text = `${tool}: ${call}${output ? `\n\n${output}` : ""}`;
	return {
		text: text.length > TOOL_TEXT ? `${text.slice(0, TOOL_TEXT)}\n… (cut)` : text,
		copy:
			typeof args.command === "string" ? args.command : typeof args.path === "string" ? args.path : undefined,
	};
};

// What an ask button sent is a user message too, but bookmarking the prompt behind a bookmark is noise.
const isOurAsk = (text: string) => text.startsWith("I bookmarked ");

/** The current branch's messages, oldest first, as rows a bookmark can be made from. */
export const rowsOf = (entries: readonly unknown[]): Row[] => {
	const rows: Row[] = [];
	const calls = new Map<string, Record<string, unknown>>();
	for (const raw of entries) {
		const entry = raw as { type?: string; id?: string; message?: Record<string, unknown> };
		if (entry.type !== "message" || !entry.message || !entry.id) continue;
		const m = entry.message;
		if (m.role === "user") {
			const text = textOf(m.content).trim();
			if (text && !isOurAsk(text)) rows.push({ entryId: entry.id, role: "user", text });
		} else if (m.role === "assistant") {
			const content = Array.isArray(m.content) ? (m.content as Block[]) : [];
			for (const c of content) if (c?.type === "toolCall" && c.id) calls.set(c.id, c.arguments ?? {});
			const text = textOf(content).trim();
			if (text) rows.push({ entryId: entry.id, role: "assistant", text });
		} else if (m.role === "toolResult") {
			const tool = typeof m.toolName === "string" ? m.toolName : "tool";
			const args = calls.get(String(m.toolCallId)) ?? {};
			rows.push({ entryId: entry.id, role: "tool", tool, ...toolText(tool, args, textOf(m.content).trim()) });
		} else if (m.role === "bashExecution" && typeof m.command === "string") {
			const out = typeof m.output === "string" ? m.output.trim() : "";
			rows.push({ entryId: entry.id, role: "tool", tool: "bash", ...toolText("bash", { command: m.command }, out) });
		}
	}
	return rows;
};

/**
 * `/bm` → the last reply. `/bm me` → your last message. `/bm tool` → the last tool call and its result.
 * `/bm <words>` → the most recent message (either side) containing those words.
 * Anything after ` -- ` becomes a note on the bookmark.
 */
export const pick = (rows: readonly Row[], args: string) => {
	const [query = "", note = ""] = args.split(/(?:^|\s+)--(?:\s+|$)/, 2).map((s) => s.trim());
	const q = query.toLowerCase();
	const found =
		q === ""
			? rows.findLast((r) => r.role === "assistant")
			: q === "me"
				? rows.findLast((r) => r.role === "user")
				: q === "tool"
					? rows.findLast((r) => r.role === "tool")
					: rows.findLast((r) => r.text.toLowerCase().includes(q));
	return { found, note, query };
};

// ── What the pane sends ─────────────────────────────────────────────────────

export const ASKS = {
	explain: {
		key: "e",
		label: "Explain",
		ask: "Explain it further: go deeper, give an example, and say what I should take away from it.",
	},
	tldr: { key: "t", label: "TL;DR", ask: "Give me the TL;DR: at most 3 short bullets, the point first. No preamble." },
	code: {
		key: "c",
		label: "In code",
		ask: "Show me where this lives in the code. Read the repo (do not guess) and point me to the exact places as file:line, one line each on why it matters. If it is not about this codebase, say so.",
	},
	verify: {
		key: "v",
		label: "Verify",
		ask: "Verify this before I rely on it. Check each claim against the actual code, docs or state, and say which hold, which do not and which you could not check, with the evidence. Do not change anything.",
	},
	remember: {
		key: "r",
		label: "Remember",
		ask: "Save the durable lesson in this where you will see it in future sessions: add it to this project's AGENTS.md (create it if missing) under a fitting heading, with the why and how to apply. Check it is not already there first. If it only matters to this conversation, tell me that instead of saving it.",
	},
} as const;
export type Ask = keyof typeof ASKS;

export const GROUP_ASKS = {
	connect: {
		key: "C",
		label: "Connect",
		ask: "How do these relate? Find the common thread, anything that contradicts, and what they add up to.",
	},
	checklist: {
		key: "L",
		label: "Checklist",
		ask: "Turn these into a concrete, ordered checklist I can act on. Mark anything you would verify first.",
	},
	note: {
		key: "D",
		label: "Design note",
		ask: "Write a short design note from these, in markdown: context, the decisions and why, and open questions.",
	},
} as const;
export type GroupAsk = keyof typeof GROUP_ASKS;

const whoOf = (b: Bookmark) =>
	b.role === "assistant" ? "you said" : b.role === "tool" ? `a ${b.tool ?? "tool"} call produced` : "I wrote";

export const askPrompt = (b: Bookmark, kind: Ask) => {
	const note = b.note ? `\n\nMy note on it: ${b.note}` : "";
	return `I bookmarked something ${whoOf(b)} earlier. ${ASKS[kind].ask}\n\n<bookmark>\n${b.text}\n</bookmark>${note}`;
};

export const groupPrompt = (bs: readonly Bookmark[], kind: GroupAsk) => {
	const items = bs
		.map((b, i) => {
			const note = b.note ? `\nMy note: ${b.note}` : "";
			return `<bookmark n="${i + 1}" from="${whoOf(b)}">\n${b.text}${note}\n</bookmark>`;
		})
		.join("\n\n");
	return `I bookmarked ${bs.length} things from our conversations. ${GROUP_ASKS[kind].ask}\n\n${items}`;
};

// Copy takes a tool's command, else the first code block, else the whole text.
export const copyTextOf = (b: Bookmark) => {
	if (b.copy) return b.copy;
	const fence = b.text.match(/```[^\n]*\n([\s\S]*?)```/);
	return fence?.[1]?.replace(/\n$/, "") ?? b.text;
};

/** The system prompt section that keeps this project's pins in the model's context. */
export const pinnedSection = (all: readonly Bookmark[], cwd: string) => {
	const pins = all.filter((b) => b.pinned && b.cwd === cwd);
	if (pins.length === 0) return undefined;
	let left = PIN_BUDGET;
	const items: string[] = [];
	for (const b of pins) {
		const body = b.text.length > PIN_EACH ? `${b.text.slice(0, PIN_EACH)}…` : b.text;
		const note = b.note ? ` note="${oneLine(b.note).replace(/"/g, "'")}"` : "";
		const item = `<pinned from="${b.role === "assistant" ? "you said" : whoOf(b)}"${note}>\n${body}\n</pinned>`;
		if (item.length > left) break;
		left -= item.length;
		items.push(item);
	}
	const cut = pins.length - items.length;
	return [
		"# Pinned by the user",
		"The user pinned these from the conversation so they stay in your context, through compaction too. Treat them as standing notes the user chose to keep: decisions, constraints and facts to honor. Text you wrote earlier may since have gone stale; check before relying on it.",
		...items,
		...(cut > 0 ? [`(${cut} more pinned bookmark${cut === 1 ? "" : "s"} did not fit.)`] : []),
	].join("\n\n");
};

// ── Labels ──────────────────────────────────────────────────────────────────

export const ROLE_EMOJI = { assistant: "🤖", user: "🙋", tool: "🔧" } as const;

export const TAG_EMOJI: Readonly<Record<string, string>> = {
	"#gotcha": "🐛",
	"#bug": "🐞",
	"#decision": "🧭",
	"#todo": "📝",
	"#idea": "💡",
	"#question": "❓",
	"#learn": "🎓",
	"#perf": "🚀",
	"#security": "🔒",
	"#fix": "🩹",
};

export const labelOf = (b: Bookmark, emoji: boolean) => {
	const name = b.role === "assistant" ? "Assistant" : b.role === "tool" ? (b.tool ?? "Tool") : "You";
	if (emoji) return `${ROLE_EMOJI[b.role]} ${name}`;
	return `${b.role === "assistant" ? "◆" : b.role === "tool" ? "▸" : "●"} ${name}`;
};

export const tagLabel = (emoji: boolean, tag: string) => (emoji && TAG_EMOJI[tag] ? `${TAG_EMOJI[tag]} ${tag}` : tag);

/** The label a bookmarked entry gets in pi's /tree. */
export const treeLabel = (b: Bookmark) => {
	const tags = tagsOf(b);
	return `★ ${tags.length > 0 ? tags.join(" ") : clip(b.text, 30)}`;
};
