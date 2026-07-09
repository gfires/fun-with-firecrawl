Build src/lib/orchestration/eval.ts and src/app/api/research/baseline/route.ts
(move the logic from the old one-shot route.ts/analyze.ts here unchanged —
this becomes the baseline arm we compare against).

Write a comparison script scripts/compare-arms.ts that, given a topic string:
  1. runs the baseline (single-prompt) arm
  2. runs the orchestrated graph (once graph.ts + gate.ts exist — stub the call
     if they don't exist yet, just build the harness shape)
  3. writes both outputs to a JSON file with token/cost counters for each arm
Don't judge quality automatically yet — just get side-by-side output and cost
numbers into one file so a human can read both and compare.
