import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { configuredCompletion } from '../integrations/conexus/model-providers.mjs'
import { bundleMetadata, createTraceRecorder, estimateTokens, toolLabel } from '../integrations/conexus/agent-trace.mjs'
import { researchCanvas } from '../integrations/conexus/research-canvas.mjs'
import { summarizeDirectory } from '../scripts/agent_trace_summary.mjs'
import { writeFile } from 'node:fs/promises'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const builtEntry = resolve(root, 'build/conexus/apps/local-host/src/index.mjs')

const readRows = async (dir, requestId) =>
  (await readFile(join(dir, `${requestId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line))

/** Loopback OpenAI-compatible endpoint that replays turns and reports `usage` like DeepSeek. */
async function modelEndpoint(turns, usage = { prompt_tokens: 1200, completion_tokens: 30, prompt_cache_hit_tokens: 1000 }) {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push(payload)
      const turn = turns[requests.length - 1]
      if (!turn) { response.writeHead(500).end('{}'); return }
      const message = { role: 'assistant', content: turn.content ?? null, ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}) }
      const body = JSON.stringify({ choices: [{ index: 0, message, finish_reason: turn.tool_calls ? 'tool_calls' : 'stop' }], usage })
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(body)
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise(done => server.close(done)) }
}

const call = (name, args) => ({ tool_calls: [{ id: randomBytes(6).toString('hex'), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

/** Minimal stand-in for Conexus createModelCompletion that honours `fetchImpl`. */
const fakeCreate = profile => async request => {
  const response = await profile.fetchImpl(`${profile.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: request.messages }) })
  const body = await response.json()
  return { content: body.choices[0].message.content, finish_reason: body.choices[0].finish_reason }
}

test('token estimate weights Chinese characters at twice the English rate', () => {
  assert.equal(estimateTokens('abcdefghij'), 3)
  assert.equal(estimateTokens('研究研究研究研究研究'), 6)
})

test('use calls are attributed to the AlphaLab command they carry', () => {
  assert.equal(toolLabel('use', { node_id: 'alphalab-project-run', input: { command: 'backtest.wait' } }), 'use:backtest.wait')
  assert.equal(toolLabel('use', { node_id: 'web-search' }), 'use:web-search')
  assert.equal(toolLabel('find', { query: 'x' }), 'find')
})

test('a traced model call records provider usage, sizes and versions without prompt text or keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alphalab-trace-'))
  const endpoint = await modelEndpoint([{ content: 'OK' }, { content: 'again' }])
  try {
    const trace = createTraceRecorder({ dir, meta: { git_commit: 'abc', prompt_digest: 'p1' } })
    const complete = configuredCompletion('/nonexistent/providers.json', fakeCreate,
      { CONEXUS_MODEL_BASE_URL: endpoint.baseUrl, CONEXUS_MODEL_ID: 'deepseek-test', CONEXUS_MODEL_API_KEY: 'secret-key' }, { trace })
    const signal = new AbortController().signal
    const messages = [{ role: 'system', content: '系统提示 secret instructions' }, { role: 'user', content: 'hello' }]
    assert.equal((await complete({ model: 'alias', signal, messages, trace: { requestId: 'req-1', modelCallId: 'm1', iteration: 1 } })).content, 'OK')
    await complete({ model: 'alias', signal, messages: [...messages, { role: 'assistant', content: 'OK' }], trace: { requestId: 'req-1', modelCallId: 'm2', iteration: 2 } })
    await trace.flush()
    const rows = await readRows(dir, 'req-1')
    assert.deepEqual(rows.map(row => row.type), ['run.meta', 'model', 'model'])
    assert.equal(rows[0].git_commit, 'abc')
    const [first, second] = rows.slice(1)
    assert.equal(first.model, 'deepseek-test')
    assert.equal(first.usage_source, 'provider')
    assert.equal(first.tokens_in, 1200)
    assert.equal(first.tokens_out, 30)
    assert.equal(first.cached_tokens_in, 1000)
    assert.ok(first.system_chars > 0 && first.prompt_chars > first.system_chars)
    assert.ok(second.prompt_growth_chars > 0 && second.prompt_growth_chars < second.prompt_chars)
    const raw = await readFile(join(dir, 'req-1.jsonl'), 'utf8')
    assert.doesNotMatch(raw, /secret/)
  } finally { await endpoint.close(); await rm(dir, { recursive: true, force: true }) }
})

test('tool events record duration, repeats and failures; model errors are recorded and rethrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alphalab-trace-'))
  let now = 1000
  try {
    const trace = createTraceRecorder({ dir, clock: () => now })
    const complete = configuredCompletion('/nonexistent/providers.json', () => async () => { throw Object.assign(new Error('Model endpoint returned HTTP 429.'), { code: 'model_provider_error' }) },
      { CONEXUS_MODEL_BASE_URL: 'http://localhost:1/v1', CONEXUS_MODEL_ID: 'm' }, { trace })
    const args = { node_id: 'alphalab-project-run', input: { command: 'backtest.wait', args: { job_id: 'j1' }, confirm_python_execution: true, confirm_cancel: false } }
    for (const id of ['t1', 't2']) {
      complete.trace({ type: 'tool.started', requestId: 'req-2', toolCallId: id, toolName: 'use', arguments: args })
      now += 250
      await complete.trace({ type: 'tool.completed', requestId: 'req-2', toolCallId: id, toolName: 'use',
        result: id === 't2' ? { output: { status: 'failed', error_code: 'ALPHALAB_API_UNAVAILABLE' } } : { output: { status: 'running' } } })
    }
    await assert.rejects(complete({ model: 'a', signal: new AbortController().signal, messages: [], trace: { requestId: 'req-2' } }), /429/)
    await trace.flush()
    const rows = await readRows(dir, 'req-2')
    const tools = rows.filter(row => row.type === 'tool')
    assert.deepEqual(tools.map(row => [row.label, row.ms, row.repeat, row.ok]), [
      ['use:backtest.wait', 250, false, true],
      ['use:backtest.wait', 250, true, false],
    ])
    assert.deepEqual(tools[0].confirms, ['confirm_python_execution'])
    assert.equal(tools[1].error_code, 'ALPHALAB_API_UNAVAILABLE')
    // A successful read that merely lists failed jobs is not a failed tool call.
    complete.trace({ type: 'tool.started', requestId: 'req-2', toolCallId: 't3', toolName: 'use',
      arguments: { input: { command: 'workspace.context' } } })
    await complete.trace({ type: 'tool.completed', requestId: 'req-2', toolCallId: 't3', toolName: 'use',
      result: JSON.stringify({ success: true, output: { status: 'ready', tasks: { sync: [{ status: 'failed', error_code: 'DATA_SYNC_FAILED' }] } } }) })
    const listed = (await readRows(dir, 'req-2')).find(row => row.label === 'use:workspace.context')
    assert.equal(listed.ok, true)
    assert.equal(listed.error_code, null)
    const model = rows.find(row => row.type === 'model')
    assert.equal(model.ok, false)
    assert.equal(model.error_code, 'model_provider_error')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the summary keeps failed runs and attributes polling calls to waiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'alphalab-trace-summary-'))
  const at = seconds => new Date(Date.UTC(2026, 10, 2, 0, 0, seconds)).toISOString()
  const model = (s, ms, tokens, cached = 0) => ({ type: 'model', at: at(s), ms, ok: true, model: 'm', tokens_in: tokens, cached_tokens_in: cached, tokens_out: 10, usage_source: 'provider', prompt_chars: tokens * 3 })
  const tool = (s, label, ms, extra = {}) => ({ type: 'tool', at: at(s), label, ms, ok: true, repeat: false, ...extra })
  const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  try {
    await writeFile(join(dir, 'a.jsonl'), lines([
      { type: 'run.meta', requestId: 'a', at: at(0), task_id: 'T01' },
      model(2, 2000, 15000, 14000), tool(3, 'use:backtest.run', 1000),
      model(5, 2000, 16000, 15000), tool(35, 'use:backtest.wait', 30000),
      model(37, 2000, 17000, 16000), tool(67, 'use:backtest.wait', 30000),
      model(69, 2000, 18000, 17000), tool(70, 'find', 500), tool(71, 'find', 500, { repeat: true }),
      model(73, 2000, 19000, 18000), tool(74, 'complete', 200),
      { type: 'request.completed', at: at(74) },
    ]))
    await writeFile(join(dir, 'b.jsonl'), lines([
      { type: 'run.meta', requestId: 'b', at: at(0), task_id: 'T02' },
      model(3, 3000, 15000), tool(4, 'use:workspace.context', 800, { ok: false }),
      { type: 'model', at: at(10), ms: 6000, ok: false, model: 'm', tokens_in: 15500, tokens_out: 0, usage_source: 'estimate' },
      { type: 'request.failed', at: at(10) },
    ]))
    const { runs, total } = await summarizeDirectory(dir, { in: 2, cached: 0.5, out: 8 })
    assert.deepEqual(runs.map(run => [run.task_id, run.status]), [['T01', 'completed'], ['T02', 'failed']])
    assert.deepEqual(total.statuses, { completed: 1, failed: 1 })
    const [a, b] = runs
    assert.equal(a.wall_s, 74)
    assert.equal(a.tool_s.wait, 60)
    assert.equal(a.polling_model_calls, 2)
    assert.equal(a.polling_tokens_in, 35000)
    assert.equal(a.repeated_tool_calls, 1)
    assert.equal(b.tool_failures + b.model_failures, 2)
    assert.equal(b.estimated_usage_calls, 1)
    assert.ok(total.cost > 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('bundle metadata pins the prompt bundle and commit', async () => {
  const meta = await bundleMetadata(root, { ALPHALAB_BENCHMARK_VERSION: 'v1', ALPHALAB_BENCHMARK_TASK: 'T01' })
  assert.match(meta.prompt_digest, /^[a-f0-9]{12}$/)
  assert.equal(meta.benchmark, 'v1')
  assert.equal(meta.task_id, 'T01')
})

test('the real AlphaLab Harness emits model and tool rows through the local Host', {
  skip: existsSync(builtEntry) ? false : 'Build the pinned Conexus runtime first: python scripts/build_conexus_runtime.py',
  timeout: 240000,
}, async () => {
  const { compileHarnessWorkspace, createLocalHost, createLocalRuntime, createModelCompletion } = await import(pathToFileURL(builtEntry).href)
  const projectRoot = await mkdtemp(join(tmpdir(), 'alphalab-trace-host-'))
  const dir = join(projectRoot, 'traces')
  const context = { node_id: 'alphalab-project-run', capability: 'tool.invoke', input: { command: 'workspace.context' } }
  // The AlphaLab API is deliberately absent: the tool fails fast and the trace must still show it.
  const endpoint = await modelEndpoint([call('use', context), call('use', context),
    call('complete', { status: 'done', summary: 'Traced.' })])
  const runtime = createLocalRuntime({ projectRoot, toolEnvironment: { ALPHALAB_API_ORIGIN: 'http://127.0.0.1:9' } })
  const model = 'alphalab/configured-provider'
  const workspace = await researchCanvas(resolve(root, 'integrations/conexus/alphalab-research-agent'), { model, slug: 'alphalab-research-agent' })
  const release = compileHarnessWorkspace({ workspace, harnessNodeId: 'alphalab-research-harness-v1' })
  const trace = createTraceRecorder({ dir, meta: await bundleMetadata(root) })
  const token = randomBytes(24).toString('base64url')
  const host = await createLocalHost({ projectRoot, release, slug: 'alphalab-research-agent', token, model, runtimeAdapter: runtime.adapter,
    complete: configuredCompletion(join(projectRoot, 'none.json'), createModelCompletion,
      { CONEXUS_MODEL_BASE_URL: endpoint.baseUrl, CONEXUS_MODEL_ID: 'fake-model' }, { trace }) })
  try {
    const started = (await host.app.inject({ method: 'POST', url: '/api/public/harnesses/alphalab-research-agent/runs',
      headers: { authorization: `Bearer ${token}` }, payload: { exposureId: 'alphalab-research-agent', input: { request: 'Describe the workspace.' } } })).json()
    let run
    for (const deadline = Date.now() + 200000; Date.now() < deadline; await delay(50)) {
      run = (await host.app.inject({ url: `/api/public/runs/${started.run.id}`, headers: { authorization: `Bearer ${started.accessToken}` } })).json().run
      if (['completed', 'blocked', 'failed', 'cancelled'].includes(run.status)) break
    }
    await trace.flush()
    const [file] = await readdir(dir)
    const rows = (await readFile(join(dir, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const models = rows.filter(row => row.type === 'model')
    const tools = rows.filter(row => row.type === 'tool')
    assert.equal(models.length, 3, JSON.stringify(run))
    assert.ok(models.every(row => row.usage_source === 'provider' && row.tokens_in === 1200))
    assert.deepEqual(tools.filter(row => row.label === 'use:workspace.context').map(row => [row.ok, row.repeat]), [[false, false], [false, true]])
    // The exact first request is what every later call pays for again.
    const first = endpoint.requests[0]
    console.log(JSON.stringify({ first_request: { system_chars: models[0].system_chars, tool_schema_chars: models[0].tool_schema_chars,
      prompt_chars: models[0].prompt_chars, est_tokens_in: models[0].est_tokens_in, tools: first.tools.map(tool => tool.function.name) } }))
  } finally {
    await host.close(); runtime.close(); await endpoint.close()
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
