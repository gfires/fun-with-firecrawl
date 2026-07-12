import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { AgentRoleT } from "../schemas/claim";
import { ROLE_MODEL_IDS, REDEBATE_ROLE_MODEL_IDS } from "../params";

/** Resolve a model id string to its SDK model instance (OpenAI for gpt-*, else Anthropic). */
function modelFromId(id: string) {
  return id.startsWith("gpt") ? openai(id) : anthropic(id);
}

/**
 * The model for a committee role. Loop 0 uses the full mix (ROLE_MODEL_IDS); re-debates
 * (loopIteration > 0) use REDEBATE_ROLE_MODEL_IDS — Haiku for the three analytical roles,
 * gpt-4o for the skeptic. Both maps live in params.ts.
 */
export function modelForRole(role: AgentRoleT, loopIteration = 0) {
  const ids = loopIteration > 0 ? REDEBATE_ROLE_MODEL_IDS : ROLE_MODEL_IDS;
  return modelFromId(ids[role]);
}

export const managerModel = anthropic("claude-haiku-4-5-20251001");
export const gateModel = anthropic("claude-sonnet-5");
export const gateClassifierModel = openai("gpt-4o-mini");
// L2 evidence digest: cheap, fast model to compress each source before the committee.
export const digestModel = anthropic("claude-haiku-4-5-20251001");