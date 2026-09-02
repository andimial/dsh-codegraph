// dsh-codegraph runtime test harness
// Loads the installed plugin's actual lib/index.js, mounts stub cordis
// services (tools/subprocess/shell), calls apply(), and exercises every
// registered tool against the real `codegraph` CLI on a real test project.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

// --- locate the installed plugin -----------------------------------------
const profileNodeModules = process.env.CG_PROFILE_NM
const pluginRoot = profileNodeModules
  ? join(profileNodeModules, 'dsh-codegraph')
  : join(__dirname, '..') // fall back to the working checkout
const plugin = await import(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)

// --- tiny real subprocess executor (minimal child_process wrapper) --------
function runProc(argv, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: cwd || '/',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ exitCode: code, stdout: out, stderr: err }))
  })
}

// Resolve a bare command the way dsh's subprocess service does on this
// platform: PATHEXT scan on Windows (lands on .cmd/.exe shims), `which` on
// POSIX.
function resolveExecutable(name) {
  if (isWin) {
    const pathDirs = (process.env.PATH || '').split(';')
    const extensions = name.includes('.') || name.includes('\\') || name.includes('/')
      ? ['']
      : (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    for (const dir of pathDirs) {
      for (const ext of extensions) {
        const candidate = resolve(process.cwd(), dir, name + ext)
        if (existsSync(candidate)) return candidate
      }
    }
    throw new Error(`not found: ${name}`)
  }
  try {
    return execFileSync('which', [name]).toString().trim()
  } catch {
    throw new Error(`not found: ${name}`)
  }
}

const subprocessService = {
  async resolveExecutable(name) {
    return resolveExecutable(name)
  },
  spawn({ argv, cwd, stdio }) {
    // stdio caps are ignored here; real service collects streams
    const collected = {
      stdout: { readFrom: () => undefined },
      stderr: { readFrom: () => undefined }
    }
    // We bypass the stream-collection abstraction and run directly for the test.
    const p = runProc(argv, cwd)
    return {
      collected,
      done: p.then((r) => {
        collected.stdout.readFrom = () => ({ text: r.stdout })
        collected.stderr.readFrom = () => ({ text: r.stderr })
        return { exitCode: r.exitCode }
      })
    }
  }
}

const shellService = {
  resolve({ command, workdir }) {
    return { command, workdir }
  },
  async run(spec) {
    const r = await runProc([isWin ? 'cmd.exe' : '/bin/bash', isWin ? '/d' : '-c', spec.command], spec.workdir)
    return { exitCode: r.exitCode, stdout: { text: r.stdout }, stderr: { text: r.stderr } }
  }
}

// --- stub cordis context --------------------------------------------------
const registeredTools = []
const promptSections = []
const listeners = []

const ctx = {
  tools: {
    register(tool) {
      registeredTools.push(tool)
    }
  },
  systemPrompt: {
    section(sec) {
      promptSections.push(sec)
      return () => {}
    }
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  get(name) {
    if (name === 'subprocess') return subprocessService
    if (name === 'shell') return shellService
    return undefined
  }
}

// --- apply the plugin ------------------------------------------------------
const sessionCwd = isWin ? join(tmpdir(), 'cg-test-proj') : '/tmp/cg-test-proj' // tools default to this via exec.agent
mkdirSync(sessionCwd, { recursive: true })

function makeExec() {
  const aborted = { value: false }
  let signal
  const ctrl = new AbortController()
  return {
    agent: { session: { header: { cwd: sessionCwd } } },
    signal: ctrl.signal,
    abort() {
      aborted.value = true
      ctrl.abort()
    }
  }
}

function results() {
  let pass = 0
  let fail = 0
  return {
    ok(label, detail) {
      pass++
      console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
    },
    bad(label, detail) {
      fail++
      console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
    },
    get tally() {
      return { pass, fail }
    }
  }
}

let pass = 0
let fail = 0
const ok = (l, d) => { pass++; console.log(`  ✅ ${l}${d ? ' — ' + d : ''}`) }
const bad = (l, d, e) => { fail++; console.log(`  ❌ ${l}${d ? ' — ' + d : ''}${e ? '\n     ↳ ' + e : ''}`) }
const call = async (name, args) => {
  const tool = registeredTools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  const exec = makeExec()
  const raw = await tool.execute(args, exec)
  exec.abort()
  return raw
}

console.log('\n=== 1) plugin.apply mounts (surface: full — exercises every tool) ===')
try {
  plugin.apply(ctx, { surface: 'full' })
  ok('apply(ctx) did not throw')
} catch (e) {
  bad('apply(ctx) threw', null, e.message)
  process.exit(1)
}

console.log('\n=== 1b) default surface is "core": only status/init/sync/explore register ===')
{
  const coreTools = []
  const coreSections = []
  const ctxCore = {
    tools: { register(t) { coreTools.push(t) } },
    systemPrompt: { section(s) { coreSections.push(s); return () => {} } },
    on() { return () => {} },
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctxCore)
  const coreNames = coreTools.map((t) => t.name).sort()
  const expected = ['codegraph_explore', 'codegraph_init', 'codegraph_status', 'codegraph_sync']
  if (JSON.stringify(coreNames) === JSON.stringify(expected)) {
    ok('core surface registers exactly status/init/sync/explore', coreNames.join(', '))
  } else {
    bad('core surface should register exactly 4 tools', `got [${coreNames.join(', ')}]`)
  }
  if (coreSections.find((s) => s.name === 'tool:codegraph')) ok('core surface still injects the prompt guidance')
  else bad('core surface must still inject tool:codegraph section')
}

console.log('\n=== 2) systemPrompt guidance injected (prefer codegraph for code search) ===')
const cg = promptSections.find((s) => s.name === 'tool:codegraph')
if (cg) {
  ok(`injected section "tool:codegraph"`, `order=${cg.order}, text.length=${cg.text.length}`)
  if (cg.order < 100) ok(`order ${cg.order} < 100 → renders before grep/glob/read`, null)
  else bad('order should be < 100 (before read=100/grep=104)', `got ${cg.order}`)
  if (/codegraph_status/.test(cg.text) && /codegraph_explore/.test(cg.text) && /INSTEAD of grep\/glob\/read/.test(cg.text)) {
    ok('guidance is imperative: MUST use explore INSTEAD of grep/glob/read, names status/explore')
  } else {
    bad('guidance text should instruct codegraph_* usage (status/explore, imperative)')
  }
  if (/Anti-patterns/.test(cg.text) && /not indexed/.test(cg.text)) ok('guidance carries anti-patterns + unindexed stop rule')
  else bad('guidance should carry anti-patterns and the unindexed stop rule')
  if (!/codegraph_query|codegraph_node|codegraph_callers/.test(cg.text)) ok('guidance names only core-surface tools')
  else bad('guidance should name only core-surface tools (query/node/callers are full-surface)')
} else {
  bad('no "tool:codegraph" systemPrompt section injected')
}

console.log('\n=== 3) config: guideSearch:false registers tools without the prompt guidance ===')
const tools2 = []
const sections2 = []
const ctx2 = {
  tools: { register(t) { tools2.push(t) } },
  systemPrompt: { section(s) { sections2.push(s); return () => {} } },
  on() { return () => {} },
  get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
}
plugin.apply(ctx2, { guideSearch: false, surface: 'full' })
if (tools2.length === 13) ok('13 tools registered with guideSearch:false (untouched)')
else bad('tools should still register with guideSearch:false', `got ${tools2.length}`)
if (sections2.find((s) => s.name === 'tool:codegraph')) {
  bad('guideSearch:false must NOT inject tool:codegraph section')
  ok(`  ...still registered`, sections2[0] ? `sections=${sections2.length} (${sections2[0].name})` : 'no sections')
} else {
  ok('guideSearch:false skips the tool:codegraph prompt section', `sections=${sections2.length}`)
}

console.log('\n=== 4) tool registration (surface: full → expect 13 codegraph_* tools) ===')
const names = registeredTools.map((t) => t.name).sort()
const codeTools = names.filter((n) => n.startsWith('codegraph_'))
console.log('   registered:', names.join(', '))
if (codeTools.length === 13) ok(`13 codegraph_* tools registered`, codeTools.join(', '))
else bad(`expected 13 codegraph_* tools, got ${codeTools.length}`, null)

console.log('\n=== 5) codegraph_status (not yet indexed) ===')
try {
  const s = await call('codegraph_status', {})
  console.log('   status output:', s.slice(0, 220))
  ok('codegraph_status ran')
} catch (e) {
  bad('codegraph_status', null, e.message)
}

console.log('\n=== 6) codegraph_init (bootstrap the index) ===')
try {
  const out = await call('codegraph_init', {})
  console.log('   init output:', String(out).slice(0, 200))
  ok('codegraph_init ran')
} catch (e) {
  bad('codegraph_init', null, e.message)
}

console.log('\n=== 7) codegraph_status (indexed) ===')
try {
  const s = String(await call('codegraph_status', {}))
  console.log('   status:', s.slice(0, 260))
  ok('codegraph_status after init')
} catch (e) {
  bad('codegraph_status after init', null, e.message)
}

console.log('\n=== 8) codegraph_query("multiply") ===')
try {
  const q = String(await call('codegraph_query', { search: 'multiply' }))
  console.log('   query:', q.slice(0, 260))
  ok('codegraph_query ran')
} catch (e) {
  bad('codegraph_query', null, e.message)
}

console.log('\n=== 9) codegraph_node("add") ===')
try {
  const n = String(await call('codegraph_node', { name: 'add' }))
  console.log('   node:', n.slice(0, 280))
  ok('codegraph_node ran')
} catch (e) {
  bad('codegraph_node', null, e.message)
}

console.log('\n=== 10) codegraph_callers(double) & codegraph_callees(multiply) ===')
try {
  const c = String(await call('codegraph_callers', { symbol: 'double' }))
  console.log('   callers(double):', c.slice(0, 200))
  ok('codegraph_callers ran')
} catch (e) {
  bad('codegraph_callers', null, e.message)
}
try {
  const c = String(await call('codegraph_callees', { symbol: 'multiply' }))
  console.log('   callees(multiply):', c.slice(0, 200))
  ok('codegraph_callees ran')
} catch (e) {
  bad('codegraph_callees', null, e.message)
}

console.log('\n=== 11) codegraph_explore("math utilities") ===')
try {
  const ex = String(await call('codegraph_explore', { query: 'math utilities', maxFiles: 2 }))
  console.log('   explore:', ex.slice(0, 280))
  ok('codegraph_explore ran')
} catch (e) {
  bad('codegraph_explore', null, e.message)
}

console.log('\n=== 12) codegraph_files ===')
try {
  const f = String(await call('codegraph_files', {}))
  console.log('   files:', f.slice(0, 200))
  ok('codegraph_files ran')
} catch (e) {
  bad('codegraph_files', null, e.message)
}

console.log('\n=== 13) path arg override (point at test project explicitly) ===')
try {
  const s = String(await call('codegraph_status', { path: sessionCwd }))
  console.log('   status(path):', s.slice(0, 200))
  ok('codegraph_status with explicit path')
} catch (e) {
  bad('codegraph_status with explicit path', null, e.message)
}

console.log('\n=== 14) codegraph_sync ===')
try {
  const s = String(await call('codegraph_sync', {}))
  console.log('   sync:', (s || '(no output)').slice(0, 200))
  ok('codegraph_sync ran')
} catch (e) {
  bad('codegraph_sync', null, e.message)
}

console.log('\n=== 15) codegraph_impact(multiply) & codegraph_affected ===')
try {
  const im = String(await call('codegraph_impact', { symbol: 'multiply', depth: 1 }))
  console.log('   impact:', im.slice(0, 220))
  ok('codegraph_impact ran')
} catch (e) {
  bad('codegraph_impact', null, e.message)
}
try {
  const af = String(await call('codegraph_affected', { files: ['src/math.ts'] }))
  console.log('   affected:', af.slice(0, 220))
  ok('codegraph_affected ran')
} catch (e) {
  bad('codegraph_affected', null, e.message)
}

console.log('\n=== 16) error path: no path, no session cwd ===')
try {
  const t = registeredTools.find((x) => x.name === 'codegraph_status')
  await t.execute({}, { agent: { session: { header: {} } }, signal: new AbortController().signal })
  bad('expected throw with no cwd & no path')
} catch (e) {
  ok('throws when no session cwd and no path', e.message.slice(0, 80))
}

console.log('\n=== 17) remaining tools registered & present ===')
for (const t of ['codegraph_index', 'codegraph_uninit']) {
  const present = !!registeredTools.find((x) => x.name === t)
  if (present) ok(`registered ${t}`)
  else bad(`MISSING ${t}`)
}

// --- front-load (prompt-hook) tests ---------------------------------------
// The plugin registered an 'agent/inbox/inserted' listener on the main ctx
// (frontload defaults to true). Drive it with fake agents and observe what
// gets steered into the turn.

const frontloadHandlers = listeners.filter((l) => l.event === 'agent/inbox/inserted')

function makeAgent(cwd, promptText, id) {
  const message = {
    id,
    role: 'user',
    content: [{ type: 'text', text: promptText }],
    source: { kind: 'user' }
  }
  const steered = []
  const agent = {
    session: { header: { cwd } },
    inbox: { nextTurn: [message] },
    steer(m) { steered.push(m) }
  }
  return { agent, message, steered }
}

async function waitForSteer(steered, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (steered.length > 0) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

console.log('\n=== 18) frontload listener registered (frontload defaults to true) ===')
if (frontloadHandlers.length === 1) ok('one agent/inbox/inserted listener registered')
else bad('expected exactly 1 frontload listener', `got ${frontloadHandlers.length}`)

console.log('\n=== 19) frontload: structural zh prompt on indexed project → steered context ===')
{
  const { agent, message, steered } = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？谁会调用它？', 'fl-1')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 30000)
  if (!fired) {
    bad('frontload did not steer anything for a structural prompt')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('<codegraph_context') && text.includes('multiply')) {
      ok('steered <codegraph_context> with explore output', `len=${text.length}`)
    } else {
      bad('steered message missing <codegraph_context> or explore content', text.slice(0, 120))
    }
    if (steered[0].role === 'user' && steered[0].id) ok('steered message is a valid user message (id + role)')
    else bad('steered message malformed')
  }
}

console.log('\n=== 19b) frontload: same prompt re-sent (GUI retry / step re-park) → deduped, no 2nd injection ===')
{
  const { agent, message, steered } = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？谁会调用它？', 'fl-1b')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 8000)
  if (!fired) ok('identical prompt within 10min is deduped (no duplicate <codegraph_context>)')
  else bad('re-sent prompt should not front-load a duplicate', steered[0].content[0].text.slice(0, 80))
}

console.log('\n=== 20) frontload: non-structural prompt → silent no-op ===')
{
  const { agent, message, steered } = makeAgent(sessionCwd, 'fix this typo please', 'fl-2')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 8000)
  if (!fired) ok('no injection for a non-structural prompt')
  else bad('non-structural prompt should not front-load', steered[0].content[0].text.slice(0, 80))
}

console.log('\n=== 21) frontload: unindexed project → silent no-op ===')
{
  const { agent, message, steered } = makeAgent('/tmp', 'multiply 的调用流程是怎样的？', 'fl-3')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 8000)
  if (!fired) ok('no injection when no .codegraph/ index is reachable')
  else bad('unindexed project should not front-load')
}

console.log('\n=== 22) frontload: does not re-trigger on its own output / non-user sources ===')
{
  const { agent, message, steered } = makeAgent(sessionCwd, '<codegraph_context>…prior injection…</codegraph_context>', 'fl-4')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired1 = await waitForSteer(steered, 5000)
  const rpc = makeAgent(sessionCwd, 'multiply 的调用流程是怎样的？', 'fl-5')
  rpc.message.source = { kind: 'rpc' }
  for (const h of frontloadHandlers) h.handler({ agent: rpc.agent, message: rpc.message })
  const fired2 = await waitForSteer(rpc.steered, 5000)
  if (!fired1 && !fired2) ok('own output and non-user sources are ignored')
  else bad(`loop-guard failed (marker=${fired1}, rpc=${fired2})`)
}

console.log('\n=== 23) config: frontload:false registers no listener ===')
{
  const listeners3 = []
  const ctx3 = {
    tools: { register() {} },
    systemPrompt: { section() { return () => {} } },
    on(event, handler) { listeners3.push({ event, handler }); return () => {} },
    get(n) { return n === 'subprocess' ? subprocessService : n === 'shell' ? shellService : undefined }
  }
  plugin.apply(ctx3, { frontload: false })
  if (!listeners3.some((l) => l.event === 'agent/inbox/inserted')) ok('frontload:false skips the inbox listener')
  else bad('frontload:false must NOT register the inbox listener')
}

console.log('\n=== 24) no executor mounted: apply must NOT throw (lazy resolution), execute errors with hint ===')
{
  const tools4 = []
  const ctx4 = {
    tools: { register(t) { tools4.push(t) } },
    systemPrompt: { section() { return () => {} } },
    on() { return () => {} },
    get() { return undefined } // neither subprocess nor shell
  }
  try {
    plugin.apply(ctx4, { surface: 'full' })
    ok('apply() mounts without any executor service (boot-order safe)')
  } catch (e) {
    bad('apply() must not throw when executors are missing', null, e.message)
  }
  const statusTool = tools4.find((t) => t.name === 'codegraph_status')
  if (!statusTool) {
    bad('codegraph_status should still register without executors')
  } else {
    try {
      await statusTool.execute({}, makeExec())
      bad('execute should throw the executor hint when no executor is mounted')
    } catch (e) {
      if (/subprocess|shell/.test(e.message)) ok('execute throws the executor hint', e.message.slice(0, 70))
      else bad('execute threw an unexpected error', null, e.message)
    }
  }
}

console.log(`\n========== ${pass} passed, ${fail} failed ==========\n`)
process.exit(fail === 0 ? 0 : 1)
