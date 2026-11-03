// Bottleneck breakdown for traces written by integrations/conexus/agent-trace.mjs (issue #22).
//
//   node scripts/agent_trace_summary.mjs <trace-dir> [--json]
//        [--price-in <per 1M>] [--price-cached <per 1M>] [--price-out <per 1M>]
//
// Every run file is included: failed, cancelled and unfinished runs are reported,
// never filtered, so a speedup cannot be claimed from successful runs alone.
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const DISCOVERY = new Set(['find', 'observe'])
const WAIT = new Set(['use:backtest.wait', 'use:backtest.status', 'use:sync.status', 'use:sync.list'])
const OUTPUT = new Set(['create', 'edit', 'complete', 'use:workspace.outputs.prepare'])
const HUMAN = new Set(['request_user_input'])

export function category(label) {
  if (DISCOVERY.has(label)) return 'discovery'
  if (WAIT.has(label)) return 'wait'
  if (OUTPUT.has(label)) return 'output'
  if (HUMAN.has(label)) return 'human'
  return 'research'
}

const seconds = ms => Math.round(ms) / 1000

export function summarizeRun(rows) {
  const meta = rows.find(row => row.type === 'run.meta') ?? {}
  // scripts/agent_benchmark.py labels each trace after the run finishes.
  const tag = rows.find(row => row.type === 'benchmark.task') ?? {}
  const times = rows.map(row => Date.parse(row.at)).filter(Number.isFinite)
  const wallMs = times.length ? Math.max(...times) - Math.min(...times) : 0
  const end = rows.filter(row => row.type?.startsWith('request.') && row.type !== 'request.started').at(-1)
  const run = {
    requestId: meta.requestId, task_id: tag.task_id ?? meta.task_id ?? null, repetition: tag.repetition ?? null,
    benchmark: meta.benchmark ?? null, git_commit: meta.git_commit ?? null,
    prompt_digest: meta.prompt_digest ?? null, model: null, status: end ? end.type.slice('request.'.length) : 'unfinished',
    wall_s: 0, model_s: 0, other_s: 0, tool_s: { discovery: 0, wait: 0, output: 0, human: 0, research: 0 },
    model_calls: 0, model_failures: 0, tool_calls: 0, tool_failures: 0, repeated_tool_calls: 0, human_requests: 0,
    tokens_in: 0, cached_tokens_in: 0, tokens_out: 0, estimated_usage_calls: 0, polling_model_calls: 0, polling_tokens_in: 0,
    max_prompt_chars: 0, tools: {},
  }
  let sinceModel = []
  for (const row of rows) {
    if (row.type === 'model') {
      run.model = row.model ?? run.model
      run.model_calls += 1
      run.model_s += (row.ms ?? 0) / 1000
      if (!row.ok) run.model_failures += 1
      run.tokens_in += row.tokens_in ?? 0
      run.cached_tokens_in += row.cached_tokens_in ?? 0
      run.tokens_out += row.tokens_out ?? 0
      if (row.usage_source !== 'provider') run.estimated_usage_calls += 1
      run.max_prompt_chars = Math.max(run.max_prompt_chars, row.prompt_chars ?? 0)
      // A call whose only new input is a wait/poll result is paid for by the waiting strategy.
      if (sinceModel.length && sinceModel.every(label => WAIT.has(label))) {
        run.polling_model_calls += 1
        run.polling_tokens_in += row.tokens_in ?? 0
      }
      sinceModel = []
    } else if (row.type === 'tool') {
      const kind = category(row.label)
      run.tool_calls += 1
      run.tool_s[kind] += (row.ms ?? 0) / 1000
      if (!row.ok) run.tool_failures += 1
      if (row.repeat) run.repeated_tool_calls += 1
      if (kind === 'human') run.human_requests += 1
      run.tools[row.label] = (run.tools[row.label] ?? 0) + 1
      sinceModel.push(row.label)
    }
  }
  run.wall_s = seconds(wallMs)
  const toolTotal = Object.values(run.tool_s).reduce((sum, value) => sum + value, 0)
  run.other_s = Math.max(0, Math.round((run.wall_s - run.model_s - toolTotal) * 1000) / 1000)
  run.model_s = Math.round(run.model_s * 1000) / 1000
  for (const key of Object.keys(run.tool_s)) run.tool_s[key] = Math.round(run.tool_s[key] * 1000) / 1000
  return run
}

export function cost(run, prices) {
  if (prices.in === undefined && prices.out === undefined) return null
  const cached = prices.cached ?? prices.in ?? 0
  return ((run.tokens_in - run.cached_tokens_in) * (prices.in ?? 0) + run.cached_tokens_in * cached + run.tokens_out * (prices.out ?? 0)) / 1e6
}

export async function summarizeDirectory(dir, prices = {}) {
  const runs = []
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.jsonl')).sort()) {
    const rows = (await readFile(join(dir, file), 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const run = summarizeRun(rows)
    run.cost = cost(run, prices)
    runs.push(run)
  }
  const sum = key => runs.reduce((total, run) => total + (typeof key === 'function' ? key(run) : run[key] ?? 0), 0)
  const statuses = {}
  for (const run of runs) statuses[run.status] = (statuses[run.status] ?? 0) + 1
  const total = {
    runs: runs.length, statuses, wall_s: sum('wall_s'), model_s: sum('model_s'), other_s: sum('other_s'),
    tool_s: Object.fromEntries(['discovery', 'wait', 'output', 'human', 'research'].map(key => [key, sum(run => run.tool_s[key])])),
    model_calls: sum('model_calls'), polling_model_calls: sum('polling_model_calls'), tool_calls: sum('tool_calls'),
    repeated_tool_calls: sum('repeated_tool_calls'), tool_failures: sum('tool_failures'), model_failures: sum('model_failures'),
    human_requests: sum('human_requests'), tokens_in: sum('tokens_in'), cached_tokens_in: sum('cached_tokens_in'),
    tokens_out: sum('tokens_out'), polling_tokens_in: sum('polling_tokens_in'), estimated_usage_calls: sum('estimated_usage_calls'),
    cost: runs.some(run => run.cost !== null) ? sum(run => run.cost ?? 0) : null,
  }
  return { runs, total }
}

function render({ runs, total }) {
  const pct = (part, whole) => whole ? `${(100 * part / whole).toFixed(1)}%` : '-'
  const lines = [`Runs: ${total.runs}  statuses: ${JSON.stringify(total.statuses)}`]
  lines.push('', 'Where the time went (all runs, including failures):')
  const time = [['model calls', total.model_s], ...Object.entries(total.tool_s).map(([key, value]) => [`tools: ${key}`, value]), ['host/other', total.other_s]]
  for (const [name, value] of time) lines.push(`  ${name.padEnd(18)} ${value.toFixed(1).padStart(9)} s  ${pct(value, total.wall_s).padStart(6)}`)
  lines.push(`  ${'wall clock'.padEnd(18)} ${total.wall_s.toFixed(1).padStart(9)} s`)
  lines.push('', 'Where the tokens went:')
  lines.push(`  input ${total.tokens_in}  (cached ${total.cached_tokens_in}, ${pct(total.cached_tokens_in, total.tokens_in)})  output ${total.tokens_out}`)
  lines.push(`  model calls ${total.model_calls}; caused only by waiting/polling ${total.polling_model_calls} (${pct(total.polling_tokens_in, total.tokens_in)} of input tokens)`)
  lines.push(`  tool calls ${total.tool_calls}; exact repeats ${total.repeated_tool_calls}; tool failures ${total.tool_failures}; model failures ${total.model_failures}; human requests ${total.human_requests}`)
  if (total.estimated_usage_calls) lines.push(`  note: ${total.estimated_usage_calls} model calls had no provider usage; their tokens are estimates`)
  if (total.cost !== null) lines.push(`  cost ${total.cost.toFixed(4)}`)
  lines.push('', 'Per run:')
  lines.push('  task      status       wall_s  model_s  wait_s  calls  tok_in    tok_out  repeats  fails')
  for (const run of runs) {
    lines.push(`  ${String(run.task_id ?? run.requestId).slice(0, 8).padEnd(9)} ${run.status.padEnd(11)} ${run.wall_s.toFixed(1).padStart(7)} ${run.model_s.toFixed(1).padStart(8)} ${run.tool_s.wait.toFixed(1).padStart(7)} ${String(run.model_calls).padStart(6)} ${String(run.tokens_in).padStart(8)} ${String(run.tokens_out).padStart(9)} ${String(run.repeated_tool_calls).padStart(8)} ${String(run.tool_failures + run.model_failures).padStart(6)}`)
  }
  return lines.join('\n')
}

if (process.argv[1]?.endsWith('agent_trace_summary.mjs')) {
  const [dir] = process.argv.slice(2).filter(arg => !arg.startsWith('--') && !/^[\d.]+$/.test(arg))
  if (!dir) throw new Error('Usage: node scripts/agent_trace_summary.mjs <trace-dir> [--json] [--price-in N] [--price-cached N] [--price-out N]')
  const flag = name => { const index = process.argv.indexOf(name); return index > 0 ? Number(process.argv[index + 1]) : undefined }
  const summary = await summarizeDirectory(dir, { in: flag('--price-in'), cached: flag('--price-cached'), out: flag('--price-out') })
  console.log(process.argv.includes('--json') ? JSON.stringify(summary, null, 2) : render(summary))
}
