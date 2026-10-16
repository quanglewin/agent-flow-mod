import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AgentFlowAgent, AgentFlowGraph, AgentFlowLink, AgentFlowView } from '../types'
import { sessionAdvisor } from './advisor'
import { summarize } from './context'
import type { CtxSnapshot, MessageRow } from './context'
import * as M from './model'
import { buildOrbSvg } from './orbs'
import { renderPixels } from './pixels'
import { renderRaster, toBase64 } from './raster'
import { buildSvg } from './svg'

/** Set to a path to have the mod write its state there every 2s (debugging only). */
const DEBUG_STATUS_FILE = ''

const PANE = 'agent-flow'
const TITLE = 'AGENT//FLOW'

const graphRef = { plugin: 'agent-flow', key: 'graph' } as const
const tickRef = { plugin: 'agent-flow', key: 'tick' } as const
const graphAtom = atom(graphRef, M.emptyGraph(0))
const tickAtom = atom(tickRef, 0)
const viewRef = { plugin: 'agent-flow', key: 'view' } as const
const viewAtom = atom(viewRef, 'compact' as AgentFlowView)
/**
 * What the desktop's SVG is drawn from. It changes only when something visible happens
 * (an agent appears, a status flips, a packet fires) or every few seconds for the numbers:
 * each new SVG reloads its frame and restarts its animations, so it must not churn.
 */
const sceneRef = { plugin: 'agent-flow', key: 'scene' } as const
const sceneAtom = atom(sceneRef, M.emptyGraph(0))
const SCENE_NUMBERS_MS = 4000

/** The live graph. Hooks mutate it in place; a timer copies it into $.state. */
let graph: AgentFlowGraph = M.emptyGraph(Date.now())
let dirty = false
let sceneUrgent = false
let sceneStale = false
let lastSceneAt = 0
/** Diagnostics for /agent-flow status: what the last open said, and who has drawn the pane. */
let lastOpen = 'not opened yet'
const drawsBySurface: Record<string, number> = {}
let lastDrawAt = 0
/** The terminal Raster as last mounted: the size a timer's frames must match. */
let raster: { columns: number; rows: number } | null = null
const RASTER_KEY = 'orbs'
/** The browser view: where its page and state file live, and whether it is on. */
let web: { dir: string; root: string; on: boolean; dirty: boolean; lastWrite: number } = { dir: '', root: '', on: false, dirty: false, lastWrite: 0 }
/**
 * This session: its id (the transcript's name) and project. Every session writes its own folder,
 * ~/.claude/agent-flow/s/<id>/, so two sessions never overwrite each other's map.
 */
const session = { id: '', project: '', cwd: '', startedAt: Date.now(), watched: true }
const SESSION_TTL_MS = 6 * 3600_000
/** The browser view was on when this session started: set it up once the session has bound. */
let webPending = false
const WEB_STORE_KEY = 'web-on'

/**
 * What the browser page shows beyond the graph: every packet's full content with its facts, and
 * each agent's context as its transcript reads. They live in files of their own (packets.js,
 * context.js), written only when they change, so state.js stays small at ten writes a second.
 */
type PacketDetail = {
  id: number
  kind: AgentFlowLink['kind']
  from: string
  to: string
  at: number
  tokens: number
  body: string
  truncated: boolean
  meta: Record<string, string | number | boolean>
}
const PACKET_MAX = 80
const BODY_MAX = 24_000
const packetLog: PacketDetail[] = []
let packetsRev = 0
let packetsWritten = -1

type AgentCtx = CtxSnapshot & { ctxTok?: number }
type MainCtx = { window: number; percent?: number; tokens?: number; categories: { name: string; tokens: number; kind: string }[]; at: number }
const contexts: Record<string, AgentCtx> = {}
let mainCtx: MainCtx | undefined
let ctxRev = 0
let ctxWritten = -1
/** Timer ticks, not wall time, pace these writes and reads (the engine's clock is the timers'). */
let webTicks = 0
let lastCtxWrite = -100
let ctxTicks = 0
/** Agents whose context changed (a request went out, a turn ended) and is due a fresh read. */
const ctxQueue = new Set<string>()
const ctxReadAt: Record<string, number> = {}

let lastBreakdownAt = 0

/** How long finished runs took, by agent type (and main turns): the page's "usually takes". */
const DURATIONS_KEY = 'durations'
const MAIN_TURN = '(main turn)'
let durations: Record<string, number[]> = {}
let durationsDirty = false

function recordPacket(link: AgentFlowLink | undefined, body: string, meta: PacketDetail['meta']): void {
  if (!link) return
  const text = String(body ?? '')
  packetLog.push({
    id: link.id,
    kind: link.kind,
    from: link.from,
    to: link.to,
    at: link.at,
    tokens: link.tokens,
    body: text.length > BODY_MAX ? text.slice(0, BODY_MAX) : text,
    truncated: text.length > BODY_MAX,
    meta,
  })
  if (packetLog.length > PACKET_MAX) packetLog.splice(0, packetLog.length - PACKET_MAX)
  packetsRev += 1
}

function recordDuration(key: string, ms: number): void {
  if (!(ms > 0) || !Number.isFinite(ms)) return
  const list = durations[key] ?? (durations[key] = [])
  list.push(Math.round(ms))
  if (list.length > 30) list.splice(0, list.length - 30)
  durationsDirty = true
}

function wantContext(id: string): void {
  if (web.on) ctxQueue.add(id)
}

/** Which desktop the session runs on: how a browser is opened, and where its page can live. */
export type Platform = 'windows' | 'wsl' | 'linux' | 'mac'
async function platform($: EngineInterface): Promise<Platform> {
  const [os, wsl, desktop, wayland, session] = await Promise.all([
    $.env.get('OS'),
    $.env.get('WSL_DISTRO_NAME'),
    $.env.get('XDG_CURRENT_DESKTOP'),
    $.env.get('WAYLAND_DISPLAY'),
    $.env.get('XDG_SESSION_TYPE'),
  ])
  return /windows/i.test(os ?? '') ? 'windows' : wsl ? 'wsl' : desktop || wayland || session ? 'linux' : 'mac'
}

async function homeDir($: EngineInterface): Promise<string> {
  if ((await platform($)) === 'windows') return (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '.'
}

/**
 * Where the dashboard lives. AGENT_FLOW_DIR wins. On a Linux desktop it is a visible folder: the Snap
 * builds of Firefox and Chromium that Ubuntu ships cannot read hidden folders like ~/.claude.
 */
async function dataRoot($: EngineInterface): Promise<string> {
  const set = await $.env.get('AGENT_FLOW_DIR')
  if (set) return set.replace(/[\\/]+$/, '')
  const home = (await homeDir($)).replace(/[\\/]+$/, '')
  return (await platform($)) === 'linux' ? `${home}/agent-flow` : `${home}/.claude/agent-flow`
}

async function ensureSession($: EngineInterface): Promise<void> {
  if (session.id) return
  let id = ''
  try {
    id = await $.session.id()
  } catch {
    id = ''
  }
  session.id = (id || `local-${Date.now().toString(36)}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'session'
}

/** Copies the page out of the mod's folder into this session's folder (so updates to the mod reach it). */
async function installPage($: EngineInterface): Promise<string> {
  await ensureSession($)
  const root = await dataRoot($)
  const dir = `${root}/s/${session.id}`
  const html = (await $.fs.read(`${$.plugin.root}/web/index.html`)) as string
  // one dashboard for every session; this session's folder holds its data and a link that opens its tab
  await $.fs.write(`${root}/index.html`, html)
  await $.fs.write(
    `${dir}/index.html`,
    `<!doctype html><meta charset="utf-8"><title>AGENT//FLOW</title><script>location.replace('../../index.html#s=' + ${JSON.stringify(session.id)})</script>`,
  )
  web.dir = dir
  web.root = root
  await register_($)
  return `${dir}/index.html`
}

/**
 * The dashboard's list of sessions, ~/.claude/agent-flow/sessions.js: ids and projects only, so it
 * changes when a session first appears (and is tidied once a minute). What each session is doing
 * lives in its own s/<id>/meta.js, which no other session writes.
 */
let registeredAt = 0
async function register_($: EngineInterface): Promise<void> {
  if (!web.root || !session.id) return
  const file = `${web.root}/sessions.js`
  let list: { id: string; project?: string; cwd?: string; startedAt?: number; lastSeen?: number }[] = []
  try {
    const text = (await $.fs.read(file)) as string
    const parsed = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))) as { sessions?: unknown }
    if (Array.isArray(parsed.sessions)) list = parsed.sessions as typeof list
  } catch {
    list = []
  }
  const now = Date.now()
  registeredAt = now
  const me = { id: session.id, project: session.project, cwd: session.cwd, startedAt: session.startedAt, lastSeen: now }
  const others = list.filter(s => s && typeof s.id === 'string' && s.id !== session.id && now - (s.lastSeen ?? 0) < SESSION_TTL_MS)
  await $.fs.write(file, `window.__AF_SESSIONS && window.__AF_SESSIONS(${JSON.stringify({ sessions: [me, ...others].slice(0, 24) })})\n`)
}

/** This session at a glance, s/<id>/meta.js: what its dashboard tab shows. */
async function heartbeat($: EngineInterface): Promise<void> {
  if (!web.dir || !session.id) return
  const now = Date.now()
  const meta = { id: session.id, project: session.project, cwd: session.cwd, startedAt: session.startedAt, lastSeen: now, ...M.summary(graph) }
  await $.fs.write(`${web.dir}/meta.js`, `window.__AF_META && window.__AF_META(${JSON.stringify(meta)})\n`)
  if (now - registeredAt > 60_000) await register_($)
}

/** The commands that open a file in the default browser, in order of preference, by platform. */
export function openers(os: Platform, file: string, windowsPath?: string): string[][] {
  if (os === 'windows') {
    const win = file.replace(/\//g, '\\')
    return [
      // an empty argument is start's window title, so a path with spaces is not taken for one
      ['cmd', '/d', '/c', 'start', '', win],
      ['rundll32', 'url.dll,FileProtocolHandler', win],
    ]
  }
  if (os === 'wsl') {
    // the browser is Windows': hand it the file's \\wsl$ path
    const tries = [['wslview', file]]
    if (windowsPath) tries.push(['cmd.exe', '/d', '/c', 'start', '', windowsPath], ['explorer.exe', windowsPath])
    return tries
  }
  if (os === 'linux') return [['xdg-open', file], ['gio', 'open', file], ['sensible-browser', file]]
  return [['open', file]]
}

/** Opens a file in the default browser. False when nothing here could (a server over SSH, say). */
async function openInBrowser($: EngineInterface, file: string): Promise<boolean> {
  const os = await platform($)
  let windowsPath: string | undefined
  if (os === 'wsl') {
    try {
      const r = await $.process.run(['wslpath', '-w', file], { timeoutMs: 4000 })
      if (r.exitCode === 0) windowsPath = r.stdout.trim()
    } catch {
      windowsPath = undefined
    }
  }
  for (const argv of openers(os, file, windowsPath)) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 8000 })
      // explorer.exe reports 1 even when it opened the file
      if (r.exitCode === 0 || argv[0] === 'explorer.exe') return true
    } catch {
      // not installed here: try the next opener
    }
  }
  return false
}

/** The pixel Image (Ghostty, kitty) as last mounted, and whether a frame is on its way. */
let pixelImage: { columns: number; rows: number } | null = null
let pixelBusy = false
const PIXEL_KEY = 'orbs-px'
/** Whether this terminal shows pictures (the kitty graphics protocol): detected, or set by /agent-flow pixels. */
let pixelsOk = false
let pixelsForced: boolean | null = null

/**
 * Never let bookkeeping break the session: a throw here is swallowed.
 * `visible` marks a change the desktop drawing must show at once (new agent, status, packet).
 */
function track(fn: (g: AgentFlowGraph, now: number) => void, visible = false): void {
  try {
    fn(graph, Date.now())
    dirty = true
    web.dirty = true
    sceneStale = true
    if (visible) sceneUrgent = true
  } catch {
    // the map misses one fact; the session goes on
  }
}

/** A scripted run so the effects can be seen without real subagents: /agent-flow demo. */
type DemoStep = { at: number; run: (g: AgentFlowGraph, now: number) => void; visible?: boolean }
let demo: { startedAt: number; steps: DemoStep[]; streaming: Set<string> } | null = null

function startDemo(now: number): void {
  graph = M.emptyGraph(now)
  graph.opened = true
  const u = (i: number, o: number, c: number) => ({
    input_tokens: i,
    output_tokens: o,
    cache_read_input_tokens: c,
    cache_creation_input_tokens: 0,
  })
  const streaming = new Set<string>()
  const go = (id: string) => streaming.add(id)
  const stop = (id: string) => streaming.delete(id)
  const steps: DemoStep[] = [
    { at: 0, run: (g, t) => (M.turnStart(g, M.MAIN, t), M.stepStart(g, M.MAIN, 'claude-opus-5-5', t), go(M.MAIN)), visible: true },
    { at: 900, run: (g, t) => (M.stepEnd(g, M.MAIN, u(3200, 900, 41000), t), stop(M.MAIN), M.toolStart(g, M.MAIN, 'Delegating to 3 agents', t)) },
    { at: 1200, run: (g, t) => (M.spawn(g, { id: 'demo-1', type: 'Explore', description: 'Map the auth flow', prompt: 'Find where JWT tokens are issued, validated and refreshed.' }, t), M.stepStart(g, 'demo-1', 'claude-haiku-5-5', t), go('demo-1')), visible: true },
    { at: 2600, run: (g, t) => (M.spawn(g, { id: 'demo-2', type: 'Plan', description: 'Design storage migration', prompt: 'Design a zero-downtime migration of the session store.' }, t), M.stepStart(g, 'demo-2', 'claude-sonnet-5-5', t), go('demo-2')), visible: true },
    { at: 4000, run: (g, t) => (M.spawn(g, { id: 'demo-3', type: 'general-purpose', description: 'Write load test', prompt: 'Write a k6 load test for login at 2k RPS.', name: 'tester' }, t), M.stepStart(g, 'demo-3', 'claude-sonnet-5-5', t), go('demo-3')), visible: true },
    { at: 5600, run: (g, t) => M.toolStart(g, 'demo-1', 'Grep "ValidateToken" src/', t) },
    { at: 6200, run: (g, t) => (M.spawn(g, { id: 'demo-4', parent: 'demo-1', type: 'Explore', description: 'Scan gateway configs', prompt: 'Grep gateway helm charts for auth filters.' }, t), M.stepStart(g, 'demo-4', 'claude-haiku-5-5', t), go('demo-4')), visible: true },
    { at: 7400, run: (g, t) => M.toolStart(g, 'demo-3', 'Write tests/login.k6.js', t) },
    { at: 11200, run: (g, t) => (M.stepEnd(g, 'demo-4', u(600, 900, 12000), t), stop('demo-4'), M.turnComplete(g, 'demo-4', { answer: 'Found 3 auth filters: jwt-verify, rate-limit-auth, mtls-edge.', reason: 'answer' }, t)), visible: true },
    { at: 13000, run: (g, t) => (M.stepEnd(g, 'demo-2', u(1500, 5200, 52000), t), stop('demo-2'), M.turnComplete(g, 'demo-2', { answer: 'Migration plan: dual-read, shadow writes, cutover per service, retire the old store.', reason: 'answer' }, t)), visible: true },
    { at: 15000, run: (g, t) => (M.toolEnd(g, 'demo-1', t), M.stepEnd(g, 'demo-1', u(900, 2400, 38000), t), stop('demo-1'), M.turnComplete(g, 'demo-1', { answer: 'Auth flow: gateway jwt-verify → AuthService.Validate → TokenStore; refresh via /auth/refresh.', reason: 'answer' }, t)), visible: true },
    { at: 17000, run: (g, t) => (M.toolEnd(g, 'demo-3', t), M.stepEnd(g, 'demo-3', u(2100, 3100, 30000), t), stop('demo-3'), M.turnComplete(g, 'demo-3', { answer: 'k6 script written: ramp to 2k RPS, refresh every 10 min, p95 < 120ms.', reason: 'answer' }, t)), visible: true },
    { at: 18500, run: (g, t) => (M.toolEnd(g, M.MAIN, t), M.stepStart(g, M.MAIN, 'claude-opus-5-5', t), go(M.MAIN)) },
    { at: 20500, run: (g, t) => (M.stepEnd(g, M.MAIN, u(9000, 1400, 60000), t), stop(M.MAIN), M.turnComplete(g, M.MAIN, { answer: 'done', reason: 'answer' }, t)), visible: true },
  ]
  demo = { startedAt: now, steps, streaming }
  dirty = true
  sceneUrgent = true
}

/** Advances the demo: due steps run, streaming agents get output. */
function stepDemo(now: number): void {
  if (!demo) return
  const t = now - demo.startedAt
  while (demo.steps.length > 0 && (demo.steps[0]?.at ?? Infinity) <= t) {
    const step = demo.steps.shift()
    if (step) track(step.run, step.visible)
  }
  for (const id of demo.streaming) {
    const chars = 160 + Math.floor(Math.random() * 520)
    track((g, n) => M.stepChunk(g, id, chars, n))
  }
  if (demo.steps.length === 0) demo = null
}

const STATUS_COLOR: Record<AgentFlowAgent['status'], string> = {
  running: '#39FF14',
  idle: '#8888AA',
  done: '#00F0FF',
  error: '#FF3864',
}

/** Reads one agent's transcript (main's too, with /context's breakdown now and then) into `contexts`. */
async function readContext($: EngineInterface, id: string, now: number): Promise<void> {
  try {
    const isMain = id === M.MAIN
    const rows = isMain ? await $.session.messages() : await $.session.messages({ agentId: id })
    if (Array.isArray(rows)) {
      contexts[id] = { ...summarize(rows as readonly MessageRow[], isMain, now), ctxTok: graph.agents[id]?.ctxTok }
    } else if (rows && typeof rows === 'object' && 'deny' in rows) {
      // a finished agent's transcript may be gone: keep what was read while it ran
      const prev = contexts[id]
      if (prev) prev.denied = String(rows.deny)
      else contexts[id] = { ...summarize([], isMain, now), denied: String(rows.deny), ctxTok: graph.agents[id]?.ctxTok }
    }
    if (isMain && now - lastBreakdownAt > 15_000) {
      lastBreakdownAt = now
      const usage = await $.session.usage({ breakdown: 'summary' })
      const cats = usage.context.breakdown?.categories ?? []
      mainCtx = {
        window: usage.context.window,
        percent: usage.context.percent,
        tokens: usage.context.tokens,
        categories: cats.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
        at: now,
      }
    }
    ctxRev += 1
    web.dirty = true
  } catch {
    // no transcript this time; the next request asks again
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    session.cwd = e.cwd ?? ''
    session.project = M.projectName(session.cwd)
    // a session nobody sits at (a -p run, the SDK, an agent working in a worktree of its own) is
    // not a session to watch: it gets no tab unless someone runs /agent-flow web in it
    session.watched = e.isInteractive !== false && !M.isAgentWorktree(session.cwd)
    try {
      const saved = await read($, graphAtom)
      if (saved.order.length > 0 && saved.agents[M.MAIN]) graph = JSON.parse(JSON.stringify(saved))
    } catch {
      // keep the fresh graph
    }
    try {
      const [prog, term, kitty, ghostty] = await Promise.all([
        $.env.get('TERM_PROGRAM'),
        $.env.get('TERM'),
        $.env.get('KITTY_WINDOW_ID'),
        $.env.get('GHOSTTY_RESOURCES_DIR'),
      ])
      pixelsOk =
        /ghostty/i.test(prog ?? '') || /kitty/i.test(term ?? '') || /ghostty/i.test(term ?? '') || !!kitty || !!ghostty
    } catch {
      pixelsOk = false
    }
    try {
      const saved = await $.store.get(DURATIONS_KEY)
      if (saved && typeof saved === 'object') durations = saved as Record<string, number[]>
    } catch {
      durations = {}
    }
    try {
      // the session id is read once the session has bound: the page is set up on the first web tick
      if ((await $.store.get(WEB_STORE_KEY)) === true && session.watched) webPending = true
    } catch {
      web.on = false
    }
    await $.command.register({
      name: 'agent-flow',
      description: 'Open the neon agent map: compact (orbs) or detail (cards); reset clears it',
      argumentHint: '[web|web demo|web off|compact|detail|demo|reset|status|pixels on|pixels off]',
    })
    $.clock.every(200, () => {
      try {
        tickOnce()
      } catch {
        // a bad frame is skipped; the next tick tries again
      }
    })
    let lastProbeAt = 0
    // the browser view: state ten times a second while it changes; packets and contexts when they do
    $.clock.every(100, () => {
      if (webPending) {
        webPending = false
        void installPage($)
          .then(() => {
            web.on = true
            web.dirty = true
            for (const id of graph.order) wantContext(id)
          })
          .catch(() => {})
      }
      if (!web.on || !web.dir) return
      webTicks += 1
      const now = Date.now()
      try {
        // state: whenever it changed, and once a second regardless (the page shows it is live)
        if (web.dirty || webTicks - web.lastWrite >= 10) {
          web.dirty = false
          web.lastWrite = webTicks
          const payload = JSON.stringify({ v: 2, sid: session.id, now, graph, history: durations, rev: { packets: packetsRev, ctx: ctxRev } })
          void $.fs.write(`${web.dir}/state.js`, `window.__AF_PUSH && window.__AF_PUSH(${payload})\n`).catch(() => {
            web.dirty = true
          })
        }
        if (packetsWritten !== packetsRev) {
          const rev = packetsRev
          packetsWritten = rev
          const items = JSON.stringify({ sid: session.id, rev, items: packetLog })
          void $.fs.write(`${web.dir}/packets.js`, `window.__AF_PACKETS && window.__AF_PACKETS(${items})\n`).catch(() => {
            packetsWritten = -1
          })
        }
        // contexts: at most every 0.7s, they can be large
        if (ctxWritten !== ctxRev && webTicks - lastCtxWrite >= 7) {
          const rev = ctxRev
          ctxWritten = rev
          lastCtxWrite = webTicks
          const all = JSON.stringify({ sid: session.id, rev, agents: contexts, main: mainCtx })
          void $.fs.write(`${web.dir}/context.js`, `window.__AF_CTX && window.__AF_CTX(${all})\n`).catch(() => {
            ctxWritten = -1
          })
        }
      } catch {
        // skip this round
      }
    })
    // contexts: read the transcripts of agents whose context just changed, a couple at a time
    $.clock.every(400, () => {
      ctxTicks += 1
      if (!web.on || ctxQueue.size === 0) return
      const now = Date.now()
      let budget = 2
      for (const id of [...ctxQueue]) {
        if (budget <= 0) break
        if (ctxTicks - (ctxReadAt[id] ?? -10) < 3) continue
        ctxQueue.delete(id)
        ctxReadAt[id] = ctxTicks
        budget -= 1
        void readContext($, id, now)
      }
    })
    // the session list the page switches between
    $.clock.every(2000, () => {
      if (web.on) void heartbeat($).catch(() => {})
    })
    // agents the map only knows as placeholders: name them from the engine's list
    const adoptTries: Record<string, number> = {}
    $.clock.every(1500, () => {
      const unknown = graph.order.filter(id => graph.agents[id]?.type === 'agent' && (adoptTries[id] ?? 0) < 6)
      if (unknown.length === 0) return
      for (const id of unknown) adoptTries[id] = (adoptTries[id] ?? 0) + 1
      void $.agent
        .list()
        .then(infos => {
          for (const info of infos) {
            if (!unknown.includes(info.id)) continue
            track(g => M.adopt(g, info.id, { type: info.type, description: info.description, name: info.name, parentId: info.parentId }), true)
          }
        })
        .catch(() => {})
    })
    // finished runs' durations, saved so "usually takes" survives restarts
    $.clock.every(5000, () => {
      if (!durationsDirty) return
      durationsDirty = false
      void $.store.set(DURATIONS_KEY, durations).catch(() => {
        durationsDirty = true
      })
    })
    // the picture orbs: up to ~20 frames a second while anything moves, one frame in flight at a time
    $.clock.every(50, () => {
      const size = pixelImage
      if (!size || pixelBusy) return
      const now = Date.now()
      if (!M.isAnimating(graph, now) && !demo) return
      pixelBusy = true
      try {
        const frame = renderPixels(graph, now, size.columns, size.rows)
        void $.ui
          .blit({ requestId: PANE, key: PIXEL_KEY, source: { png: toBase64(frame.png) } })
          .then(r => {
            if ('deny' in r) pixelImage = null
          })
          .catch(() => {
            pixelImage = null
          })
          .finally(() => {
            pixelBusy = false
          })
      } catch {
        pixelBusy = false
      }
    })
    // the terminal's orbs: ~15 frames a second while anything moves, straight to the Raster
    $.clock.every(66, () => {
      const size = raster
      if (!size) return
      const now = Date.now()
      if (!M.isAnimating(graph, now) && !demo) return
      try {
        const frame = renderRaster(graph, now, size.columns, size.rows)
        void $.ui
          .blit({ requestId: PANE, key: RASTER_KEY, cells: frame.cells, columns: frame.columns })
          .then(r => {
            if ('deny' in r) raster = null
          })
          .catch(() => {
            raster = null
          })
      } catch {
        // a frame that fails to paint is skipped
      }
    })
    function tickOnce() {
      const now = Date.now()
      if (now - lastProbeAt > 2000) {
        lastProbeAt = now
        void (async () => {
          const panes = await $.ui.panes().catch(() => [])
          const status = {
            at: new Date(now).toISOString(),
            lastOpen,
            panes,
            drawsBySurface,
            lastDrawAgoMs: lastDrawAt ? now - lastDrawAt : null,
            agents: graph.order.map(id => {
              const a = graph.agents[id]
              return a ? { id, label: a.label, status: a.status, inTok: a.inTok, outTok: a.outTok, tps: Math.round(a.tps) } : id
            }),
            packets: graph.links.length,
            demo: demo !== null,
          }
          if (DEBUG_STATUS_FILE) await $.fs.write(DEBUG_STATUS_FILE, JSON.stringify(status, null, 2))
        })().catch(() => {})
      }
      stepDemo(now)
      if (sceneUrgent || (sceneStale && now - lastSceneAt > SCENE_NUMBERS_MS)) {
        sceneUrgent = false
        sceneStale = false
        lastSceneAt = now
        const scene = JSON.parse(JSON.stringify(graph)) as AgentFlowGraph
        void update($, sceneAtom, () => scene).catch(() => {
          sceneUrgent = true
        })
      }
      if (dirty) {
        dirty = false
        const snapshot = JSON.parse(JSON.stringify(graph)) as AgentFlowGraph
        void update($, graphAtom, () => snapshot).catch(() => {
          dirty = true
        })
      }
      if (M.isAnimating(graph, Date.now())) void update($, tickAtom, n => (n + 1) % 1_000_000).catch(() => {})
    }
    return next(e)
  })

  on('command.run', { command: 'agent-flow' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'reset') {
      graph = M.emptyGraph(Date.now())
      demo = null
      dirty = true
      sceneUrgent = true
    }
    if (arg === 'web' || arg === 'web demo') {
      let page = ''
      try {
        page = await installPage($)
        if (arg === 'web demo') {
          // the page plays its own scripted run (contexts, packets, a failing agent): a copy flagged to do so
          const html = (await $.fs.read(`${$.plugin.root}/web/index.html`)) as string
          page = `${web.root}/demo.html`
          await $.fs.write(page, html.replace('<head>', '<head><script>window.__AF_DEMO = true</script>'))
        }
      } catch (err) {
        return { text: `Couldn't set up the browser view: ${String(err)}` }
      }
      web.on = true
      web.dirty = true
      packetsWritten = -1
      ctxWritten = -1
      for (const id of graph.order) wantContext(id)
      void heartbeat($).catch(() => {})
      await $.store.set(WEB_STORE_KEY, true).catch(() => {})
      const opened = await openInBrowser($, page)
      return {
        text: opened
          ? arg === 'web demo'
            ? 'AGENT//FLOW is playing a demo run in your browser. For this session live, run /agent-flow web.'
            : `AGENT//FLOW is open in your browser on this session's tab (${session.project}). Every session with the mod shows up there as a tab; /agent-flow web off stops this one.`
          : `AGENT//FLOW is ready, but no browser could be opened from here. Open this file in a browser: ${page}`,
      }
    }
    if (arg === 'web off') {
      web.on = false
      ctxQueue.clear()
      await $.store.set(WEB_STORE_KEY, false).catch(() => {})
      return { text: 'The browser view stopped updating.' }
    }
    if (arg === 'demo') startDemo(Date.now())
    if (arg === 'pixels on' || arg === 'pixels off' || arg === 'pixels auto') {
      pixelsForced = arg === 'pixels on' ? true : arg === 'pixels off' ? false : null
      dirty = true
      sceneUrgent = true
      await $.ui.open({ id: PANE, title: TITLE })
      return {
        text: `Pixel orbs ${pixelsForced === null ? `auto (this terminal: ${pixelsOk ? 'pictures supported' : 'no pictures'})` : pixelsForced ? 'on' : 'off'}.`,
      }
    }
    if (arg === 'compact' || arg === 'detail') await update($, viewAtom, () => arg)
    if (arg === 'advisor') {
      const rep = sessionAdvisor(graph)
      const lines = [
        'AGENT//FLOW Token & Prompt Advisor',
        `Session Efficiency Score: ${rep.overallScore}/100 (${rep.overallScore >= 85 ? 'Optimal' : rep.overallScore >= 70 ? 'Good' : rep.overallScore >= 50 ? 'Moderate Waste' : 'High Token Bleed'})`,
        `Estimated Cost: $${rep.totalCost.toFixed(2)} · Prompt Cache Saved: $${rep.totalSaved.toFixed(2)} (${Math.round(rep.cacheRate * 100)}% cache hit)`,
        `Total Tokens: ${M.fmt(rep.totalTokens)} across ${graph.order.length} agent(s)`,
      ]
      if (rep.topSuggestions.length > 0) {
        lines.push('', 'Top Prompt & Token Recommendations:')
        for (const s of rep.topSuggestions) {
          lines.push(`• [${s.severity.toUpperCase()}] ${s.title}`)
          lines.push(`  ${s.summary}`)
          if (s.snippet) lines.push(`  Tip: ${s.snippet}`)
          if (s.potentialSavings) lines.push(`  Savings: ${s.potentialSavings}`)
        }
      } else {
        lines.push('', 'All prompts and token caches are operating at optimal efficiency!')
      }
      return { text: lines.join('\n') }
    }
    graph.opened = true
    if (arg === 'status') {
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      lastOpen = opened.isPlaced ? 'placed' : `not placed: ${'reason' in opened ? String(opened.reason) : 'no reason given'}`
      const draws = Object.entries(drawsBySurface).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'
      const ago = lastDrawAt ? `${Math.round((Date.now() - lastDrawAt) / 1000)}s ago` : 'never'
      return {
        text: [
          `pane: ${lastOpen}`,
          `drawn by: ${draws} (last ${ago})`,
          `agents: ${graph.order.length} · packets: ${graph.links.length} · demo: ${demo ? 'running' : 'off'}`,
        ].join('\n'),
      }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    lastOpen = opened.isPlaced ? 'placed' : `not placed: ${'reason' in opened ? String(opened.reason) : 'no reason given'}`
    if (!opened.isPlaced) return { text: `The agent map is open but this window does not place panes (${lastOpen}).` }
    if (arg === 'reset') return { text: 'Agent map cleared and opened.' }
    if (arg === 'demo') return { text: 'Playing a 20-second demo run on the agent map.' }
    if (arg === 'compact' || arg === 'detail') return { text: `Agent map opened in ${arg} view.` }
    return { text: 'Agent map opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    let agentId: string | undefined
    try {
      agentId = typeof res === 'object' && res !== null && 'agentId' in res ? res.agentId : undefined
    } catch {
      agentId = undefined
    }
    if (!agentId) return res
    const spawned = agentId
    const model = 'model' in res ? res.model : undefined
    track((g, now) => {
      M.spawn(
        g,
        {
          id: spawned,
          parent: e.parentAgentId,
          type: e.subagentType,
          description: e.description,
          prompt: e.prompt,
          model,
          name: e.name,
        },
        now,
      )
      const meta: PacketDetail['meta'] = {
        'Agent type': e.subagentType,
        'Asked to': e.description,
        Model: model ?? e.model ?? 'inherits the parent',
        "Parent's model": e.parentModel,
        'Runs in the background': e.background,
        'Fork (inherits the parent context)': e.fork,
      }
      if (e.name) meta.Name = e.name
      if (e.permissionMode) meta['Permission mode'] = e.permissionMode
      if (e.cwd) meta['Working directory'] = e.cwd
      if (e.isTeammate) meta.Teammate = true
      recordPacket(g.links.at(-1), e.prompt, meta)
    }, true)
    wantContext(spawned)
    if (!graph.opened) {
      graph.opened = true
      void $.ui
        .open({ id: PANE, title: TITLE })
        .then(o => {
          lastOpen = o.isPlaced ? 'placed' : `not placed: ${'reason' in o ? String(o.reason) : 'no reason given'}`
        })
        .catch(() => {})
    }
    return res
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    track((g, now) => M.turnStart(g, e.agentId ?? M.MAIN, now), true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId ?? M.MAIN
    track((g, now) => M.stepStart(g, id, e.model, now))
    wantContext(id)
    const stream = next(e)
    for await (const chunk of stream) {
      // reading the chunk is bookkeeping too: inside track, so a malformed chunk never breaks the stream
      track((g, now) => {
        const piece = chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text : chunk.kind === 'input' ? chunk.json : undefined
        if (typeof piece === 'string' && piece.length > 0) M.stepChunk(g, id, piece.length, now)
      })
      yield chunk
    }
    const result = await stream.result
    track((g, now) => {
      M.stepEnd(g, id, result.usage, now)
      const kept = contexts[id]
      if (kept) kept.ctxTok = g.agents[id]?.ctxTok
    })
    return result
  })

  on('turn.complete', ($, e, next) => {
    const id = e.agentId ?? M.MAIN
    track((g, now) => {
      const before = g.links.length > 0 ? g.links[g.links.length - 1] : undefined
      M.turnComplete(g, id, { answer: e.answer, reason: e.reason }, now)
      const a = g.agents[id]
      const ok = !e.isAborted && e.reason !== 'error' && e.reason !== 'refusal'
      if (id === M.MAIN) {
        if (ok) recordDuration(MAIN_TURN, e.durationMs)
        return
      }
      const report = g.links.at(-1)
      if (!a || !report || report === before) return
      if (ok && a.startedAt) recordDuration(a.type, now - a.startedAt)
      recordPacket(report, e.answer, {
        Outcome: e.isAborted ? 'aborted' : e.reason,
        'Ran for': `${Math.round((now - a.startedAt) / 1000)}s`,
        'Tokens read': a.inTok,
        'Tokens written': a.outTok,
        Requests: a.steps,
        'Tool calls': a.tools,
      })
    }, true)
    wantContext(id)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? M.MAIN
    const args = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    let processId: string | undefined
    track((g, now) => {
      const detail = M.toolDetail(tool, args)
      M.toolStart(g, id, M.summarizeTool(tool, args), now, tool, detail)
      if (tool === 'TodoWrite') M.setTodos(g, id, args.todos, now)
      if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
        M.taskUpdate(g, args.taskId, {
          status: typeof args.status === 'string' ? args.status : undefined,
          subject: typeof args.subject === 'string' ? args.subject : undefined,
          active: typeof args.activeForm === 'string' ? args.activeForm : undefined,
        })
      }
      // Bash calling an external process: show it as a child node on the map
      if (tool === 'Bash') {
        const command = typeof args.command === 'string' ? args.command : ''
        const description = typeof args.description === 'string' ? args.description : ''
        processId = M.processStart(g, id, command, description, now)
      }
    }, true)
    let out: Awaited<ReturnType<typeof next>> | undefined
    try {
      out = await next(e)
      return out
    } finally {
      track((g, now) => {
        M.toolEnd(g, id, now)
        if (tool === 'TaskCreate' && out && typeof out === 'object' && 'result' in out) {
          const r = (out as { result?: unknown }).result as { task?: { id?: unknown; subject?: unknown } } | undefined
          const taskId = r?.task && typeof r.task.id === 'string' ? r.task.id : undefined
          M.taskCreate(g, id, taskId, String(args.subject ?? r?.task?.subject ?? ''), typeof args.activeForm === 'string' ? args.activeForm : undefined, now)
        }
        // Complete the process node when the Bash tool finishes
        if (processId) {
          let success = true
          let resultText = ''
          if (out && typeof out === 'object' && 'result' in out) {
            const r = out as { result?: unknown }
            const res = r.result as Record<string, unknown> | undefined
            if (res) {
              const exitCode = typeof res.exitCode === 'number' ? res.exitCode : typeof res.exit_code === 'number' ? res.exit_code : undefined
              success = exitCode === undefined || exitCode === 0
              resultText = typeof res.stdout === 'string' ? res.stdout : typeof res.output === 'string' ? res.output : ''
              if (!success && typeof res.stderr === 'string' && res.stderr) resultText = res.stderr
            }
          }
          M.processEnd(g, processId, success, resultText, now)
        }
      }, tool === 'TaskCreate' || !!processId)
    }
  }).catch(($, e, next) => next(e))

  on('session.send', ($, e, next) => {
    track((g, now) => {
      const link = M.message(g, e.agentId ?? M.MAIN, e.to, e.text, now)
      recordPacket(link, e.text, { 'Addressed to': e.to, 'Sent by': e.origin.kind })
    }, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = Date.now()
    drawsBySurface[e.surface] = (drawsBySurface[e.surface] ?? 0) + 1
    lastDrawAt = now

    const view = await read($, viewAtom)
    const next = view === 'compact' ? ('detail' as const) : ('compact' as const)
    const toggleLabel = view === 'compact' ? '▦ detail' : '◎ compact'
    const flip = () => update($, viewAtom, () => next)
    const table = $.ui.resolve(e)

    if (e.surface !== 'terminal' && 'Svg' in table) {
      const { Svg, Box, Button } = table
      const g = await read($, sceneAtom)
      const { source, alt } = view === 'compact' ? buildOrbSvg(g, now) : buildSvg(g, now)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="view" plain label={toggleLabel} onPress={flip} />
          </Box>
          <Svg source={source} alt={alt} isInteractive />
        </Box>
      )
    }

    const { Box, Text, Button } = table

    // compact on a terminal that shows pictures: real pixels, animated by blits
    const usePixels = pixelsForced ?? pixelsOk
    if (view === 'compact' && usePixels && 'Image' in table && e.props.bodyColumns >= 40) {
      const { Image } = table
      const columns = Math.min(255, e.props.bodyColumns)
      const rows = Math.max(10, Math.min(255, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - 1))
      const frame = renderPixels(graph, now, columns, rows)
      pixelImage = { columns: frame.columns, rows: frame.rows }
      raster = null
      const t = M.totals(graph)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="view" plain label={toggleLabel} onPress={flip} />
          </Box>
          <Image
            key={PIXEL_KEY}
            columns={frame.columns}
            rows={frame.rows}
            source={{ png: toBase64(frame.png) }}
            alt={`Agent flow: ${t.agents} agents, ${t.running} running (this terminal shows no pictures: /agent-flow pixels off)`}
          />
        </Box>
      )
    }
    pixelImage = null

    // compact on the terminal: neon orbs painted into a Raster, animated by blits
    if (view === 'compact' && 'Raster' in table && e.props.bodyColumns >= 40) {
      const { Raster } = table
      const columns = Math.min(512, e.props.bodyColumns)
      const rows = Math.max(10, Math.min(256, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30) - 1))
      const frame = renderRaster(graph, now, columns, rows)
      raster = { columns: frame.columns, rows: frame.rows }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="view" plain label={toggleLabel} onPress={flip} />
          </Box>
          <Raster key={RASTER_KEY} columns={frame.columns} rows={frame.rows} cells={frame.cells} />
        </Box>
      )
    }
    raster = null

    // the text views redraw from state; the picture views above are fed frames by timers instead,
    // so a token count changing does not rebuild and swap the whole picture mid-animation
    const g = await read($, graphAtom)
    const tick = await read($, tickAtom)
    const cols = Math.max(30, e.props.bodyColumns)
    const t = M.totals(g)

    const wire = (len: number, color: string, forward: boolean, isLive: boolean) => {
      const n = Math.max(4, len)
      const at = isLive ? (forward ? tick % n : n - 1 - (tick % n)) : -1
      const cells: RenderChildren[] = []
      for (let k = 0; k < n; k += 1) {
        if (k === at) cells.push(<Text color="#FFFFFF" bold>●</Text>)
        else if (isLive && Math.abs(k - at) === 1) cells.push(<Text color={color} bold>━</Text>)
        else cells.push(<Text color={color} dimColor={!isLive}>━</Text>)
      }
      return cells
    }

    if (view === 'compact') {
      const lines: RenderChildren[] = [
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color="#00F0FF" bold>◎ AGENT//FLOW </Text>
            <Text color="#39FF14">{t.running} live</Text>
            <Text color="#7FE7FF"> {M.fmt(t.inTok)}</Text>
            <Text color="#8888AA">/</Text>
            <Text color="#FF9BEA">{M.fmt(t.outTok)}</Text>
            <Text color="#FFE600"> ⚡{t.tps.toFixed(0)}</Text>
          </Text>
          <Button key="view" plain label={toggleLabel} onPress={flip} />
        </Box>,
      ]
      // packets in flight on the terminal: a spark crosses the wire once, the receiver flashes on landing
      const TRAVEL = 2000
      const LAND = 1200
      const flying = M.packets(g, now, TRAVEL, LAND)
      const spark = (n: number, color: string, frac: number | undefined, forward: boolean) => {
        const at = frac === undefined ? -1 : Math.min(n - 1, Math.floor(frac * n))
        const pos = forward ? at : at < 0 ? -1 : n - 1 - at
        const cells: RenderChildren[] = []
        for (let k = 0; k < n; k += 1) {
          if (k === pos) cells.push(<Text color="#FFFFFF" bold>●</Text>)
          else if (pos >= 0 && (forward ? k === pos - 1 : k === pos + 1)) cells.push(<Text color={color} bold>━</Text>)
          else cells.push(<Text color={color} dimColor>━</Text>)
        }
        return cells
      }
      const landing = (id: string) => flying.find(p => p.link.to === id && p.elapsed >= TRAVEL)
      for (const { id, depth } of M.treeOrder(g)) {
        const a = g.agents[id]
        if (!a) continue
        const c = a.status === 'error' ? '#FF3864' : M.neon(a.color)
        const running = a.status === 'running'
        const parent = a.parent ?? M.MAIN
        const onWire = flying.find(
          p => p.elapsed < TRAVEL && ((p.link.from === parent && p.link.to === id) || (p.link.from === id && p.link.to === parent)),
        )
        const hit = landing(id)
        const glyph = hit ? '✦' : a.isProcess
          ? (a.status === 'done' ? '⚙' : a.status === 'error' ? '⚙✗' : '⚙⟳')
          : a.status === 'done' ? '◉' : a.status === 'error' ? '⊗' : running ? '●' : '○'
        const out = a.outTok + Math.round(a.liveOut)
        const elapsed = a.endedAt ? Math.round((a.endedAt - a.startedAt) / 1000) : Math.round((now - a.startedAt) / 1000)
        lines.push(
          <Text wrap="truncate">
            {depth > 0 ? ' '.repeat(Math.max(0, (depth - 1) * 3)) : ''}
            {depth > 0 ? <Text color={c}>┗</Text> : ''}
            {depth > 0 ? spark(6, c, onWire ? onWire.elapsed / TRAVEL : undefined, onWire ? onWire.link.from === parent : true) : ''}
            <Text color={hit ? '#FFFFFF' : c} backgroundColor={hit ? M.neon(g.agents[hit.link.from]?.color ?? 0) : undefined} bold>
              {depth > 0 ? ' ' : ''}
              {glyph} {a.label}
            </Text>
            {hit ? <Text color={M.neon(g.agents[hit.link.from]?.color ?? 0)} bold> +{M.fmt(hit.link.tokens)}</Text> : ''}
            {a.isProcess ? (
              <Text color="#8888AA"> {elapsed}s</Text>
            ) : (
              <>
                <Text color="#7FE7FF"> {M.fmt(a.inTok)}</Text>
                <Text color="#8888AA">/</Text>
                <Text color="#FF9BEA">{M.fmt(out)}</Text>
              </>
            )}
            {running && a.tps > 0 ? <Text color="#FFE600"> ⚡{a.tps.toFixed(0)}</Text> : ''}
            <Text color="#8888AA"> {a.activity ? `${a.activity}${a.activeStartedAt ? ` [${Math.round((now - a.activeStartedAt) / 1000)}s]` : ''}` : a.role}</Text>
          </Text>,
        )
      }
      for (const p of flying) {
        if (p.link.kind !== 'message' || p.elapsed >= TRAVEL) continue
        const from = g.agents[p.link.from]
        const to = g.agents[p.link.to]
        const fc = M.neon(from?.color ?? 0)
        lines.push(
          <Text wrap="truncate">
            <Text color={fc} bold>✉ {from?.label ?? p.link.from} </Text>
            {spark(8, fc, p.elapsed / TRAVEL, true)}
            <Text color={M.neon(to?.color ?? 0)} bold>▶ {to?.label ?? p.link.to}</Text>
            <Text color="#7FE7FF"> {M.fmt(p.link.tokens)} tok</Text>
          </Text>,
        )
      }
      return <Box flexDirection="column">{lines}</Box>
    }

    const rows: RenderChildren[] = []
    rows.push(
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="#00F0FF" bold>
            ◢◤ AGENT//FLOW ◢◤
          </Text>
          <Button key="view" plain label={toggleLabel} onPress={flip} />
        </Box>
        <Text>
          <Text color="#C9C9E8">{t.agents} agents · </Text>
          <Text color="#39FF14">{t.running} running</Text>
          <Text color="#7FE7FF"> · in {M.fmt(t.inTok)}</Text>
          <Text color="#FF9BEA"> · out {M.fmt(t.outTok)}</Text>
          <Text color="#FFE600"> · ⚡ {t.tps.toFixed(0)} tok/s</Text>
        </Text>
      </Box>,
    )

    for (const { id, depth } of M.treeOrder(g)) {
      const a = g.agents[id]
      if (!a) continue
      const c = M.neon(a.color)
      const indent = Math.min(depth * 3, 12)
      const width = cols - indent
      if (depth > 0) {
        const parent = a.parent ?? M.MAIN
        const spawnL = M.lastLink(g, parent, id, 'spawn')
        const reportL = M.lastLink(g, id, parent, 'report')
        const reportHot = reportL !== undefined && now - reportL.at < M.HOT_MS
        const live = a.status === 'running' || reportHot
        const label = [
          spawnL ? `↓task ${M.fmt(spawnL.tokens)}` : '',
          reportL ? `↑report ${M.fmt(reportL.tokens)}` : '',
        ]
          .filter(Boolean)
          .join(' ')
        const wireLen = Math.max(4, Math.min(16, width - label.length - 6))
        rows.push(
          <Text>
            {' '.repeat(Math.max(0, indent - 2))}
            <Text color={c}>┗</Text>
            {wire(wireLen, c, !reportHot, live)}
            <Text color={c} bold>
              ▶{' '}
            </Text>
            <Text color={c}>{label}</Text>
          </Text>,
        )
      }
      const out = a.outTok + Math.round(a.liveOut)
      const toolTimer = a.activeStartedAt ? ` (${Math.round((now - a.activeStartedAt) / 1000)}s)` : ''
      const doing = a.activity ? `▶ ${a.activity}${toolTimer}` : a.task ? `“${a.task}”` : a.role
      const detailElapsed = a.endedAt ? Math.round((a.endedAt - a.startedAt) / 1000) : Math.round((now - a.startedAt) / 1000)
      rows.push(
        <Box flexDirection="row">
          <Text>{' '.repeat(indent)}</Text>
          <Box
            flexDirection="column"
            borderStyle={a.status === 'running' ? 'bold' : 'round'}
            borderColor={c}
            borderDimColor={a.status === 'done' || a.status === 'idle'}
            paddingX={1}
            width={width}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text color={c} bold wrap="truncate">
                {a.isProcess ? '⚙' : a.status === 'running' && tick % 2 === 0 ? '◉' : '○'} {a.label}
                <Text color={c} dimColor>
                  {' '}
                  · {a.id === M.MAIN ? 'orchestrator' : a.isProcess ? 'external process' : a.type}
                </Text>
              </Text>
              <Text color={STATUS_COLOR[a.status]} bold>
                {a.status.toUpperCase()}
              </Text>
            </Box>
            <Text color="#C9C9E8" wrap="truncate">
              {a.role}
            </Text>
            <Text color={a.activity ? '#FFFFFF' : '#9A9AC0'} wrap="truncate">
              {doing}
            </Text>
            {a.activeDetail ? (
              <Text color="#7FE7FF" wrap="truncate">
                $ {a.activeDetail}
              </Text>
            ) : null}
            {a.isProcess ? (
              <Text color="#8888AA" wrap="truncate">
                ⏱ {detailElapsed}s {a.result ? `· ${a.result.slice(0, 40)}` : ''}
              </Text>
            ) : (
              <Text wrap="truncate">
                <Text color="#7FE7FF">in {M.fmt(a.inTok)}</Text>
                <Text color="#FF9BEA"> out {M.fmt(out)}</Text>
                {a.status === 'running' && a.tps > 0 ? (
                  <Text color="#FFE600"> ⚡ {a.tps.toFixed(0)} tok/s</Text>
                ) : a.peakTps > 0 ? (
                  <Text color="#FFE600" dimColor>
                    {' '}
                    peak {a.peakTps.toFixed(0)} tok/s
                  </Text>
                ) : (
                  <Text> </Text>
                )}
                <Text color="#6E6E95"> · {a.steps} req · {a.tools} tools</Text>
              </Text>
            )}
          </Box>
        </Box>,
      )
    }

    const room = Math.max(3, Math.min(8, (e.viewport?.rows ?? 30) - 6 - g.order.length * 6))
    const feed = g.links.slice(-room).reverse()
    rows.push(
      <Text color="#FF2BD6" bold>
        ─── DATA WIRE ───
      </Text>,
    )
    if (feed.length === 0) rows.push(<Text color="#8888AA">No traffic yet: spawn a subagent to light the wires.</Text>)
    for (const l of feed) {
      const from = g.agents[l.from]
      const to = g.agents[l.to]
      const fc = from ? M.neon(from.color) : '#FFFFFF'
      const tc = to ? M.neon(to.color) : '#FFFFFF'
      const hot = now - l.at < M.HOT_MS
      const kind = l.kind === 'spawn' ? '↓TASK' : l.kind === 'report' ? '↑REPORT' : '✉MSG'
      rows.push(
        <Text wrap="truncate">
          <Text color="#8888AA">{String(Math.round((now - l.at) / 1000)).padStart(3)}s </Text>
          <Text color={fc} bold>
            {from?.label ?? l.from}
          </Text>{' '}
          {wire(5, fc, true, hot)}
          <Text color={tc} bold>
            ▶ {to?.label ?? l.to}
          </Text>
          <Text color="#FFE600"> {kind}</Text>
          <Text color="#7FE7FF"> {M.fmt(l.tokens)}tok</Text>
          <Text color="#C9C9E8"> {l.text}</Text>
        </Text>,
      )
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}
