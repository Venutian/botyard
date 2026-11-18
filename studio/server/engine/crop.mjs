/**
 * A part of a picture, cut out for a mark: the owner boxed or tapped a place, and the bot is sent that
 * place on its own as well as its position.
 *
 * PNG is read and written here with nothing but zlib, so a screenshot (the usual case) is cut on any
 * computer. Other pictures (JPEG, WebP, GIF) are cut by ffmpeg when it is installed; without it the
 * mark still goes, with the box in pixels and no cut copy, and says so.
 *
 * Boxes are fractions of the picture (0..1) so a mark made on a small phone screen and one made on the
 * PC page mean the same place. A point is a box with no size: it is cut as a square around the point.
 */
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** How much is kept around a box, as a share of the picture, so the bot sees the place in its setting. */
export const MARGIN = 0.04
/** The square cut around a point, as a share of the picture's shorter side. */
export const POINT_SIDE = 0.24
const MAX_PIXELS = 40_000_000

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0))

/** A box the owner drew, made safe: fractions inside the picture, x/y the top left corner. */
export function cleanBox(box = {}) {
  const x = clamp01(box.x)
  const y = clamp01(box.y)
  return { x, y, w: Math.min(clamp01(box.w), 1 - x), h: Math.min(clamp01(box.h), 1 - y) }
}

/** The pixels a box covers on a picture of this size, margin and point square included. */
export function pixelBox(box, width, height) {
  const b = cleanBox(box)
  let left
  let top
  let right
  let bottom
  if (b.w * width < 2 && b.h * height < 2) {
    const side = Math.max(16, Math.round(Math.min(width, height) * POINT_SIDE))
    const cx = Math.round(b.x * width)
    const cy = Math.round(b.y * height)
    left = cx - side / 2
    top = cy - side / 2
    right = cx + side / 2
    bottom = cy + side / 2
  } else {
    const mx = width * MARGIN
    const my = height * MARGIN
    left = b.x * width - mx
    top = b.y * height - my
    right = (b.x + b.w) * width + mx
    bottom = (b.y + b.h) * height + my
  }
  left = Math.max(0, Math.floor(left))
  top = Math.max(0, Math.floor(top))
  right = Math.min(width, Math.ceil(right))
  bottom = Math.min(height, Math.ceil(bottom))
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** The box itself in pixels, no margin: what the message says. */
export function markedPixels(box, width, height) {
  const b = cleanBox(box)
  return { x: Math.round(b.x * width), y: Math.round(b.y * height), w: Math.round(b.w * width), h: Math.round(b.h * height) }
}

/** A picture's size from its first bytes: PNG, JPEG, GIF and WebP. Null when it cannot be told. */
export function sizeOf(bytes) {
  if (!bytes || bytes.length < 24) return null
  if (bytes.subarray(0, 8).equals(SIGNATURE)) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: 'image/png' }
  if (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), type: 'image/gif' }
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16)
    if (kind === 'VP8X' && bytes.length >= 30) return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), type: 'image/webp' }
    if (kind === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, type: 'image/webp' }
    if (kind === 'VP8L' && bytes.length >= 25) {
      const b = bytes.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, type: 'image/webp' }
    }
    return null
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue }
      const marker = bytes[at + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
      const length = bytes.readUInt16BE(at + 2)
      // Start-of-frame markers carry the size; 0xc4, 0xc8 and 0xcc are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5), type: 'image/jpeg' }
      at += 2 + length
    }
  }
  return null
}

// ── PNG ───────────────────────────────────────────────────────────────────────────

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function chunksOf(bytes) {
  const out = []
  let at = 8
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('ascii', at + 4, at + 8)
    out.push({ type, data: bytes.subarray(at + 8, at + 8 + length) })
    at += 12 + length
    if (type === 'IEND') break
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** The rows of a PNG, unfiltered: each `stride` bytes long. Null for what is not read here (interlaced, under 8 bits). */
export function readPng(bytes) {
  if (!bytes?.subarray(0, 8).equals(SIGNATURE)) return null
  const chunks = chunksOf(bytes)
  const head = chunks.find((c) => c.type === 'IHDR')?.data
  if (!head) return null
  const width = head.readUInt32BE(0)
  const height = head.readUInt32BE(4)
  const depth = head[8]
  const colour = head[9]
  const interlace = head[12]
  if (interlace !== 0 || !(colour in CHANNELS) || (depth !== 8 && depth !== 16) || (colour === 3 && depth !== 8)) return null
  if (width * height > MAX_PIXELS) return null
  const bpp = CHANNELS[colour] * (depth / 8)
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  if (raw.length < (stride + 1) * height) return null
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const from = y * (stride + 1) + 1
    const row = y * stride
    const up = row - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[from + i]
      const a = i >= bpp ? pixels[row + i - bpp] : 0
      const b = y > 0 ? pixels[up + i] : 0
      const c = y > 0 && i >= bpp ? pixels[up + i - bpp] : 0
      pixels[row + i] = (filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 0xff
    }
  }
  return { width, height, depth, colour, bpp, stride, pixels, extra: chunks.filter((c) => c.type === 'PLTE' || c.type === 'tRNS') }
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length)
  return out
}

/** A part of a PNG as a PNG of its own, in the same colours. Null when the PNG is not one read here. */
export function cropPng(bytes, area) {
  const png = readPng(bytes)
  if (!png) return null
  const left = Math.min(area.left, png.width - 1)
  const top = Math.min(area.top, png.height - 1)
  const width = Math.min(area.width, png.width - left)
  const height = Math.min(area.height, png.height - top)
  const rowBytes = width * png.bpp
  const raw = Buffer.alloc((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const from = (top + y) * png.stride + left * png.bpp
    png.pixels.copy(raw, y * (rowBytes + 1) + 1, from, from + rowBytes)
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0)
  head.writeUInt32BE(height, 4)
  head[8] = png.depth
  head[9] = png.colour
  return Buffer.concat([SIGNATURE, chunk('IHDR', head), ...png.extra.map((c) => chunk(c.type, c.data)), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Is ffmpeg on this computer? Asked once. */
let ffmpegThere = null
function hasFfmpeg() {
  if (ffmpegThere === null) {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }); ffmpegThere = true } catch { ffmpegThere = false }
  }
  return ffmpegThere
}

function cropWithFfmpeg(bytes, area) {
  if (!hasFfmpeg()) return null
  try {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `crop=${area.width}:${area.height}:${area.left}:${area.top}`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { input: bytes, timeout: 20000, maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/**
 * Cut the marked place out of a picture.
 * @returns {{ size: {width:number,height:number}|null, marked: object|null, area: object|null, png: Buffer|null, why?: string }}
 */
export function cropMark(bytes, box) {
  const size = sizeOf(bytes)
  if (!size) return { size: null, marked: null, area: null, png: null, why: 'the picture\'s size could not be read' }
  const area = pixelBox(box, size.width, size.height)
  const marked = markedPixels(box, size.width, size.height)
  const png = (size.type === 'image/png' ? cropPng(bytes, area) : null) || cropWithFfmpeg(bytes, area)
  return { size: { width: size.width, height: size.height }, marked, area, png, ...(png ? {} : { why: 'no cut copy could be made on this computer' }) }
}
