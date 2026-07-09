Build src/lib/orchestration/graph.ts using @langchain/langgraph's StateGraph
over ResearchState (src/lib/schemas/state.ts). Nodes, in order:
  decompose -> retrieve -> debate -> gate -> (conditional: retrieve | recommend)

- decompose: manager (use managerModel) breaks state.topic into 3-5 Question
  objects, sets state.questions.
- retrieve: calls evidence/firecrawl.ts search() for each unresolved question,
  adds results to state.evidence.
- debate: calls committee.runCommittee() for each unresolved question, adds
  results to state.claims.
- gate: import from src/lib/orchestration/gate.ts — a function
  allocateBudget(state: ResearchStateT): { state: ResearchStateT, continueLoop: boolean }.
  LEAVE gate.ts itself as a stub throwing NotImplementedError — someone else
  owns that file. Just wire the conditional edge to call it and route to
  "retrieve" if continueLoop is true and state.budgetRemaining > 0, else "recommend".
- recommend: assembles the final output (evidence graph + confidence per
  question + unresolved questions) — a simple synthesis for now, doesn't need
  to be fancy yet.

Export compileResearchGraph() returning the compiled graph with a MemorySaver
checkpointer so we get state history/time-travel for free.
