# Agent efficiency benchmark (issue #22)

A fixed task set for measuring the single AlphaLab Research Agent before and
after each optimization. Compare only traces with the same benchmark version,
model, and repetition count.

## Record a run

Tracing is off unless `ALPHALAB_AGENT_TRACE_DIR` is set for the local Agent:

```powershell
$env:ALPHALAB_AGENT_TRACE_DIR = "$PWD\build\traces\baseline"
$env:ALPHALAB_BENCHMARK_VERSION = "alphalab-agent-v1"
$env:ALPHALAB_BENCHMARK_TASK = "T04"      # optional label for this run
alphalab dev serve
```

Each Harness request writes one `<requestId>.jsonl` file: a `run.meta` header
(git commit, dirty flag, prompt/skill/tool digests, benchmark labels), then one
row per model call (time, provider token usage including cache hits, prompt
size and growth, requested tools) and per tool call (time, AlphaLab command,
confirmation flags, failure code, repeat flag, result size). Prompt text, tool
payloads and keys are never written.

## Run tasks

Create the fixtures once with `scripts/benchmark_fixtures.py`, start
`alphalab dev serve` with the trace variables above, then in a second terminal:

```powershell
python scripts\agent_benchmark.py --tasks T01 --label pilot     # one task
python scripts\agent_benchmark.py --label pilot                  # all tasks once
python scripts\agent_benchmark.py --label baseline --repeat 3
```

The runner restores fixtures before every task, enforces each task's
model-call and time budget by cancelling the run (recorded as
`budget_exhausted`), answers Agent questions with a fixed "no further input"
reply and counts them as human effort, and writes automatic check results to
`build/benchmarks/<label>/results.jsonl`. Grader and output checks remain manual.

## Read the results

```powershell
node scripts/agent_trace_summary.mjs build\traces\baseline
node scripts/agent_trace_summary.mjs build\traces\baseline --price-in <per1M> --price-cached <per1M> --price-out <per1M>
node scripts/agent_prompt_budget.mjs     # fixed prompt cost per model call, no model needed
```

The summary includes every run file; failed, cancelled and unfinished runs are
counted, never filtered.

## Rules

- `v1/tasks.json` stays `draft` until a pilot confirms each fixture exists on the
  evaluation deployment. Then set `status` to `frozen`, record its SHA-256 in
  `v1/FROZEN.sha256`, and never edit it again; changes go to `v2`.
- Register acceptance thresholds after the pilot and before formal evaluation.
- Run each task at least three times per configuration; LLM runs vary.
- One optimization per comparison, with the others held fixed (ablation).
