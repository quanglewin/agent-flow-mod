import type { AgentFlowAgent, AgentFlowGraph } from '../types'
import { GLYPHS, GLYPH_DATA, GLYPH_H, GLYPH_W } from './font'
import { MAIN, clip, fmt, packets, totals, treeOrder } from './model'
import { encodePng } from './png'

/**
 * The compact view at real pixel resolution, for terminals with the kitty graphics protocol
 * (Ghostty, kitty): antialiased orbs with neon glow, curved wires, comets with tails and a
 * burst where a packet lands, labels drawn from a bitmap font. A pure function of
 * (graph, now, size) returning a PNG, so a timer can swap frames in with $.ui.blit.
 */

/** Pixels per terminal cell: about a cell's shape, so circles stay round. */
export const PX_PER_COL = 6
export const PX_PER_ROW = 12
export const PIXEL_TRAVEL_MS = 1600
export const PIXEL_IMPACT_MS = 1100

type RGB = [number, number, number]
type Pt = { x: number; y: number }
type Orb = { x: number; y: number; r: number; a: AgentFlowAgent; c: RGB }
type Path = (t: number) => Pt

const NEON: readonly RGB[] = [
  [0, 240, 255],
  [255, 43, 214],
  [57, 255, 20],
  [255, 230, 0],
  [176, 38, 255],
  [255, 138, 0],
  [255, 56, 100],
  [0, 255, 163],
]
const WHITE: RGB = [255, 255, 255]
const CYAN_TEXT: RGB = [127, 231, 255]
const PINK_TEXT: RGB = [255, 155, 234]
const MUTED: RGB = [170, 170, 210]

function rgbOf(a: AgentFlowAgent): RGB {
  if (a.status === 'error') return [255, 56, 100]
  return NEON[((a.color % NEON.length) + NEON.length) % NEON.length] ?? WHITE
}

let atlas: Uint8Array | null = null
function glyphs(): Uint8Array {
  if (atlas) return atlas
  const bin = atob(GLYPH_DATA)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  atlas = out
  return out
}

let bgCache: { w: number; h: number; px: Float32Array } | null = null

/** The backdrop (a violet glow fading to near black, with a faint dot grid), computed once per size. */
function background(w: number, h: number): Float32Array {
  if (bgCache && bgCache.w === w && bgCache.h === h) return bgCache.px
  const px = new Float32Array(w * h * 3)
  const cx = w / 2
  const cy = h * 0.3
  const R = Math.hypot(w, h) * 0.75
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const t = Math.min(1, Math.hypot(x - cx, y - cy) / R)
      const i = (y * w + x) * 3
      const dot = x % 24 === 0 && y % 24 === 0 ? 10 : 0
      px[i] = 20 * (1 - t) + 5 * t + dot * 0.6
      px[i + 1] = 10 * (1 - t) + 5 * t + dot * 0.6
      px[i + 2] = 46 * (1 - t) + 13 * t + dot
    }
  }
  bgCache = { w, h, px }
  return px
}

class Frame {
  readonly w: number
  readonly h: number
  readonly px: Float32Array
  constructor(w: number, h: number, from?: Float32Array) {
    this.w = w
    this.h = h
    this.px = new Float32Array(w * h * 3)
    this.px.set(from ?? background(w, h))
  }
  add(x: number, y: number, c: RGB, k: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || k <= 0) return
    const i = (y * this.w + x) * 3
    this.px[i] = (this.px[i] ?? 0) + c[0] * k
    this.px[i + 1] = (this.px[i + 1] ?? 0) + c[1] * k
    this.px[i + 2] = (this.px[i + 2] ?? 0) + c[2] * k
  }
  mix(x: number, y: number, c: RGB, a: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return
    const i = (y * this.w + x) * 3
    this.px[i] = (this.px[i] ?? 0) * (1 - a) + c[0] * a
    this.px[i + 1] = (this.px[i + 1] ?? 0) * (1 - a) + c[1] * a
    this.px[i + 2] = (this.px[i + 2] ?? 0) * (1 - a) + c[2] * a
  }
  /** A soft round light: full at the centre, smooth to nothing at `radius`. */
  splat(x: number, y: number, c: RGB, radius: number, k: number): void {
    const r = Math.ceil(radius)
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    for (let dy = -r; dy <= r + 1; dy += 1) {
      for (let dx = -r; dx <= r + 1; dx += 1) {
        const d = Math.hypot(x0 + dx - x, y0 + dy - y)
        if (d >= radius) continue
        const f = 1 - d / radius
        this.add(x0 + dx, y0 + dy, c, k * f * f * (3 - 2 * f))
      }
    }
  }
  text(x: number, y: number, s: string, c: RGB, alpha = 1): void {
    const g = glyphs()
    let cx = Math.round(x)
    const cy = Math.round(y)
    for (const ch of s) {
      const gi = GLYPHS.indexOf(ch)
      if (gi >= 0) {
        const base = gi * GLYPH_W * GLYPH_H
        for (let gy = 0; gy < GLYPH_H; gy += 1) {
          for (let gx = 0; gx < GLYPH_W; gx += 1) {
            const a = ((g[base + gy * GLYPH_W + gx] ?? 0) / 255) * alpha
            if (a <= 0.01) continue
            this.mix(cx + gx + 1, cy + gy + 1, [0, 0, 0], a * 0.75) // shadow, so text reads over glow
            this.mix(cx + gx, cy + gy, c, a)
          }
        }
      }
      cx += GLYPH_W
    }
  }
  textCentered(x: number, y: number, s: string, c: RGB, alpha = 1): void {
    this.text(x - (s.length * GLYPH_W) / 2, y, s, c, alpha)
  }
  rgba(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4)
    const px = this.px
    for (let p = 0, q = 0; p < px.length; p += 3, q += 4) {
      out[q] = tone(px[p] ?? 0)
      out[q + 1] = tone(px[p + 1] ?? 0)
      out[q + 2] = tone(px[p + 2] ?? 0)
      out[q + 3] = 255
    }
    return out
  }
}

/** A soft shoulder instead of a hard clip, so bright overlaps bloom to white smoothly (a lookup table). */
const TONE = (() => {
  const t = new Uint8Array(1024)
  for (let v = 0; v < 1024; v += 1) t[v] = v <= 200 ? v : Math.min(255, Math.round(200 + 55 * (1 - Math.exp(-(v - 200) / 80))))
  return t
})()
function tone(v: number): number {
  return v <= 0 ? 0 : (TONE[v >= 1023 ? 1023 : v | 0] ?? 255)
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

function length(path: Path): number {
  let L = 0
  let p = path(0)
  for (let s = 1; s <= 16; s += 1) {
    const q = path(s / 16)
    L += Math.hypot(q.x - p.x, q.y - p.y)
    p = q
  }
  return L
}

function stroke(f: Frame, path: Path, c: RGB, core: number, glow: number): void {
  const steps = Math.max(12, Math.ceil(length(path) * 1.6))
  for (let s = 0; s <= steps; s += 1) {
    const p = path(s / steps)
    f.splat(p.x, p.y, c, 1.4, core)
    if (glow > 0 && s % 4 === 0) f.splat(p.x, p.y, c, 5, glow * 1.6)
  }
}

function orbBody(f: Frame, o: Orb): void {
  const { x, y, r, a, c } = o
  const dim = a.status === 'done' || a.status === 'idle' ? 0.6 : 1
  const reach = Math.ceil(r + 18)
  const x0 = Math.round(x)
  const y0 = Math.round(y)
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const d = Math.hypot(dx, dy)
      const px = x0 + dx
      const py = y0 + dy
      if (d < r) {
        // the core: a radial gradient, with a soft edge so the disc is antialiased
        const t = d / r
        const edge = Math.min(1, (r - d) / 1.2)
        f.add(px, py, c, (0.1 + 0.42 * (1 - t) * (1 - t)) * dim * edge)
      }
      const ring = 1 - Math.abs(d - r) / 1.6
      if (ring > 0) {
        f.add(px, py, c, 1.05 * ring * dim)
        f.add(px, py, WHITE, 0.25 * ring * dim)
      }
      if (d > r) f.add(px, py, c, 0.38 * Math.exp(-(d - r) / 6) * dim)
    }
  }
}

function orbHalo(f: Frame, o: Orb, now: number): void {
  const { x, y, r, c } = o
  // a dashed halo turning around the orb
  const hr = r + 7
  const spin = (now / 1000) * ((Math.PI * 2) / 6)
  const n = Math.ceil(hr * 9)
  for (let k = 0; k < n; k += 1) {
    const ang = (k / n) * Math.PI * 2
    const phase = (((ang + spin) / (Math.PI * 2)) * 16) % 1
    if (phase > 0.55) continue
    f.splat(x + Math.cos(ang) * hr, y + Math.sin(ang) * hr, c, 1.3, 0.55)
  }
  // a heartbeat ring spreading outward and fading
  const beat = ((now / 1000) % 1.8) / 1.8
  const br = r + beat * 22
  const bn = Math.ceil(br * 7)
  for (let k = 0; k < bn; k += 1) {
    const ang = (k / bn) * Math.PI * 2
    f.splat(x + Math.cos(ang) * br, y + Math.sin(ang) * br, c, 1.6, 0.5 * (1 - beat) * (1 - beat))
  }
}

function comet(f: Frame, path: Path, c: RGB, t: number): void {
  const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  for (let k = 14; k >= 1; k -= 1) {
    const tt = ease - k * 0.012
    if (tt < 0) continue
    const p = path(tt)
    f.splat(p.x, p.y, c, 3.6 - k * 0.18, 0.5 * (1 - k / 15))
  }
  const p = path(ease)
  f.splat(p.x, p.y, c, 13, 0.55)
  f.splat(p.x, p.y, c, 6, 0.9)
  f.splat(p.x, p.y, WHITE, 3.2, 1.6)
}

function burst(f: Frame, o: Orb, c: RGB, t: number): void {
  const flash = Math.max(0, 1 - t * 3)
  if (flash > 0) f.splat(o.x, o.y, c, o.r * 1.15, 0.9 * flash)
  for (const [lag, k, col] of [
    [0, 1.2, c],
    [0.12, 0.8, WHITE],
  ] as const) {
    const tt = Math.max(0, t - lag)
    if (tt <= 0) continue
    const rr = o.r + 2 + tt * 34
    const n = Math.ceil(rr * 7)
    for (let i = 0; i < n; i += 1) {
      const ang = (i / n) * Math.PI * 2
      f.splat(o.x + Math.cos(ang) * rr, o.y + Math.sin(ang) * rr, col, 2, k * (1 - tt) * (1 - tt))
    }
  }
}

let staticLayer: { sig: string; px: Float32Array } | null = null

export type PixelFrame = { png: Uint8Array; width: number; height: number; columns: number; rows: number }

/** One frame for an Image of `columns × rows` cells. */
export function renderPixels(g: AgentFlowGraph, now: number, columns: number, rows: number): PixelFrame {
  const cols = Math.max(20, Math.min(255, Math.floor(columns)))
  const rws = Math.max(8, Math.min(255, Math.floor(rows)))
  const W = Math.min(2048, cols * PX_PER_COL)
  const H = Math.min(2048, rws * PX_PER_ROW)

  const bands: string[][] = []
  for (const { id, depth } of treeOrder(g)) (bands[depth] ?? (bands[depth] = [])).push(id)
  const HEADER = 34
  const LABELS = 3 * GLYPH_H + 6
  const bandH = Math.max(110, Math.min(220, Math.floor((H - HEADER - 8) / Math.max(1, bands.length))))
  const rMax = Math.max(12, Math.min(34, Math.floor((bandH - LABELS - 36) / 2)))
  const orbs: Record<string, Orb> = {}
  bands.forEach((ids, depth) => {
    const slot = W / ids.length
    ids.forEach((id, k) => {
      const a = g.agents[id]
      if (!a) return
      const tok = a.inTok + a.outTok + a.liveOut
      const scale = tok <= 0 ? 0 : Math.min(1, Math.log10(tok + 1) / 6)
      orbs[id] = {
        x: slot * k + slot / 2,
        y: HEADER + depth * bandH + rMax + 18,
        r: rMax * (0.62 + 0.38 * scale),
        a,
        c: rgbOf(a),
      }
    })
  })

  const wires: Record<string, Path> = {}
  const live: Record<string, boolean> = {}
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || id === MAIN) continue
    const from = orbs[a.parent ?? MAIN]
    const to = orbs[id]
    if (!from || !to) continue
    const p0 = { x: from.x, y: from.y + from.r + LABELS + 4 }
    const p3 = { x: to.x, y: to.y - to.r - 10 }
    const my = (p0.y + p3.y) / 2
    wires[`${from.a.id}>${id}`] = t => bezier(p0, { x: p0.x, y: my }, { x: p3.x, y: my }, p3, t)
    live[`${from.a.id}>${id}`] = a.status === 'running'
  }

  // what does not move between frames (backdrop, wires, orb bodies) is painted once per change
  const sig =
    `${W}x${H}|` +
    Object.values(orbs)
      .map(o => `${o.a.id}:${o.x.toFixed(0)},${o.y.toFixed(0)},${o.r.toFixed(1)},${o.a.status},${o.a.color}`)
      .join(';') +
    '|' +
    Object.entries(live)
      .map(([k, v]) => `${k}=${v ? 1 : 0}`)
      .join(';')
  if (!staticLayer || staticLayer.sig !== sig) {
    const base = new Frame(W, H)
    for (const [key, path] of Object.entries(wires)) {
      const childId = key.split('>')[1] ?? ''
      const to = orbs[childId]
      if (!to) continue
      stroke(base, path, to.c, live[key] ? 0.55 : 0.28, live[key] ? 0.06 : 0.025)
    }
    for (const o of Object.values(orbs)) orbBody(base, o)
    staticLayer = { sig, px: base.px }
  }
  const f = new Frame(W, H, staticLayer.px)
  for (const o of Object.values(orbs)) if (o.a.status === 'running') orbHalo(f, o, now)

  const tags: { x: number; y: number; s: string; c: RGB; a: number }[] = []
  for (const { link, elapsed } of packets(g, now, PIXEL_TRAVEL_MS, PIXEL_IMPACT_MS)) {
    const from = orbs[link.from]
    const to = orbs[link.to]
    if (!from || !to || link.from === link.to) continue
    let path: Path | undefined
    if (link.kind === 'spawn') path = wires[`${link.from}>${link.to}`]
    else if (link.kind === 'report') {
      const down = wires[`${link.to}>${link.from}`]
      if (down) path = t => down(1 - t)
    }
    if (!path) {
      const p0 = { x: from.x, y: from.y - from.r - 6 }
      const p3 = { x: to.x, y: to.y - to.r - 6 }
      const top = Math.min(p0.y, p3.y) - Math.max(30, Math.abs(p3.x - p0.x) / 4)
      path = t => bezier(p0, { x: p0.x, y: top }, { x: p3.x, y: top }, p3, t)
    }
    if (elapsed < PIXEL_TRAVEL_MS) {
      const t = elapsed / PIXEL_TRAVEL_MS
      comet(f, path, from.c, t)
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      const p = path(ease)
      const sym = link.kind === 'spawn' ? '↓' : link.kind === 'report' ? '↑' : '⇢'
      tags.push({ x: p.x + 14, y: p.y - 8, s: `${sym} ${fmt(link.tokens)}`, c: from.c, a: Math.min(1, t * 6) })
    } else {
      const t = (elapsed - PIXEL_TRAVEL_MS) / PIXEL_IMPACT_MS
      burst(f, to, from.c, t)
      tags.push({ x: to.x + to.r + 10, y: to.y - to.r - 12 - t * 26, s: `+${fmt(link.tokens)} tok`, c: from.c, a: 1 - t * t })
    }
  }

  // labels
  for (const o of Object.values(orbs)) {
    const a = o.a
    const running = a.status === 'running'
    const mid = running && a.tps > 0 ? `${Math.round(a.tps)}` : a.status === 'done' ? '✓' : a.status === 'error' ? '!' : '·'
    f.textCentered(o.x, o.y - GLYPH_H / 2 - (running && a.tps > 0 ? 5 : 0), mid, WHITE)
    if (running && a.tps > 0) f.textCentered(o.x, o.y + 2, 'tok/s', WHITE, 0.7)
    const band = bands.find(b => b.includes(a.id)) ?? []
    const room = Math.max(8, Math.floor(W / Math.max(1, band.length) / GLYPH_W) - 2)
    const top = o.y + o.r + 8
    f.textCentered(o.x, top, clip(a.label, room), o.c)
    const out = a.outTok + Math.round(a.liveOut)
    const stat = `${fmt(a.inTok)} / ${fmt(out)}`
    f.text(o.x - (stat.length * GLYPH_W) / 2, top + GLYPH_H, fmt(a.inTok), CYAN_TEXT)
    f.text(o.x - (stat.length * GLYPH_W) / 2 + (fmt(a.inTok).length + 3) * GLYPH_W, top + GLYPH_H, fmt(out), PINK_TEXT)
    f.text(o.x - (stat.length * GLYPH_W) / 2 + fmt(a.inTok).length * GLYPH_W, top + GLYPH_H, ' / ', MUTED, 0.6)
    f.textCentered(o.x, top + 2 * GLYPH_H, clip(a.activity ?? a.role, room), MUTED, 0.9)
  }
  for (const t of tags) f.text(t.x, t.y, t.s, t.c, t.a)

  const tt = totals(g)
  f.text(14, 10, 'AGENT//FLOW', [0, 240, 255])
  f.text(14 + 12 * GLYPH_W, 10, `${tt.agents} agents · ${tt.running} live · ${fmt(tt.inTok)} in / ${fmt(tt.outTok)} out · ${Math.round(tt.tps)} tok/s`, MUTED)

  return { png: encodePng(f.rgba(), W, H), width: W, height: H, columns: cols, rows: rws }
}
