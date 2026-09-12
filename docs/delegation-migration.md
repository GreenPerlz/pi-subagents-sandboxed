# Delegation ownership and native communication

This page is the migration contract for delegation changes planned under #91. It
separates the workflows implemented today from the target behavior that still
needs runtime work and, where noted, human approval.

## Ownership in every workflow

The trusted parent owns the canonical checkout. A child must never stage, commit,
reset, merge, or create a worktree in that checkout. Names such as `work`, task
prose, a nested route, and a message do not grant Git, sandbox, or human-approval
authority.

A direct packaged writer runs in a runtime-owned private checkout with isolated
Git. That writer is authorized to make the issue change and must author the
commit there when the runtime requires commit evidence. The runtime exports the
authored history for the trusted parent; it does not silently integrate it. The
parent verifies the exported evidence and deliberately integrates the reviewed
authored commits into the canonical checkout.

A fresh reviewer is an observation-only participant. A commit can leave the
working-tree diff empty, so review is not just `git diff`: inspect the authored
history and tree relative to the reported base, then inspect any remaining
working-tree and index changes. In a runtime-owned scope, the minimum review
shape is conceptually:

```text
observe (read-only):
  history = commits from <base> through <authored-head>
  tree = authored-head tree
  base-change = diff <base> to <authored-head>
  remaining-change = status, index diff, and working-tree diff
```

The reviewer may report findings, but may not edit, stage, commit, or integrate.
Nested workflows inherit one authenticated scoped Git context. They do not create
nested worktrees; writers are serialized, and handoffs are inline. The outer
parent retains export, recovery, integration, and cleanup ownership.

## Current behavior (implemented now)

The current extension remains usable during this migration:

- `/run <agent> <task>` starts one foreground child; `/run ... --bg` starts the
  current detached form and returns its existing receipt/status behavior.
- `/chain` and saved or dynamic `/run-chain` execute the currently supported
  sequential, static-parallel, and dynamic-fanout forms.
- `/parallel` runs its current task list, and `--bg` remains available on the
  supported slash workflows.
- The existing `subagent` tool and current async execution path are not silently
  redefined by the target examples below.

These commands are the compatibility surface until later migration tickets
change the runtime. Do not remove registrations or claim that the target batch
engine is available today.

## #91 target: batches and durable observation (pending)

The following are **PENDING #91 TARGET — CONCEPTUAL PSEUDOCODE, NOT EXECUTABLE
API**. Names, schemas, limits, and compatibility for #96 are still pending
human approval. The examples intentionally show the contract, not a new tool
name or an installable call.

The target creation operation always receives one explicit, nonempty `tasks`
array and always creates asynchronously. Each array item is one child task.
Creation returns durable receipts immediately; callers observe results later.

### One-task batch (target)

```text
[PENDING #91 TARGET — conceptual operation]
create delegation:
  tasks: [{ agent: "work", task: "Implement the approved change" }]
  async: true
return immediately: durable receipt for that one-task batch
later: observe the receipt and its eventual result
```

### Multi-task batch (target)

```text
[PENDING #91 TARGET — conceptual operation]
create delegation:
  tasks: [
    { agent: "explore", task: "Inspect the parser" },
    { agent: "review", task: "Check the documented contract" }
  ]
  async: true
return immediately: durable receipts for both children
later: observe each result by its returned receipt
```

### Sequential submission (target)

Sequential work is represented by later submissions, not by smuggling an
ordered workflow into one task. Observe the first batch before deciding the next
one, then submit another nonempty array asynchronously:

```text
[PENDING #91 TARGET — conceptual operation]
first = create delegation:
  tasks: [{ agent: "work", task: "Make the isolated authored change" }]
  async: true
observe first.receipt later
second = create delegation:
  tasks: [{ agent: "review", task: "Freshly inspect first's authored history" }]
  async: true
observe second.receipt later
```

### Discovered fan-out (target)

A caller may discover work from observed results and submit the next array. The
fan-out remains bounded by the approved runtime contract; discovery does not
create authority or nested worktrees:

```text
[PENDING #91 TARGET — conceptual operation]
seed = create delegation:
  tasks: [{ agent: "explore", task: "Find independent migration items" }]
  async: true
observe seed.receipt later
items = derive tasks from the observed seed result
require items is nonempty
fanout = create delegation:
  tasks: [{ agent: item.agent, task: item.task } for item in items]
  async: true
observe fanout receipts/results later
```

The exact target tool name, fields, limits, and compatibility rules remain the
#96 human-approval boundary. Do not turn these conceptual records into an
invented executable API in agent prompts or docs.

## #99/#100/#95 target: native run-scoped communication (pending)

These are **PENDING MIGRATION TARGETS — CONCEPTUAL OPERATION DESCRIPTIONS**.
They describe routing and lifecycle guarantees without inventing executable
APIs. Native communication is scoped to the run and replaces the current
intercom dependency for the target engine.

### Live follow-up (#99)

A live follow-up is a distinct child-to-parent or parent-to-child run-scoped
message while the relevant run is live. It is addressed to the actual immediate
parent identified by runtime metadata, not a global roster, alias, or name in
prompt prose. It does not answer a decision request and it is not terminal
publication or post-completion revival.

```text
[PENDING #99 TARGET — conceptual event]
live child follow-up -> actual immediate parent:
  { run: authenticated-run, kind: "follow-up", body: "Progress changed" }
```

### Correlated decision roundtrip (#100)

A decision request pauses for the actual immediate parent. The parent reply must
carry the exact pending request correlation; a different or arbitrary message
cannot answer it. Runtime metadata authenticates the route. Generated text,
agent names, and task prose do not grant Git, sandbox, or human-approval rights.

```text
[PENDING #100 TARGET — conceptual events]
child -> actual immediate parent:
  { kind: "decision-request", correlation: "pending-7", question: "Choose X or Y" }
actual immediate parent -> child:
  { kind: "decision-reply", correlation: "pending-7", answer: "X" }
```

A reply for `pending-6`, a free-form message, or a message from another run is
not a response to `pending-7`. Live follow-up, decision reply, terminal
publication, and post-completion revival remain separate operations.

### Automatic terminal publication (#95)

A child returns its final task result normally. It does not send a second
model-authored "completion" message. After acceptance validation and required
teardown/export are complete, the runtime publishes exactly one terminal result
attributed to that child/run. Revival after completion is a new process over
persisted session data, not a duplicate terminal event.

```text
[PENDING #95 TARGET — conceptual lifecycle]
child returns final task result
runtime completes acceptance validation
runtime completes required teardown and export
runtime publishes exactly one attributed terminal result
(no duplicate model-sent completion)
```

### Authorship and provenance

The actual model-facing text must identify the speaker as the delegated agent,
and the transcript must preserve that attribution separately from human
approval, system instructions, and developer instructions. A provider-native
agent role is not assumed; textual attribution is required, while runtime
metadata authenticates routing and lifecycle ownership.

```text
model-facing text: "You are the delegated work agent. This is an agent-authored result."
transcript: [agent-authored, agent=work, run=<runtime-id>] result text
transcript: [human approval] approval text
transcript: [system/developer instruction] instruction text
```

Neither generated text nor transcript labels by themselves grant authority.
They explain provenance; the runtime-enforced scope and metadata decide what a
child may do.

## Review passes and self-review

A work/fresh-review loop reassesses after each five passes; five is a
reassessment point, not a stop limit. A fixed two-loop or one-follow-up ceiling
must not replace convergence, a real blocker, or a parent decision. This policy
is separate from the runtime's bounded acceptance self-review: the latter is an
explicit acceptance setting that checks a result after completion and is not a
work-loop stop rule.

See [Workflows](workflows.md), [Packaged and custom agents](agents.md), and
[Git, worktrees & recovery](git-worktrees.md) for the current implementation
and integration details.
