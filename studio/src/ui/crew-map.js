
import { inkOn } from './crew-colours.js'
import { DESCRIBE } from './describe.js'
import { busyWords, copyTag, jobsTitle } from './copies-view.js'

/**
 * The crew map: the PC's home. An org chart that is also a live wiring diagram — the owner on top, the
 * lead under them, the judges beside the lead, the builders, then the checkers, and the crew's scripts in
 * a machine room along the bottom. Every line is a kind of message with a direction (lib/flow.mjs says
 * which), its thickness the count in the chosen window, red when the last one failed. On the right, the
 * projects in the owner's work order, each with the bots working in it.
 *
 * It stands still: it is drawn when the flow changes or the window is resized, and at no other time. The
 * plates, the line counts and the lanes are real buttons, so the keyboard and a screen reader reach all of
 * it; the List view says the same in sentences.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Each kind of line: its words and its mark. The marks are drawn on a 12-unit square. */
export const KIND = {
  order: { one: 'order', many: 'orders', mark: 'M2 3l4 3.4L10 3M2 6.6L6 10l4-3.4' },
  brief: { one: 'brief', many: 'briefs', mark: 'M3 1.5h4.4L10 4.1v6.4H3zM5 6h3M5 8.2h3' },
  report: { one: 'report', many: 'reports', mark: 'M6 10.5V1.8M2.6 5.2L6 1.8l3.4 3.4' },
  check: { one: 'check asked', many: 'checks asked', mark: 'M8.6 5.2a3.4 3.4 0 1 1-6.8 0a3.4 3.4 0 1 1 6.8 0M7.6 7.6l2.9 2.9' },
  verdict: { one: 'verdict', many: 'verdicts', mark: 'M1.8 6.4l2.8 2.8L10.4 3.2' },
  ask: { one: 'ruling asked', many: 'rulings asked', mark: 'M3.9 4.1a2.1 2.1 0 1 1 3.2 1.8c-.8.5-1.1 1-1.1 1.8M6 9.6v.6' },
  ruling: { one: 'ruling', many: 'rulings', mark: 'M1.8 10.5h5.4M4.3 4.3l2.6-2.6 3 3-2.6 2.6zM5.6 5.6L2.2 9' },
  idea: { one: 'idea', many: 'ideas', mark: 'M4.2 8.4h3.6M4.6 10.5h2.8M6 1.4a3.1 3.1 0 0 1 1.9 5.5v1.5H4.1V6.9A3.1 3.1 0 0 1 6 1.4z' },
  approval: { one: 'approval', many: 'approvals', mark: 'M6 1.4l1.4 2.9 3.1.4-2.3 2.1.6 3.1L6 8.4l-2.8 1.5.6-3.1-2.3-2.1 3.1-.4z' },
  start: { one: 'start', many: 'starts', mark: 'M3.4 1.8v8.4L10.2 6z' },
  card: { one: 'card', many: 'cards', mark: 'M1.4 2.4h9.2v7.2H1.4zM6 4.2v2.6M6 8v.2' },
  notice: { one: 'notice', many: 'notices', mark: 'M3 8.3V5.6a3 3 0 0 1 6 0v2.7l1.1 1.1H1.9zM5 10.6h2' },
  wait: { one: 'waits on', many: 'waits on', mark: 'M3 1.5h6M3 10.5h6M3.6 1.5c0 2.9 4.8 2.9 4.8 4.5S3.6 7.6 3.6 10.5M8.4 1.5c0 2.9-4.8 2.9-4.8 4.5s4.8 1.6 4.8 4.5' },
}
const markSvg = (kind) => `<svg class="mk" viewBox="0 0 12 12" aria-hidden="true"><path d="${KIND[kind]?.mark || ''}"/></svg>`
export const kindWords = (kind, n) => (n === 1 ? KIND[kind]?.one : KIND[kind]?.many) || kind

const STATUS = { working: 'Working', waiting: 'Waiting', free: 'Free', resting: 'Resting', paused: 'Paused', error: 'Stopped on an error' }
const WINDOW_WORDS = { now: 'the work in hand now', '24h': 'the last 24 hours', '7d': 'the last 7 days' }

/** Which row of the chart a node stands in. */
const ROW_OF = { owner: 0, lead: 1, ruler: 1, researcher: 1, builder: 2, general: 2, checker: 3, reviewer: 3, script: 4 }
const ROLE_ORDER = { lead: 0, ruler: 1, researcher: 2, builder: 0, general: 1, checker: 0, reviewer: 1 }

const NODE_W = 236
const NODE_H = 122
const OWNER_W = 268
const OWNER_H = 62
const SCRIPT_W = 156
const SCRIPT_H = 36
const GAP = 22
const LANE_H = 64

const pct = (share) => (share >= 0.995 ? '100%' : share > 0 && share < 0.01 ? 'under 1%' : `${Math.round(share * 100)}%`)

/** A bot's plate, said in one sentence: what a screen reader reads, and the List view's line. */
export function nodeSentence(node, nodes) {
  if (node.kind === 'owner') return node.needs ? `You. ${plural(node.needs, 'card waits', 'cards wait')} for your answer.` : 'You. Nothing waits for your answer.'
  if (node.kind === 'script') return `${node.name}, a script. ${plural(node.notices, 'notice')} to the crew.`
  const boss = nodes.find((n) => n.id === node.under)
  const many = busyWords(node.jobs)
  const job = many ? `${many[0].toUpperCase()}${many.slice(1)}: ${node.jobs.map((j) => j.ref).join(', ')}.` : node.job ? `${node.job.stage} ${node.job.title}, ${node.job.ref}${node.job.project ? `, in ${node.job.project}` : ''}.` : node.why || 'No job now.'
  const copies = node.copies?.length > 1 ? ` On ${node.on}, one of ${node.copies.length} copies.` : ''
  const share = node.week?.share === null || node.week?.share === undefined ? '' : ` ${pct(node.week.share)} of the Claude week.`
  const met = node.met || node.notMet ? ` ${node.met} met, ${node.notMet} not met this week.` : ''
  return `${node.name}, ${node.roleName.toLowerCase()}, ${node.model}.${copies} ${STATUS[node.status] || node.status}. ${job} Answers to ${boss ? (boss.kind === 'owner' ? 'you' : boss.name) : 'nobody'}. ${plural(node.runsToday, 'run')} today.${share}${met}`
}

/** A line, said in one sentence. */
export function edgeSentence(edge, nodes, window = '24h') {
  const name = (id) => { const n = nodes.find((x) => x.id === id); return n ? (n.kind === 'owner' ? 'you' : n.name) : 'someone' }
  const failed = edge.failed ? `, ${edge.failed} failed` : ''
  if (edge.kind === 'wait') return `${name(edge.from)} waits on ${name(edge.to)}${edge.count > 1 ? ` (${edge.count})` : ''}.`
  return `${plural(edge.count, KIND[edge.kind]?.one || edge.kind, KIND[edge.kind]?.many)} from ${name(edge.from)} to ${name(edge.to)} in ${WINDOW_WORDS[window] || window}${failed}.`
}

/**
 * Every message between two nodes in one direction is one line: its total, its kinds (most first), whether
 * the last one failed, and its newest messages with their kind. The line is painted in its main kind.
 */
export function bundleEdges(edges = []) {
  const order = new Map(Object.keys(KIND).map((k, i) => [k, i]))
  const out = new Map()
  for (const e of edges) {
    const id = `${e.from}>${e.to}`
    const b = out.get(id) || { id, from: e.from, to: e.to, count: 0, failed: 0, last: 0, lastFailed: false, kinds: [], messages: [] }
    b.count += e.count
    b.failed += e.failed || 0
    if ((e.last || 0) >= b.last) { b.last = e.last || 0; b.lastFailed = Boolean(e.lastFailed) }
    b.kinds.push({ kind: e.kind, count: e.count, failed: e.failed || 0, lastFailed: Boolean(e.lastFailed) })
    for (const m of e.messages || []) b.messages.push({ ...m, kind: e.kind })
    out.set(id, b)
  }
  return [...out.values()].map((b) => {
    b.kinds.sort((x, y) => y.count - x.count || order.get(x.kind) - order.get(y.kind))
    b.messages.sort((x, y) => y.at - x.at)
    return { ...b, kind: b.kinds[0].kind, messages: b.messages.slice(0, 8) }
  })
}

/** A line's pill: how wide it is, for a total and the kind dots it carries. */
const pillW = (l) => 22 + 7 * String(l.count).length + 7 * Math.min(2, l.kinds.length)
const PILL_H = 24

/** Whether a point lies on the straight piece from p to q. */
const onSegment = (c, p, q) => Math.abs((q.x - p.x) * (c.y - p.y) - (q.y - p.y) * (c.x - p.x)) < 0.5 && c.x >= Math.min(p.x, q.x) - 0.5 && c.x <= Math.max(p.x, q.x) + 0.5 && c.y >= Math.min(p.y, q.y) - 0.5 && c.y <= Math.max(p.y, q.y) + 0.5

/** A route through points, its corners rounded. */
function roundPath(pts, r = 7) {
  const f = (n) => Math.round(n * 10) / 10
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1]
    const in1 = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2); const out1 = Math.min(r, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    const p = { x: b.x - Math.sign(b.x - a.x) * in1, y: b.y - Math.sign(b.y - a.y) * in1 }
    const q = { x: b.x + Math.sign(c.x - b.x) * out1, y: b.y + Math.sign(c.y - b.y) * out1 }
    d += `L${f(p.x)} ${f(p.y)}Q${f(b.x)} ${f(b.y)} ${f(q.x)} ${f(q.y)}`
  }
  const z = pts[pts.length - 1]
  return `${d}L${f(z.x)} ${f(z.y)}`
}

/**
 * Where everything stands, for a box of this size. Pure: the same flow and size give the same picture.
 *
 * The plates stand in rows by role. A line never crosses a plate: it leaves a plate's top or bottom, runs
 * along the gap between two rows on a track of its own, passes a row in between through a free corridor
 * beside the plates, and comes into the other plate. Its pill sits on its own line where it touches no
 * plate and no other pill.
 */
export function layoutFlow(flow, { width, height }) {
  const narrow = width < 1020
  const laneW = narrow ? 0 : Math.round(Math.min(330, Math.max(260, width * 0.23)))
  const chartW = width - laneW - (laneW ? GAP * 2 : 0)
  const top = 16
  const scripts = flow.nodes.filter((n) => n.kind === 'script')
  const bandH = scripts.length ? SCRIPT_H + 26 : 0
  const bandY = height - bandH
  const bottom = bandY - (scripts.length ? 46 : 12)
  const rows = [[], [], [], []]
  for (const n of flow.nodes) if (n.kind !== 'script') rows[ROW_OF[n.role] ?? 2].push(n)
  for (const row of rows.slice(1)) row.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name))
  const widest = Math.max(1, ...rows.slice(1).map((r) => r.length))
  const space = GAP * 2.4
  const w = Math.max(150, Math.min(NODE_W, Math.floor((chartW - space * (widest + 1)) / widest)))
  const h = NODE_H
  const used = rows.map((row, i) => (row.length ? (i === 0 ? OWNER_H : h) : 0)).map((rh, i) => ({ i, rh })).filter((r) => r.rh)
  const gap = Math.max(40, (bottom - top - used.reduce((sum, r) => sum + r.rh, 0)) / Math.max(1, used.length - 1))
  const rowY = new Map()
  let y = top
  for (const r of used) { rowY.set(r.i, Math.round(y)); y += r.rh + gap }
  const box = new Map()
  const rowOf = new Map()
  rows.forEach((row, i) => {
    if (!row.length || i === 0) return
    const total = row.length * w + (row.length - 1) * space
    let x = Math.round((chartW - total) / 2)
    for (const n of row) { box.set(n.id, { x, y: rowY.get(i), w, h }); rowOf.set(n.id, i); x += Math.round(w + space) }
  })
  const owner = rows[0][0]
  if (owner) {
    const lead = rows[1].find((n) => n.role === 'lead') || rows[1][0]
    const cx = lead ? box.get(lead.id).x + w / 2 : chartW / 2
    box.set(owner.id, { x: Math.round(Math.max(0, Math.min(chartW - OWNER_W, cx - OWNER_W / 2))), y: rowY.get(0), w: OWNER_W, h: OWNER_H })
    rowOf.set(owner.id, 0)
  }
  const per = Math.max(1, Math.floor((chartW - 170) / (SCRIPT_W + 14)))
  scripts.forEach((n, i) => {
    box.set(n.id, { x: 170 + (i % per) * (SCRIPT_W + 14), y: bandY + 13, w: SCRIPT_W, h: SCRIPT_H })
    rowOf.set(n.id, 4)
  })

  // The rows that hold something, top to bottom, and the gap under each: a channel the lines run along.
  const bands = [0, 1, 2, 3, 4].filter((i) => [...rowOf.values()].includes(i)).map((i) => {
    const boxes = [...rowOf].filter(([, r]) => r === i).map(([id]) => box.get(id))
    return { i, top: Math.min(...boxes.map((b) => b.y)), bottom: Math.max(...boxes.map((b) => b.y + b.h)), boxes }
  })
  const at = new Map(bands.map((b, k) => [b.i, k]))
  const channel = (k) => ({ top: bands[k].bottom, bottom: bands[k + 1].top })

  // Free corridors beside the plates of a row, where a line may pass it.
  const corridors = (k) => {
    const taken = bands[k].boxes.map((b) => [b.x - 10, b.x + b.w + 10]).sort((a, b) => a[0] - b[0])
    const free = []
    let from = 6
    for (const [a, b] of taken) { if (a - from > 8) free.push([from, a]); from = Math.max(from, b) }
    if (chartW - 6 - from > 8) free.push([from, chartW - 6])
    return free
  }
  const meet = (a, b) => a.flatMap(([x1, x2]) => b.map(([y1, y2]) => [Math.max(x1, y1), Math.min(x2, y2)])).filter(([p, q]) => q - p > 8)

  const lines = bundleEdges(flow.edges).filter((e) => box.has(e.from) && box.has(e.to))
  const centre = (id) => box.get(id).x + box.get(id).w / 2
  // Each line's plan: which side it leaves and enters, the channels it runs in, the corridor it passes through.
  for (const l of lines) {
    const ka = at.get(rowOf.get(l.from)); const kb = at.get(rowOf.get(l.to))
    if (ka === kb) {
      const k = ka > 0 ? ka - 1 : ka
      l.plan = { out: ka > 0 ? 'top' : 'bottom', in: ka > 0 ? 'top' : 'bottom', ch: [k], pass: [] }
    } else if (ka < kb) {
      l.plan = { out: 'bottom', in: 'top', ch: kb - ka > 1 ? [ka, kb - 1] : [ka], pass: Array.from({ length: kb - ka - 1 }, (_, n) => ka + 1 + n) }
    } else {
      l.plan = { out: 'top', in: 'bottom', ch: ka - kb > 1 ? [ka - 1, kb] : [ka - 1], pass: Array.from({ length: ka - kb - 1 }, (_, n) => kb + 1 + n) }
    }
    if (l.plan.pass.length) {
      const free = l.plan.pass.map(corridors).reduce(meet)
      const want = (centre(l.from) + centre(l.to)) / 2
      const pick = free.map((iv) => ({ iv, d: Math.abs(Math.max(iv[0], Math.min(iv[1], want)) - want) })).sort((a, b) => a.d - b.d)[0]
      l.plan.iv = pick ? pick.iv : [want - 4, want + 4]
    }
  }
  // Lines through one corridor share it, side by side, in the order of where they are going.
  const byCorridor = new Map()
  for (const l of lines.filter((x) => x.plan.iv)) {
    const key = `${l.plan.pass.join(',')}:${l.plan.iv.join(',')}`
    byCorridor.set(key, [...(byCorridor.get(key) || []), l])
  }
  for (const group of byCorridor.values()) {
    const [a, b] = group[0].plan.iv
    const want = (l) => (centre(l.from) + centre(l.to)) / 2
    group.sort((p, q) => want(p) - want(q))
    const step = Math.min(9, (b - a - 8) / Math.max(1, group.length))
    const mid = Math.max(a + 4 + step * group.length / 2, Math.min(b - 4 - step * group.length / 2, (a + b) / 2))
    group.forEach((l, n) => { l.plan.cx = mid + (n - (group.length - 1) / 2) * step })
  }
  // Where each line touches its plates: spread along the side, in the order of where it heads next.
  const sides = new Map()
  const touch = (id, side, l, end) => { const key = `${id}|${side}`; sides.set(key, [...(sides.get(key) || []), { l, end }]) }
  for (const l of lines) { touch(l.from, l.plan.out, l, 'from'); touch(l.to, l.plan.in, l, 'to') }
  for (const [key, list] of sides) {
    const [id] = key.split('|')
    const b = box.get(id)
    const heads = ({ l, end }) => (l.plan.cx ?? centre(end === 'from' ? l.to : l.from))
    list.sort((p, q) => heads(p) - heads(q) || (p.end === 'from' ? -1 : 1))
    const room = b.w - 28
    list.forEach((t, n) => { t.l[t.end === 'from' ? 'xa' : 'xb'] = b.x + 14 + room * (list.length === 1 ? 0.5 : n / (list.length - 1)) })
  }
  // The horizontal runs, each on a track of its own in its channel.
  const runs = new Map()
  for (const l of lines) {
    const cs = l.plan.ch
    // One channel: from the first plate straight along to the second. Two: to the corridor, then on from it.
    const ends = cs.length === 1 ? [[l.xa, l.xb]] : [[l.xa, l.plan.cx], [l.plan.cx, l.xb]]
    l.runs = cs.map((k, n) => ({ k, a: Math.min(...ends[n]), b: Math.max(...ends[n]), l }))
    for (const r of l.runs) runs.set(r.k, [...(runs.get(r.k) || []), r])
  }
  for (const [k, list] of runs) {
    // Fewest tracks: runs in the order they start, each on the track that came free first.
    const tracks = []
    list.sort((p, q) => p.a - q.a || p.b - q.b)
    for (const r of list) {
      let t = -1
      let best = Infinity
      tracks.forEach((end, n) => { if (end + 14 < r.a && end < best) { best = end; t = n } })
      if (t < 0) { tracks.push(0); t = tracks.length - 1 }
      tracks[t] = r.b
      r.t = t
    }
    const c = channel(k)
    const pad = 9
    const stepY = Math.min(16, (c.bottom - c.top - pad * 2) / Math.max(1, tracks.length))
    const mid = (c.top + c.bottom) / 2
    for (const r of list) r.y = mid + (r.t - (tracks.length - 1) / 2) * stepY
  }
  // The routes.
  for (const l of lines) {
    const a = box.get(l.from); const b = box.get(l.to)
    const ya = l.plan.out === 'bottom' ? a.y + a.h : a.y
    const yb = l.plan.in === 'top' ? b.y : b.y + b.h
    const pts = [{ x: l.xa, y: ya }]
    if (l.runs.length === 1) {
      pts.push({ x: l.xa, y: l.runs[0].y }, { x: l.xb, y: l.runs[0].y })
    } else {
      pts.push({ x: l.xa, y: l.runs[0].y }, { x: l.plan.cx, y: l.runs[0].y }, { x: l.plan.cx, y: l.runs[1].y }, { x: l.xb, y: l.runs[1].y })
    }
    pts.push({ x: l.xb, y: yb })
    l.points = pts
    const [p, q] = pts.slice(-2)
    l.dir = q.y > p.y ? 'down' : q.y < p.y ? 'up' : q.x > p.x ? 'right' : 'left'
    l.d = roundPath(pts)
    l.width = Math.round((1.4 + Math.min(1.6, Math.log2(l.count + 1) * 0.4)) * 10) / 10
  }
  // One pill for the two lines between a pair (a half for each way, each its own button), on one of its
  // lines, clear of every plate and every other pill.
  const cards = [...box.values()].map((b) => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }))
  const placed = []
  const hits = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h
  const fits = (r) => r.x >= 2 && r.x + r.w <= chartW && r.y >= 2 && r.y + r.h <= height - 2 && !cards.some((c) => hits(r, c))
  const free = (r) => fits(r) && !placed.some((p) => hits(r, p))
  const pairs = new Map()
  for (const l of lines) { const key = [l.from, l.to].sort().join('|'); pairs.set(key, [...(pairs.get(key) || []), l]) }
  const pills = [...pairs.values()].map((group) => ({ group, w: group.reduce((sum, l) => sum + pillW(l), 0), count: group.reduce((sum, l) => sum + l.count, 0) }))
  // Where each pill could go: along its lines, lying on a run first, near the middle.
  for (const pill of pills) {
    const tries = []
    for (const l of pill.group) {
      for (let i = 0; i < l.points.length - 1; i++) {
        const p = l.points[i]; const q = l.points[i + 1]
        const len = Math.hypot(q.x - p.x, q.y - p.y)
        const n = Math.max(1, Math.floor(len / 7))
        for (let s = 0; s <= n; s++) {
          const t = 0.5 + (s % 2 ? 1 : -1) * Math.ceil(s / 2) / n
          if (t >= 0 && t <= 1) tries.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, flat: p.y === q.y, mid: Math.abs(t - 0.5) })
        }
      }
    }
    tries.sort((p, q) => Number(q.flat) - Number(p.flat) || p.mid - q.mid)
    // Each place once as a box, and only those clear of the plates.
    pill.tries = tries.map((c) => ({ ...c, r: { x: c.x - pill.w / 2, y: c.y - PILL_H / 2, w: pill.w, h: PILL_H } })).filter((c) => fits(c.r))
    if (!pill.tries.length) pill.tries = tries.slice(0, 1).map((c) => ({ ...c, r: { x: c.x - pill.w / 2, y: c.y - PILL_H / 2, w: pill.w, h: PILL_H } }))
    pill.tries.raw = tries
  }
  // The most hemmed-in pill is placed first: the one with the fewest free places left.
  const left = [...pills]
  while (left.length) {
    // Counted against what was placed last only: a place a pill lost earlier stays lost.
    const last = placed[placed.length - 1]
    for (const pill of left) {
      if (!pill.open) pill.open = pill.tries.filter((c) => !placed.some((q) => hits(c.r, q)))
      else if (last) pill.open = pill.open.filter((c) => !hits(c.r, last))
    }
    left.sort((p, q) => (p.open.length || Infinity) - (q.open.length || Infinity) || q.count - p.count)
    const pill = left.shift()
    const tries = pill.open.length ? pill.open : pill.tries
    const rect = (c, w = pill.w) => ({ x: c.x - w / 2, y: c.y - PILL_H / 2, w, h: PILL_H })
    const keep = (r) => placed.push({ x: r.x - 3, y: r.y - 2, w: r.w + 6, h: r.h + 4 })
    const spot = pill.open[0]
    if (spot || pill.group.length === 1) {
      const at = spot || tries.find((c) => fits(rect(c))) || tries[0]
      let x = Math.round(at.x - pill.w / 2)
      for (const l of pill.group) { const pw = pillW(l); l.chip = { x: x + pw / 2, y: Math.round(at.y), w: pw, part: pill.group.length === 1 ? 'solo' : x === Math.round(at.x - pill.w / 2) ? 'pa' : 'pb' }; x += pw }
      keep(rect(at))
      continue
    }
    // No room for the pair's pill: each way gets a small pill of its own, on its own line.
    for (const l of pill.group) {
      const pw = pillW(l)
      const own = pill.tries.raw.filter((c) => l.points.some((p, i) => i < l.points.length - 1 && onSegment(c, p, l.points[i + 1])))
      const at = own.find((c) => free(rect(c, pw))) || own.find((c) => fits(rect(c, pw))) || own[0] || tries[0]
      l.chip = { x: Math.round(at.x), y: Math.round(at.y), w: pw, part: 'solo' }
      keep(rect(at, pw))
    }
  }

  // The lanes on the right, in the work order, in a column of their own that scrolls when they are many.
  const laneH = Math.max(46, Math.min(LANE_H, Math.floor((height - top - 40) / Math.max(1, flow.lanes.length)) - 8))
  const lanes = laneW ? flow.lanes.map((lane, i) => ({ ...lane, x: 0, y: i * (laneH + 8), w: laneW - 8, h: laneH })) : []
  return { width, height, chartW, laneW, laneX: chartW + GAP * 2, laneTop: top + 30, laneH, bandY: scripts.length ? bandY : null, bandH, box, lanes, lines }
}

const face = (node, faces) => {
  const src = faces?.[node.id]
  const paint = node.look?.colour || '#7d8590'
  return src ? `<img class="cm-face" src="${esc(src)}" alt="" draggable="false">`
    : `<i class="cm-face" style="background:${esc(paint)};color:${inkOn(paint)}" aria-hidden="true">${esc(node.name.slice(0, 1))}</i>`
}

/** One plate. */
function plateHtml(node, b, nodes, faces) {
  const style = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`
  const label = esc(nodeSentence(node, nodes))
  if (node.kind === 'owner') {
    return `<button type="button" class="cm-node cm-owner" data-node="owner" style="${style}" aria-label="${label} Open Needs you.">
      <span class="cm-you">You</span>
      <span class="cm-needs ${node.needs ? 'on' : ''}" title="${esc(DESCRIBE.map.owner)}"><b>${node.needs}</b><span>${node.needs === 1 ? 'card waits for your answer' : 'cards wait for your answer'}</span></span>
    </button>`
  }
  if (node.kind === 'script') {
    return `<button type="button" class="cm-node cm-script" data-node="${esc(node.id)}" style="${style}" aria-label="${label}">
      <svg class="cm-cog" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM6 .8v1.6M6 9.6v1.6M.8 6h1.6M9.6 6h1.6M2.3 2.3l1.1 1.1M8.6 8.6l1.1 1.1M2.3 9.7l1.1-1.1M8.6 3.4l1.1-1.1"/></svg>
      <span class="cm-name">${esc(node.name)}</span><span class="cm-count" title="${esc(DESCRIBE.map.script)}">${node.notices}</span>
    </button>`
  }
  const paint = node.look?.colour || '#7d8590'
  const many = busyWords(node.jobs)
  const job = many
    ? `<span class="cm-job" title="${esc(jobsTitle(node.jobs))}"><span class="cm-step">${esc(many)}</span> <span class="cm-title">${esc(node.jobs.map((j) => j.ref).join(', '))}</span></span>`
    : node.job
    ? `<span class="cm-job"><span class="cm-step" title="${esc(DESCRIBE.status[node.job.stage] || '')}">${esc(node.job.stage)}</span> <span class="cm-title">${esc(node.job.title)}</span> <span class="cm-ref">${esc(node.job.ref)}</span></span>`
    : `<span class="cm-job none">${esc(node.why || (node.status === 'waiting' ? 'Waiting on other work' : 'No job now'))}</span>`
  const stats = [
    `${plural(node.runsToday, 'run')} today`,
    node.week?.share === null || node.week?.share === undefined ? '' : `<span title="Its share of all the Claude tokens the crew used this week, cached reads included">${pct(node.week.share)} of Claude</span>`,
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join('')
  return `<button type="button" class="cm-node cm-bot st-${esc(node.status)}" data-node="${esc(node.id)}" style="${style};--paint:${esc(paint)}" aria-label="${label} Open its page.">
    <span class="cm-head">${face(node, faces)}<span class="cm-who"><span class="cm-name">${esc(node.name)}</span><span class="cm-role"><span class="cm-lamp" title="${esc(DESCRIBE.botStatus[STATUS[node.status]] || '')}"><i></i>${esc(STATUS[node.status] || node.status)}</span><span class="cm-what">${esc(node.roleName)}, ${esc(node.model)}${copyTag(node)}</span></span></span>${node.met || node.notMet ? `<span class="cm-met${node.notMet > node.met ? ' cm-bad' : ''}" title="This week's results: met and not met"><span>${node.met} met</span><span>${node.notMet} not</span></span>` : ''}</span>
    ${job}
    <span class="cm-stats">${stats}</span>
  </button>`
}

const ARROW = { down: '↓', up: '↑', right: '→', left: '←' }
const NAME_OF = (nodes, id) => { const n = nodes.find((x) => x.id === id); return n ? (n.kind === 'owner' ? 'you' : n.name) : 'someone' }

/** A bundled line, said in one sentence: its total, then each kind. */
export function lineSentence(line, nodes, window = '24h') {
  const kinds = line.kinds.map((k) => (k.kind === 'wait' ? 'waits on' : `${k.count} ${kindWords(k.kind, k.count)}`)).join(', ')
  const failed = line.failed ? `, ${line.failed} failed` : ''
  return `${plural(line.count, 'message')} from ${NAME_OF(nodes, line.from)} to ${NAME_OF(nodes, line.to)} in ${WINDOW_WORDS[window] || window}: ${kinds}${failed}.`
}

/** A line's half of its pair's pill: the way it goes, its total and dots for its main kinds; it opens the breakdown. */
const chipHtml = (l, nodes, window, part = '') => `<button type="button" class="cm-chip ${part} k-${l.kind}${l.lastFailed ? ' bad' : ''}" data-edge="${esc(l.id)}" data-from="${esc(l.from)}" data-to="${esc(l.to)}" style="left:${l.chip.x}px;top:${l.chip.y}px;width:${l.chip.w}px" title="${esc(DESCRIBE.map.chip)}" aria-label="${esc(lineSentence(l, nodes, window))} Show the breakdown and the last messages."><span class="cm-arrow" aria-hidden="true">${ARROW[l.dir] || ''}</span><b>${l.count}</b>${l.kinds.slice(0, 2).map((k) => `<i class="cm-dot k-${k.kind}" aria-hidden="true"></i>`).join('')}</button>`

/**
 * What decides where everything stands: the size, the window, which plates, which lines, the lanes. While it
 * stays the same, a change (a new message, a bot starting work) only patches the plates and lines it touched.
 */
export const shapeOf = (flow, size) => JSON.stringify([size, flow.window, flow.nodes.map((n) => [n.id, n.kind, n.role]), bundleEdges(flow.edges).map((l) => [l.id, pillW(l)]), flow.lanes])

/** The picture: lines under the plates, the pills on the lines, the lanes and the legend, the machine room. */
export function flowHtml(flow, layout, { faces = {}, window = '24h' } = {}) {
  const nodes = flow.nodes
  const svg = [
    `<svg class="cm-lines" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true"><defs>`,
    ...Object.keys(KIND).map((k) => `<marker id="cm-a-${k}" class="k-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>`),
    '<marker id="cm-a-bad" class="k-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>',
    '</defs>',
    ...layout.lines.map((l) => `<path class="cm-edge k-${l.kind}${l.kinds.every((k) => k.kind === 'wait') ? ' dashed' : ''}${l.lastFailed ? ' bad' : ''}" data-edge="${esc(l.id)}" data-from="${esc(l.from)}" data-to="${esc(l.to)}" d="${l.d}" stroke-width="${l.width}" marker-end="url(#cm-a-${l.lastFailed ? 'bad' : l.kind})"/>`),
    '</svg>',
  ].join('')
  const band = layout.bandY === null ? '' : `<div class="cm-band" style="top:${layout.bandY}px;height:${layout.bandH}px;width:${layout.chartW + GAP}px"><span>Machine room<small>Scripts, no AI</small></span></div>`
  const plates = nodes.map((n) => (layout.box.has(n.id) ? plateHtml(n, layout.box.get(n.id), nodes, faces) : '')).join('')
  // A pair's pill is two halves side by side (one per way); a pill that had no room is split into two.
  const chips = layout.lines.map((l) => chipHtml(l, nodes, window, l.chip.part || 'solo')).join('')
  const lanes = layout.laneW ? `<div class="cm-lanes" style="left:${layout.laneX}px;width:${layout.laneW}px">
      <h2 class="cm-lanes-head">Projects, in work order</h2>
      <div class="cm-lane-list">${layout.lanes.map((lane) => {
    const who = lane.bots.map((id) => nodes.find((n) => n.id === id)).filter(Boolean)
    return `<button type="button" class="cm-lane" data-lane="${esc(lane.name)}" data-bots="${esc(lane.bots.join(' '))}" style="min-height:${lane.h}px" aria-label="${esc(`${lane.rank}. ${lane.name}: ${plural(lane.open, 'open job')}, ${who.length ? `${who.map((n) => n.name).join(', ')} working` : 'nobody working'}. Open the project.`)}">
      <span class="cm-rank" title="${esc(DESCRIBE.map.rank)}">${lane.rank}</span><span class="cm-lane-text"><span class="cm-name">${esc(lane.name)}</span><span class="cm-lane-sub">${plural(lane.open, 'open job')}${who.length ? '' : ', nobody on it'}</span></span>
      <span class="cm-lane-who">${who.slice(0, 4).map((n) => face(n, faces)).join('')}${who.length > 4 ? `<i class="cm-more" title="${esc(DESCRIBE.map.more)}">+${who.length - 4}</i>` : ''}</span>
    </button>`
  }).join('')}</div>
      <div class="cm-legend-side" aria-label="What the lines mean">${legendHtml(flow)}</div>
    </div>` : ''
  return svg + band + lanes + plates + chips
}

/** The same in sentences: every plate, every line out of it, every lane. What the List view shows. */
export function flowList(flow, { window = '24h' } = {}) {
  const nodes = flow.nodes
  const out = (id) => flow.edges.filter((e) => e.from === id)
  const into = (id) => flow.edges.filter((e) => e.to === id)
  const edgeItem = (e) => `<li><button type="button" class="cm-list-edge k-${e.kind}${e.lastFailed ? ' bad' : ''}" data-edge="${esc(e.id)}">${markSvg(e.kind)}${esc(edgeSentence(e, nodes, window))}</button></li>`
  const nodeItem = (n) => {
    const lines = [...out(n.id), ...into(n.id).filter((e) => n.kind === 'owner' || nodes.find((x) => x.id === e.from)?.kind === 'script' || e.from === 'owner')]
    return `<li><button type="button" class="cm-list-node" data-node="${esc(n.id)}">${esc(nodeSentence(n, nodes))}</button>${lines.length ? `<ul>${lines.map(edgeItem).join('')}</ul>` : ''}</li>`
  }
  const lanes = flow.lanes.map((l) => {
    const who = l.bots.map((id) => nodes.find((n) => n.id === id)?.name).filter(Boolean)
    return `<li><button type="button" data-lane="${esc(l.name)}">${l.rank}. ${esc(l.name)}: ${plural(l.open, 'open job')}${who.length ? `, ${esc(who.join(', '))} working` : ''}.</button></li>`
  }).join('')
  return `<h2>The crew, ${esc(WINDOW_WORDS[window] || window)}</h2><ul class="cm-list-nodes">${nodes.map(nodeItem).join('')}</ul>
    ${lanes ? `<h2>Projects, in work order</h2><ol class="cm-list-lanes">${lanes}</ol>` : ''}`
}

/** The legend: the kinds of line in this picture, and what dashed and red mean. */
export function legendHtml(flow) {
  const here = new Set(flow.edges.map((e) => e.kind))
  const kinds = flow.kinds.filter((k) => here.has(k.kind))
  return kinds.map((k) => `<span class="cm-key k-${k.kind}" title="${esc(k.says)}">${markSvg(k.kind)}${esc(k.label)}</span>`).join('')
    + `<span class="cm-key cm-key-bad" title="${esc(DESCRIBE.map.failed)}"><i></i>Last one failed or not met</span>`
}

/** One line's breakdown by kind and its last messages, for the box a click opens. */
export function edgeDetail(line, nodes, window) {
  const when = (at) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return `<header><span class="k-${line.kind}">${markSvg(line.kind)}</span><h3>${esc(`${plural(line.count, 'message')} from ${NAME_OF(nodes, line.from)} to ${NAME_OF(nodes, line.to)}, ${WINDOW_WORDS[window] || window}`)}</h3>
    <button type="button" class="cm-x" data-act="cm-close" aria-label="Close">×</button></header>
    <ul class="cm-kinds">${line.kinds.map((k) => `<li class="k-${k.kind}${k.lastFailed ? ' bad' : ''}">${markSvg(k.kind)}<span>${k.kind === 'wait' ? 'Waits on' : `${k.count} ${esc(kindWords(k.kind, k.count))}`}${k.failed ? `, ${k.failed} failed` : ''}</span></li>`).join('')}</ul>
    <ol>${line.messages.map((m) => `<li class="k-${m.kind}${m.failed ? ' bad' : ''}"><time>${markSvg(m.kind)}${esc(when(m.at))}</time><p>${esc(m.text || '(no words)')}</p>${m.job ? `<button type="button" class="cm-job-link" data-job="${esc(m.job.id)}">${esc(m.job.title)} <span class="cm-ref">${esc(m.job.ref)}</span></button>` : ''}</li>`).join('')}</ol>`
}

/** What the picture is drawn from: two flows that give the same key give the same picture. */
const keyOf = (flow) => JSON.stringify([flow.nodes, flow.edges.map((e) => [e.id, e.count, e.failed, e.lastFailed, e.last]), flow.lanes, flow.window])

export class CrewMap {
  /**
   * @param {HTMLElement} host where the map sits
   * @param {{ openBot: (id: string) => void, openNeeds: () => void, openJob: (id: string) => void, openProject: (name: string) => void, faces: () => object, needsSeen?: (n: number) => void }} acts
   */
  constructor(host, acts) {
    this.acts = acts
    this.window = '24h'
    this.mode = 'picture'
    try { this.window = localStorage.getItem('botyard.flow.window') || '24h'; this.mode = localStorage.getItem('botyard.flow.mode') || 'picture' } catch { /* storage off */ }
    this.el = document.createElement('section')
    this.el.className = 'crewmap'
    this.el.setAttribute('aria-label', 'Crew map')
    this.el.innerHTML = `<div class="cm-bar">
        <h1 class="cm-title-main">The crew</h1>
        <div class="cm-seg" role="group" aria-label="Lines from">${[['now', 'Now'], ['24h', '24 h'], ['7d', '7 days']].map(([w, t]) => `<button type="button" data-window="${w}" title="${esc(DESCRIBE.map[w])}" aria-pressed="false">${t}</button>`).join('')}</div>
        <div class="cm-seg" role="group" aria-label="Show as">${[['picture', 'Map'], ['list', 'List']].map(([m, t]) => `<button type="button" data-mode="${m}" title="${esc(DESCRIBE.map[m])}" aria-pressed="false">${t}</button>`).join('')}</div>
        <p class="cm-said" role="status" aria-live="polite"></p>
      </div>
      <div class="cm-stage"></div>
      <div class="cm-list" hidden></div>
      <div class="cm-legend" aria-label="What the lines mean"></div>
      <div class="cm-pop panel" role="dialog" aria-label="Last messages on this line" hidden></div>`
    host.prepend(this.el)
    this.stage = this.el.querySelector('.cm-stage')
    this.list = this.el.querySelector('.cm-list')
    this.legend = this.el.querySelector('.cm-legend')
    this.pop = this.el.querySelector('.cm-pop')
    this.said = this.el.querySelector('.cm-said')
    this.flow = null
    this._key = ''
    this._size = ''
    this.on = false
    this.drawMs = []
    this._syncBar()
    this.el.addEventListener('click', (e) => this._click(e))
    this.el.addEventListener('pointerover', (e) => this._hover(e.target.closest('[data-node],[data-edge]')))
    this.el.addEventListener('pointerleave', () => this._hover(null))
    this.el.addEventListener('focusin', (e) => this._hover(e.target.closest('[data-node],[data-edge]')))
    this.el.addEventListener('focusout', () => this._hover(null))
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.pop.hidden) { e.stopPropagation(); this._closePop() } })
    new ResizeObserver(() => this._draw()).observe(this.el)
  }

  show(on) {
    this.on = on
    this.el.hidden = !on
    if (on) this.refresh()
  }

  /** Ask for the flow again; drawn only if something in it changed. */
  async refresh() {
    if (!this.on || this._asking) return
    this._asking = true
    try {
      const res = await fetch(`/api/studio/flow?window=${encodeURIComponent(this.window)}`, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`The flow answered ${res.status}`)
      this.setFlow(await res.json())
    } catch (err) {
      if (!this.flow) this.said.textContent = 'The crew map could not be read. It tries again in a few seconds.'
    } finally {
      this._asking = false
    }
  }

  setFlow(flow) {
    if (!flow || !Array.isArray(flow.nodes)) return
    const before = this.flow
    this.flow = flow
    this.acts.needsSeen?.(flow.needs)
    const key = keyOf(flow)
    if (key === this._key) return
    // A line with a newer message pulses once: the only motion the map makes.
    const fresh = new Set(before && before.window === flow.window ? flow.edges.filter((e) => e.last > (before.edges.find((b) => b.id === e.id)?.last || 0)).map((e) => e.id) : [])
    this._key = key
    this._draw({ force: true, fresh })
  }

  _syncBar() {
    for (const b of this.el.querySelectorAll('[data-window]')) b.setAttribute('aria-pressed', String(b.dataset.window === this.window))
    for (const b of this.el.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode))
    this.stage.hidden = this.mode !== 'picture'
    this.list.hidden = this.mode !== 'list'
  }

  /** Draw it, if the flow or the size changed since the last time. Measured, so the 16 ms budget can be checked. */
  _draw({ force = false, fresh = new Set() } = {}) {
    if (!this.flow || !this.on) return
    const t0 = performance.now()
    const width = Math.round(this.el.clientWidth)
    const height = Math.round(this.stage.clientHeight || this.list.clientHeight)
    const size = `${width}x${height}:${this.mode}`
    if (!force && size === this._size) return
    this._size = size
    const flow = this.flow
    // A narrow window gets the list: a chart that does not fit is worse than the same facts in sentences.
    const listed = this.mode === 'list' || (width > 0 && width < 640)
    this.stage.hidden = listed
    this.list.hidden = !listed
    this._lines = bundleEdges(flow.edges)
    if (listed) { this.list.innerHTML = flowList(flow, { window: this.window }); this.legend.hidden = true }
    else if (width > 0 && height > 0) {
      const layout = layoutFlow(flow, { width, height })
      this._lines = layout.lines
      // With lanes beside the chart the legend stands under them; without, along the bottom.
      this.legend.hidden = layout.laneW > 0
      const shape = shapeOf(flow, size)
      if (shape === this._shape && this._drawnFlow) this._patch(flow, layout)
      else this.stage.innerHTML = flowHtml(flow, layout, { faces: this.acts.faces?.(), window: this.window })
      this._shape = shape
      this._drawnFlow = flow
      // The pulse starts on the next frame: it is motion after the drawing, not part of it.
      if (fresh.size) requestAnimationFrame(() => { for (const id of fresh) for (const el of this.stage.querySelectorAll(`[data-edge="${CSS.escape(id)}"]`)) el.classList.add('pulse') })
    }
    this.legend.innerHTML = legendHtml(flow)
    const bots = flow.nodes.filter((n) => n.kind === 'bot')
    const working = bots.filter((n) => n.status === 'working').length
    this.said.textContent = `${plural(working, 'bot')} working of ${bots.length}. ${plural(flow.edges.reduce((s, e) => s + (e.kind === 'wait' ? 0 : e.count), 0), 'message')} in ${WINDOW_WORDS[this.window]}.`
    // Laid out, so the time counts the browser's work too, not only the string.
    void this.stage.offsetHeight
    this.drawMs.push(Math.round((performance.now() - t0) * 10) / 10)
    if (this.drawMs.length > 20) this.drawMs.shift()
    this.drawn = (this.drawn || 0) + 1
  }

  /** Only what changed: the plates whose bot moved on, the lines whose count or ending changed. */
  _patch(flow, layout) {
    const before = this._drawnFlow
    const was = new Map(before.nodes.map((n) => [n.id, JSON.stringify(n)]))
    const faces = this.acts.faces?.()
    for (const n of flow.nodes) {
      if (was.get(n.id) === JSON.stringify(n)) continue
      const el = this.stage.querySelector(`.cm-node[data-node="${CSS.escape(n.id)}"]`)
      if (el && layout.box.has(n.id)) el.outerHTML = plateHtml(n, layout.box.get(n.id), flow.nodes, faces)
    }
    const said = (l) => JSON.stringify([l.count, l.failed, l.lastFailed, l.kind, l.kinds])
    const lines = new Map(bundleEdges(before.edges).map((l) => [l.id, said(l)]))
    for (const l of layout.lines) {
      if (lines.get(l.id) === said(l)) continue
      const path = this.stage.querySelector(`path[data-edge="${CSS.escape(l.id)}"]`)
      if (path) {
        path.setAttribute('stroke-width', l.width)
        path.classList.toggle('bad', Boolean(l.lastFailed))
        path.setAttribute('marker-end', `url(#cm-a-${l.lastFailed ? 'bad' : l.kind})`)
      }
      const chip = this.stage.querySelector(`.cm-chip[data-edge="${CSS.escape(l.id)}"]`)
      if (chip) chip.outerHTML = chipHtml(l, flow.nodes, this.window, ['pa', 'pb', 'solo'].find((c) => chip.classList.contains(c)) || 'solo')
    }
  }

  _hover(el) {
    const id = el?.dataset.node || null
    const edge = el?.dataset.edge || null
    if (!id && !edge) {
      delete this.stage.dataset.hot
      for (const x of this.stage.querySelectorAll('.hot')) x.classList.remove('hot')
      return
    }
    const flow = this.flow
    if (!flow) return
    // One bot's chain: who briefed it, who checks it, who rules on it, and who waits on it; or one line's two ends.
    const all = this._lines || bundleEdges(flow.edges)
    const lines = edge ? all.filter((e) => e.id === edge) : all.filter((e) => e.from === id || e.to === id)
    const ends = new Set(lines.flatMap((e) => [e.from, e.to]).concat(id ? [id] : []))
    const ids = new Set(lines.map((e) => e.id))
    this.stage.dataset.hot = '1'
    for (const x of this.stage.querySelectorAll('[data-node]')) x.classList.toggle('hot', ends.has(x.dataset.node))
    for (const x of this.stage.querySelectorAll('[data-edge]')) x.classList.toggle('hot', ids.has(x.dataset.edge))
    // The project a lit bot is working in is lit too.
    for (const x of this.stage.querySelectorAll('.cm-lane')) x.classList.toggle('hot', (x.dataset.bots || '').split(' ').some((b) => ends.has(b)))
  }

  _click(e) {
    const t = e.target
    const win = t.closest('[data-window]')?.dataset.window
    if (win && win !== this.window) {
      this.window = win
      try { localStorage.setItem('botyard.flow.window', win) } catch { /* storage off */ }
      this._syncBar()
      this._closePop()
      return void this.refresh()
    }
    const mode = t.closest('[data-mode]')?.dataset.mode
    if (mode && mode !== this.mode) {
      this.mode = mode
      try { localStorage.setItem('botyard.flow.mode', mode) } catch { /* storage off */ }
      this._syncBar()
      return void this._draw({ force: true })
    }
    if (t.closest('[data-act="cm-close"]')) return this._closePop()
    const job = t.closest('[data-job]')?.dataset.job
    if (job) { this._closePop(); return this.acts.openJob(job) }
    const edge = t.closest('[data-edge]')?.dataset.edge
    if (edge) return this._openPop(edge, t.closest('[data-edge]'))
    const node = t.closest('[data-node]')?.dataset.node
    if (node === 'owner') return this.acts.openNeeds()
    if (node && !node.startsWith('script:')) return this.acts.openBot(node)
    if (node) return this._openPop((this._lines || []).find((x) => x.from === node)?.id, t.closest('[data-node]'))
    const lane = t.closest('[data-lane]')?.dataset.lane
    if (lane) return this.acts.openProject(lane)
    if (!t.closest('.cm-pop')) this._closePop()
  }

  _openPop(edgeId, near) {
    // The List names a line by its kind too ("brief:a>b"); its box is the whole line between the two.
    const edge = (this._lines || []).find((x) => x.id === edgeId || x.id === String(edgeId || '').replace(/^[a-z]+:/, ''))
    if (!edge) return
    this.pop.innerHTML = edgeDetail(edge, this.flow.nodes, this.window)
    this.pop.hidden = false
    const host = this.el.getBoundingClientRect()
    const r = near.getBoundingClientRect()
    const w = Math.min(380, host.width - 24)
    this.pop.style.width = `${w}px`
    this.pop.style.left = `${Math.max(12, Math.min(host.width - w - 12, r.left - host.left + r.width / 2 - w / 2))}px`
    const below = r.bottom - host.top + 8
    this.pop.style.top = `${below + 260 < host.height ? below : Math.max(12, r.top - host.top - 268)}px`
    this._popFrom = near
    this.pop.querySelector('[data-act="cm-close"]').focus()
  }

  _closePop() {
    if (this.pop.hidden) return
    this.pop.hidden = true
    if (this._popFrom?.isConnected) this._popFrom.focus()
    this._popFrom = null
  }
}
