/**
 * Prompt assembly. The caller owns the question and the response format; the
 * extension adds only a standing instruction to assess evidence independently
 * and an optional scope hint.
 */

/** The only instruction the extension adds ahead of the caller's task. */
export const STANDING_INSTRUCTION = "Assess the evidence independently.";

/**
 * Build the outgoing prompt from the standing instruction, the caller's
 * unchanged task, and an optional scope hint. The task text is inserted
 * verbatim: no response format, disagreement, or counterargument is imposed.
 */
export function assemblePrompt(task: string, scope?: string): string {
 const parts = [STANDING_INSTRUCTION, task];
 const trimmedScope = scope?.trim();
 if (trimmedScope) parts.push(`Scope: ${trimmedScope}`);
 return parts.join("\n\n");
}
