// dsh-codegraph runtime test harness
// Loads the installed plugin's actual lib/index.js, mounts stub cordis
// services (tools/subprocess/shell), calls apply(), and exercises every
// registered tool against the real `codegraph` CLI on a real test project.
//
// The plugin imports `defineTool` from @deepseek-ai/dsh-tools and
// `createUserMessage` from @deepseek-ai/dsh-llm. Those are REAL peer
// dependencies, not stubs: resolution goes through node_modules, so whichever
// DSH version the harness installs is the version whose argument validation,
// Config schema, and message factory the plugin is exercised against. That is
// what makes this suite a cross-version gate — see section 0 below.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const isWin = process.platform === 'win32'

// --- locate the installed plugin -----------------------------------------
const profileNodeModules = process.env.CG_PROFILE_NM
const pluginRoot = profileNodeModules
  ? join(profileNodeModules, 'dsh-codegraph')
  : join(__dirname, '..') // fall back to the working checkout
// pathToFileURL, not a bare path: on Windows `pluginRoot` is an absolute
// `D:\…` path and the ESM loader rejects it (ERR_UNSUPPORTED_ESM_URL_SCHEME).
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

// Scripts resolveExecutable had to fall back to running under the current
// Node (a `#!/usr/bin/env node` launcher that Node cannot exec directly).
// Keyed by resolved script path -> the original command name.
const shimScripts = new Map()

// Locate an executable the way a POSIX `which` would, cross-platform.
// On Windows `which` (when present at all) is Git bash's and returns a
// `/c/...` path that Node cannot even stat, while the real lookup is `where.exe`
// and the hits are `.CMD` shims Node refuses to spawn without a shell. So:
// enumerate, and for a shim resolve the JS entry it delegates to.
function locateCandidates(name) {
  if (process.platform !== 'win32') {
    try {
      return [execFileSync('which', [name]).toString().trim()]
    } catch {
      return []
    }
  }
  let found = []
  try {
    found = execFileSync('where.exe', [name]).toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch { /* not on PATH */ }
  return found
}

// Extract the JS entry a pnpm/npm `.CMD` shim delegates to, e.g.
// node "%~dp0\..\global\v11\<hash>\node_modules\@colbymchenry\codegraph\npm-shim.js"
function winShimScript(cmdPath) {
  let text
  try {
    text = readFileSync(cmdPath, 'utf8')
  } catch {
    return undefined
  }
  const m = /"([^"]*\.js)"/.exec(text)
  if (!m) return undefined
  // npm/pnpm emit `%dp0%`, cmd wrappers `%~dp0`; a bash launcher emits
  // `$basedir_win` and simply fails the existsSync probe below.
  const abs = resolve(dirname(cmdPath), m[1].replace(/^%?~?dp0%?\\?/, ''))
  return existsSync(abs) ? abs : undefined
}

const subprocessService = {
  async resolveExecutable(name) {
    // Resolve the way the REAL subprocess service does: hand back something
    // Node can actually spawn.
    //
    // `which` alone is not enough. npm global bins are symlinks into the
    // package (or, for shim packages, a `#!/usr/bin/env node` launcher), and a
    // shell happily runs those while `spawn()` needs a real executable file at
    // the resolved path. On CI `which codegraph` returned a path that
    // `codegraph --version` ran fine from bash yet `spawn()` rejected with
    // ENOENT — 14 tests failed on an environment quirk that had nothing to do
    // with the plugin. So: locate it, then prove Node can spawn it, and fall
    // back to running the JS entry through the current Node when it cannot.
    const candidates = locateCandidates(name)

    // Fallback: a global bin directory that is not the running Node's.
    const nodeDir = dirname(process.execPath)
    candidates.push(join(nodeDir, name))

    for (const candidate of candidates) {
      if (!candidate || !existsSync(candidate)) continue
      try {
        // Proven spawnable only if a bare spawn of it does not error.
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 30000 })
        if (!probe.error && probe.status === 0) return candidate
      } catch { /* try the next candidate */ }
    }

    // Last resort: resolve the shim's JS file and run it with the current Node.
    // The returned value is a path the plugin execs directly, so recover the
    // script path here and let spawn() prepend the interpreter.
    for (const candidate of candidates) {
      if (!candidate || !existsSync(candidate)) continue
      const script = winShimScript(candidate)
      if (script !== undefined) {
        shimScripts.set(script, name)
        return script
      }
    }
    // POSIX shims are plain files: realpath them and let spawn() add Node.
    try {
      const which = execFileSync('which', [name]).toString().trim()
      const real = realpathSync(which)
      if (existsSync(real)) {
        shimScripts.set(real, name)
        return real
      }
    } catch { /* fall through to the error */ }
    throw new Error(`not found: ${name}`)
  },
  spawn({ argv, cwd, stdio }) {
    // stdio caps are ignored here; real service collects streams
    const collected = {
      stdout: { readFrom: () => undefined },
      stderr: { readFrom: () => undefined }
    }
    // If resolveExecutable fell back to a `#!/usr/bin/env node` script that
    // Node cannot exec directly, run it under the current Node instead.
    let spawnArgv = argv
    const script = argv[0] && shimScripts.get(argv[0])
    if (script !== undefined) spawnArgv = [process.execPath, argv[0], ...argv.slice(1)]
    // We bypass the stream-collection abstraction and run directly for the test.
    const p = runProc(spawnArgv, cwd)
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
    // `/d /c` — without `/c` cmd.exe opens an interactive session, reads EOF
    // from the ignored stdin and exits 0 having run NOTHING. That silently
    // turned every shell-service call into a no-op.
    const base = isWin ? ['cmd.exe', '/d', '/c'] : ['/bin/bash', '-c']
    const r = await runProc([...base, spec.command], spec.workdir)
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

// The fixture project MUST exist on disk before any tool runs.
//
// The plugin spawns the CLI with `cwd: <project root>`, defaulting to the
// session cwd. `spawn` with a directory that does not exist fails with
// ENOENT — and Node reports that error against the COMMAND path
// ("spawn /path/to/codegraph ENOENT"), not the cwd, so it reads exactly like a
// missing binary. That misdirection cost real debugging time on CI, where the
// runner starts with a clean /tmp and tests 5-13 all ran before `init` had
// created the directory. A real session cwd always exists, so this is purely a
// fixture-setup concern: create the project up front.
function ensureFixtureProject() {
  const files = {
    'src/math.ts': [
      'export function multiply(a: number, b: number): number {',
      '  return a * b',
      '}',
      '',
      'export function double(x: number): number {',
      '  return multiply(x, 2)',
      '}',
      '',
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      ''
    ].join('\n'),
    'src/index.ts': [
      "import { double, add } from './math'",
      '',
      'export function main(): number {',
      '  return double(21) + add(1, 2)',
      '}',
      ''
    ].join('\n'),
    // Names chosen for the medium-tier gate: `edgeCache` is what a fuzzy
    // query for the prose word `Edge` returns, and `processor_euid` is an
    // exact symbol name. One must not fire, the other must. `Autowired` is a
    // decorator-looking word that IS a real symbol — it must survive the `@`.
    'src/coverage.ts': [
      'export function edgeCache(x: number): number {',
      '  return x + 1',
      '}',
      '',
      'export function processor_euid(x: number): number {',
      '  return x',
      '}',
      '',
      'export function Autowired(x: number): number {',
      '  return x',
      '}',
      '',
      'export function Override(x: number): number {',
      '  return x',
      '}',
      ''
    ].join('\n'),
    // `/lib/` mid-token: the path stripper must NOT treat it as a system root,
    // or `src/lib/utils.ts` degrades to `src` and the file token is lost.
    'src/lib/utils.ts': [
      'export function utilsFn(x: number): number {',
      '  return x - 1',
      '}',
      ''
    ].join('\n')
  }
  mkdirSync(join(sessionCwd, 'src'), { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(sessionCwd, rel)
    mkdirSync(dirname(target), { recursive: true })
    // Rewrite when the fixture body changed, so a symbol added here reaches
    // the index on the next `sync` instead of waiting for a pristine temp dir.
    if (!existsSync(target) || readFileSync(target, 'utf8') !== body) writeFileSync(target, body)
  }
}
ensureFixtureProject()

// A vendor-only project. An explore against it can only answer with 3rdparty
// symbols — the exact dump that taught an agent to stop using the tool
// (session-eadce75f: 40 asio/rest_rpc symbols for a log question, then zero
// codegraph calls for the rest of the session). The front-load must drop it.
const vendorCwd = isWin ? join(tmpdir(), 'cg-vendor-proj') : '/tmp/cg-vendor-proj'
function ensureVendorProject() {
  const files = {
    '3rdparty/asio/basic_endpoint.hpp': 'namespace asio { struct basic_endpoint { const char* path() const; }; }\n',
    '3rdparty/asio/local/detail/endpoint.hpp': 'namespace asio { struct endpoint { const char* path() const; }; }\n',
    '3rdparty/asio/io_context.hpp': 'namespace asio { struct io_context { void run(); }; }\n',
    '3rdparty/asio/strand.hpp': 'namespace asio { struct strand { void dispatch(); }; }\n',
    '3rdparty/rest_rpc/connection.h': 'namespace rest_rpc { struct connection { const char* remote_address(); }; }\n'
  }
  for (const [rel, body] of Object.entries(files)) {
    const target = join(vendorCwd, rel)
    mkdirSync(dirname(target), { recursive: true })
    if (!existsSync(target)) writeFileSync(target, body)
  }
}

// A second fixture INSIDE the session cwd, addressed by its bare name. This is
// the shape that shipped broken in 1.2.2: the name reached spawn() as a cwd and
// was resolved against the harness process's own cwd, not the session's.
const REL_PROJECT = 'cg-rel-proj'
const relProjectDir = join(sessionCwd, REL_PROJECT)
// A name that must never exist under the session workspace; see section 13d.
const MISSING_PROJECT = 'cg-no-such-proj-xyz'
mkdirSync(join(relProjectDir, 'src'), { recursive: true })
if (!existsSync(join(relProjectDir, 'src/rel.ts'))) {
  writeFileSync(join(relProjectDir, 'src/rel.ts'), 'export function relFn(x: number): number {\n  return x + 1\n}\n')
}

function makeExec(cwd = sessionCwd) {
  const aborted = { value: false }
  let signal
  const ctrl = new AbortController()
  return {
    agent: { session: { header: { cwd } } },
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

console.log('\n=== 0) installed DSH version + peer-range install gate ===')
{
  // The harness resolves the plugin's real peers from node_modules. Report the
  // versions actually under test so a cross-version run is self-describing.
  // Resolution order mirrors Node's own: the plugin's sibling node_modules
  // first (a profile install / CG_PROFILE_NM staging dir), then the plugin
  // root itself. Do NOT fall back to the repo's own node_modules after that —
  // a stale local link would report a version the plugin never sees.
  const readVersion = (pkg) => {
    const candidates = [
      join(pluginRoot, '..', pkg, 'package.json'), // sibling of the plugin dir
      join(pluginRoot, 'node_modules', pkg, 'package.json'), // plugin-local
      join(__dirname, '..', 'node_modules', pkg, 'package.json') // bare checkout
    ]
    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')).version
      } catch { /* try the next candidate */ }
    }
    return undefined
  }
  const toolsVersion = readVersion('@deepseek-ai/dsh-tools')
  const llmVersion = readVersion('@deepseek-ai/dsh-llm')
  console.log(`   @deepseek-ai/dsh-tools: ${toolsVersion ?? '(unresolved)'}`)
  console.log(`   @deepseek-ai/dsh-llm:   ${llmVersion ?? '(unresolved)'}`)
  // Independently confirm what the PLUGIN itself resolves, so the printed
  // version cannot drift from the runtime the assertions below exercise.
  // createRequire seeded with the plugin's own entry file reproduces Node's
  // real resolution for that module (sibling node_modules, then upward).
  try {
    const pluginRequire = createRequire(join(pluginRoot, 'lib/index.js'))
    const resolvedManifest = pluginRequire.resolve('@deepseek-ai/dsh-tools/package.json')
    const resolvedVersion = JSON.parse(readFileSync(resolvedManifest, 'utf8')).version
    if (resolvedVersion === toolsVersion) ok(`plugin resolves dsh-tools ${resolvedVersion} (real peer, not a stub)`)
    else bad('version probe disagrees with the plugin\'s own resolution', `probe=${toolsVersion} resolved=${resolvedVersion}`)
  } catch (e) {
    bad('cannot resolve @deepseek-ai/dsh-tools from the plugin — peers are not installed', null, e.message)
  }

  // DSH 0.2.0 gates installation on peerDependencies: it rejects when the
  // running dsh version fails semver.satisfies(v, range, {includePrerelease:true}).
  // A `<0.2.0-0` ceiling therefore hard-fails `dsh plugin add`, which is the
  // exact regression this suite exists to prevent.
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  } catch {
    manifest = undefined
  }
  const peers = manifest?.peerDependencies ?? {}
  const dshPeers = Object.entries(peers).filter(([n]) => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))
  if (dshPeers.length > 0) ok(`manifest declares ${dshPeers.length} @deepseek-ai/dsh* peer range(s)`)
  else bad('manifest declares no @deepseek-ai/dsh* peerDependencies')

  // Any 0.2.x runtime must survive every declared range. Evaluate the ranges
  // as plain SemVer comparisons so this check needs no semver dependency.
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v))
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : undefined
  }
  // Compare only the numeric bound that each range clause carries; that is
  // enough to catch a ceiling that excludes a whole minor line.
  const upperBoundExcludes = (range, target) => {
    const t = parse(target)
    return range.split('||').every((clause) => {
      const upper = /<\s*(\d+)\.(\d+)\.(\d+)/.exec(clause)
      if (!upper) return false // unbounded clause: cannot exclude
      const u = { major: +upper[1], minor: +upper[2], patch: +upper[3] }
      if (t.major !== u.major) return t.major >= u.major
      if (t.minor !== u.minor) return t.minor >= u.minor
      return t.patch >= u.patch
    })
  }
  for (const version of ['0.2.0', '0.2.0-rc.2', '0.2.5']) {
    const blocked = dshPeers.filter(([, range]) => upperBoundExcludes(range, version)).map(([n]) => n)
    if (blocked.length === 0) ok(`peer ranges admit DSH ${version} (install gate passes)`)
    else bad(`peer ranges REJECT DSH ${version} — \`dsh plugin add\` would hard-fail the install`, blocked.join(', '))
  }
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

console.log('\n=== 4b) ToolDefinition shape matches DSH 0.2.0 contract ===')
{
  // defineTool is the REAL one from the installed dsh-tools, so a definition
  // that survives this block is a definition the registry accepts.
  const probe = registeredTools.find((t) => t.name === 'codegraph_status')
  for (const field of ['name', 'description', 'parameters', 'output', 'execute']) {
    if (probe[field] !== undefined) ok(`definition exposes "${field}"`)
    else bad(`definition missing required DSH field "${field}"`)
  }
  if (typeof probe.execute === 'function') ok('execute is a function')
  else bad('execute must be a function')

  // output.render is the Native projection; in 0.2.0 it receives the RAW call
  // args, which may be malformed. It must not throw and must return blocks.
  try {
    const blocks = probe.output.render({}, 'status-text')
    if (Array.isArray(blocks) && blocks[0]?.type === 'text' && blocks[0].text === 'status-text') {
      ok('output.render returns ContentBlock[] for a plain string value')
    } else {
      bad('output.render should return [{type:"text", text}]', JSON.stringify(blocks))
    }
  } catch (e) {
    bad('output.render threw', null, e.message)
  }
  try {
    const blocks = probe.output.render({}, undefined)
    if (Array.isArray(blocks)) ok('output.render tolerates a non-string value (no throw)')
    else bad('output.render should always return an array')
  } catch (e) {
    bad('output.render must not throw on malformed input', null, e.message)
  }

  // presentCall must return a ToolCallView discriminated by `card`. 0.2.0
  // turned this into a union ('generic' | 'terminal' | 'diff'), so an
  // untagged object would no longer be a valid view.
  try {
    const view = probe.presentCall({})
    if (view && view.card === 'terminal') ok('presentCall returns a tagged terminal ToolCallView (card: "terminal")')
    else bad('presentCall must return a card-tagged view', JSON.stringify(view))
    if (view && typeof view.title === 'string' && view.title.length > 0) ok('terminal view carries a non-empty title (the command line)')
    else bad('terminal view needs a non-empty title')
  } catch (e) {
    bad('presentCall threw', null, e.message)
  }

  // timeoutMs is optional metadata; when declared it must be a positive number.
  const withTimeout = registeredTools.filter((t) => t.timeoutMs !== undefined)
  if (withTimeout.length > 0 && withTimeout.every((t) => typeof t.timeoutMs === 'number' && t.timeoutMs > 0)) {
    ok(`${withTimeout.length} tools declare a positive timeoutMs budget`)
  } else if (withTimeout.length === 0) {
    ok('no tool declares timeoutMs (optional in 0.2.0)')
  } else {
    bad('timeoutMs must be a positive number when declared')
  }
}

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

console.log('\n=== 9b) codegraph_node: a FILE in `path` disambiguates the symbol ===')
try {
  const n = String(await call('codegraph_node', { name: 'multiply', path: 'src/math.ts' }))
  console.log('   node(path=src/math.ts):', n.slice(0, 200))
  if (/Location:\*?\*?\s*src\/math\.ts/.test(n)) ok('file in `path` disambiguated the symbol to that file')
  else bad('a FILE passed as `path` was not used as the file', n.slice(0, 200))
} catch (e) {
  bad('codegraph_node with a file in `path`', null, e.message)
}

console.log('\n=== 9c) codegraph_node: `path` = file, `name` = same file → file read ===')
try {
  const n = String(await call('codegraph_node', { name: 'src/math.ts', path: 'src/math.ts', limit: 3 }))
  console.log('   node(file read):', n.slice(0, 200))
  if (n.includes('export function multiply')) ok('file mode read the requested range')
  else bad('file mode did not read the file', n.slice(0, 200))
} catch (e) {
  bad('codegraph_node file read via `path`', null, e.message)
}

console.log('\n=== 9d) multi-repo workspace: file mode resolves against the owning member ===')
// A symlink-aggregation workspace: the cwd carries no index, its members do.
// `--file` is matched against the MEMBER's own index, so an absolute or
// backslash value never matches — and the CLI reports that on exit code 0, so a
// wrong argv silently answers "No indexed file matches ..." instead of failing.
const memberWs = isWin ? join(tmpdir(), 'cg-member-ws') : '/tmp/cg-member-ws'
const nodeToolFor = () => registeredTools.find((x) => x.name === 'codegraph_node')
try {
  mkdirSync(memberWs, { recursive: true })
  const memberLink = join(memberWs, 'proj')
  if (!existsSync(memberLink)) symlinkSync(sessionCwd, memberLink, isWin ? 'junction' : 'dir')
  const read = String(await nodeToolFor().execute({ name: 'proj/src/math.ts', path: 'proj/src/math.ts', limit: 2 }, makeExec(memberWs)))
  console.log('   member file read:', read.slice(0, 160))
  if (/No indexed file matches|Symbol ".*" not found/.test(read)) bad('member file mode returned the CLI error line as the answer', read.slice(0, 160))
  else if (read.includes('export function multiply')) ok('member file mode read the file through the owning member')
  else bad('member file mode did not read the file', read.slice(0, 160))
} catch (e) {
  bad('multi-repo file mode (file read)', null, e.message)
}
try {
  const sym = String(await nodeToolFor().execute({ name: 'multiply', path: 'proj/src/math.ts' }, makeExec(memberWs)))
  console.log('   member symbol+file:', sym.slice(0, 160))
  if (/No indexed file matches|Symbol ".*" not found/.test(sym)) bad('member symbol mode returned the CLI error line as the answer', sym.slice(0, 160))
  else if (/Location:\s*\**\s*src\/math\.ts/.test(sym)) ok('member symbol mode disambiguated the symbol to the file')
  else bad('member symbol mode did not reach the symbol', sym.slice(0, 160))
} catch (e) {
  bad('multi-repo file mode (symbol + file)', null, e.message)
}

console.log('\n=== 9e) multi-repo workspace: the documented file:true shape, realpath callers, and a stray file ===')
// `file: true` means "the name IS a file path", and callers pass it relative to
// the MEMBER root. Resolving it against the workspace root instead skipped every
// member and returned an empty JSON body.
try {
  mkdirSync(memberWs, { recursive: true })
  if (!existsSync(join(memberWs, 'proj'))) symlinkSync(sessionCwd, join(memberWs, 'proj'), isWin ? 'junction' : 'dir')
  const read = String(await nodeToolFor().execute({ name: 'src/math.ts', file: true, limit: 2 }, makeExec(memberWs)))
  console.log('   file:true (member-relative):', read.slice(0, 160))
  if (read.includes('export function multiply')) ok('file:true with a member-relative name reads the file')
  else bad('file:true with a member-relative name returned no content', read.slice(0, 200))
} catch (e) {
  bad('multi-repo file:true (member-relative)', null, e.message)
}
try {
  // A caller holding the member's REAL path rather than the workspace symlink.
  const real = join(realpathSync(sessionCwd), 'src/math.ts')
  const n = String(await nodeToolFor().execute({ name: 'multiply', path: real }, makeExec(memberWs)))
  console.log('   realpath caller:', n.slice(0, 160))
  if (/Location:\s*\**\s*src\/math\.ts/.test(n)) ok('a realpath caller reaches the owning member')
  else bad('a realpath caller lost the member match', n.slice(0, 200))
} catch (e) {
  bad('multi-repo realpath caller', null, e.message)
}
try {
  // A file in the workspace that no member indexes: say so instead of an empty body.
  writeFileSync(join(memberWs, 'stray.ts'), 'export const stray = 1\n')
  const n = String(await nodeToolFor().execute({ name: 'stray.ts', path: 'stray.ts' }, makeExec(memberWs)))
  console.log('   stray file:', n.slice(0, 160))
  if (/No indexed member repository contains/.test(n)) ok('a file outside every member reports why it has no answer')
  else bad('a file outside every member returned a bare JSON body', n.slice(0, 200))
} catch (e) {
  bad('multi-repo stray file', null, e.message)
}

console.log('\n=== 9f) multi-repo workspace: non-owner member is read FIRST ===')
// Two members, the one that does NOT hold the file read first (readdir order:
// alpha < proj). A non-owner asked for a file answers `No indexed file matches
// "..."` on exit code 0, and the first-answer rule would return that miss line
// as the file's content — so file mode must skip it, not ask it.
const memberWs2 = join(tmpdir(), 'cg-member-ws2')
try {
  ensureVendorProject()
  if (!existsSync(join(vendorCwd, '.codegraph'))) {
    const init = await shellService.run({ command: 'codegraph init', workdir: vendorCwd })
    if (init.exitCode !== 0) bad('could not index the non-owner member fixture', null, init.stderr.text.slice(0, 200))
  }
  mkdirSync(memberWs2, { recursive: true })
  for (const [link, target] of [['alpha', vendorCwd], ['proj', sessionCwd]]) {
    if (!existsSync(join(memberWs2, link))) symlinkSync(target, join(memberWs2, link), isWin ? 'junction' : 'dir')
  }
  const n = String(await nodeToolFor().execute({ name: 'src/math.ts', file: true, limit: 2 }, makeExec(memberWs2)))
  console.log('   file:true (non-owner first):', n.slice(0, 160))
  if (/No indexed file matches|Symbol ".*" not found/.test(n)) bad('a non-owner member answered with its miss line', n.slice(0, 200))
  else if (n.includes('export function multiply')) ok('the owner answers even with a non-owner member read first')
  else bad('file:true returned no content with two members', n.slice(0, 200))
} catch (e) {
  bad('multi-repo file:true (non-owner first)', null, e.message)
}
try {
  // codegraph_files prints member-prefixed paths; file:true must accept that shape.
  const p = String(await nodeToolFor().execute({ name: 'proj/src/math.ts', file: true, limit: 2 }, makeExec(memberWs2)))
  console.log('   file:true (member-prefixed):', p.slice(0, 160))
  if (/No indexed file matches|Symbol ".*" not found/.test(p)) bad('a member-prefixed file path was not resolved', p.slice(0, 200))
  else if (p.includes('export function multiply')) ok('file:true accepts a workspace-relative (member-prefixed) path')
  else bad('file:true did not read the member-prefixed file', p.slice(0, 200))
} catch (e) {
  bad('multi-repo file:true (member-prefixed)', null, e.message)
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

console.log('\n=== 13b) RELATIVE path arg resolves against the session workspace ===')
// The caller only knows the session cwd, so `path: '<rel>'` must mean
// "<session cwd>/<rel>". It must NOT be handed to spawn() as a cwd: spawn
// resolves that against the HOST process's cwd (not the session's), and when
// the directory is missing there the failure surfaces as
// `spawn <codegraph> ENOENT` — which reads exactly like a missing binary.
// This is the regression that shipped as 1.2.2.
try {
  // The fixture nests inside the session project, and the CLI bubbles `status`
  // up to the nearest indexed ancestor, so it needs its own index before it can
  // report itself. Indexing it through a RELATIVE path exercises the same fix
  // on the init path.
  const initOut = String(await call('codegraph_init', { path: REL_PROJECT }))
  console.log('   init(rel):', initOut.slice(0, 160))
  const s = String(await call('codegraph_status', { path: REL_PROJECT }))
  const parsed = JSON.parse(s)
  // Compare RESOLVED paths: the CLI echoes a native (backslash) path on
  // Windows while the fixture is built from POSIX-style pieces.
  if (resolve(parsed.projectPath) === resolve(relProjectDir)) {
    ok('relative path resolved to sessionCwd/<rel>', parsed.projectPath)
  } else {
    bad('relative path did not resolve against the session cwd', `expected ${resolve(relProjectDir)}, got ${parsed.projectPath}`)
  }
  if (isAbsolute(parsed.projectPath)) ok('reported projectPath is absolute')
  else bad('reported projectPath must be absolute', parsed.projectPath)
} catch (e) {
  bad('codegraph_status with RELATIVE path', null, e.message)
}

console.log('\n=== 13c) relative path with NO session cwd (guarded resolve, no TypeError) ===')
// `resolve(undefined, p)` throws a TypeError, so the guarded branch in
// lib/index.js must fall back to resolving against the host cwd. That path is
// supported today — do not regress it into a crash. Address the harness's own
// cwd so the fallback is observable and the directory exists there.
try {
  const t = registeredTools.find((x) => x.name === 'codegraph_status')
  const s = String(await t.execute({ path: '.' }, {
    agent: { session: { header: {} } },
    signal: new AbortController().signal
  }))
  const parsed = JSON.parse(s)
  if (isAbsolute(parsed.projectPath) && resolve(parsed.projectPath) === resolve('.')) {
    ok('no session cwd → relative path resolves against the host cwd', parsed.projectPath)
  } else {
    bad('relative path without session cwd resolved unexpectedly', `got ${parsed.projectPath}`)
  }
} catch (e) {
  bad('relative path without session cwd must still work', null, e.message)
}

console.log('\n=== 13d) a MISSING path errors with the path, not a phantom ENOENT binary ===')
// Resolving the path fixes the silent misdirection only for directories that
// exist. A typo'd name still reaches spawn() as a `cwd`, and Node reports that
// as `spawn <codegraph> ENOENT` — blaming the binary for a directory problem.
// The plugin must name the offending path itself.
try {
  await call('codegraph_status', { path: MISSING_PROJECT })
  bad('missing path must be rejected before spawning', 'call resolved without an error')
} catch (e) {
  const msg = String(e.message || e)
  if (/ENOENT.*spawn|spawn .*ENOENT/.test(msg) === false && msg.includes('does not exist')) {
    ok('missing path reported as a path problem', msg.slice(0, 120))
  } else {
    bad('missing path should name the directory, not the binary', msg)
  }
  if (msg.includes(MISSING_PROJECT)) ok('error message names the offending relative path')
  else bad('error message must quote the path that failed', msg)
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
    // 0.2.0 shape: UserMessage is frozen and carries a merge-extensible source
    // tag. LOAD-BEARING: the kind must NOT be 'user' — the Chat UI prints a
    // kind:'user' message in full as a human bubble, which would paste the
    // whole explore dump into the transcript. Every DSH-native injection uses
    // `plugin:<name>`, so this one collapses into an injected-context row.
    if (steered[0].source && steered[0].source.kind === 'plugin:dsh-codegraph') ok('steered message is tagged plugin:dsh-codegraph (0.2.0 MessageSourceMap shape)')
    else bad('steered message must carry the plugin source kind', JSON.stringify(steered[0].source))
    if (steered[0].source && steered[0].source.kind !== 'user') ok('injected context does not claim source.kind === "user" (renders as collapsed row, not a bubble)')
    else bad('injected context must not be tagged as a user message', JSON.stringify(steered[0].source))
    if (Object.isFrozen(steered[0])) ok('steered message is frozen (0.2.0 createUserMessage freezes before publication)')
    else bad('steered message should be frozen by createUserMessage')
    if (Array.isArray(steered[0].content) && steered[0].content.length > 0) ok('steered message content is a ContentBlock[] array')
    else bad('steered message content must be a non-empty ContentBlock array')
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

console.log('\n=== 22b) frontload: a vendored-only explore result is dropped, never injected ===')
{
  ensureVendorProject()
  // Index through the shell service (cmd.exe), not the subprocess service:
  // the npm shim only resolves its native platform bundle when launched
  // through a shell, and `init` is the one command that needs it.
  if (!existsSync(join(vendorCwd, '.codegraph'))) {
    const init = await shellService.run({ command: 'codegraph init', workdir: vendorCwd })
    if (init.exitCode !== 0) bad('could not index the vendor fixture', null, init.stderr.text.slice(0, 200))
  }
  // Prove the fixture still reproduces the bad shape through the SAME channel
  // the front-load uses — else a green result here would only mean explore
  // failed and the gate never ran.
  let probe = ''
  try {
    probe = String(await call('codegraph_explore', { path: vendorCwd, query: 'asio path' }))
  } catch (e) {
    probe = `THREW: ${e.message}`
  }
  if (/3rdparty\//.test(probe)) ok('fixture: explore answers with 3rdparty symbols only')
  else bad('vendor fixture did not produce a vendored explore result', probe.slice(0, 160))

  const { agent, message, steered } = makeAgent(vendorCwd, 'asio path 的调用流程是怎样的？', 'fl-6')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 60000)
  if (!fired) ok('vendored-only explore result is dropped (no negative sample injected)')
  else bad('vendor-dominated explore result must NOT be injected', steered[0].content[0].text.slice(0, 140))
}

console.log('\n=== 22c) frontload: @-refs and filesystem paths stripped from the query ===')
{
  // The query is what explores the index. Handing it `@C:\…\itx_helper.log`
  // searches for whatever symbol is named `path`; stripping the scaffolding
  // leaves the code-shaped residue the index can actually answer.
  const prompt = '看下 @C:\\Users\\Administrator\\Desktop\\log\\itx_helper.log 里说的 multiply 调用流程是怎样的？'
  const { agent, message, steered } = makeAgent(sessionCwd, prompt, 'fl-7')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a path-laden structural prompt should still front-load')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('multiply')) ok('query survived sanitization and hit the index')
    else bad('sanitized query lost the code term', text.slice(0, 120))
    if (!/itx_helper\.log|Administrator/.test(text)) ok('no log path leaked into the injected query')
    else bad('prompt paths leaked into the explore query', text.slice(0, 160))
  }
}

console.log('\n=== 22d) frontload: a prose word is not a symbol (no fuzzy verification) ===')
{
  // `codegraph query Edge` returns `edgeCache` — a substring hit. Counting any
  // non-empty result as verified is how a prompt full of ordinary words fired
  // the injection and produced a dump the agent threw away. Same-name only.
  const sync = await shellService.run({ command: 'codegraph sync', workdir: sessionCwd })
  if (sync.exitCode !== 0) bad('could not sync the fixture index', null, sync.stderr.text.slice(0, 160))
  const { agent, message, steered } = makeAgent(sessionCwd, 'Desktop 上的 Edge 打不开 webcodez.com，帮我看看', 'fl-8')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) ok('a prose word that only fuzzy-matches a symbol does not fire')
  else bad('fuzzy match must not count as verification', steered[0].content[0].text.slice(0, 120))
}

console.log('\n=== 22e) frontload: an exact symbol name still fires (medium tier) ===')
{
  const { agent, message, steered } = makeAgent(sessionCwd, 'processor_euid 是从哪来的', 'fl-9')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('an exact symbol name must still fire the medium tier')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('processor_euid')) ok('exact symbol name fires and reaches the source')
    else bad('injected query lost the symbol', text.slice(0, 120))
  }
}

console.log('\n=== 22f) frontload: a bare `/` is not a path — the token after it survives ===')
{
  // `提交/processor_euid`: the `/` separates two words, it does not start a
  // path. A path-stripper that eats it leaves `提交` (no keyword, no token) and
  // the prompt silently stops firing.
  const { agent, message, steered } = makeAgent(sessionCwd, '提交/processor_euid 是谁写的', 'fl-10')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a `/` in ordinary wording must not swallow the symbol after it')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('processor_euid')) ok('token after a bare `/` survives sanitization')
    else bad('token after a bare `/` was stripped', text.slice(0, 120))
  }
}

console.log('\n=== 22g) frontload: `/lib/` mid-token is not a system root ===')
{
  // `src/lib/utils.ts` must survive as a file token. Stripping `/lib/` mid-token
  // leaves `src 的调用流程` — a query that matches 21 unrelated symbols instead
  // of the file the user named.
  const { agent, message, steered } = makeAgent(sessionCwd, 'src/lib/utils.ts 的调用流程', 'fl-11')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a relative path under src/lib/ must still fire')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('utils.ts')) ok('file token under src/lib/ survives sanitization')
    else bad('src/lib/utils.ts was degraded', text.slice(0, 140))
  }
}

console.log('\n=== 22h) frontload: an @-ref keeps its file NAME (explore pins it) ===')
{
  // DSH's most common shape. The basename must survive: explore pins a file
  // from the query (`1 file pinned from the query`) and hands back real source.
  // Stripping the whole ref leaves `调用流程`, which explores to nothing.
  const { agent, message, steered } = makeAgent(sessionCwd, '@src/math.ts 调用流程', 'fl-12')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('an @-ref path must not be stripped down to nothing')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('math.ts')) ok('@-ref keeps its file name and the pin lands')
    else bad('@-ref lost the file name', text.slice(0, 140))
  }
}

console.log('\n=== 22i) frontload: a no-hit explore is dropped, not injected ===')
{
  // explore exits 0 with a `No relevant code found …` explainer. Steering that
  // into the turn is the same negative sample as a vendored dump.
  const { agent, message, steered } = makeAgent(sessionCwd, 'zzzqqq 的调用流程', 'fl-13')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) ok('no-hit explore result is dropped')
  else bad('a `No relevant code found` body must not be injected', steered[0].content[0].text.slice(0, 140))
}

console.log('\n=== 22j) frontload: a path flush against Chinese text is still a path ===')
{
  // `日志在C:\proj\src\math.ts` has no space before the drive letter. An
  // ASCII-only word boundary leaves the whole path in the query.
  const { agent, message, steered } = makeAgent(sessionCwd, '日志在C:\\proj\\src\\math.ts 里 multiply 为什么错', 'fl-14')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a path flush against Chinese text must still be sanitized')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (!/C:\\\\?proj/.test(text)) ok('the directory prefix is gone')
    else bad('a CJK-adjacent path leaked into the query', text.slice(0, 160))
    if (text.includes('math.ts')) ok('its file name survives')
    else bad('the CJK-adjacent path lost its file name', text.slice(0, 140))
  }
}

console.log('\n=== 22k) frontload: an @-ref file still verifies in the medium tier ===')
{
  // No structural keyword here: the gate has to verify `math.ts` against the
  // index. The file token is what makes that possible.
  const { agent, message, steered } = makeAgent(sessionCwd, '@src/math.ts 这里有问题', 'fl-15')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (fired) ok('file token from an @-ref verifies and fires')
  else bad('an @-ref file token must still verify in the medium tier')
}

console.log('\n=== 22l) frontload: trailing punctuation does not swallow the basename ===')
{
  // `、` after the path used to be eaten as path text, so the basename failed
  // CODE_EXT_RE and `math.ts` — plus the `multiply` after it — vanished.
  const { agent, message, steered } = makeAgent(sessionCwd, '日志在C:\\proj\\src\\math.ts、multiply 为什么错', 'fl-16')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a path followed by `、` must still fire')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('math.ts')) ok('basename survives trailing punctuation')
    else bad('trailing punctuation swallowed the basename', text.slice(0, 140))
    if (text.includes('multiply')) ok('the word after the punctuation survives')
    else bad('the word after the punctuation was swallowed', text.slice(0, 140))
  }
}

console.log('\n=== 22m) frontload: a bare @-ref to a non-code file is dropped ===')
{
  // `@itx_helper.log` has no drive letter, so only the ref branch sees it. The
  // prompt still names a real symbol so this fires either way — what must NOT
  // reach the turn is the `**Not in the index:** itx_helper.log` opening.
  const { agent, message, steered } = makeAgent(sessionCwd, '@itx_helper.log multiply 的调用流程', 'fl-17')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('the real symbol in the prompt must still fire')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (!text.includes('itx_helper.log')) ok('non-code @-ref is dropped')
    else bad('a non-code @-ref leaked into the query', text.slice(0, 160))
  }
}

console.log('\n=== 22n) frontload: a bare `@word` is not a file reference ===')
{
  // `@Autowired` / `@Override` / `@types/node` are decorators, annotations and
  // package scopes — real lexical search terms. Only the `@` goes.
  const { agent, message, steered } = makeAgent(sessionCwd, '为什么 @Autowired multiply 注入失败', 'fl-18')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a prompt naming a real symbol must still fire')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('Autowired')) ok('the bare `@word` keeps its word')
    else bad('a bare `@word` was deleted instead of just the `@`', text.slice(0, 140))
  }
}

console.log('\n=== 22o) frontload: a sentence-ending `.` after a path is trimmed ===')
{
  // `@src/math.ts.` — the `.` is kept for the extension, so a second trim is
  // needed or the basename is `math.ts.` and matches no extension at all.
  const { agent, message, steered } = makeAgent(sessionCwd, '看 @src/math.ts. 为什么', 'fl-19')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a trailing `.` must not swallow the file name')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('math.ts')) ok('basename survives a trailing `.`')
    else bad('trailing `.` swallowed the basename', text.slice(0, 140))
  }
}

console.log('\n=== 22p) frontload: UNC paths stop at punctuation too ===')
{
  const { agent, message, steered } = makeAgent(sessionCwd, '\\\\srv\\share\\src\\math.ts、multiply 为什么错', 'fl-20')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a UNC path followed by `、` must still fire')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('math.ts')) ok('UNC basename survives')
    else bad('UNC path lost its basename', text.slice(0, 140))
    if (text.includes('multiply')) ok('the word after the UNC punctuation survives')
    else bad('the word after the UNC punctuation was swallowed', text.slice(0, 140))
  }
}

console.log('\n=== 22q) frontload: a bare `@word` with a trailing `.` keeps its word ===')
{
  // `@Override.` is the bare word plus sentence punctuation, not a filename
  // that happens to contain a `.`. Judging barenness on the trimmed token is
  // what keeps it from falling into the file branch and being dropped.
  const { agent, message, steered } = makeAgent(sessionCwd, '为什么 @Override. 没生效', 'fl-21')
  for (const h of frontloadHandlers) h.handler({ agent, message })
  const fired = await waitForSteer(steered, 45000)
  if (!fired) {
    bad('a bare `@word.` must still fire')
  } else {
    const text = steered[0].content.map((b) => b.text).join('\n')
    if (text.includes('Override')) ok('bare `@word.` keeps its word')
    else bad('trailing `.` still deleted the bare word', text.slice(0, 140))
  }
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
