import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { AgentRoleT } from "../schemas/claim";

// Your explicit model mix decision, in one place
const ROLE_MODEL: Record<AgentRoleT, ReturnType<typeof anthropic> | ReturnType<typeof openai>> = {
  historian: anthropic("claude-sonnet-5"),
  operator: anthropic("claude-sonnet-5"),
  investor: anthropic("claude-sonnet-5"),
  skeptic: openai("gpt-4o"),   // deliberately different family — genuine adversarial check
};

export function modelForRole(role: AgentRoleT) {
  return ROLE_MODEL[role];
}

// manager + gate use a cheap/fast model for triage-y work
export const managerModel = anthropic("claude-sonnet-5");
export const gateModel = anthropic("claude-sonnet-5");