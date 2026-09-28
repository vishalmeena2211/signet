// The agent may stop and ask.
//
// When the request does not settle a choice and either answer would pass every check,
// picking one is a product decision made by the agent, silently. So it is told it may
// stop instead, ending its reply with a question, the answers it sees, and why it could
// not choose. That becomes a question on the person's Desk, answered in the thread.

import { z } from "zod";

const AskSchema = z.object({
  ask: z.object({
    question: z.string().min(1).max(1000),
    options: z.array(z.string().min(1).max(200)).max(6).default([]),
    why: z.string().max(600).optional(),
  }),
});

export type AgentQuestion = { question: string; options: string[]; why: string | null };

/** The LAST fenced block holding an "ask", if the reply ends with one. */
export function parseAgentQuestion(resultText: string): AgentQuestion | null {
  const blocks = [...resultText.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const block of blocks.reverse()) {
    if (!block.includes('"ask"')) continue;
    const start = block.indexOf("{");
    const end = block.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    let json: unknown;
    try {
      json = JSON.parse(block.slice(start, end + 1)); // signet-policy-allow: raw-json-parse -- validated by AskSchema on the next line
    } catch {
      continue;
    }
    const parsed = AskSchema.safeParse(json);
    if (parsed.success) return { question: parsed.data.ask.question, options: parsed.data.ask.options, why: parsed.data.ask.why ?? null };
  }
  return null;
}

/** The instruction appended to the implement prompt. */
export const ASK_INSTRUCTION = [
  "## If you must choose something the request does not settle",
  "If you reach a choice the request and its clarifications do not settle, and either answer",
  "would pass every check, do not pick one. Stop, and end your reply with ONE fenced json block:",
  "```json",
  '{ "ask": { "question": "one sentence", "options": ["first answer", "second answer"],',
  '           "why": "why you could not choose — what each answer would cost" } }',
  "```",
  "A person answers it, and the answer is added to the request before you continue.",
].join("\n");
