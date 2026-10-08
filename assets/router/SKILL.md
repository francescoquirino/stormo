---
name: model-router
description: Default skill for any work that can be delegated. Routes coding work across the subscriptions you already have — A (Opus 5.5) designs; B (Sonnet 5.5, GPT-6.1 Sol, Haiku 5.5 as a fallback) builds complex code and reviews; C (optional free local models, GPT-6 Luna, GLM-5.3 Flash) writes routine code. BC work = C writes, a single B reviews, at most two returns to C. Powers Stormo's Auto Mode and respects quotas and tier locks. Use when the user says "route", "delegate", "which model should do this", "how much quota is left", "let C write it", or when there is a lot to write or read and the lead's window should be saved.
---

# Model Router

`route-ask` sends a well-defined task to the right model among the subscriptions you are signed in to,
balancing their quotas. It never buys anything and never uses a provider you are not logged in to.

## Model tiers

| Tier | Models | Role |
|---|---|---|
| A | `claude-opus-5-5-antigravity` (Opus 5.5 via Antigravity), `claude-opus-5-5` | Design and task breakdown only |
| B | `claude-sonnet-5-5-antigravity`, `claude-sonnet-5-5`, `gpt-6.1-sol`, `claude-haiku-5-5` (fallback) | Complex code, review, final fixes |
| C | local models if running (free), `gpt-6-luna`, `glm-5.3-flash` | Routine code |

- The Antigravity variants are the same Claude models served by `agy`, with a separate quota: they come
  first in their tier so the native Claude window lasts longer. They are workers only, never the director.
- Haiku 5.5 shares the native Claude quota with Sonnet 5.5 and is only picked when Sonnet is unavailable
  or when asked explicitly (`-m claude-haiku-5-5`). It is never the director.
- Gemini models and full GLM-5.3 are not router candidates.

## Work classes (separate from tiers)

- **A:** Opus designs, picks the structure and splits the work into B/C/BC tasks. No full code.
- **B:** a B model writes the complex part directly.
- **C:** a C model writes a routine part directly. Most tasks belong here.
- **BC:** C writes, **one single B model** reviews the same task:
  1. C delivers complete code.
  2. The B reviewer lists concrete defects, location and exact fix, using the router's JSON protocol.
  3. If fixes are needed the task returns to C — **at most two returns** (three B reviews).
  4. If only minor defects remain, it is approved with notes. No endless loops.
  5. If blocking defects remain after two returns, **the same B** fixes it directly once; the result is
     `needs-verification`.
  6. If the chosen reviewer becomes unavailable the run stops and keeps the code. No second reviewer.

The limits live in `route_workflow.py`, not only in the prompt. A review is not a test: after generation the
orchestrator reads, applies and verifies the real files. Never claim code works because a model approved it.

## Commands

```text
route-ask --work A -f design.md
route-ask --work B -f complex-part.md
route-ask --work C -f task.md
route-ask --work BC -f task.md
route-ask --work BC --writer glm-5.3-flash --reviewer gpt-6.1-sol -f task.md
route-ask --work BC --dry-run x
route-ask --status
route-ask --tiers
```

`--planner`, `--writer` and `--reviewer` prefer a model for that role; `-m` picks one model for A/B/C (not for BC).
Removed models or models from the wrong tier are refused. `-c easy|med|hard` means work C|B|A when `--work` is
not given. `--code` is kept for compatibility. `--review` requires BC.

## Effort

| Model | Effort |
|---|---|
| Opus 5.5 | always `medium` |
| Sonnet 5.5, Haiku 5.5, GPT-6.1 Sol | `low` / `medium` / `high` by difficulty (`--difficulty easy|medium|hard`), never above `high` |
| GPT-6 Luna, GLM-5.3 Flash | always `max` |

Defaults: B high, BC medium (the reviewer moves to high after blocking defects). Save quota by shrinking
context, duplication and cycles — not by lowering C's effort.

Every run is saved in `~/.route/runs/<timestamp-id>/` (task, code, reviews, `result.json`). Only the final code is
printed. Empty output, truncated answers or invalid review JSON are errors; nothing is retried on another
account automatically. `result.json` states `planned`, `ready-for-tests`, `approved-with-notes`,
`needs-verification` or `failed`; `tests_executed` is always false — testing is the orchestrator's job.

## Stormo Auto Mode

| Menu | Work class | What it does |
|---|---|---|
| AUTO MODE | picked automatically | Designs if needed and assigns tasks to the right class |
| HIGH MODE | A | Design only, with Opus 5.5 |
| MEDIUM MODE | B | Complex code with Sonnet 5.5 or GPT-6.1 Sol |
| LOW MODE | C | Routine code with GPT-6 Luna or GLM-5.3 Flash |
| BC MODE | BC | C writes, one B reviews, at most two returns |

Claude Code or Codex acts as the **director** over the working folder and receives this skill at the start of
the session; it does not run the router for every message.

| Request | Action |
|---|---|
| Greetings, thanks, small talk | Answer directly; do not run route-ask |
| General non-coding questions, translations, short explanations | Answer directly |
| Which model you use, how tiers/router/permissions work | Explain from what is loaded; do not delegate |
| Status, summary of verified results, choosing between designed options | Answer from context |
| Ambiguous message | Ask for clarification directly |
| Software design, writing/changing/fixing code, real debugging, tests, review | Use route-ask in the chosen class, without being asked |
| Greeting followed by a coding request | Answer the greeting and delegate the coding |
| "Continue", "do it", "yes" about coding work | Continue that work through the router |

The app enforces delegation for recognised coding requests: a skipped delegation gets one reminder, a second
skip fails the turn. A failed router run is never relaunched blindly. The app sets
`ROUTE_WORK_CLASS=A|B|C|BC|auto`, `ROUTE_ONLY_TIER=A|B|C|auto` and `ROUTE_TIER_LOCK=1`; an incompatible class
is refused and must be changed from the app menu. In HIGH mode the design is the deliverable.

The director is chosen between Sonnet 5.5 and GPT-6.1 Sol by available quota, **only when a new chat opens**,
and stays the same for the whole chat (saved in `regia.json`). It spends its own provider's quota too.

## Quotas and minimal context

- Before many tasks: `--status`. Local ledger `~/.route/ledger.jsonl`, estimated caps in `~/.route/config.json`.
- OpenAI: pressure is corrected with the real counters from the Codex logs. A reserve (30% by default) is kept for B.
- Claude: `/usage` is cached for 15 minutes; delegation is avoided when the session is ≥90%, the week ≥80%, or
  the counter is unreadable.
- GLM: real 5-hour and weekly counters from z.ai's official usage endpoint, using your local z.ai key
  (`~/.zai/env`), cached for 5 minutes. 5% reserve.
- Antigravity: no real counter; an estimated cap is shown in `--status`.
- Rate limits put that account in cooldown and move to another candidate **of the same role and tier**.
  No silent promotion to A, no silent fallback from C to B.
- **Balancing** compares the share of quota used (the higher of 5-hour and weekly), not message counts; gaps
  under 5% keep the list order. A BC reviewer, once chosen, stays the same.
- `--usage-json` shows usage, windows, resets, cooldowns and whether each number is real or estimated.
  Nothing is invented: unreadable counters are declared as estimates, and Claude without a counter is skipped.
- GLM via `glm-ask` and local models have no tools: put all the code and context they need **in the brief**.
- Keep each call to one well-defined task; a truncated output is not finished.
- `~/.route/preamble.md` is prepended to every role; `--no-preamble` skips it.

## Optional extras (Linux)

- **Local models:** any OpenAI-compatible local server listed in `~/.route/config.json` can lead tier C for free.
  If it is off the router moves on immediately. `"local_only": true` uses only the local model.
- **`--design`:** one model proposes and a *different* one challenges it, one round, saved in
  `~/.route/design/<timestamp>/`. Run it only when the user asks for it: it uses a large share of quota.
- `--budget N` writes a quota budget at the top of the brief; `--grade ok|meh|ko` rates the last run and
  `--report` compares models.

## Requirements

`route-ask`, `route_workflow.py`, `route_budget.py`, `glm-ask` (installed by `python3 assets/router/setup.py`),
Python 3, and the CLIs you want to route to, signed in. Never print keys or tokens.
