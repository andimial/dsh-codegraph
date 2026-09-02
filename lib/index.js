// dsh-codegraph — CodeGraph for DSH (standalone, installable DSH plugin)
//
// Registers native model tools wrapping the `codegraph` CLI
// (@colbymchenry/codegraph). The agent can bootstrap a project's
// pre-indexed code knowledge graph (`.codegraph/`), maintain it (index/sync),
// and query it (query/node/explore/files/callers/callees/impact/affected)
// without grepping through files.
//
// Tool surface (config `surface`, default 'core'): following the upstream
// project's adoption finding — "codegraph_explore is the single tool that
// reliably earns its place" (its MCP server exposes ONLY explore by default)
// — the core surface registers just 4 tools: status/init/sync (bootstrap and
// maintain the index) + explore (the one query tool that answers most code
// questions in a single call). `surface: 'full'` restores all 13 tools.
//
// Prompt front-load (config `frontload`, default true): the upstream
// prompt-hook's DSH equivalent. Listens for user prompts entering an agent's
// inbox, and for structural/flow prompts against an indexed project, pre-runs
// codegraph_explore and steers the result into the turn as
// <codegraph_context> — the agent's grep/read reflex has nothing left to
// find. Every failure path is a silent no-op.
//
// Why a native plugin instead of a plain MCP server: codegraph's MCP server
// exposes ZERO tools while the workspace is unindexed (and tells the agent it
// should not index itself). This plugin always exposes the tools, including
// the init/index/sync ones the model needs to bootstrap and maintain the
// index. Tool names match CodeGraph's official MCP tool names so the model's
// mental model stays consistent with the official docs.
//
// Export shape: namespace plugin (named exports, no default) — the same shape
// as @deepseek-ai/dsh-tool-cordis and the other @local/* static plugins.
// `defineTool` resolves from `@deepseek-ai/dsh-tools`, declared as a normal
// dependency and installed by pnpm alongside this package.
//
// Execution: prefers the `subprocess` service (argv spawn, no quoting hazards),
// falls back to the `shell` service (bash). Both are read LAZILY via ctx.get
// at each tool call — never at apply time. Cordis makes no mount-order
// guarantee between sibling plugins, so an apply-time check races the
// executor's own mount and can fail the whole plugin tree at boot (observed
// in the wild: intermittent "neither subprocess nor shell mounted" boot
// crashes). Lazy resolution also lets the tools start working if an executor
// mounts after this plugin. The `codegraph` executable must be on PATH (e.g.
// global `npm i -g @colbymchenry/codegraph` or the npm thin shim); a clearer
// error is thrown when it is missing. On Windows, PATH resolution lands on
// npm's .cmd shim, which the subprocess service cannot spawn without a shell
// (spawn EINVAL, Node >= 24 CVE-2024-27980 hardening) — so the shim's
// embedded Node entry is re-executed through node.exe instead (see
// winShimEntry below).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-codegraph'

export const inject = ['tools', 'systemPrompt']

// Plugin config.
// - guideSearch (default true): when set, a high-priority system-prompt
//   section tells the model to reach for codegraph_* before grep/glob/read
//   for code search. Set false (e.g. in cordis.patch.yml) to register the
//   tools without that guidance.
// - surface (default 'core'): which tools to register. 'core' registers only
//   status/init/sync/explore — the minimal set that bootstraps the index and
//   answers most code questions in one call, mirroring the upstream MCP
//   server which exposes codegraph_explore ALONE by default. 'full'
//   registers all 13 tools.
// - frontload (default true): the upstream prompt-hook equivalent. Listens
//   for user prompts entering an agent's inbox, and for structural/flow
//   prompts against an indexed project, runs codegraph_explore up front and
//   steers the result into the turn as <codegraph_context> — so the agent's
//   grep/read reflex has nothing left to find. Every failure path is a
//   silent no-op; it never breaks or blocks the user's prompt.
export const Config = z.object({
  guideSearch: z.boolean().default(true),
  surface: z.union([z.const('core'), z.const('full')]).default('core'),
  frontload: z.boolean().default(true)
})

// System-prompt guidance that makes the codegraph tools preferred for code
// search. Rendered at order 98 — before the built-in tool block (read=100,
// write=101, edit=102, glob=103, grep=104) — so the model sees "reach for
// codegraph_* first" for searching/exploring code, before it reaches for
// grep/glob/read. Lower order = earlier in the assembled prompt.
//
// Wording follows the upstream project's MCP server instructions
// (src/mcp/server-instructions.ts): imperative ("MUST use INSTEAD of"),
// explicit anti-patterns, and a hard stop rule for unindexed projects. A
// soft "Prefer ..." phrasing measurably gets ignored — the model falls back
// to its grep/bash reflex. Only names tools on the CORE surface, so the
// guidance stays accurate under the default config.
const CODEGRAPH_GUIDE = `# CodeGraph — pre-indexed code knowledge graph

CodeGraph is a pre-computed graph of every symbol and call edge in the project — structure you would otherwise re-derive by reading files. When the current project is indexed (a \`.codegraph/\` directory at the project root; confirm once with codegraph_status), you MUST use codegraph_explore INSTEAD of grep/glob/read to find or understand code:
- Call codegraph_explore BEFORE any grep/glob/read whenever you need to locate a symbol, understand a flow, or read code you can name. One call returns the relevant symbols' verbatim, line-numbered source (safe to edit from) plus the call paths between them — including dynamic-dispatch hops grep can't follow. Name files or symbols in the query.
- If codegraph_status reports initialized:false and the task needs code search, run codegraph_init once (requires the codegraph CLI on PATH), then use codegraph_explore.
- After editing source files, run codegraph_sync so later codegraph_explore calls reflect the new code.

Anti-patterns — do NOT:
- grep/glob first "to find the files": that repeats work the index already did, in dozens of round-trips instead of one call.
- re-verify codegraph results with grep: they come from a full AST parse.
- keep calling codegraph tools after one reports the project is not indexed and you did not initialize it: stop calling them for the rest of the session and use the built-in tools instead. Indexing is the user's decision.`

// ---- helpers ---------------------------------------------------------------

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max) + '\n... [truncated] ...'
}

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function executableHint() {
  return '`codegraph` was not found on PATH. Install it once, e.g. `npm i -g @colbymchenry/codegraph` (or use the official install.sh / npm thin shim), then retry.'
}

// Windows npm-global CLI shims are .cmd/.bat wrappers. The subprocess service
// spawns argv directly with no shell, and Node >= 24 refuses to spawn a .cmd
// without one (CVE-2024-27980 hardening — `spawn EINVAL`). The npm shim's body
// embeds its real entry: `"%dp0%\node_modules\<pkg>\<bin>.js" %*` — so bridge
// by running that Node entry through node.exe (a real PE executable the
// service CAN spawn). codegraph's npm-shim.js then re-execs its bundled Node
// internally, so the PATH node only needs to be able to run the shim.
const NPM_SHIM_TARGET_RE = /"%dp0%\\([^"]+\.js)"/
function winShimEntry(shimPath) {
  try {
    const match = NPM_SHIM_TARGET_RE.exec(readFileSync(shimPath, 'utf8'))
    if (!match) return undefined
    return join(dirname(shimPath), match[1].replace(/\//g, sep))
  } catch {
    return undefined
  }
}

// The core tool surface (see Config.surface): the index bootstrap/maintenance
// tools plus explore — the one query tool that answers most code questions in
// a single call. Everything else (query/node/files/callers/callees/impact/
// affected/index/uninit) is registered only under surface: 'full'.
const CORE_TOOLS = new Set([
  'codegraph_status',
  'codegraph_init',
  'codegraph_sync',
  'codegraph_explore'
])

// ---- prompt front-load (upstream prompt-hook equivalent) --------------------

// Marker fencing our injected context, so the gate never re-triggers on its
// own output.
const FRONTLOAD_MARKER = '<codegraph_context'

// Structural keywords (EN + zh) signalling a code-structure/flow question —
// the HIGH-confidence gate tier: fire explore without further verification.
const STRUCTURAL_KEYWORDS = [
  // English
  'how does', 'where is', 'where are', 'who calls', 'callers of', 'callees',
  'call flow', 'architecture', 'refactor', 'impact of', 'dependency graph',
  'trace', 'entry point', 'lifecycle', 'inheritance',
  // 中文
  '调用', '流程', '原理', '怎么实现', '如何实现', '哪里', '哪些文件', '哪些类',
  '哪些函数', '重构', '影响', '依赖', '入口', '链路', '架构', '源码'
]

// Code-shaped token candidates (the MEDIUM tier): file names with a code
// extension, camelCase, PascalCase, snake_case. A candidate only fires the
// injection after verification against the index (a real symbol with that
// name exists), so prose that merely looks like code stays a no-op.
const CODE_TOKEN_RE = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|kt|kts|java|py|go|rs|swift|vue|ets|cs|rb|php|c|cc|cpp|h|hpp)\b|[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|[A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g

function extractCodeTokens(text) {
  const tokens = new Set()
  let m
  CODE_TOKEN_RE.lastIndex = 0
  while ((m = CODE_TOKEN_RE.exec(text)) !== null) tokens.add(m[0])
  return [...tokens].slice(0, 5)
}

// Nearest indexed ancestor: the project root is the closest directory at or
// above the session cwd that carries a `.codegraph/` index. Unindexed → the
// hook is a no-op; indexing is the user's decision.
function findIndexRoot(cwd) {
  let dir = cwd
  for (let i = 0; i < 12 && dir; i++) {
    if (existsSync(join(dir, '.codegraph'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

// ---- plugin ---------------------------------------------------------------

export function apply(ctx, config = {}) {
  const tools = ctx.tools
  const { guideSearch = true, surface = 'core', frontload = true } = config
  const toolEnabled = (name) => surface === 'full' || CORE_TOOLS.has(name)

  // Make the codegraph_* tools the preferred route for code search: instruct
  // the model BEFORE the built-in grep/glob/read guidance (order < 100) to
  // reach for the indexed graph first. This is how the tools become the
  // "first to invoke" once the plugin is installed, with no per-session setup.
  // Adjustable via the `guideSearch` config option (default true).
  if (guideSearch !== false) {
    ctx.systemPrompt.section({
      name: 'tool:codegraph',
      order: 98,
      text: CODEGRAPH_GUIDE
    })
  }

  // NOTE: the subprocess/shell executors are resolved lazily inside
  // runCodegraph — see the header comment for why an apply-time check races
  // the executor's mount and can crash the whole plugin tree at boot.

  const resolvedExe = { value: null }
  const resolvedNode = { value: null } // Windows bridge: node.exe running the shim's Node entry

  const cwdOf = (exec) => {
    const agent = exec && exec.agent
    const header = agent && agent.session && agent.session.header
    return header && header.cwd ? header.cwd : undefined
  }

  async function runCodegraph({ argv, cwd, signal, timeoutMs }) {
    // Lazy executor resolution: re-read on every call so mount order does not
    // matter and a late-mounting executor still becomes usable.
    const sub = ctx.get('subprocess')
    const shell = ctx.get('shell')
    if (sub === undefined && shell === undefined) {
      throw new Error(
        'dsh-codegraph: neither the subprocess nor the shell service is mounted. ' +
        'Enable a bash/subprocess executor (e.g. dsh-bash-local) so the codegraph CLI can run.'
      )
    }
    if (sub !== undefined) {
      if (resolvedExe.value === null) {
        try {
          resolvedExe.value = await sub.resolveExecutable('codegraph')
        } catch {
          throw new Error('dsh-codegraph: ' + executableHint())
        }
      }
      let program = resolvedExe.value
      let args = argv
      // Windows: resolveExecutable follows PATHEXT and lands on npm's .cmd
      // shim, which cannot be spawned without a shell (`spawn EINVAL` on
      // Node >= 24). Re-exec the shim's embedded Node entry via node.exe.
      if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program)) {
        const entry = winShimEntry(program)
        if (!entry || !existsSync(entry)) {
          throw new Error(
            'dsh-codegraph: cannot run the Windows command shim ' + program +
            ' (its Node entry could not be located). Install codegraph via the standalone ' +
            'installer (install.sh) for a real executable, or reinstall `npm i -g @colbymchenry/codegraph`.'
          )
        }
        if (resolvedNode.value === null) {
          resolvedNode.value = await sub.resolveExecutable('node')
        }
        program = resolvedNode.value
        args = [entry].concat(argv)
      }
      const proc = sub.spawn({
        argv: [program].concat(args),
        cwd: cwd || '/',
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 8 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } },
          stderr: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 64 * 1024 * 1024 } }
        },
        graceMs: 2000,
        signal: signal
      })
      const outcome = await proc.done
      const out = proc.collected.stdout ? proc.collected.stdout.readFrom(0) : undefined
      const err = proc.collected.stderr ? proc.collected.stderr.readFrom(0) : undefined
      const text = stripAnsi(out ? out.text : '')
      const errText = stripAnsi(err ? err.text : '')
      if (outcome.exitCode !== 0) {
        const detail = errText && errText.trim() ? errText.trim() : text && text.trim()
        throw new Error(detail ? `codegraph exited ${outcome.exitCode}: ${truncate(detail, 2000)}` : `codegraph exited ${outcome.exitCode}`)
      }
      return text
    }
    const command = 'codegraph ' + argv.map(shQuote).join(' ')
    const spec = shell.resolve({
      command,
      workdir: cwd || '/',
      timeoutMs: timeoutMs || 120000,
      signal,
      stdoutMaxBytes: 8 * 1024 * 1024
    })
    const result = await shell.run(spec)
    const text = stripAnsi(result.stdout ? result.stdout.text : '')
    const errText = stripAnsi(result.stderr ? result.stderr.text : '')
    if (result.exitCode !== 0) {
      const detail = errText && errText.trim() ? errText.trim() : text && text.trim()
      if (result.exitCode === 127) {
        throw new Error('dsh-codegraph: ' + executableHint())
      }
      throw new Error(detail ? `codegraph exited ${result.exitCode}: ${truncate(detail, 2000)}` : `codegraph exited ${result.exitCode}`)
    }
    return text
  }

  function registerTool(name, description, parameters, buildArgv, opts) {
    // Surface gating: tools outside the configured surface are skipped, so
    // the default 'core' surface keeps the model-facing tool list small.
    if (!toolEnabled(name)) return
    opts = opts || {}
    const tool = defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }]
      },
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const base = cwdOf(exec)
        const projectRoot = typeof args.path === 'string' && args.path.length > 0 ? args.path : base
        if (!projectRoot) {
          throw new Error('codegraph: no session workspace (cwd) available; pass the project path explicitly via the `path` argument.')
        }
        const argv = buildArgv(args, projectRoot)
        const out = await runCodegraph({ argv, cwd: projectRoot, signal: exec.signal, timeoutMs: opts.timeoutMs })
        return truncate(out, 200000)
      },
      presentCall: (args) => ({
        card: 'terminal',
        title: 'codegraph ' + argvPreview(buildArgv(args, '<project>')),
        description: opts.callDescription
      })
    })
    // tools.register is already fiber-aware (layers.effect): no extra ctx.effect wrap.
    tools.register(tool)
  }

  function argvPreview(argv) {
    const preview = argv
      .map((a) => (a === '<project>' || a === '/' || String(a).startsWith('/')) ? a : JSON.stringify(a))
      .join(' ')
    return preview.length > 120 ? preview.slice(0, 120) + '…' : preview
  }

  // ---- index maintenance ----------------------------------------------------

  registerTool(
    'codegraph_status',
    'Show the CodeGraph index status for a project as JSON (initialized, version, projectPath, lastIndexed, fileCount, nodeCount, pendingChanges, languages). Run this first to check whether a project is indexed before using other codegraph tools. If the project is not initialized, run codegraph_init.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' }
    },
    (args, root) => ['status', '--json', root],
    { callDescription: 'Show CodeGraph index status' }
  )

  registerTool(
    'codegraph_init',
    'Initialize CodeGraph in a project directory and build the initial index. Run this once per project before querying with codegraph_query/node/explore. Creates a .codegraph/ directory. Optional force flag to initialize even if the path looks like a home or filesystem root.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      force: { type: 'boolean', description: 'Initialize even if the path looks like the home directory or a filesystem root.' }
    },
    (args, root) => ['init'].concat(args.force ? ['--force'] : []).concat([root]),
    { timeoutMs: 600000, callDescription: 'Initialize the CodeGraph index' }
  )

  registerTool(
    'codegraph_index',
    'Index (or re-index) all files in the project. Use after large changes or when codegraph_status reports reindexRecommended. Supports force to force a full re-index.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      force: { type: 'boolean', description: 'Force a full re-index even if already indexed.' }
    },
    (args, root) => ['index'].concat(args.force ? ['--force'] : []).concat([root]),
    { timeoutMs: 600000, callDescription: '(Re)index the project' }
  )

  registerTool(
    'codegraph_sync',
    'Incrementally sync the index with changes since the last index. Run after editing a file so queries reflect the new code.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' }
    },
    (args, root) => ['sync', root],
    { timeoutMs: 300000, callDescription: 'Sync the CodeGraph index' }
  )

  registerTool(
    'codegraph_uninit',
    'Remove CodeGraph from a project by deleting its .codegraph/ directory. Use only when the index is no longer needed.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' }
    },
    (args, root) => ['uninit', '--force', root],
    { timeoutMs: 120000, callDescription: 'Remove the CodeGraph index' }
  )

  // ---- query & exploration ----------------------------------------------------

  registerTool(
    'codegraph_query',
    'Search symbols in the codebase by name/query and return matching nodes as JSON (node kind, name, signature, filePath, startLine, score). Use to locate a symbol before diving into its source with codegraph_node. Requires an initialized project (run codegraph_init first).',
    {
      search: { type: 'string', required: true, description: 'Symbol name or partial name to search for (e.g. "multiply", "fetchUser").' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      limit: { type: 'integer', description: 'Maximum results (default 10).' },
      kind: { type: 'string', description: 'Filter by node kind (function, class, interface, import, file, etc.).' }
    },
    (args, root) => ['query', '--json', '--path', root, '-l', String(args.limit || 10)].concat(args.kind ? ['-k', args.kind] : []).concat([args.search]),
    { callDescription: 'Search symbols in the codebase' }
  )

  registerTool(
    'codegraph_node',
    'Get one symbol\'s source with its caller/callee trail, or read a file with line numbers and its dependents. Pass a symbol name for symbol mode; pass a file path (or set file: true) for file mode. In file mode, offset/limit read a range with line numbers and symbols-only omits the code. Requires an initialized project.',
    {
      name: { type: 'string', required: true, description: 'A symbol name (e.g. multiply) or a file path (e.g. src/math.ts).' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      file: { type: 'boolean', description: 'Treat the name as a file path (disambiguate a symbol to this file).' },
      offset: { type: 'integer', description: 'File mode: 1-based start line.' },
      limit: { type: 'integer', description: 'File mode: maximum lines.' },
      symbolsOnly: { type: 'boolean', description: 'File mode: only the symbol map + dependents, no source.' }
    },
    (args, root) => {
      const argv = ['node', '--path', root]
      if (args.file) argv.push('--file', args.name)
      if (args.offset) argv.push('--offset', String(args.offset))
      if (args.limit) argv.push('--limit', String(args.limit))
      if (args.symbolsOnly) argv.push('--symbols-only')
      argv.push(args.name)
      return argv
    },
    { timeoutMs: 60000, callDescription: 'Show a symbol or file with its trail' }
  )

  registerTool(
    'codegraph_explore',
    'Explore an area of the codebase: relevant symbols\' verbatim source plus call paths in one shot. Give a natural-language description of the area you want (e.g. "user authentication flow"). Returns source of the most relevant files so you do not need to Read them. Requires an initialized project.',
    {
      query: { type: 'string', required: true, description: 'Natural-language area description, e.g. "payment checkout flow".' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      maxFiles: { type: 'integer', description: 'Maximum number of files to include source from.' }
    },
    (args, root) => ['explore', '--path', root].concat(args.maxFiles ? ['--max-files', String(args.maxFiles)] : []).concat([args.query]),
    { timeoutMs: 60000, callDescription: 'Explore a code area with source + call paths' }
  )

  registerTool(
    'codegraph_files',
    'Show the project file structure from the index as JSON (paths, languages, symbol counts). Supports filtering by directory, glob pattern, and tree/flat/grouped formats. Requires an initialized project.',
    {
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      filter: { type: 'string', description: 'Only files under this directory.' },
      pattern: { type: 'string', description: 'Only files matching this glob (e.g. "src/**/*.ts").' },
      format: { type: 'string', description: 'Output format: tree, flat, or grouped.' },
      maxDepth: { type: 'integer', description: 'Maximum directory depth for the tree format.' },
      noMetadata: { type: 'boolean', description: 'Hide file metadata (language, symbol count).' }
    },
    (args, root) => {
      const argv = ['files', '--json', '--path', root]
      if (args.filter) argv.push('--filter', args.filter)
      if (args.pattern) argv.push('--pattern', args.pattern)
      if (args.format) argv.push('--format', args.format)
      if (args.maxDepth) argv.push('--max-depth', String(args.maxDepth))
      if (args.noMetadata) argv.push('--no-metadata')
      return argv
    },
    { callDescription: 'Show the indexed file structure' }
  )

  // ---- relations --------------------------------------------------------------

  registerTool(
    'codegraph_callers',
    'Find all functions/methods that call a specific symbol. Returns JSON callers with name, kind, filePath, startLine. Useful to assess what would be affected by changing a function. Requires an initialized project.',
    {
      symbol: { type: 'string', required: true, description: 'The symbol to find callers for.' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      limit: { type: 'integer', description: 'Maximum results (default 20).' }
    },
    (args, root) => ['callers', '--json', '--path', root, '-l', String(args.limit || 20), args.symbol],
    { callDescription: 'Find callers of a symbol' }
  )

  registerTool(
    'codegraph_callees',
    'Find all functions/methods that a specific symbol calls. Returns JSON callees with name, kind, filePath, startLine. Useful to understand what a function depends on. Requires an initialized project.',
    {
      symbol: { type: 'string', required: true, description: 'The symbol to find callees for.' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      limit: { type: 'integer', description: 'Maximum results (default 20).' }
    },
    (args, root) => ['callees', '--json', '--path', root, '-l', String(args.limit || 20), args.symbol],
    { callDescription: 'Find callees of a symbol' }
  )

  registerTool(
    'codegraph_impact',
    'Analyze what code is affected by changing a symbol. Returns JSON with the affected nodes traversed up to a depth. Use before refactoring or renaming. Requires an initialized project.',
    {
      symbol: { type: 'string', required: true, description: 'The symbol to analyze impact for.' },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      depth: { type: 'integer', description: 'Traversal depth (default 2).' }
    },
    (args, root) => ['impact', '--json', '--path', root, '-d', String(args.depth || 2), args.symbol],
    { callDescription: 'Analyze impact of changing a symbol' }
  )

  registerTool(
    'codegraph_affected',
    'Find test files affected by changed source files. Pass one or more changed source paths; returns JSON changedFiles + affectedTests. Use after modifying code to know which tests to run. Requires an initialized project.',
    {
      files: {
        type: 'array',
        required: true,
        description: 'Changed source file paths (relative to the project root), e.g. ["src/math.ts"].',
        items: { type: 'string' }
      },
      path: { type: 'string', description: 'Project directory (default: the current session workspace).' },
      depth: { type: 'integer', description: 'Max dependency traversal depth (default 5).' },
      filter: { type: 'string', description: 'Custom glob filter for test files (e.g. "e2e/*.spec.ts").' }
    },
    (args, root) => ['affected', '--json', '--path', root, '-d', String(args.depth || 5)].concat(args.filter ? ['--filter', args.filter] : []).concat(args.files),
    { callDescription: 'Find affected test files' }
  )

  // ---- prompt front-load listener ------------------------------------------
  //
  // The upstream project's validated adoption lever: a UserPromptSubmit hook
  // that pre-runs codegraph_explore and injects the result into the prompt,
  // "so the agent's reflex grep/read has nothing left to find". The DSH
  // equivalent: listen for user prompts entering an agent's next-turn inbox,
  // gate, then steer the explore result into the turn as context.
  //
  // LOAD-BEARING: this must NEVER break the user's prompt. Every failure
  // path — unindexed project, non-structural prompt, CLI error — is a silent
  // no-op. The only effect is additive context when we can confidently
  // provide it.
  if (frontload !== false) {
    // Dedup: the same prompt text can legitimately enter the next-turn inbox
    // more than once within a turn — the GUI re-sends a queued message on
    // retry, and a rejected step can re-park it. Each arrival is a fresh
    // message id, so id-based guards don't catch it. Without a content
    // window, every re-send injects a duplicate 10KB <codegraph_context>
    // (observed in the wild: one prompt, two injections). Keyed per agent,
    // expired after 10 minutes so a genuinely re-asked question later still
    // front-loads.
    const FRONTLOAD_DEDUP_MS = 10 * 60 * 1000
    const frontloadedByAgent = new Map() // agentId -> Map<text, timestamp>
    const alreadyFrontloaded = (agentId, text) => {
      let seen = frontloadedByAgent.get(agentId)
      if (!seen) {
        seen = new Map()
        frontloadedByAgent.set(agentId, seen)
      }
      const now = Date.now()
      for (const [t, ts] of seen) if (now - ts > FRONTLOAD_DEDUP_MS) seen.delete(t)
      if (seen.has(text)) return true
      seen.set(text, now)
      if (seen.size > 20) seen.delete(seen.keys().next().value)
      return false
    }

    const maybeFrontload = async (agent, message) => {
      // Only genuine user prompts entering the next-turn boundary. This also
      // excludes our own steered injections (they land in next-step) and any
      // rpc/system-sourced messages.
      if (!message || message.role !== 'user') return
      if (message.source && message.source.kind !== 'user') return
      if (!agent || !agent.inbox || !Array.isArray(agent.inbox.nextTurn)) return
      if (!agent.inbox.nextTurn.some((c) => c && c.id === message.id)) return

      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text.length < 8 || text.includes(FRONTLOAD_MARKER)) return
      if (alreadyFrontloaded(String(agent.id || ''), text)) return

      const header = agent.session && agent.session.header
      const cwd = header && header.cwd
      if (!cwd) return
      const root = findIndexRoot(cwd)
      if (!root) return // not indexed — indexing is the user's decision

      // Gate, tiered by confidence (mirrors the upstream prompt-hook):
      //   HIGH   — a structural keyword → fire explore directly.
      //   MEDIUM — code-shaped tokens verified against the index (at least
      //            one token is a real symbol name) → fire explore.
      //   silent — nothing verified → zero-cost no-op.
      const lower = text.toLowerCase()
      const keyworded = STRUCTURAL_KEYWORDS.some((k) => lower.includes(k))
      if (!keyworded) {
        const tokens = extractCodeTokens(text)
        if (tokens.length === 0) return
        let verified = false
        for (const token of tokens) {
          try {
            const out = await runCodegraph({
              argv: ['query', '--json', '--path', root, '-l', '1', token],
              cwd: root,
              signal: AbortSignal.timeout(15000)
            })
            const parsed = JSON.parse(out)
            if (Array.isArray(parsed) && parsed.length > 0) { verified = true; break }
          } catch { /* try the next token */ }
        }
        if (!verified) return
      }

      const out = await runCodegraph({
        argv: ['explore', '--path', root, text],
        cwd: root,
        signal: AbortSignal.timeout(60000)
      })
      const body0 = out.trim()
      if (!body0) return
      // Cap the injection so a large-repo explore can't flood the turn.
      const MAX = 12000
      const body = body0.length > MAX
        ? body0.slice(0, MAX) + '\n…(truncated; call codegraph_explore for the rest)'
        : body0
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: `${FRONTLOAD_MARKER} note="Structural context from CodeGraph for this prompt — treat the returned source as already read; call codegraph_explore for more.">\n${body}\n</codegraph_context>`
        }],
        source: { kind: 'user' }
      }))
    }

    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      // Fire-and-forget; a front-load failure must never surface to the user.
      void maybeFrontload(agent, message).catch(() => {})
    })
  }
}
