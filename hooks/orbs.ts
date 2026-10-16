import type { AgentFlowAgent, AgentFlowGraph, AgentFlowLink } from '../types'
import { HOT_MS, IMPACT_MS, MAIN, PACKET_MS, clip, fmt, lastLink, neon, packets, totals, treeOrder } from './model'

/** Compact view: every agent is a glowing orb, wires carry particles between them. */

const CELL_W = 150
const CELL_H = 175
const PAD = 24
const HEADER = 50
const R_MIN = 20
const R_MAX = 36

type Orb = { x: number; y: number; r: number }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function phase(now: number, dur: number): number {
  return -((now / 1000) % dur)
}

/** Bigger orb for an agent that moved more tokens (log scale). */
function radius(a: AgentFlowAgent): number {
  const tok = a.inTok + a.outTok + a.liveOut
  if (tok <= 0) return R_MIN
  const t = Math.min(1, Math.log10(tok + 1) / 6)
  return R_MIN + (R_MAX - R_MIN) * t
}

function place(g: AgentFlowGraph): { orbs: Record<string, Orb>; width: number; height: number } {
  const rows: string[][] = []
  for (const { id, depth } of treeOrder(g)) (rows[depth] ?? (rows[depth] = [])).push(id)
  const widest = Math.max(1, ...rows.map(r => r.length))
  const width = Math.max(320, PAD * 2 + widest * CELL_W)
  const height = HEADER + rows.length * CELL_H - 20
  const orbs: Record<string, Orb> = {}
  rows.forEach((row, depth) => {
    const left = (width - row.length * CELL_W) / 2
    row.forEach((id, k) => {
      const a = g.agents[id]
      if (!a) return
      orbs[id] = { x: left + CELL_W * k + CELL_W / 2, y: HEADER + depth * CELL_H + 50, r: radius(a) }
    })
  })
  return { orbs, width, height }
}

function orb(a: AgentFlowAgent, o: Orb, now: number): string {
  const c = a.status === 'error' ? '#FF3864' : neon(a.color)
  const running = a.status === 'running'
  const dim = a.status === 'done' || a.status === 'idle'
  const out = a.outTok + Math.round(a.liveOut)
  const center = running && a.tps > 0 ? `${a.tps.toFixed(0)}` : a.status === 'done' ? '✓' : a.status === 'error' ? '!' : '·'
  const unit = running && a.tps > 0 ? 'tok/s' : ''
  const halo = running
    ? `<circle r="${(o.r + 10).toFixed(1)}" fill="none" stroke="${c}" stroke-width="1.2" stroke-dasharray="4 6" filter="url(#glow)"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="6s" begin="${phase(now, 6).toFixed(3)}s" repeatCount="indefinite"/></circle>
       <circle r="${o.r.toFixed(1)}" fill="none" stroke="${c}" stroke-width="2"><animate attributeName="r" values="${o.r.toFixed(1)};${(o.r + 16).toFixed(1)}" dur="1.8s" begin="${phase(now, 1.8).toFixed(3)}s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" values="0.8;0" dur="1.8s" begin="${phase(now, 1.8).toFixed(3)}s" repeatCount="indefinite"/></circle>`
    : ''
  return `
  <g transform="translate(${o.x.toFixed(1)},${o.y.toFixed(1)})">
    <title>${esc(`${a.label} · ${a.type}\nRole: ${a.role}\n${a.activity ? `Now: ${a.activity}\n` : ''}In ${a.inTok} · Out ${out} tok\nPeak ${a.peakTps.toFixed(0)} tok/s · ${a.steps} requests · ${a.tools} tools\n${a.model ?? ''}`)}</title>
    ${halo}
    <circle r="${o.r.toFixed(1)}" fill="url(#core${a.color % 8})" fill-opacity="${dim ? 0.35 : 0.85}"/>
    <circle r="${o.r.toFixed(1)}" fill="none" stroke="${c}" stroke-width="${running ? 2.6 : 1.6}" stroke-opacity="${dim ? 0.6 : 1}" filter="url(#glow)"/>
    <text y="${unit ? 2 : 5}" class="core" fill="#FFFFFF">${esc(center)}</text>
    ${unit ? `<text y="13" class="unit" fill="#FFFFFF" fill-opacity="0.8">${unit}</text>` : ''}
    <text y="${(o.r + 18).toFixed(1)}" class="name" fill="${c}">${esc(clip(a.label, 16))}</text>
    <text y="${(o.r + 31).toFixed(1)}" class="role">${esc(clip(a.activity ?? a.role, 22))}</text>
    <text y="${(o.r + 44).toFixed(1)}" class="stat"><tspan fill="#7FE7FF">${fmt(a.inTok)}</tspan><tspan fill="#8888AA"> / </tspan><tspan fill="#FF9BEA">${fmt(out)}</tspan></text>
  </g>`
}

function wire(g: AgentFlowGraph, a: AgentFlowAgent, from: Orb, to: Orb, now: number, i: number): string {
  const c = neon(a.color)
  const x1 = from.x
  const y1 = from.y + from.r + 52
  const x2 = to.x
  const y2 = to.y - to.r - 12
  const dx = x2 - x1
  const my = (y1 + y2) / 2
  const id = `w${i}`
  const running = a.status === 'running'
  const report = lastLink(g, a.id, a.parent ?? MAIN, 'report')
  const reportHot = report !== undefined && now - report.at < HOT_MS
  const spawn = lastLink(g, a.parent ?? MAIN, a.id, 'spawn')
  const tok = [spawn ? `↓${fmt(spawn.tokens)}` : '', report ? `↑${fmt(report.tokens)}` : ''].filter(Boolean).join(' ')
  return `
  <path id="${id}" d="M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${c}" stroke-width="1.6" stroke-opacity="${running || reportHot ? 0.7 : 0.2}" filter="url(#glow)"/>
  <text x="${(x2 + (dx >= 0 ? 8 : -8)).toFixed(1)}" y="${(y2 - 4).toFixed(1)}" class="tok" fill="${c}" text-anchor="${dx >= 0 ? 'start' : 'end'}" fill-opacity="${running || reportHot ? 1 : 0.55}">${esc(tok)}</text>`
}

function chat(g: AgentFlowGraph, orbs: Record<string, Orb>, now: number): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (let k = g.links.length - 1; k >= 0; k -= 1) {
    const l = g.links[k]
    if (!l || l.kind !== 'message') continue
    const key = [l.from, l.to].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    const a = orbs[l.from]
    const b = orbs[l.to]
    if (!a || !b || l.from === l.to) continue
    const hot = now - l.at < HOT_MS * 1.5
    const c = neon(g.agents[l.from]?.color ?? 0)
    const mx = (a.x + b.x) / 2
    const my = Math.min(a.y, b.y) - 46
    const id = `c${k}`
    out.push(`<path id="${id}" d="M${a.x.toFixed(1)},${(a.y - a.r).toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${(b.y - b.r).toFixed(1)}" fill="none" stroke="${c}" stroke-width="1.3" stroke-dasharray="3 5" stroke-opacity="${hot ? 0.9 : 0.25}"/>
      <text x="${mx.toFixed(1)}" y="${((a.y - a.r + b.y - b.r) / 4 + my / 2 - 4).toFixed(1)}" class="tok" text-anchor="middle" fill="${c}">✉ ${fmt(l.tokens)}</text>`)
  }
  return out.join('')
}

const KIND_TEXT = { spawn: '↓ task', report: '↑ report', message: '✉ msg' } as const

/** One packet: a comet from sender to receiver, then a flash on the receiver. Plays once. */
function packet(g: AgentFlowGraph, orbs: Record<string, Orb>, link: AgentFlowLink, elapsed: number): string {
  const a = orbs[link.from]
  const b = orbs[link.to]
  if (!a || !b || link.from === link.to) return ''
  const c = neon(g.agents[link.from]?.color ?? 0)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.max(1, Math.hypot(dx, dy))
  const ux = dx / len
  const uy = dy / len
  // tasks and reports bow to opposite sides, so a reply never hides its order
  const side = link.kind === 'report' ? -1 : 1
  const bow = Math.min(70, len * 0.22) * side
  const x0 = a.x + ux * (a.r + 2)
  const y0 = a.y + uy * (a.r + 2)
  const ex = b.x - ux * (b.r + 2)
  const ey = b.y - uy * (b.r + 2)
  const cx = (x0 + ex) / 2 - uy * bow
  const cy = (y0 + ey) / 2 + ux * bow
  const id = `pk${link.id}`
  const D = PACKET_MS / 1000
  const t0 = -elapsed / 1000
  const land = t0 + D
  const fmtS = (n: number) => `${n.toFixed(3)}s`
  const fade = (dur: number, begin: number, values = '0;1;1;0', times = '0;0.06;0.9;1') =>
    `<animate attributeName="opacity" values="${values}" keyTimes="${times}" dur="${dur.toFixed(2)}s" begin="${fmtS(begin)}" fill="freeze"/>`
  const ride = (begin: number) =>
    `<animateMotion dur="${D.toFixed(2)}s" begin="${fmtS(begin)}" fill="freeze" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.45 0 0.25 1"><mpath href="#${id}" xlink:href="#${id}"/></animateMotion>`
  const tail = [0.05, 0.1, 0.15, 0.2]
    .map((lag, k) => `<circle r="${(3.4 - k * 0.6).toFixed(1)}" fill="${c}" opacity="0">${ride(t0 - lag)}${fade(D, t0 - lag, `0;${(0.7 - k * 0.15).toFixed(2)};${(0.7 - k * 0.15).toFixed(2)};0`)}</circle>`)
    .join('')
  return `
  <g class="packet">
    <path id="${id}" d="M${x0.toFixed(1)},${y0.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="2 6" opacity="0">${fade(D + 0.3, t0, '0;0.55;0.55;0', '0;0.08;0.8;1')}</path>
    <circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="${a.r.toFixed(1)}" fill="none" stroke="${c}" stroke-width="2.5" opacity="0" filter="url(#glow)"><animate attributeName="r" values="${(a.r + 12).toFixed(1)};${a.r.toFixed(1)}" dur="0.45s" begin="${fmtS(t0)}" fill="freeze"/>${fade(0.45, t0, '0;1;0', '0;0.3;1')}</circle>
    ${tail}
    <circle r="9" fill="${c}" opacity="0" filter="url(#glow)">${ride(t0)}${fade(D, t0, '0;0.65;0.65;0')}</circle>
    <circle r="4.5" fill="#FFFFFF" opacity="0">${ride(t0)}${fade(D, t0)}</circle>
    <text class="pk" fill="${c}" dy="-13" opacity="0">${ride(t0)}${fade(D, t0)}${esc(`${KIND_TEXT[link.kind]} ${fmt(link.tokens)}`)}</text>
    <circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${b.r.toFixed(1)}" fill="${c}" opacity="0">${fade(0.6, land, '0;0.8;0', '0;0.25;1')}</circle>
    <circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${b.r.toFixed(1)}" fill="none" stroke="${c}" stroke-width="3" opacity="0" filter="url(#glow)"><animate attributeName="r" values="${b.r.toFixed(1)};${(b.r + 28).toFixed(1)}" dur="0.9s" begin="${fmtS(land)}" fill="freeze"/>${fade(0.9, land, '0;1;0', '0;0.1;1')}</circle>
    <circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${b.r.toFixed(1)}" fill="none" stroke="#FFFFFF" stroke-width="1.5" opacity="0"><animate attributeName="r" values="${b.r.toFixed(1)};${(b.r + 18).toFixed(1)}" dur="0.7s" begin="${fmtS(land + 0.15)}" fill="freeze"/>${fade(0.7, land + 0.15, '0;0.9;0', '0;0.1;1')}</circle>
    <text x="${(b.x + b.r + 6).toFixed(1)}" y="${(b.y - b.r).toFixed(1)}" class="pop" fill="${c}" opacity="0"><animate attributeName="y" values="${(b.y - b.r).toFixed(1)};${(b.y - b.r - 20).toFixed(1)}" dur="${(IMPACT_MS / 1000).toFixed(2)}s" begin="${fmtS(land)}" fill="freeze"/>${fade(IMPACT_MS / 1000, land, '0;1;1;0', '0;0.1;0.6;1')}+${esc(fmt(link.tokens))} tok</text>
  </g>`
}

export function buildOrbSvg(g: AgentFlowGraph, now: number): { source: string; alt: string } {
  const { orbs, width, height } = place(g)
  const t = totals(g)
  const wires: string[] = []
  let i = 0
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || id === MAIN) continue
    const from = orbs[a.parent ?? MAIN]
    const to = orbs[id]
    if (from && to) wires.push(wire(g, a, from, to, now, i++))
  }
  const cores = Array.from({ length: 8 }, (_, k) => {
    const c = neon(k)
    return `<radialGradient id="core${k}"><stop offset="0" stop-color="${c}" stop-opacity="0.95"/><stop offset="0.55" stop-color="${c}" stop-opacity="0.35"/><stop offset="1" stop-color="#05050D" stop-opacity="0.9"/></radialGradient>`
  }).join('')
  const nodes = treeOrder(g)
    .map(({ id }) => {
      const a = g.agents[id]
      const o = orbs[id]
      return a && o ? orb(a, o, now) : ''
    })
    .join('')
  const source = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" width="100%" font-family="'JetBrains Mono','SF Mono',Menlo,Consolas,monospace">
  <defs>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    ${cores}
    <radialGradient id="bg" cx="50%" cy="30%" r="80%"><stop offset="0" stop-color="#140A2E"/><stop offset="1" stop-color="#05050D"/></radialGradient>
    <style>
      .title{font-size:13px;font-weight:700;letter-spacing:3px}
      .sub{font-size:10.5px;fill:#9A9AC0}
      .core{font-size:13px;font-weight:800;text-anchor:middle}
      .unit{font-size:7px;text-anchor:middle;letter-spacing:.5px}
      .name{font-size:11.5px;font-weight:700;text-anchor:middle}
      .role{font-size:9.5px;fill:#B9B9D6;text-anchor:middle}
      .stat{font-size:9.5px;font-weight:600;text-anchor:middle}
      .tok{font-size:9.5px;font-weight:700}
      .pk{font-size:9.5px;font-weight:800;text-anchor:middle}
      .pop{font-size:11px;font-weight:800}
    </style>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <text x="${PAD}" y="24" class="title" fill="#00F0FF" filter="url(#glow)">AGENT//FLOW</text>
  <text x="${PAD}" y="40" class="sub">${t.agents} agents · ${t.running} live · ${fmt(t.inTok)} in / ${fmt(t.outTok)} out · ⚡ ${t.tps.toFixed(0)} tok/s</text>
  ${wires.join('')}
  ${chat(g, orbs, now)}
  ${nodes}
  ${packets(g, now).map(p => packet(g, orbs, p.link, p.elapsed)).join('')}
</svg>`
  return { source, alt: `Agent flow (compact): ${t.agents} agents, ${t.running} running, ${fmt(t.inTok)} in, ${fmt(t.outTok)} out` }
}
