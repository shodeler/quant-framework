// Fixed per-call cost of the AlphaLab Agent (issue #22), measured without a real model.
//
//   node scripts/agent_prompt_budget.mjs [--json] [--dump <file>]
//
// Boots the real Harness on the built local Host with a one-turn loopback model,
// captures the exact first request, and splits it into system prompt parts and
// tool schemas. Every later model call in a run resends at least this much.
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { researchCanvas } from '../integrations/conexus/research-canvas.mjs'
import { bundleMetadata, estimateTokens } from '../integrations/conexus/agent-trace.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = resolve(root, 'integrations/conexus/alphalab-research-agent')
const entry = resolve(root, 'build/conexus/apps/local-host/src/index.mjs')
if (!existsSync(entry)) throw new Error('Build the pinned Conexus runtime first: python scripts/build_conexus_runtime.py')
const { compileHarnessWorkspace, createLocalHost, createLocalRuntime, createModelCompletion } = await import(pathToFileURL(entry).href)

let captured
const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    captured ??= JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const message = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function',
      function: { name: 'complete', arguments: JSON.stringify({ status: 'done', summary: 'Measured.' }) } }] }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: 'tool_calls' }] }))
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const projectRoot = await mkdtemp(join(tmpdir(), 'alphalab-budget-'))
const runtime = createLocalRuntime({ projectRoot, toolEnvironment: { ALPHALAB_API_ORIGIN: 'http://127.0.0.1:9' } })
const model = 'alphalab/configured-provider'
const release = compileHarnessWorkspace({ workspace: await researchCanvas(bundle, { model }), harnessNodeId: 'alphalab-research-harness-v1' })
const token = randomBytes(24).toString('base64url')
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const complete = createModelCompletion({ baseUrl, model: 'budget-probe' })
const host = await createLocalHost({ projectRoot, release, slug: 'alphalab-research-agent', token, model, runtimeAdapter: runtime.adapter,
  complete: request => complete({ ...request, model: 'budget-probe' }) })
try {
  const started = (await host.app.inject({ method: 'POST', url: '/api/public/harnesses/alphalab-research-agent/runs',
    headers: { authorization: `Bearer ${token}` }, payload: { exposureId: 'alphalab-research-agent', input: { request: '你好' } } })).json()
  for (const deadline = Date.now() + 60000; !captured && Date.now() < deadline;) await delay(50)
  if (!captured) throw new Error('The Harness did not call the model.')
  void started
} finally {
  await host.close(); runtime.close(); server.close()
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const read = path => readFile(resolve(bundle, path), 'utf8')
const agent = JSON.parse(await read('agents/AlphaLab-Research-Agent.agent.json'))
const skill = (await read('skills/alphalab-sdk-v1/SKILL.md')).trim()
const schema = JSON.stringify(JSON.parse(await read('workspace-output.schema.json')).properties.workspaceCommands)
const base = agent.systemPrompt.replace('{{ALPHALAB_SDK_SKILL}}', '').replace('{{ALPHALAB_WORKSPACE_COMMAND_SCHEMA}}', '')
const system = captured.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n')
const other = captured.messages.filter(message => message.role !== 'system').map(message => JSON.stringify(message.content)).join('\n')
const measure = value => ({ chars: value.length, est_tokens: estimateTokens(value) })
const parts = {
  'system: agent instructions': measure(base),
  'system: injected SKILL.md': measure(skill),
  'system: workspace command schema': measure(schema),
  'system: added by Conexus runtime': measure(system.slice(0, Math.max(0, system.length - base.length - skill.length - schema.length))),
  'user/context messages': measure(other),
  ...Object.fromEntries(captured.tools.map(tool => [`tool schema: ${tool.function.name}`, measure(JSON.stringify(tool))])),
}
const total = Object.values(parts).reduce((sum, item) => ({ chars: sum.chars + item.chars, est_tokens: sum.est_tokens + item.est_tokens }), { chars: 0, est_tokens: 0 })
const report = { meta: await bundleMetadata(root), messages: captured.messages.map(message => message.role), parts, total,
  // Provider prefix caches only help if nothing request-specific precedes the stable text.
  stable_prefix: { skill_offset: system.indexOf(skill.slice(0, 200)), agent_offset: system.indexOf(base.slice(0, 200)) } }
const dump = process.argv.indexOf('--dump')
if (dump > 0) await writeFile(process.argv[dump + 1], JSON.stringify(captured, null, 2))
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`Prompt bundle ${report.meta.prompt_digest} at ${report.meta.git_commit?.slice(0, 7)}; first request messages: ${report.messages.join(', ')}`)
  const rows = Object.entries(parts).sort((a, b) => b[1].est_tokens - a[1].est_tokens)
  for (const [name, item] of rows) console.log(`${name.padEnd(36)} ${String(item.chars).padStart(7)} chars ${String(item.est_tokens).padStart(6)} est. tokens ${(100 * item.est_tokens / total.est_tokens).toFixed(1).padStart(5)}%`)
  console.log(`${'TOTAL fixed cost per model call'.padEnd(36)} ${String(total.chars).padStart(7)} chars ${String(total.est_tokens).padStart(6)} est. tokens`)
  console.log(`Offsets in system text: agent instructions at ${report.stable_prefix.agent_offset}, SKILL.md at ${report.stable_prefix.skill_offset}`)
}
