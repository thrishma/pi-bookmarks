import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addTags,
	askPrompt,
	type Bookmark,
	copyTextOf,
	groupPrompt,
	groupsOf,
	PIN_EACH,
	pick,
	pinnedSection,
	rowsOf,
	tagsOf,
	toTags,
	withGroup,
	wrapLines,
} from "../extensions/bookmarks/core.ts";

const entries = [
	{ type: "message", id: "u1", message: { role: "user", content: "Why does the cache miss?" } },
	{
		type: "message",
		id: "a1",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "Both keys include the request time." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } },
			],
		},
	},
	{
		type: "message",
		id: "r1",
		message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "1 failing" }] },
	},
	{ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "Fixed the key." }] } },
	{ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "I bookmarked something you said earlier." }] } },
	{ type: "label", id: "l1", targetId: "a2", label: "x" },
];

const bm = (over: Partial<Bookmark> = {}): Bookmark => ({
	id: "b1",
	role: "assistant",
	text: "Both keys include the request time.",
	note: "",
	cwd: "/p",
	savedAt: 1,
	...over,
});

test("rowsOf keeps text, joins tool results to their call, and skips our own asks", () => {
	const rows = rowsOf(entries);
	assert.deepEqual(
		rows.map((r) => [r.entryId, r.role]),
		[
			["u1", "user"],
			["a1", "assistant"],
			["r1", "tool"],
			["a2", "assistant"],
		],
	);
	assert.equal(rows[1]?.text, "Both keys include the request time.");
	assert.equal(rows[2]?.text, "bash: npm test\n\n1 failing");
	assert.equal(rows[2]?.copy, "npm test");
});

test("pick: last reply, me, tool, words, and a note after --", () => {
	const rows = rowsOf(entries);
	assert.equal(pick(rows, "").found?.entryId, "a2");
	assert.equal(pick(rows, "me").found?.entryId, "u1");
	assert.equal(pick(rows, "tool").found?.entryId, "r1");
	assert.equal(pick(rows, "request time").found?.entryId, "a1");
	const p = pick(rows, "cache -- #gotcha check keys");
	assert.equal(p.found?.entryId, "u1");
	assert.equal(p.note, "#gotcha check keys");
	assert.equal(pick(rows, "-- just a note").found?.entryId, "a2");
	assert.equal(pick(rows, "nowhere").found, undefined);
});

test("tags live in the note", () => {
	assert.deepEqual(toTags("#Gotcha, decision bad!"), ["#gotcha", "#decision"]);
	const b = addTags(bm({ note: "why #gotcha" }), ["#gotcha", "#perf"]);
	assert.equal(b.note, "why #gotcha #perf");
	assert.deepEqual(tagsOf(b), ["#gotcha", "#perf"]);
});

test("groups: newest group first, empty name ungroups", () => {
	const all = [bm({ id: "a", group: "Old", savedAt: 1 }), bm({ id: "b", group: "New", savedAt: 5 }), bm({ id: "c" })];
	assert.deepEqual(groupsOf(all), ["New", "Old"]);
	assert.equal(withGroup(all[0] as Bookmark, "").group, undefined);
});

test("prompts carry the bookmark and its note", () => {
	const p = askPrompt(bm({ note: "#gotcha" }), "tldr");
	assert.match(p, /^I bookmarked something you said earlier\. Give me the TL;DR/);
	assert.match(p, /<bookmark>\nBoth keys include the request time\.\n<\/bookmark>\n\nMy note on it: #gotcha$/);
	const g = groupPrompt([bm(), bm({ id: "b2", role: "user", text: "Why?" })], "connect");
	assert.match(g, /^I bookmarked 2 things/);
	assert.match(g, /<bookmark n="2" from="I wrote">\nWhy\?/);
});

test("pinned section: only this project's pins, each capped", () => {
	const long = "x".repeat(PIN_EACH + 50);
	const all = [bm({ pinned: true }), bm({ id: "2", pinned: true, cwd: "/other" }), bm({ id: "3", pinned: true, text: long })];
	const s = pinnedSection(all, "/p") ?? "";
	assert.match(s, /^# Pinned by the user/);
	assert.equal((s.match(/<pinned /g) ?? []).length, 2);
	assert.ok(s.includes(`${"x".repeat(PIN_EACH)}…`));
	assert.equal(pinnedSection(all.map((b) => ({ ...b, pinned: false })), "/p"), undefined);
});

test("copy takes a command, else the first code block", () => {
	assert.equal(copyTextOf(bm({ copy: "npm test" })), "npm test");
	assert.equal(copyTextOf(bm({ text: "Run:\n```sh\nmake\n```\n" })), "make");
});

test("wrapLines cuts with an ellipsis", () => {
	const lines = wrapLines("one two three four five six", 9, 2);
	assert.deepEqual(lines, ["one two", "three…"]);
});
