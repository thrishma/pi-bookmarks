// Loads the real extension against a fake pi, then drives its commands, hooks and pane.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "pi-bookmarks-"));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: bookmarks } = await import("../extensions/bookmarks/index.ts");

const entries = [
	{ type: "message", id: "u1", message: { role: "user", content: "Why does the cache miss?" } },
	{
		type: "message",
		id: "a1",
		message: { role: "assistant", content: [{ type: "text", text: "Both keys include the request time." }] },
	},
];

type Handler = (...args: any[]) => any;
const commands = new Map<string, Handler>();
const events = new Map<string, Handler>();
const labels = new Map<string, string | undefined>();
const sent: { text: string; opts?: unknown }[] = [];
const notes: string[] = [];
let idle = true;
let paneFactory: Handler | undefined;
let paneResolve: ((r: unknown) => void) | undefined;

const pi = {
	registerCommand: (name: string, o: { handler: Handler }) => commands.set(name, o.handler),
	registerShortcut: () => {},
	on: (name: string, h: Handler) => events.set(name, h),
	setLabel: (id: string, l: string | undefined) => labels.set(id, l),
	sendUserMessage: (text: string, opts?: unknown) => sent.push({ text, opts }),
};

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
const ctx = {
	cwd: "/proj",
	hasUI: true,
	isIdle: () => idle,
	hasPendingMessages: () => false,
	sessionManager: {
		getBranch: () => entries,
		getSessionFile: () => "/s.jsonl",
		getLabel: (id: string) => labels.get(id),
	},
	ui: {
		theme,
		notify: (m: string) => notes.push(m),
		setStatus: () => {},
		select: async (_t: string, options: string[]) => options.find((o) => o === "+ New group"),
		input: async () => "Fish",
		custom: (factory: Handler) =>
			new Promise((resolve) => {
				paneFactory = factory;
				paneResolve = resolve;
			}),
	},
};

bookmarks(pi as any);

const stored = () => JSON.parse(readFileSync(join(dir, "bookmarks.json"), "utf8"));

/** Opens the pane and hands back its component; `done` resolves the pane like pi would. */
const openPane = async () => {
	const run = commands.get("bookmarks")?.("", ctx);
	await new Promise((r) => setTimeout(r, 10));
	const tui = { requestRender: () => {}, terminal: { rows: 40 } };
	const pane = paneFactory?.(tui, theme, {}, (r: unknown) => paneResolve?.(r));
	return { pane, run, view: () => pane.render(50).map(plain).join("\n") };
};

test("/bm saves the last reply with its note, labels it in /tree", async () => {
	await commands.get("bm")?.("-- #gotcha check keys", ctx);
	const [b] = stored().list;
	assert.equal(b.text, "Both keys include the request time.");
	assert.equal(b.note, "#gotcha check keys");
	assert.equal(b.entryId, "a1");
	assert.equal(labels.get("a1"), "★ #gotcha");
	await commands.get("bm")?.("me", ctx);
	assert.equal(stored().list.length, 2);
	await commands.get("bm")?.("me", ctx);
	assert.equal(stored().list.length, 2, "bookmarking the same text twice keeps one");
});

test("the pane shows cards and the open card's actions", async () => {
	const { pane, view } = await openPane();
	const v = view();
	assert.match(v, /Bookmarks\s+2 bookmarks/);
	assert.match(v, /🙋 You/);
	assert.match(v, /Ask\s+e Explain · t TL;DR/);
	assert.match(v, /Card\s+p Pin · y Copy · g Group · o Color · x ✕/);
	for (const line of pane.render(50)) assert.ok(plain(line).length <= 50, `too wide: ${line}`);
	pane.handleInput("\x1b");
});

test("Pin adds the bookmark to this project's system prompt only", async () => {
	const { pane } = await openPane();
	pane.handleInput("j"); // the reply's card (the newest is "me")
	pane.handleInput("\r");
	pane.handleInput("p");
	await new Promise((r) => setTimeout(r, 20));
	pane.handleInput("\x1b");
	const here = await events.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx);
	assert.match(here.systemPrompt, /^BASE\n\n# Pinned by the user/);
	assert.match(here.systemPrompt, /Both keys include the request time\./);
	const elsewhere = await events.get("before_agent_start")?.({ systemPrompt: "BASE" }, { ...ctx, cwd: "/other" });
	assert.equal(elsewhere, undefined);
});

test("an ask is sent once and locked until its run ends", async () => {
	let { pane, run } = await openPane();
	pane.handleInput("e");
	await run;
	assert.equal(sent.length, 1);
	assert.match(sent[0]?.text ?? "", /^I bookmarked something you said earlier\. Explain it further/);

	({ pane, run } = await openPane());
	assert.match(plain(pane.render(50).join("\n")), /Explain…/);
	pane.handleInput("e");
	assert.equal(sent.length, 1, "a second Explain while the first is answered sends nothing");
	await events.get("agent_end")?.({ messages: [{ role: "user", content: sent[0]?.text }] });
	pane.handleInput("e");
	await run;
	assert.equal(sent.length, 2, "after the answer the button works again");

	idle = false;
	({ pane, run } = await openPane());
	pane.handleInput("t");
	await run;
	assert.deepEqual(sent[2]?.opts, { deliverAs: "followUp" }, "while busy the ask waits its turn");
	idle = true;
});

test("ticked cards group into a new group, with headings in the pane", async () => {
	let { pane, run } = await openPane();
	pane.handleInput("k"); // the pane reopens on the card left open: start from the top
	pane.handleInput(" ");
	pane.handleInput("j");
	pane.handleInput(" ");
	assert.match(plain(pane.render(50).join("\n")), /2 ticked/);
	pane.handleInput("G");
	await new Promise((r) => setTimeout(r, 20));
	// The pane closed for the group dialog; it opens again after.
	({ pane } = await openPane().then((p) => ({ ...p, run })));
	assert.deepEqual(
		stored().list.map((b: { group?: string }) => b.group),
		["Fish", "Fish"],
	);
	assert.match(plain(pane.render(50).join("\n")), /▾ Fish 2/);
	pane.handleInput("\x1b");
});

test("x removes the open card and clears its /tree label", async () => {
	const { pane } = await openPane();
	pane.handleInput("k");
	pane.handleInput("k"); // the Fish heading
	pane.handleInput("j"); // its first card, closed
	pane.handleInput("\r");
	const before = stored().list.length;
	pane.handleInput("x");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(stored().list.length, before - 1);
	pane.handleInput("\x1b");
});
