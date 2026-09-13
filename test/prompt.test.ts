import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assemblePrompt,
	STANDING_INSTRUCTION,
} from "../.pi/extensions/agent-dispatch/prompt.ts";

test("prepends the standing instruction and preserves the task verbatim", () => {
	const task =
		'Review "src/a.ts"\nSecond line — Unicode: ✓ café\nRespond as a JSON object with keys "summary" and "risks".';
	const prompt = assemblePrompt(task);
	assert.ok(prompt.startsWith(`${STANDING_INSTRUCTION}\n\n`));
	assert.equal(prompt, `${STANDING_INSTRUCTION}\n\n${task}`);
	assert.ok(prompt.includes(task));
});

test("preserves a caller-requested response format and adds no critique requirement", () => {
	const task = "Answer with exactly three bullet points.";
	const prompt = assemblePrompt(task);
	assert.ok(prompt.includes(task));
	assert.doesNotMatch(prompt, /disagree|counterargument|critique format/i);
});

test("appends a scope hint after the unchanged task", () => {
	const task = "Summarize the diff.";
	const prompt = assemblePrompt(task, "  src/parser  ");
	assert.equal(
		prompt,
		`${STANDING_INSTRUCTION}\n\n${task}\n\nScope: src/parser`,
	);
});

test("omits an empty or whitespace-only scope hint", () => {
	assert.equal(assemblePrompt("task", "   "), `${STANDING_INSTRUCTION}\n\ntask`);
	assert.equal(
		assemblePrompt("task", undefined),
		`${STANDING_INSTRUCTION}\n\ntask`,
	);
});

test("does not modify quotes, newlines, or Unicode in the task", () => {
	const task = 'line1\n\tline2 "quoted" — ✓';
	assert.equal(assemblePrompt(task), `${STANDING_INSTRUCTION}\n\n${task}`);
});
