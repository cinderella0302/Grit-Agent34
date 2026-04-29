# Grit-Agent34

`Grit-Agent34` is a focused, task-optimized fork of the `tau/agent` base project (pi monorepo) for high-precision coding-agent execution in Bittensor tau-style evaluation environments.

Instead of being a generic monorepo distribution, this fork applies substantial runtime and prompting changes to make the coding loop more deterministic, auditable, and aligned with strict diff-scoring workflows.

## Why This Fork Exists

The base project at `tau/agent` is broad and extensible, with many packages and general-purpose capabilities.

This fork narrows and strengthens behavior around one objective:

- discover thoroughly
- plan explicitly
- implement in controlled order
- produce precise, minimal, high-signal edits

## Significant Updates from `tau/agent`

### 1) Added explicit PLAN -> IMPLEMENT workflow

This fork introduces strict phase-driven execution in the coding agent:

- PLAN phase: discovery + structured planning only
- IMPLEMENT phase: execute validated plans only

This behavior is wired through customized prompt/runtime logic in:

- `agent/packages/coding-agent/src/core/system-prompt.ts`
- `agent/packages/agent/src/agent-loop.ts`
- `agent/packages/agent/src/agent.ts`
- `agent/packages/agent/src/types.ts`

### 2) New `plan` tool with validation and handoff contract

A new planning tool was added:

- `agent/packages/coding-agent/src/core/tools/plan.ts`

Key capabilities:

- Enforces structured plan payloads with explicit acceptance criteria mapping
- Requires per-file implementation plan details and required-read paths
- Validates file paths and read dependencies
- Uses a two-step plan handshake (draft then validated commit)
- Prevents weak or underspecified planning before implementation

### 3) New `editdone` tool for completion handshake

A new implementation completion signal was added:

- `agent/packages/coding-agent/src/core/tools/editdone.ts`

Key capabilities:

- Forces explicit completion evidence for each planned edit bullet
- Uses a two-step confirmation pattern before advancing to next plan item
- Improves implementation auditability and reduces silent partial completion

### 4) Discovery-step tracking and deduping for PLAN mode

A new PLAN discovery tracking module was added:

- `agent/packages/agent/src/plan-discovery-steps.ts`

It normalizes discovery calls (`bash`, `find`, `grep`, `ls`, `read`), builds canonical dedupe keys, and preserves valid tool-call/result pairing while collapsing duplicate discovery spans.

### 5) Tool registry and runtime integration updates

Tool wiring was updated so `plan` and `editdone` are first-class tools in coding-agent runtime:

- `agent/packages/coding-agent/src/core/tools/index.ts`
- `agent/packages/coding-agent/src/index.ts`
- `agent/packages/coding-agent/src/main.ts`
- `agent/packages/coding-agent/src/core/agent-session.ts`

### 6) Focused monorepo scope for leaner harness execution

Compared to `tau/agent`, this fork trims non-essential workspace scope and build targets for this use case:

- reduced workspace entries in `agent/package.json`
- focused build pipeline around required packages
- excludes broader package surface (`mom`, `pods`, `web-ui`, and many example/test trees) from this fork context

This keeps iteration tighter for benchmark-style agent runs.

## Repository Structure

- `agent/` - adapted pi monorepo workspace used by this fork
- `agent/packages/coding-agent/` - primary CLI and task-execution behavior
- `agent/packages/agent/` - runtime loop/state orchestration with phase logic
- `agent/packages/ai/` - model/provider integration used by the runtime
- `README.md` (this file) - fork intent and change summary

## Development

From `agent/`:

```bash
npm install
npm run build
```

## Contribution Intent

I want to contribute to the coding-agent community by sharing this fork's improvements around:

- structured planning discipline
- deterministic phase control
- auditable implementation handoffs
- stronger completion verification patterns

If these patterns prove useful in real tasks, I plan to upstream ideas, open discussions, and collaborate on improvements that can benefit the broader coding-agent ecosystem.

## Base Project Credit

This work is built on top of the excellent base project in `tau/agent` (pi monorepo).  
Many core architecture decisions and package foundations come from that upstream codebase, and this fork focuses on specialized behavior on top of it.
