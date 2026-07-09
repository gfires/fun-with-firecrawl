## Project standards
- Next.js/TypeScript repo. Run `npm install` in your worktree first.
- Import Evidence/Claim/ResearchState from src/lib/schemas/*.ts — do NOT modify those files.
- Import model assignments from src/lib/models/provider.ts — do NOT change the role-to-model mapping.
- Use `generateObject` from the `ai` package with the model from `modelForRole()`/`managerModel`/`gateModel` for ALL structured LLM output. Never hand-parse JSON from a text completion.
- Evidence fields on claims are string IDs into the evidence store, never inline copied text.
- Write vitest tests for every new module in the same directory (*.test.ts).
- Run `npm run typecheck && npx vitest run` before saying you're done.
