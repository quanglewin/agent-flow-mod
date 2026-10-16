/**
 * A small PNG encoder for RGBA frames, written for an environment with no zlib and no canvas:
 * the "Up" row filter turns the mostly dark, mostly still picture into long runs of zeros,
 * and a fixed-Huffman deflate with a hashed LZ77 match search folds those runs away.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i += 1) c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  const MOD = 65521
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 3800)
    for (; i < end; i += 1) {
      a += bytes[i] ?? 0
      b += a
    }
    a %= MOD
    b %= MOD
  }
  return ((b << 16) | a) >>> 0
}

class BitWriter {
  buf: Uint8Array
  pos = 0
  bit = 0
  acc = 0
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(1024, size))
  }
  private grow(): void {
    const next = new Uint8Array(this.buf.length * 2)
    next.set(this.buf)
    this.buf = next
  }
  /** `n` bits of `v`, least significant first (deflate's order for everything but Huffman codes). */
  bits(v: number, n: number): void {
    this.acc |= v << this.bit
    this.bit += n
    while (this.bit >= 8) {
      if (this.pos >= this.buf.length) this.grow()
      this.buf[this.pos++] = this.acc & 0xff
      this.acc >>>= 8
      this.bit -= 8
    }
  }
  /** A Huffman code of `n` bits, most significant first. */
  code(v: number, n: number): void {
    let r = 0
    for (let i = 0; i < n; i += 1) r = (r << 1) | ((v >> i) & 1)
    this.bits(r, n)
  }
  flush(): Uint8Array {
    if (this.bit > 0) {
      if (this.pos >= this.buf.length) this.grow()
      this.buf[this.pos++] = this.acc & 0xff
      this.acc = 0
      this.bit = 0
    }
    return this.buf.subarray(0, this.pos)
  }
}

function literal(w: BitWriter, v: number): void {
  if (v < 144) w.code(0x30 + v, 8)
  else if (v < 256) w.code(0x190 + v - 144, 9)
  else if (v < 280) w.code(v - 256, 7)
  else w.code(0xc0 + v - 280, 8)
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

function match(w: BitWriter, len: number, dist: number): void {
  let li = LEN_BASE.length - 1
  while ((LEN_BASE[li] ?? 0) > len) li -= 1
  literal(w, 257 + li)
  const le = LEN_EXTRA[li] ?? 0
  if (le) w.bits(len - (LEN_BASE[li] ?? 0), le)
  let di = DIST_BASE.length - 1
  while ((DIST_BASE[di] ?? 0) > dist) di -= 1
  w.code(di, 5)
  const de = DIST_EXTRA[di] ?? 0
  if (de) w.bits(dist - (DIST_BASE[di] ?? 0), de)
}

/** zlib stream (header, one fixed-Huffman deflate block, Adler-32) of `data`. */
export function zlib(data: Uint8Array): Uint8Array {
  const w = new BitWriter(data.length >> 2)
  w.bits(0x78, 8)
  w.bits(0x01, 8)
  w.bits(1, 1) // final block
  w.bits(1, 2) // fixed Huffman
  const HASH_BITS = 15
  const head = new Int32Array(1 << HASH_BITS).fill(-1)
  const prev = new Int32Array(data.length)
  const WINDOW = 32768
  const n = data.length
  const hashAt = (i: number) =>
    ((((data[i] ?? 0) << 10) ^ ((data[i + 1] ?? 0) << 5) ^ (data[i + 2] ?? 0)) * 2654435761) >>> (32 - HASH_BITS)
  let i = 0
  while (i < n) {
    let bestLen = 0
    let bestDist = 0
    if (i + 2 < n) {
      const h = hashAt(i)
      let cand = head[h] ?? -1
      let tries = 3
      while (cand >= 0 && i - cand <= WINDOW && tries > 0) {
        let l = 0
        const max = Math.min(258, n - i)
        while (l < max && data[cand + l] === data[i + l]) l += 1
        if (l > bestLen) {
          bestLen = l
          bestDist = i - cand
          if (l === max) break
        }
        cand = prev[cand] ?? -1
        tries -= 1
      }
      prev[i] = head[h] ?? -1
      head[h] = i
    }
    if (bestLen >= 3) {
      match(w, bestLen, bestDist)
      // index the bytes the match covered (sparsely past the first few, for speed on long runs)
      const end = i + bestLen
      for (let j = i + 1; j < end && j + 2 < n; j += bestLen > 32 ? 7 : 1) {
        const h = hashAt(j)
        prev[j] = head[h] ?? -1
        head[h] = j
      }
      i = end
    } else {
      literal(w, data[i] ?? 0)
      i += 1
    }
  }
  literal(w, 256) // end of block
  const body = w.flush()
  const out = new Uint8Array(body.length + 4)
  out.set(body)
  const ad = adler32(data)
  out[body.length] = (ad >>> 24) & 0xff
  out[body.length + 1] = (ad >>> 16) & 0xff
  out[body.length + 2] = (ad >>> 8) & 0xff
  out[body.length + 3] = ad & 0xff
  return out
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length)
  const len = payload.length
  out[0] = (len >>> 24) & 0xff
  out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff
  out[3] = len & 0xff
  for (let k = 0; k < 4; k += 1) out[4 + k] = type.charCodeAt(k)
  out.set(payload, 8)
  const c = crc32(out, 4, 8 + len)
  out[8 + len] = (c >>> 24) & 0xff
  out[9 + len] = (c >>> 16) & 0xff
  out[10 + len] = (c >>> 8) & 0xff
  out[11 + len] = c & 0xff
  return out
}

/** A whole PNG of `width × height` RGBA pixels. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const o = y * (stride + 1)
    const row = y * stride
    if (y === 0) {
      raw[o] = 0
      raw.set(rgba.subarray(row, row + stride), o + 1)
    } else {
      raw[o] = 2 // Up: each byte minus the one above it
      const up = row - stride
      for (let x = 0; x < stride; x += 1) raw[o + 1 + x] = ((rgba[row + x] ?? 0) - (rgba[up + x] ?? 0)) & 0xff
    }
  }
  const ihdr = new Uint8Array(13)
  ihdr[0] = (width >>> 24) & 0xff
  ihdr[1] = (width >>> 16) & 0xff
  ihdr[2] = (width >>> 8) & 0xff
  ihdr[3] = width & 0xff
  ihdr[4] = (height >>> 24) & 0xff
  ihdr[5] = (height >>> 16) & 0xff
  ihdr[6] = (height >>> 8) & 0xff
  ihdr[7] = height & 0xff
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', zlib(raw)), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
