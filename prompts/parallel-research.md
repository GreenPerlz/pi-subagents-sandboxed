---
description: Parallel researcher subagents
---

Launch parallel `researcher` subagents to build a grounded answer to the current question or decision.

Use fresh context, not forked context, unless I explicitly ask for forked context. Researchers should inspect sources directly instead of relying on the main conversation history.

Give each researcher a distinct angle. Unless I specify angles, use two or three of these:

1. External evidence
   Find current, authoritative sources: official docs, specs, release notes, benchmarks, issue threads, or primary explanations.

2. Practical tradeoffs
   Compare options, risks, edge cases, maintenance cost, and what would be easiest to validate.

3. Recent developments
   For time-sensitive topics, include recent sources and prefer 2026/2025 material when relevant.

4. Implementation constraints from public docs
   For library/API questions, focus on supported APIs, examples, migration notes, and gotchas from primary sources.

Prefer two or three strong researchers over many vague ones. The parent agent should frame the question and assign angles; child agents should research, not invent broad plans.

Ask each subagent to return concise findings with evidence:
- source links for external findings
- confidence level and gaps
- recommended next step or decision implication

Do not ask subagents to edit files. This is a research pass only unless I explicitly ask for implementation.

After the subagents return, synthesize the answer into:
- what we know
- tradeoffs and risks
- gaps or assumptions
- the recommended next move

If findings disagree, call out the disagreement instead of smoothing it over.

$@
