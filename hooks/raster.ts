import type { AgentFlowAgent, AgentFlowGraph } from '../types'
import { MAIN, clip, fmt, packets, totals, treeOrder } from './model'

/**
 * The compact view for the terminal: a Raster of half-block cells, so every cell holds two
 * square-ish pixels (▀: foreground is the top pixel, background the bottom one). Orbs, wires,
 * glow and flying packets are painted into that pixel buffer; labels are written into cells.
 * A pure function of (graph, now, size), so a timer can blit frames without a render pass.
 */

const NEON_RGB: readonly [number, number, number][] = [
  [0x00, 0xf0, 0xff],
  [0xff, 0x2b, 0xd6],
  [0x39, 0xff, 0x14],
  [0xff, 0xe6, 0x00],
  [0xb0, 0x26, 0xff],
  [0xff, 0x8a, 0x00],
  [0xff, 0x38, 0x64],
  [0x00, 0xff, 0xa3],
]
const ERROR_RGB: [number, number, number] = [0xff, 0x38, 0x64]
const WHITE: [number, number, number] = [255, 255, 255]

/** Packet timing on the terminal: a little slower than the desktop's so a 15fps frame sees it travel. */
export const RASTER_TRAVEL_MS = 1800
export const RASTER_IMPACT_MS = 1200

type RGB = [number, number, number]
type Pt = { x: number; y: number }
type Orb = { x: number; y: number; r: number; a: AgentFlowAgent; c: RGB }

function rgbOf(a: AgentFlowAgent): RGB {
  if (a.status === 'error') return ERROR_RGB
  return NEON_RGB[((a.color % NEON_RGB.length) + NEON_RGB.length) % NEON_RGB.length] ?? NEON_RGB[0]!
}

class Canvas {
  readonly w: number
  readonly h: number
  readonly px: Float32Array
  constructor(w: number, h: number) {
    this.w = w
    this.h = h
    this.px = new Float32Array(w * h * 3)
    // background: deep navy to violet, top to bottom
    for (let y = 0; y < h; y += 1) {
      const t = h <= 1 ? 0 : y / (h - 1)
      const r = 5 + 8 * t
      const g = 5 - 1 * t
      const b = 13 + 19 * t
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 3
        this.px[i] = r
        this.px[i + 1] = g
        this.px[i + 2] = b
      }
    }
  }
  add(x: number, y: number, c: RGB, k: number): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h || k <= 0) return
    const i = (yi * this.w + xi) * 3
    this.px[i] = (this.px[i] ?? 0) + c[0] * k
    this.px[i + 1] = (this.px[i + 1] ?? 0) + c[1] * k
    this.px[i + 2] = (this.px[i + 2] ?? 0) + c[2] * k
  }
  /** A soft glowing dot: bright core, falling off over `radius` pixels. */
  glow(x: number, y: number, c: RGB, radius: number, k: number): void {
    const r = Math.ceil(radius)
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        const d = Math.hypot(dx, dy)
        if (d > radius) continue
        const f = 1 - d / radius
        this.add(x + dx, y + dy, c, k * f * f)
      }
    }
  }
  color(x: number, y: number): number {
    const i = (y * this.w + x) * 3
    const r = Math.max(0, Math.min(255, Math.round(this.px[i] ?? 0)))
    const g = Math.max(0, Math.min(255, Math.round(this.px[i + 1] ?? 0)))
    const b = Math.max(0, Math.min(255, Math.round(this.px[i + 2] ?? 0)))
    return (r << 16) | (g << 8) | b
  }
}

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

type Path = (t: number) => Pt

/** The wire from a parent orb down to a child orb, leaving below the parent's labels. */
function treeWire(from: Orb, to: Orb, labelPx: number): Path {
  const p0 = { x: from.x, y: from.y + from.r + labelPx + 1 }
  const p3 = { x: to.x, y: to.y - to.r - 2 }
  const my = (p0.y + p3.y) / 2
  return t => bezier(p0, { x: p0.x, y: my }, { x: p3.x, y: my }, p3, t)
}

/** An arc between any two orbs (messages), bowing upward. */
function arc(from: Orb, to: Orb): Path {
  const p0 = { x: from.x, y: from.y - from.r - 1 }
  const p3 = { x: to.x, y: to.y - to.r - 1 }
  const lift = Math.max(6, Math.abs(p3.x - p0.x) / 4)
  const top = Math.min(p0.y, p3.y) - lift
  return t => bezier(p0, { x: p0.x, y: top }, { x: p3.x, y: top }, p3, t)
}

function strokePath(cv: Canvas, path: Path, c: RGB, k: number): void {
  const a = path(0)
  const b = path(1)
  const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2.2))
  for (let s = 0; s <= steps; s += 1) {
    const p = path(s / steps)
    cv.add(p.x, p.y, c, k)
  }
}

function drawOrb(cv: Canvas, o: Orb, now: number): void {
  const { x, y, r, a, c } = o
  const running = a.status === 'running'
  const dim = a.status === 'done' || a.status === 'idle' ? 0.55 : 1
  const R = Math.ceil(r + 6)
  for (let dy = -R; dy <= R; dy += 1) {
    for (let dx = -R; dx <= R; dx += 1) {
      const d = Math.hypot(dx, dy)
      if (d <= r - 1.2) {
        // core: radial gradient, bright centre fading to dark at the rim
        const f = 1 - d / r
        cv.add(x + dx, y + dy, c, (0.12 + 0.55 * f * f) * dim)
      } else if (d <= r + 0.6) {
        // the neon ring
        cv.add(x + dx, y + dy, c, 1.05 * dim)
        cv.add(x + dx, y + dy, WHITE, 0.18 * dim)
      } else if (d <= r + 5) {
        // outer glow
        const f = 1 - (d - r) / 5
        cv.add(x + dx, y + dy, c, 0.32 * f * f * dim)
      }
    }
  }
  if (!running) return
  // a dashed halo turning slowly around the orb
  const hr = r + 2.5
  const spin = ((now / 1000) * Math.PI * 2) / 6
  const n = Math.max(24, Math.ceil(hr * 7))
  for (let k = 0; k < n; k += 1) {
    const ang = (k / n) * Math.PI * 2
    if (Math.floor(((ang + spin) / (Math.PI * 2)) * 12) % 2 === 0) continue
    cv.add(x + Math.cos(ang) * hr, y + Math.sin(ang) * hr, c, 0.75)
  }
  // a heartbeat ring spreading outward
  const beat = ((now / 1000) % 1.8) / 1.8
  const br = r + beat * 9
  const bn = Math.ceil(br * 7)
  for (let k = 0; k < bn; k += 1) {
    const ang = (k / bn) * Math.PI * 2
    cv.add(x + Math.cos(ang) * br, y + Math.sin(ang) * br, c, 0.55 * (1 - beat))
  }
}

function ringBurst(cv: Canvas, o: Orb, c: RGB, t: number): void {
  // t in 0..1 after landing: the orb flashes, a ring spreads out and fades
  const flash = Math.max(0, 1 - t * 2.5)
  if (flash > 0) {
    for (let dy = -Math.ceil(o.r); dy <= Math.ceil(o.r); dy += 1) {
      for (let dx = -Math.ceil(o.r); dx <= Math.ceil(o.r); dx += 1) {
        if (Math.hypot(dx, dy) <= o.r) cv.add(o.x + dx, o.y + dy, c, 0.6 * flash)
      }
    }
  }
  const rr = o.r + 1 + t * 14
  const n = Math.ceil(rr * 7)
  for (let k = 0; k < n; k += 1) {
    const ang = (k / n) * Math.PI * 2
    cv.add(o.x + Math.cos(ang) * rr, o.y + Math.sin(ang) * rr, c, 1.1 * (1 - t))
    if (t > 0.1) cv.add(o.x + Math.cos(ang) * (rr - 4), o.y + Math.sin(ang) * (rr - 4), WHITE, 0.5 * (1 - t))
  }
}

function comet(cv: Canvas, path: Path, c: RGB, t: number): void {
  // the head, white with the sender's halo, and a fading tail behind it
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  for (let k = 7; k >= 1; k -= 1) {
    const tt = ease - k * 0.025
    if (tt < 0) continue
    const p = path(tt)
    cv.glow(p.x, p.y, c, 2.2, 0.55 * (1 - k / 8))
  }
  const p = path(ease)
  cv.glow(p.x, p.y, c, 4.5, 0.9)
  cv.glow(p.x, p.y, WHITE, 1.6, 1.4)
}

type Label = { col: number; row: number; text: string; fg: number; bold?: boolean }

function rgbInt(c: RGB): number {
  return (c[0] << 16) | (c[1] << 8) | c[2]
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

/** Characters a Raster cell takes: printable, one column wide. Anything else becomes a space. */
function safeChar(ch: string): number {
  const cp = ch.codePointAt(0) ?? 32
  if (cp < 32 || cp === 127 || cp > 0xffff) return 32
  // wide East Asian blocks and emoji ranges are not one column
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)) return 32
  if (cp >= 0xf900 && cp <= 0xfaff) return 32
  if (cp >= 0xfe30 && cp <= 0xfe4f) return 32
  if (cp >= 0xff00 && cp <= 0xff60) return 32
  if (cp >= 0xd800 && cp <= 0xdfff) return 32
  return cp
}

export type RasterFrame = { cells: string; columns: number; rows: number; text: string[] }

/**
 * Paints one frame. `columns` × `rows` are the Raster's cells; the pixel buffer is
 * columns × rows*2. `text` is the same frame's characters row by row, for tests and alt.
 */
export function renderRaster(g: AgentFlowGraph, now: number, columns: number, rows: number): RasterFrame {
  const cols = Math.max(20, Math.min(512, Math.floor(columns)))
  const rws = Math.max(6, Math.min(256, Math.floor(rows)))
  const W = cols
  const H = rws * 2
  const cv = new Canvas(W, H)
  const labels: Label[] = []

  // layout: one band of orbs per tree depth
  const bands: string[][] = []
  for (const { id, depth } of treeOrder(g)) (bands[depth] ?? (bands[depth] = [])).push(id)
  const HEADER_PX = 4
  const LABEL_PX = 8 // three text rows under each orb, and a little air
  const avail = H - HEADER_PX - 2
  const bandCount = Math.max(1, bands.length)
  const bandH = Math.max(18, Math.min(32, Math.floor(avail / bandCount)))
  const rMax = Math.max(3, Math.min(7, Math.floor((bandH - LABEL_PX - 8) / 2)))
  const orbs: Record<string, Orb> = {}
  bands.forEach((ids, depth) => {
    const slot = W / ids.length
    ids.forEach((id, k) => {
      const a = g.agents[id]
      if (!a) return
      const tok = a.inTok + a.outTok + a.liveOut
      const scale = tok <= 0 ? 0 : Math.min(1, Math.log10(tok + 1) / 6)
      const r = Math.max(3, rMax - 2 + 2 * scale)
      orbs[id] = {
        x: Math.round(slot * k + slot / 2),
        y: Math.round(HEADER_PX + depth * bandH + rMax + 3),
        r,
        a,
        c: rgbOf(a),
      }
    })
  })

  // wires parent → child
  const wires: Record<string, Path> = {}
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || id === MAIN) continue
    const from = orbs[a.parent ?? MAIN]
    const to = orbs[id]
    if (!from || !to) continue
    const path = treeWire(from, to, LABEL_PX)
    wires[`${from.a.id}>${id}`] = path
    strokePath(cv, path, to.c, a.status === 'running' ? 0.42 : 0.2)
  }

  for (const o of Object.values(orbs)) drawOrb(cv, o, now)

  // packets: a comet from sender to receiver, then a burst on the receiver
  for (const { link, elapsed } of packets(g, now, RASTER_TRAVEL_MS, RASTER_IMPACT_MS)) {
    const from = orbs[link.from]
    const to = orbs[link.to]
    if (!from || !to || link.from === link.to) continue
    const c = from.c
    let path: Path | undefined
    if (link.kind === 'spawn') path = wires[`${link.from}>${link.to}`]
    else if (link.kind === 'report') {
      const down = wires[`${link.to}>${link.from}`]
      if (down) path = t => down(1 - t)
    }
    if (!path) path = arc(from, to)
    if (elapsed < RASTER_TRAVEL_MS) {
      const t = elapsed / RASTER_TRAVEL_MS
      comet(cv, path, c, t)
      const p = path(Math.min(1, t))
      const tag = `${link.kind === 'spawn' ? '↓' : link.kind === 'report' ? '↑' : '⇢'}${fmt(link.tokens)}`
      labels.push({ col: Math.round(p.x) + 2, row: Math.floor(p.y / 2), text: tag, fg: rgbInt(c), bold: true })
    } else {
      const t = (elapsed - RASTER_TRAVEL_MS) / RASTER_IMPACT_MS
      ringBurst(cv, to, c, t)
      const rise = Math.floor(t * 3)
      labels.push({
        col: Math.round(to.x + to.r + 2),
        row: Math.floor((to.y - to.r) / 2) - rise,
        text: `+${fmt(link.tokens)} tok`,
        fg: rgbInt(c),
        bold: true,
      })
    }
  }

  // labels: number in the orb, name and tokens beneath it
  for (const o of Object.values(orbs)) {
    const a = o.a
    const running = a.status === 'running'
    const mid = running && a.tps > 0 ? `${Math.round(a.tps)}` : a.status === 'done' ? '✓' : a.status === 'error' ? '!' : '·'
    labels.push({ col: Math.round(o.x - (mid.length - 1) / 2), row: Math.floor(o.y / 2), text: mid, fg: 0xffffff, bold: true })
    const nameRow = Math.floor((o.y + o.r + 2) / 2) + 1
    const name = clip(a.label, Math.max(6, Math.floor(W / Math.max(1, (bands.find(b => b.includes(a.id)) ?? []).length)) - 2))
    labels.push({ col: Math.round(o.x - name.length / 2), row: nameRow, text: name, fg: rgbInt(o.c), bold: true })
    const out = a.outTok + Math.round(a.liveOut)
    const doing = clip(a.activity ?? a.role, 22)
    const stat = `${fmt(a.inTok)}/${fmt(out)}`
    labels.push({ col: Math.round(o.x - stat.length / 2), row: nameRow + 1, text: stat, fg: 0x7fe7ff })
    labels.push({ col: Math.round(o.x - doing.length / 2), row: nameRow + 2, text: doing, fg: 0x9a9ac0 })
  }

  // header
  const t = totals(g)
  labels.push({
    col: 1,
    row: 0,
    text: `AGENT//FLOW  ${t.agents} agents · ${t.running} live · ${fmt(t.inTok)} in / ${fmt(t.outTok)} out · ${Math.round(t.tps)} tok/s`,
    fg: 0x00f0ff,
    bold: true,
  })

  // compose cells: ▀ with top/bottom pixels, then labels over them
  const words = new Uint32Array(cols * rws * 3)
  const text: string[][] = Array.from({ length: rws }, () => Array.from({ length: cols }, () => ' '))
  for (let row = 0; row < rws; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const i = (row * cols + col) * 3
      words[i] = 0x2580
      words[i + 1] = cv.color(col, row * 2)
      words[i + 2] = cv.color(col, row * 2 + 1)
    }
  }
  for (const l of labels) {
    if (l.row < 0 || l.row >= rws) continue
    let col = l.col
    for (const ch of l.text) {
      if (col >= 0 && col < cols) {
        const i = (l.row * cols + col) * 3
        const top = words[i + 1] ?? 0
        const bottom = words[i + 2] ?? 0
        // the cell's background becomes the average of its two pixels, so text sits on the picture
        const avg =
          ((((top >> 16) & 255) + ((bottom >> 16) & 255)) >> 1) * 65536 +
          ((((top >> 8) & 255) + ((bottom >> 8) & 255)) >> 1) * 256 +
          (((top & 255) + (bottom & 255)) >> 1)
        words[i] = safeChar(ch)
        words[i + 1] = l.fg
        words[i + 2] = Math.round(avg * 0.55) === avg ? avg : darken(avg, 0.55)
        const row = text[l.row]
        if (row) row[col] = ch
      }
      col += 1
    }
  }
  const cells = toBase64(new Uint8Array(words.buffer))
  return { cells, columns: cols, rows: rws, text: text.map(r => r.join('')) }
}

/** Text over a bright pixel needs a darker backdrop to stay readable. */
function darken(c: number, k: number): number {
  const r = Math.round(((c >> 16) & 255) * k)
  const g = Math.round(((c >> 8) & 255) * k)
  const b = Math.round((c & 255) * k)
  return (r << 16) | (g << 8) | b
}
