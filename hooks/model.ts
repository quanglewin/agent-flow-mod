import type {
  AgentFlowAgent,
  AgentFlowGraph,
  AgentFlowLink,
  AgentFlowLinkKind,
  AgentFlowTodo,
} from '../types'

/** The main loop's id in the graph (its events carry no agentId). */
export const MAIN = 'main'

/** Neon palette: cyan, magenta, lime, yellow, violet, orange, hot pink, mint. */
export const NEON = [
  '#00F0FF',
  '#FF2BD6',
  '#39FF14',
  '#FFE600',
  '#B026FF',
  '#FF8A00',
  '#FF3864',
  '#00FFA3',
] as const

const MAX_LINKS = 80
export const TOOL_LOG_MAX = 24
const RESULT_MAX = 700

/** A link stays "hot" (animated) this long after it fired. */
export const HOT_MS = 6000

/** A packet's flight from sender to receiver, and the flash when it lands. */
export const PACKET_MS = 1400
export const IMPACT_MS = 1100

/** Links still in flight or landing at `now`, oldest first, with ms since they fired. */
export function packets(
  g: AgentFlowGraph,
  now: number,
  travelMs = PACKET_MS,
  impactMs = IMPACT_MS,
): { link: AgentFlowLink; elapsed: number }[] {
  const out: { link: AgentFlowLink; elapsed: number }[] = []
  for (const link of g.links) {
    const elapsed = now - link.at
    if (elapsed >= 0 && elapsed < travelMs + impactMs) out.push({ link, elapsed })
  }
  return out
}

export function neon(index: number): string {
  return NEON[((index % NEON.length) + NEON.length) % NEON.length] ?? '#00F0FF'
}

/** Rough token estimate for text we only have as characters. */
export function est(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

/** 950 → "950", 12345 → "12.3k", 2_400_000 → "2.4M". */
export function fmt(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, Math.max(1, max - 1))}…`
}

function blankAgent(
  id: string,
  label: string,
  type: string,
  role: string,
  color: number,
  now: number,
): AgentFlowAgent {
  return {
    id,
    label,
    type,
    role,
    task: '',
    color,
    status: 'idle',
    inTok: 0,
    outTok: 0,
    cacheTok: 0,
    steps: 0,
    tools: 0,
    liveOut: 0,
    tps: 0,
    peakTps: 0,
    startedAt: now,
    lastActiveAt: now,
    toolLog: [],
  }
}

export function emptyGraph(now: number): AgentFlowGraph {
  const main = blankAgent(MAIN, 'MAIN', 'orchestrator', 'Talks to you, plans, delegates', 0, now)
  return { agents: { [MAIN]: main }, order: [MAIN], links: [], seq: 0, opened: false, startedAt: now }
}

/** The agent with this id, created as a placeholder when we missed its spawn. */
export function agentOf(g: AgentFlowGraph, id: string, now: number): AgentFlowAgent {
  const known = g.agents[id]
  if (known) return known
  const index = g.order.length
  const made = blankAgent(id, `agent #${index}`, 'agent', 'Started before this map was watching', index, now)
  made.parent = MAIN
  g.agents[id] = made
  g.order.push(id)
  return made
}

/** Agent types that say nothing about the job: such an agent is named by its task instead. */
const GENERIC_TYPES = new Set(['general-purpose', 'agent', 'loop', 'teammate', 'fork'])
const LABEL_MAX = 30

/**
 * An agent's short name: the one it was given; else for a generic type (general-purpose) the task
 * it was handed ("Write plan for exporter"), since every such agent shares the type; else type #n.
 * A name already on the map gets a number, so two agents never look alike.
 */
export function labelFor(g: AgentFlowGraph, id: string, type: string, description: string, name?: string): string {
  if (name) return name
  const sameType = g.order.filter(x => x !== id && g.agents[x]?.type === type).length
  if (!GENERIC_TYPES.has(type) || !description.trim()) return `${type} #${sameType + 1}`
  const base = clip(description, LABEL_MAX)
  let label = base
  for (let k = 2; g.order.some(x => x !== id && g.agents[x]?.label === label); k += 1) label = `${base} #${k}`
  return label
}

/** What the engine's agent list says of an agent: enough to name one whose spawn the map missed. */
export type AgentFacts = { type: string; description: string; name?: string; parentId?: string }

/**
 * Names an agent the map only knows as a placeholder (it started before the mod was loaded, or
 * without an agent.spawn, as a forked skill does), from the engine's own list of agents.
 */
export function adopt(g: AgentFlowGraph, id: string, info: AgentFacts): boolean {
  const a = g.agents[id]
  if (!a || a.type !== 'agent') return false
  const type = info.type || 'loop'
  a.label = labelFor(g, id, type, info.description, info.name)
  a.type = type
  if (info.description) a.role = info.description
  if (info.parentId && info.parentId !== id && g.agents[info.parentId]) a.parent = info.parentId
  return true
}

export function addLink(
  g: AgentFlowGraph,
  from: string,
  to: string,
  kind: AgentFlowLinkKind,
  text: string,
  now: number,
  tokens?: number,
): AgentFlowLink {
  g.seq += 1
  const link: AgentFlowLink = {
    id: g.seq,
    from,
    to,
    kind,
    tokens: tokens ?? est(text.length),
    text: clip(text, 120),
    at: now,
  }
  g.links.push(link)
  if (g.links.length > MAX_LINKS) g.links.splice(0, g.links.length - MAX_LINKS)
  return link
}

export type SpawnFacts = {
  id: string
  parent?: string
  type: string
  description: string
  prompt: string
  model?: string
  name?: string
}

export function spawn(g: AgentFlowGraph, s: SpawnFacts, now: number): AgentFlowAgent {
  const parent = s.parent && g.agents[s.parent] ? s.parent : MAIN
  const existing = g.agents[s.id]
  const agent =
    existing ??
    blankAgent(
      s.id,
      labelFor(g, s.id, s.type, s.description, s.name),
      s.type,
      s.description || s.type,
      g.order.length,
      now,
    )
  agent.parent = parent
  // the agent's own turn.start can land before its spawn resolves, leaving a placeholder: name it properly now
  if (existing && existing.type === 'agent') {
    existing.label = labelFor(g, s.id, s.type, s.description, s.name)
  }
  agent.type = s.type
  agent.role = s.description || agent.role
  agent.task = clip(s.prompt, 160)
  agent.status = 'running'
  agent.startedAt = now
  agent.endedAt = undefined
  if (s.model) agent.model = s.model
  if (!existing) {
    g.agents[s.id] = agent
    g.order.push(s.id)
  }
  addLink(g, parent, s.id, 'spawn', s.description ? `${s.description}: ${s.prompt}` : s.prompt, now, est(s.prompt.length))
  return agent
}

export function turnStart(g: AgentFlowGraph, id: string, now: number): void {
  const a = agentOf(g, id, now)
  a.status = 'running'
  if (id === MAIN) {
    a.startedAt = now
    a.endedAt = undefined
  }
}

export function stepStart(g: AgentFlowGraph, id: string, model: string, now: number): void {
  const a = agentOf(g, id, now)
  a.lastActiveAt = now
  a.status = 'running'
  a.model = model
  a.liveOut = 0
  a.tps = 0 // no stale rate from the last request while this one waits for its first token
  a.stepStartedAt = now
  a.firstChunkAt = undefined
  a.firstOut = undefined
}

/**
 * A streamed piece of output (text, thinking or tool arguments). The rate is measured from
 * the first chunk on, and the first chunk itself is left out of it: it arrives at elapsed 0,
 * and a big buffered one would otherwise spike the rate (and the peak).
 */
export function stepChunk(g: AgentFlowGraph, id: string, chars: number, now: number): void {
  const a = agentOf(g, id, now)
  a.lastActiveAt = now
  a.liveOut += chars / 4
  if (a.firstChunkAt === undefined || a.firstOut === undefined) {
    a.firstChunkAt = now
    a.firstOut = a.liveOut
    return
  }
  const secs = (now - a.firstChunkAt) / 1000
  if (secs >= 0.25) {
    a.tps = (a.liveOut - a.firstOut) / secs
    if (a.tps > a.peakTps) a.peakTps = a.tps
  }
}

export type UsageFacts = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

export function stepEnd(g: AgentFlowGraph, id: string, usage: UsageFacts | null, now: number): void {
  const a = agentOf(g, id, now)
  a.lastActiveAt = now
  a.steps += 1
  if (usage) {
    a.ctxTok = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    a.inTok += a.ctxTok
    a.outTok += usage.output_tokens
    a.cacheTok += usage.cache_read_input_tokens
    if (usage.model) a.model = usage.model
    // only a request that streamed has a measurable rate; time-to-first-token is not output time
    const secs = a.firstChunkAt === undefined ? 0 : (now - a.firstChunkAt) / 1000
    if (secs >= 0.25 && usage.output_tokens > 0) {
      a.tps = usage.output_tokens / secs
      if (a.tps > a.peakTps) a.peakTps = a.tps
    }
  } else {
    a.outTok += Math.round(a.liveOut)
  }
  a.liveOut = 0
  // the request is over: nothing streams until the next one, so the live rate is zero (the peak remains)
  a.tps = 0
  a.stepStartedAt = undefined
  a.firstChunkAt = undefined
  a.firstOut = undefined
}

export function toolStart(g: AgentFlowGraph, id: string, summary: string, now: number): void {
  const a = agentOf(g, id, now)
  a.tools += 1
  a.activity = clip(summary, 80)
  a.lastActiveAt = now
  const log = a.toolLog ?? (a.toolLog = [])
  log.push({ at: now, text: clip(summary, 120) })
  if (log.length > TOOL_LOG_MAX) log.splice(0, log.length - TOOL_LOG_MAX)
}

export function toolEnd(g: AgentFlowGraph, id: string, now: number): void {
  const a = agentOf(g, id, now)
  a.activity = undefined
  a.lastActiveAt = now
  const log = a.toolLog ?? []
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i]
    if (entry && entry.end === undefined) {
      entry.end = now
      break
    }
  }
}

export type CompleteFacts = { answer: string; reason: string; outTokens?: number }

export function turnComplete(g: AgentFlowGraph, id: string, c: CompleteFacts, now: number): void {
  const a = agentOf(g, id, now)
  a.activity = undefined
  a.liveOut = 0
  if (id === MAIN) {
    // the orchestrator's turn is over: it waits for you now
    a.status = 'idle'
    a.endedAt = now
    a.lastActiveAt = now
    for (const entry of a.toolLog ?? []) if (entry.end === undefined) entry.end = now
    return
  }
  a.status = c.reason === 'error' || c.reason === 'refusal' ? 'error' : 'done'
  a.endedAt = now
  a.lastActiveAt = now
  a.result = c.answer.length > RESULT_MAX ? `${c.answer.slice(0, RESULT_MAX - 1)}…` : c.answer
  for (const entry of a.toolLog ?? []) if (entry.end === undefined) entry.end = now
  addLink(g, id, a.parent ?? MAIN, 'report', c.answer || `(${c.reason})`, now, est(c.answer.length))
}

/** Resolves a SendMessage recipient (a name, a label or an id) to an agent id. */
export function resolveRecipient(g: AgentFlowGraph, to: string): string {
  const want = to.toLowerCase().replace(/@.*$/, '')
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a) continue
    if (id === to || a.label.toLowerCase() === want) return id
  }
  if (want === 'main' || want === 'lead' || want === 'team-lead') return MAIN
  return to
}

/** The key of the channel between two agents, the same whichever way a message goes. */
export function channelKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function message(g: AgentFlowGraph, from: string, to: string, text: string, now: number): AgentFlowLink {
  agentOf(g, from, now)
  const target = resolveRecipient(g, to)
  const link = addLink(g, from, target, 'message', text, now)
  const fa = g.agents[from]
  const ta = g.agents[target]
  // a message along a parent-child wire travels that wire; any other pair gets a channel of its own
  const related = fa?.parent === target || ta?.parent === from
  if (!related && target !== from && ta) {
    const key = channelKey(from, target)
    const channels = g.channels ?? (g.channels = {})
    const ch = channels[key] ?? (channels[key] = { a: from, b: target, count: 0, tokens: 0, last: now })
    ch.count += 1
    ch.tokens += link.tokens
    ch.last = now
  }
  return link
}

const TODO_MAX = 40

function todoStatus(s: unknown): AgentFlowTodo['status'] {
  return s === 'completed' || s === 'in_progress' ? s : 'pending'
}

/** TodoWrite: the agent's whole plan, replaced. */
export function setTodos(g: AgentFlowGraph, id: string, todos: unknown, now: number): void {
  if (!Array.isArray(todos)) return
  const a = agentOf(g, id, now)
  a.todos = todos.slice(0, TODO_MAX).map(t => {
    const o = (t ?? {}) as Record<string, unknown>
    return {
      text: clip(String(o.content ?? o.subject ?? ''), 140),
      active: typeof o.activeForm === 'string' ? clip(o.activeForm, 140) : undefined,
      status: todoStatus(o.status),
    }
  })
}

/** TaskCreate: one more step in the agent's plan. */
export function taskCreate(g: AgentFlowGraph, id: string, taskId: string | undefined, subject: string, active: string | undefined, now: number): void {
  const a = agentOf(g, id, now)
  const list = a.todos ?? (a.todos = [])
  if (taskId && list.some(t => t.id === taskId)) return
  list.push({ id: taskId, text: clip(subject, 140), active: active ? clip(active, 140) : undefined, status: 'pending' })
  if (list.length > TODO_MAX) list.splice(0, list.length - TODO_MAX)
}

/** TaskUpdate: a step moves on (whichever agent's plan holds it), or is deleted. */
export function taskUpdate(
  g: AgentFlowGraph,
  taskId: string,
  change: { status?: string; subject?: string; active?: string },
): void {
  for (const id of g.order) {
    const list = g.agents[id]?.todos
    if (!list) continue
    const k = list.findIndex(t => t.id === taskId)
    if (k < 0) continue
    const t = list[k]
    if (!t) continue
    if (change.status === 'deleted') {
      list.splice(k, 1)
      return
    }
    if (change.status) t.status = todoStatus(change.status)
    if (change.subject) t.text = clip(change.subject, 140)
    if (change.active) t.active = clip(change.active, 140)
    return
  }
}

/** How far an agent's plan has got: done out of total, and the step in progress. */
export function todoProgress(a: AgentFlowAgent): { done: number; total: number; current?: string } {
  const list = a.todos ?? []
  const current = list.find(t => t.status === 'in_progress')
  return {
    done: list.filter(t => t.status === 'completed').length,
    total: list.length,
    current: current ? current.active ?? current.text : undefined,
  }
}

/** Agents in tree order (each parent before its children), with their depth. */
export function treeOrder(g: AgentFlowGraph): { id: string; depth: number }[] {
  const out: { id: string; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (seen.has(id) || depth > 12) return
    seen.add(id)
    out.push({ id, depth })
    for (const child of g.order) if (g.agents[child]?.parent === id) walk(child, depth + 1)
  }
  walk(MAIN, 0)
  for (const id of g.order) if (!seen.has(id)) walk(id, 1)
  return out
}

/** The newest link between two agents in either direction, if any. */
export function lastLink(g: AgentFlowGraph, a: string, b: string, kind?: AgentFlowLinkKind): AgentFlowLink | undefined {
  for (let i = g.links.length - 1; i >= 0; i -= 1) {
    const l = g.links[i]
    if (!l) continue
    if (kind && l.kind !== kind) continue
    if ((l.from === a && l.to === b) || (l.from === b && l.to === a)) return l
  }
  return undefined
}

export function isAnimating(g: AgentFlowGraph, now: number): boolean {
  for (const id of g.order) if (g.agents[id]?.status === 'running') return true
  const last = g.links[g.links.length - 1]
  return last !== undefined && now - last.at < HOT_MS
}

export type Totals = { agents: number; running: number; inTok: number; outTok: number; tps: number }

export function totals(g: AgentFlowGraph): Totals {
  let running = 0
  let inTok = 0
  let outTok = 0
  let tps = 0
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a) continue
    inTok += a.inTok
    outTok += a.outTok + Math.round(a.liveOut)
    if (a.status === 'running') {
      running += 1
      tps += a.tps
    }
  }
  return { agents: g.order.length, running, inTok, outTok, tps }
}

/** One line saying what a tool call does, from its input's usual fields. */
export function summarizeTool(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  const path = str('file_path') ?? str('path') ?? str('notebook_path')
  const short = path ? path.split('/').slice(-2).join('/') : undefined
  switch (tool) {
    case 'Bash':
      return `Bash: ${str('description') ?? str('command') ?? ''}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${tool} ${short ?? ''}`
    case 'Grep':
    case 'Glob':
      return `${tool} ${str('pattern') ?? ''}`
    case 'WebSearch':
      return `WebSearch ${str('query') ?? ''}`
    case 'WebFetch':
      return `WebFetch ${str('url') ?? ''}`
    case 'Agent':
    case 'Task':
      return `Agent → ${str('subagent_type') ?? 'agent'}: ${str('description') ?? ''}`
    case 'SendMessage':
      return `SendMessage → ${str('to') ?? str('recipient') ?? ''}`
    default:
      return short ? `${tool} ${short}` : tool.replace(/^mcp__/, '').replace(/__/g, ' · ')
  }
}

export type SessionSummary = {
  state: 'running' | 'done' | 'failed' | 'idle'
  /** Subagents running now (the main loop is `busy`). */
  running: number
  busy: boolean
  agents: number
  done: number
  failed: number
  turnStart: number
  endedAt?: number
  plan: { done: number; total: number }
}

/** One session at a glance, for its tab on the dashboard: is it working, done, or failed. */
export function summary(g: AgentFlowGraph): SessionSummary {
  const main = g.agents[MAIN]
  const turnStart = main?.startedAt ?? g.startedAt
  let running = 0
  let done = 0
  let failed = 0
  let agents = 0
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || id === MAIN) continue
    if (a.type === 'agent' && a.inTok === 0 && a.outTok === 0 && a.tools === 0) continue // a loop it learned nothing about
    agents += 1
    if (a.status === 'running') running += 1
    if (a.startedAt >= turnStart - 1000) {
      if (a.status === 'done') done += 1
      if (a.status === 'error') failed += 1
    }
  }
  const busy = main?.status === 'running'
  const state = busy || running > 0 ? 'running' : main?.endedAt ? (failed > 0 ? 'failed' : 'done') : 'idle'
  const p = main ? todoProgress(main) : { done: 0, total: 0 }
  return { state, running, busy, agents, done, failed, turnStart, endedAt: main?.endedAt, plan: { done: p.done, total: p.total } }
}

/** A working copy Claude Code made for one agent (`Agent` with worktree isolation): not a session of yours. */
export function isAgentWorktree(cwd: string): boolean {
  return /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(cwd)
}

/** The project a session works in, by its folder; a worktree is named after its repository. */
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const wt = /^(.*)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)$/.exec(trimmed)
  if (wt) return `${(wt[1] ?? '').split(/[\\/]/).pop() || 'repo'} (worktree ${wt[2]})`
  return trimmed.split(/[\\/]/).pop() || 'session'
}
