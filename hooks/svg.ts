import type { AgentFlowAgent, AgentFlowGraph, AgentFlowLink } from '../types'
import { HOT_MS, MAIN, clip, fmt, lastLink, neon, totals, treeOrder } from './model'

const NODE_W = 250
const NODE_H = 104
const GAP_X = 34
const GAP_Y = 86
const PAD = 26
const HEADER = 64
const FEED_ROW = 19
const FEED_ROWS = 7

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Seconds into a looping animation of `dur`, so a redraw continues where the last one was. */
function phase(now: number, dur: number): string {
  return (-((now / 1000) % dur)).toFixed(3)
}

const STATUS_TEXT: Record<AgentFlowAgent['status'], string> = {
  running: 'RUNNING',
  idle: 'IDLE',
  done: 'DONE',
  error: 'ERROR',
}

type Pos = { x: number; y: number }

function layout(g: AgentFlowGraph): { pos: Record<string, Pos>; width: number; height: number } {
  const rows: string[][] = []
  for (const { id, depth } of treeOrder(g)) {
    const row = rows[depth] ?? (rows[depth] = [])
    row.push(id)
  }
  const widest = Math.max(1, ...rows.map(r => r.length))
  const width = Math.max(560, PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X)
  const pos: Record<string, Pos> = {}
  rows.forEach((row, depth) => {
    const span = row.length * NODE_W + (row.length - 1) * GAP_X
    let x = (width - span) / 2
    for (const id of row) {
      pos[id] = { x, y: HEADER + PAD + depth * (NODE_H + GAP_Y) }
      x += NODE_W + GAP_X
    }
  })
  const height = HEADER + PAD * 2 + rows.length * NODE_H + (rows.length - 1) * GAP_Y + 30 + FEED_ROWS * FEED_ROW
  return { pos, width, height }
}

function node(a: AgentFlowAgent, p: Pos, now: number): string {
  const c = neon(a.color)
  const running = a.status === 'running'
  const dim = a.status === 'done' || a.status === 'idle'
  const out = a.outTok + Math.round(a.liveOut)
  const doing = a.activity ? `▶ ${a.activity}` : a.task ? `“${a.task}”` : a.role
  const speed = running && a.tps > 0 ? `⚡ ${a.tps.toFixed(0)} tok/s` : a.peakTps > 0 ? `peak ${a.peakTps.toFixed(0)} tok/s` : ''
  const pulse = running
    ? `<animate attributeName="stroke-opacity" values="1;0.35;1" dur="1.6s" begin="${phase(now, 1.6)}s" repeatCount="indefinite"/>`
    : ''
  return `
  <g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
    <title>${esc(`${a.label} (${a.type})\nRole: ${a.role}\nTask: ${a.task}\nModel: ${a.model ?? '?'}\nIn ${a.inTok} · Out ${out} · Cache ${a.cacheTok}\nRequests ${a.steps} · Tools ${a.tools}`)}</title>
    <rect width="${NODE_W}" height="${NODE_H}" rx="12" fill="#0B0B1A" fill-opacity="0.92"/>
    <rect width="${NODE_W}" height="${NODE_H}" rx="12" fill="none" stroke="${c}" stroke-width="${running ? 2.2 : 1.4}" stroke-opacity="${dim ? 0.55 : 1}" filter="url(#glow)">${pulse}</rect>
    <circle cx="16" cy="19" r="5" fill="${c}" filter="url(#glow)">${running ? `<animate attributeName="r" values="4;6.5;4" dur="1s" begin="${phase(now, 1)}s" repeatCount="indefinite"/>` : ''}</circle>
    <text x="28" y="24" class="name" fill="${c}">${esc(clip(a.label, 20))}</text>
    <text x="${NODE_W - 12}" y="23" class="badge" fill="${c}" text-anchor="end">${STATUS_TEXT[a.status]}</text>
    <text x="12" y="44" class="role">${esc(clip(a.id === MAIN ? a.role : `${a.type} · ${a.role}`, 38))}</text>
    <text x="12" y="63" class="doing" fill="${a.activity ? '#FFFFFF' : '#B9B9D6'}">${esc(clip(doing, 38))}</text>
    <text x="12" y="85" class="stat"><tspan fill="#7FE7FF">in ${fmt(a.inTok)}</tspan><tspan dx="10" fill="#FF9BEA">out ${fmt(out)}</tspan><tspan dx="10" fill="#FFE600">${esc(speed)}</tspan></text>
    <text x="12" y="99" class="model">${esc(clip(a.model ?? '', 40))}</text>
  </g>`
}

function edge(g: AgentFlowGraph, child: AgentFlowAgent, from: Pos, to: Pos, now: number, i: number): string {
  const c = neon(child.color)
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  const my = (y1 + y2) / 2
  const id = `e${i}`
  const d = `M${x1.toFixed(1)},${y1} C${x1.toFixed(1)},${my} ${x2.toFixed(1)},${my} ${x2.toFixed(1)},${y2}`
  const spawnL = lastLink(g, child.parent ?? MAIN, child.id, 'spawn')
  const reportL = lastLink(g, child.id, child.parent ?? MAIN, 'report')
  const running = child.status === 'running'
  const reportHot = reportL !== undefined && now - reportL.at < HOT_MS
  const speed = Math.max(0.55, Math.min(2.6, 2.6 - child.tps / 45))
  const particles = (forward: boolean, color: string, n: number) =>
    Array.from({ length: n }, (_, k) => {
      const dur = speed
      const offset = Number(phase(now, dur)) - (dur / n) * k
      return `<circle r="${k === 0 ? 4.2 : 3}" fill="${color}" filter="url(#glow)"><animateMotion dur="${dur.toFixed(2)}s" begin="${offset.toFixed(3)}s" repeatCount="indefinite" keyPoints="${forward ? '0;1' : '1;0'}" keyTimes="0;1" calcMode="linear"><mpath href="#${id}" xlink:href="#${id}"/></animateMotion></circle>`
    }).join('')
  const labelParts = [
    spawnL ? `↓ task ${fmt(spawnL.tokens)} tok` : '',
    reportL ? `↑ report ${fmt(reportL.tokens)} tok` : '',
  ].filter(Boolean)
  return `
  <path id="${id}" d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-opacity="${running || reportHot ? 0.55 : 0.22}" filter="url(#glow)"/>
  <path d="${d}" fill="none" stroke="${c}" stroke-width="1" stroke-opacity="0.9" stroke-dasharray="6 10">${running ? `<animate attributeName="stroke-dashoffset" from="16" to="0" dur="${(speed / 2).toFixed(2)}s" begin="${phase(now, speed / 2)}s" repeatCount="indefinite"/>` : ''}</path>
  ${running ? particles(true, c, 3) : ''}
  ${reportHot ? particles(false, '#FFFFFF', 2) : ''}
  <text x="${x2.toFixed(1)}" y="${(y2 - 12).toFixed(1)}" class="wire" text-anchor="middle" fill="${c}">${esc(labelParts.join('  '))}</text>`
}

function messageArc(g: AgentFlowGraph, l: AgentFlowLink, pos: Record<string, Pos>, now: number, i: number): string {
  const a = pos[l.from]
  const b = pos[l.to]
  if (!a || !b || l.from === l.to) return ''
  const hot = now - l.at < HOT_MS * 1.5
  const from = g.agents[l.from]
  const c = from ? neon(from.color) : '#FFFFFF'
  const x1 = a.x + NODE_W / 2
  const y1 = a.y + NODE_H / 2
  const x2 = b.x + NODE_W / 2
  const y2 = b.y + NODE_H / 2
  const lift = Math.max(60, Math.abs(x2 - x1) / 3)
  const d = `M${x1.toFixed(1)},${y1.toFixed(1)} Q${((x1 + x2) / 2).toFixed(1)},${(Math.min(y1, y2) - lift).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
  const id = `m${i}`
  return `
  <path id="${id}" d="${d}" fill="none" stroke="${c}" stroke-width="1.6" stroke-opacity="${hot ? 0.85 : 0.25}" stroke-dasharray="3 7" filter="url(#glow)"/>
  ${hot ? `<circle r="4" fill="${c}" filter="url(#glow)"><animateMotion dur="1.4s" begin="${phase(now, 1.4)}s" repeatCount="indefinite"><mpath href="#${id}" xlink:href="#${id}"/></animateMotion></circle>` : ''}
  <text x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2 + 2 * (Math.min(y1, y2) - lift)) / 4 - 7).toFixed(1)}" class="wire" text-anchor="middle" fill="${c}">✉ ${fmt(l.tokens)} tok</text>`
}

function feed(g: AgentFlowGraph, y: number, width: number, now: number): string {
  const rows = g.links.slice(-FEED_ROWS).reverse()
  const kindIcon = { spawn: '↓ TASK', report: '↑ REPORT', message: '✉ MSG' } as const
  const lines = rows.map((l, k) => {
    const from = g.agents[l.from]
    const to = g.agents[l.to]
    const c = from ? neon(from.color) : '#FFFFFF'
    const ago = Math.max(0, Math.round((now - l.at) / 1000))
    const hot = now - l.at < HOT_MS
    return `<text x="${PAD}" y="${y + 22 + k * FEED_ROW}" class="feed" fill-opacity="${hot ? 1 : 0.6}"><tspan fill="#8888AA">${ago}s</tspan><tspan dx="10" fill="${c}">${esc(from?.label ?? l.from)}</tspan><tspan fill="${c}"> ━━▶ </tspan><tspan fill="${to ? neon(to.color) : '#FFF'}">${esc(to?.label ?? l.to)}</tspan><tspan dx="10" fill="#FFE600">${kindIcon[l.kind]}</tspan><tspan dx="8" fill="#7FE7FF">${fmt(l.tokens)} tok</tspan><tspan dx="10" fill="#C9C9E8">${esc(clip(l.text, Math.max(20, Math.floor((width - 420) / 6.6))))}</tspan></text>`
  })
  return `<text x="${PAD}" y="${y}" class="section">DATA WIRE</text>${lines.join('')}${rows.length === 0 ? `<text x="${PAD}" y="${y + 22}" class="feed" fill="#8888AA">No traffic yet: spawn a subagent to light the wires.</text>` : ''}`
}

export function buildSvg(g: AgentFlowGraph, now: number): { source: string; alt: string } {
  const { pos, width, height } = layout(g)
  const t = totals(g)
  const edges: string[] = []
  let i = 0
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || id === MAIN) continue
    const from = pos[a.parent ?? MAIN]
    const to = pos[id]
    if (from && to) edges.push(edge(g, a, from, to, now, i++))
  }
  const msgs: string[] = []
  const seenPairs = new Set<string>()
  for (let k = g.links.length - 1; k >= 0; k -= 1) {
    const l = g.links[k]
    if (!l || l.kind !== 'message') continue
    const key = [l.from, l.to].sort().join('|')
    if (seenPairs.has(key)) continue
    seenPairs.add(key)
    msgs.push(messageArc(g, l, pos, now, k))
  }
  const nodes = treeOrder(g)
    .map(({ id }) => {
      const a = g.agents[id]
      const p = pos[id]
      return a && p ? node(a, p, now) : ''
    })
    .join('')
  const feedY = height - FEED_ROWS * FEED_ROW - 20
  const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="100%" font-family="'JetBrains Mono','SF Mono',Menlo,Consolas,monospace">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#1A1A3A" stroke-width="1"/></pattern>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05050D"/><stop offset="1" stop-color="#0D0420"/></linearGradient>
    <style>
      .title{font-size:17px;font-weight:700;letter-spacing:3px}
      .sub{font-size:12px;fill:#9A9AC0}
      .name{font-size:14px;font-weight:700}
      .badge{font-size:10px;font-weight:700;letter-spacing:1.5px}
      .role{font-size:11px;fill:#C9C9E8}
      .doing{font-size:11px}
      .stat{font-size:11px;font-weight:600}
      .model{font-size:9px;fill:#6E6E95}
      .wire{font-size:10.5px;font-weight:600}
      .section{font-size:11px;font-weight:700;letter-spacing:3px;fill:#FF2BD6}
      .feed{font-size:11px}
    </style>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#grid)"/>
  <text x="${PAD}" y="30" class="title" fill="#00F0FF" filter="url(#glow)">AGENT//FLOW</text>
  <text x="${PAD}" y="50" class="sub">${t.agents} agents · ${t.running} running · in ${fmt(t.inTok)} · out ${fmt(t.outTok)} tok · ⚡ ${t.tps.toFixed(0)} tok/s live</text>
  ${edges.join('')}
  ${msgs.join('')}
  ${nodes}
  <line x1="${PAD}" x2="${width - PAD}" y1="${feedY - 18}" y2="${feedY - 18}" stroke="#FF2BD6" stroke-opacity="0.35"/>
  ${feed(g, feedY, width, now)}
</svg>`
  const alt = `Agent flow: ${t.agents} agents, ${t.running} running, ${fmt(t.inTok)} tokens in, ${fmt(t.outTok)} out`
  return { source, alt }
}
