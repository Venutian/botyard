
import { inkOn } from './crew-colours.js'

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
const WINDOW_WORDS = { now: 'open now and the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days' }

/** Which row of the chart a node stands in. */
const ROW_OF = { owner: 0, lead: 1, ruler: 1, researcher: 1, builder: 2, general: 2, checker: 3, reviewer: 3, script: 4 }
const ROLE_ORDER = { lead: 0, ruler: 1, researcher: 2, builder: 0, general: 1, checker: 0, reviewer: 1 }

const NODE_W = 236
const NODE_H = 106
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
  const job = node.job ? `${node.job.stage} ${node.job.title}, ${node.job.ref}${node.job.project ? `, in ${node.job.project}` : ''}.` : node.why || 'No job now.'
  const share = node.week?.share === null || node.week?.share === undefined ? '' : ` ${pct(node.week.share)} of the Claude week.`
  const met = node.met || node.notMet ? ` ${node.met} met, ${node.notMet} not met this week.` : ''
  return `${node.name}, ${node.roleName.toLowerCase()}, ${node.model}. ${STATUS[node.status] || node.status}. ${job} Answers to ${boss ? (boss.kind === 'owner' ? 'you' : boss.name) : 'nobody'}. ${plural(node.runsToday, 'run')} today.${share}${met}`
}

/** A line, said in one sentence. */
export function edgeSentence(edge, nodes, window = '24h') {
  const name = (id) => { const n = nodes.find((x) => x.id === id); return n ? (n.kind === 'owner' ? 'you' : n.name) : 'someone' }
  const failed = edge.failed ? `, ${edge.failed} failed` : ''
  if (edge.kind === 'wait') return `${name(edge.from)} waits on ${name(edge.to)}${edge.count > 1 ? ` (${edge.count})` : ''}.`
  return `${plural(edge.count, KIND[edge.kind]?.one || edge.kind, KIND[edge.kind]?.many)} from ${name(edge.from)} to ${name(edge.to)} in ${WINDOW_WORDS[window] || window}${failed}.`
}

/**
 * Where everything stands, for a box of this size. Pure: the same flow and size give the same picture.
 * Returns the nodes with their boxes, the lanes with theirs, and each line's path and the place of its count.
 */
export function layoutFlow(flow, { width, height }) {
  const narrow = width < 1020
  const laneW = narrow ? 0 : Math.round(Math.min(340, Math.max(264, width * 0.24)))
  const chartW = width - laneW - (laneW ? GAP * 2 : 0)
  const top = 18
  const scripts = flow.nodes.filter((n) => n.kind === 'script')
  const bandH = scripts.length ? SCRIPT_H + 26 : 0
  const bandY = height - bandH
  const bottom = bandY - (scripts.length ? 20 : 12)
  const rows = [[], [], [], []]
  for (const n of flow.nodes) if (n.kind !== 'script') rows[ROW_OF[n.role] ?? 2].push(n)
  for (const row of rows.slice(1)) row.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name))
  const widest = Math.max(1, ...rows.slice(1).map((r) => r.length))
  const w = Math.max(150, Math.min(NODE_W, Math.floor((chartW - GAP * 1.6 * (widest + 1)) / widest)))
  const h = NODE_H
  // The rows share the height: each its own height, the room left over spread evenly between them.
  const used = rows.map((row, i) => (row.length ? (i === 0 ? OWNER_H : h) : 0)).map((rh, i) => ({ i, rh })).filter((r) => r.rh)
  const gap = Math.max(36, (bottom - top - used.reduce((sum, r) => sum + r.rh, 0)) / Math.max(1, used.length - 1))
  const rowY = new Map()
  let y = top
  for (const r of used) { rowY.set(r.i, Math.round(y)); y += r.rh + gap }
  const box = new Map()
  rows.forEach((row, i) => {
    if (!row.length || i === 0) return
    const total = row.length * w + (row.length - 1) * GAP * 1.6
    let x = Math.round((chartW - total) / 2)
    for (const n of row) { box.set(n.id, { x, y: rowY.get(i), w, h }); x += Math.round(w + GAP * 1.6) }
  })
  // The owner stands over the lead.
  const owner = rows[0][0]
  if (owner) {
    const lead = rows[1].find((n) => n.role === 'lead') || rows[1][0]
    const cx = lead ? box.get(lead.id).x + w / 2 : chartW / 2
    box.set(owner.id, { x: Math.round(Math.max(0, Math.min(chartW - OWNER_W, cx - OWNER_W / 2))), y: rowY.get(0), w: OWNER_W, h: OWNER_H })
  }
  // The machine room along the bottom.
  scripts.forEach((n, i) => {
    const per = Math.max(1, Math.floor((chartW - 170) / (SCRIPT_W + 14)))
    box.set(n.id, { x: 170 + (i % per) * (SCRIPT_W + 14), y: bandY + 13, w: SCRIPT_W, h: SCRIPT_H })
  })

  // The lanes on the right, in the work order.
  const lanes = laneW ? flow.lanes.map((lane, i) => ({ ...lane, x: chartW + GAP * 2, y: top + 34 + i * (LANE_H + 10), w: laneW, h: LANE_H })) : []

  // ── the lines ───────────────────────────────────────────────────────────────────
  const pairs = new Map()
  for (const e of flow.edges) {
    const key = [e.from, e.to].sort().join('|')
    pairs.set(key, [...(pairs.get(key) || []), e])
  }
  const lines = []
  const inside = (p) => [...box.values()].some((b) => p.x > b.x - 18 && p.x < b.x + b.w + 18 && p.y > b.y - 14 && p.y < b.y + b.h + 14)
  const chips = []
  const crowded = (p) => chips.some((c) => Math.abs(c.x - p.x) < 40 && Math.abs(c.y - p.y) < 28)
  for (const group of pairs.values()) {
    group.forEach((e, i) => {
      const a = box.get(e.from)
      const b = box.get(e.to)
      if (!a || !b) return
      const shift = (i - (group.length - 1) / 2) * 11
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      let p0, p3, c1, c2
      if (Math.abs(ca.y - cb.y) < 4) {
        // Side by side: out of one side and into the other; past a neighbour, over the top.
        const right = cb.x > ca.x
        const next = Math.abs(cb.x - ca.x) < a.w + b.w / 2 + GAP * 2
        if (next) {
          p0 = { x: right ? a.x + a.w : a.x, y: ca.y + shift }
          p3 = { x: right ? b.x : b.x + b.w, y: cb.y + shift }
          c1 = { x: (p0.x + p3.x) / 2, y: p0.y }
          c2 = { x: (p0.x + p3.x) / 2, y: p3.y }
        } else {
          p0 = { x: ca.x + shift, y: a.y }
          p3 = { x: cb.x + shift, y: b.y }
          c1 = { x: p0.x, y: a.y - 46 }
          c2 = { x: p3.x, y: b.y - 46 }
        }
      } else {
        const down = cb.y > ca.y
        const aim = (from, to, bx) => Math.max(bx.x + 14, Math.min(bx.x + bx.w - 14, from.x + (to.x - from.x) * 0.3 + shift))
        p0 = { x: aim(ca, cb, a), y: down ? a.y + a.h : a.y }
        p3 = { x: aim(cb, ca, b), y: down ? b.y : b.y + b.h }
        const dy = (p3.y - p0.y) * 0.5
        c1 = { x: p0.x, y: p0.y + dy }
        c2 = { x: p3.x, y: p3.y - dy }
      }
      const at = (t) => {
        const u = 1 - t
        return { x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y }
      }
      const tries = [0.5 + (i - (group.length - 1) / 2) * 0.16, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82].map(at)
      const chip = tries.find((p) => !inside(p) && !crowded(p)) || tries.find((p) => !inside(p)) || tries[0]
      chips.push(chip)
      const f = (n) => Math.round(n * 10) / 10
      lines.push({ ...e, d: `M${f(p0.x)} ${f(p0.y)}C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(p3.x)} ${f(p3.y)}`, chip: { x: Math.round(chip.x), y: Math.round(chip.y) }, width: Math.round((1.6 + Math.min(4, Math.log2(e.count + 1) * 1.1)) * 10) / 10 })
    })
  }
  // Each working bot to its job's lane: a thin line, so who does what reads without a click.
  const toLanes = []
  for (const lane of lanes) {
    for (const id of lane.bots) {
      const b = box.get(id)
      if (!b) continue
      const p0 = { x: b.x + b.w, y: b.y + b.h - 18 }
      const p3 = { x: lane.x, y: lane.y + lane.h / 2 }
      toLanes.push({ bot: id, lane: lane.id, d: `M${p0.x} ${p0.y}C${p0.x + 80} ${p0.y} ${p3.x - 80} ${p3.y} ${p3.x} ${p3.y}` })
    }
  }
  return { width, height, chartW, laneW, bandY: scripts.length ? bandY : null, bandH, box, lanes, lines, toLanes }
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
      <span class="cm-needs ${node.needs ? 'on' : ''}"><b>${node.needs}</b><span>${node.needs === 1 ? 'card waits for your answer' : 'cards wait for your answer'}</span></span>
    </button>`
  }
  if (node.kind === 'script') {
    return `<button type="button" class="cm-node cm-script" data-node="${esc(node.id)}" style="${style}" aria-label="${label}">
      <svg class="cm-cog" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 3.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM6 .8v1.6M6 9.6v1.6M.8 6h1.6M9.6 6h1.6M2.3 2.3l1.1 1.1M8.6 8.6l1.1 1.1M2.3 9.7l1.1-1.1M8.6 3.4l1.1-1.1"/></svg>
      <span class="cm-name">${esc(node.name)}</span><span class="cm-count">${node.notices}</span>
    </button>`
  }
  const paint = node.look?.colour || '#7d8590'
  const job = node.job
    ? `<span class="cm-job"><span class="cm-step">${esc(node.job.stage)}</span> <span class="cm-title">${esc(node.job.title)}</span> <span class="cm-ref">${esc(node.job.ref)}</span></span>`
    : `<span class="cm-job none">${esc(node.why || (node.status === 'waiting' ? 'Waiting on other work' : 'No job now'))}</span>`
  const stats = [
    `${plural(node.runsToday, 'run')} today`,
    node.week?.share === null || node.week?.share === undefined ? '' : `<span title="Its share of all the Claude tokens the crew used this week, cached reads included">${pct(node.week.share)} of Claude</span>`,
    node.met || node.notMet ? `<span class="${node.notMet > node.met ? 'cm-bad' : ''}" title="This week's results: met and not met">${node.met} met, ${node.notMet} not</span>` : '',
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join('')
  return `<button type="button" class="cm-node cm-bot st-${esc(node.status)}" data-node="${esc(node.id)}" style="${style};--paint:${esc(paint)}" aria-label="${label} Open its page.">
    <span class="cm-head">${face(node, faces)}<span class="cm-who"><span class="cm-name">${esc(node.name)}</span><span class="cm-role">${esc(node.roleName)}, ${esc(node.model)}</span></span><span class="cm-lamp"><i></i>${esc(STATUS[node.status] || node.status)}</span></span>
    ${job}
    <span class="cm-stats">${stats}</span>
  </button>`
}

/** A line's count on the line: a button that opens its last messages. */
const chipHtml = (l, nodes, window) => `<button type="button" class="cm-chip k-${l.kind}${l.lastFailed ? ' bad' : ''}" data-edge="${esc(l.id)}" data-from="${esc(l.from)}" data-to="${esc(l.to)}" style="left:${l.chip.x}px;top:${l.chip.y}px" aria-label="${esc(edgeSentence(l, nodes, window))} Show the last messages.">${markSvg(l.kind)}<b>${l.count}</b></button>`

/**
 * What decides where everything stands: the size, the window, which plates, which lines, the lanes. While it
 * stays the same, a change (a new message, a bot starting work) only patches the plates and lines it touched.
 */
export const shapeOf = (flow, size) => JSON.stringify([size, flow.window, flow.nodes.map((n) => [n.id, n.kind, n.role]), flow.edges.map((e) => e.id), flow.lanes])

/** The picture: lines under the plates, the counts on the lines, the lanes, the machine room. */
export function flowHtml(flow, layout, { faces = {}, window = '24h' } = {}) {
  const nodes = flow.nodes
  const svg = [
    `<svg class="cm-lines" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" aria-hidden="true"><defs>`,
    ...Object.keys(KIND).flatMap((k) => [`<marker id="cm-a-${k}" class="k-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>`]),
    '<marker id="cm-a-bad" class="k-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>',
    '</defs>',
    ...layout.toLanes.map((l) => `<path class="cm-lane-line" data-from="${esc(l.bot)}" d="${l.d}"/>`),
    ...layout.lines.map((l) => `<path class="cm-edge k-${l.kind}${l.lastFailed ? ' bad' : ''}" data-edge="${esc(l.id)}" data-from="${esc(l.from)}" data-to="${esc(l.to)}" d="${l.d}" stroke-width="${l.width}" marker-end="url(#cm-a-${l.lastFailed ? 'bad' : l.kind})"/>`),
    '</svg>',
  ].join('')
  const band = layout.bandY === null ? '' : `<div class="cm-band" style="top:${layout.bandY}px;height:${layout.bandH}px;width:${layout.chartW + GAP}px"><span>Machine room<small>Scripts, no AI</small></span></div>`
  const plates = nodes.map((n) => (layout.box.has(n.id) ? plateHtml(n, layout.box.get(n.id), nodes, faces) : '')).join('')
  const chips = layout.lines.map((l) => chipHtml(l, nodes, window)).join('')
  const lanes = layout.lanes.length ? `<h2 class="cm-lanes-head" style="left:${layout.lanes[0].x}px;width:${layout.laneW}px">Projects, in work order</h2>` + layout.lanes.map((lane) => {
    const who = lane.bots.map((id) => nodes.find((n) => n.id === id)).filter(Boolean)
    return `<button type="button" class="cm-lane" data-lane="${esc(lane.name)}" style="left:${lane.x}px;top:${lane.y}px;width:${lane.w}px;height:${lane.h}px" aria-label="${esc(`${lane.rank}. ${lane.name}: ${plural(lane.open, 'open job')}, ${who.length ? `${who.map((n) => n.name).join(', ')} working` : 'nobody working'}. Open the project.`)}">
      <span class="cm-rank">${lane.rank}</span><span class="cm-lane-text"><span class="cm-name">${esc(lane.name)}</span><span class="cm-lane-sub">${plural(lane.open, 'open job')}${who.length ? '' : ', nobody on it'}</span></span>
      <span class="cm-lane-who">${who.slice(0, 4).map((n) => face(n, faces)).join('')}${who.length > 4 ? `<i class="cm-more">+${who.length - 4}</i>` : ''}</span>
    </button>`
  }).join('') : ''
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
    + '<span class="cm-key cm-key-bad"><i></i>Last one failed or not met</span>'
}

/** The last messages on one line, for the box a click opens. */
export function edgeDetail(edge, nodes, window) {
  const when = (at) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return `<header><span class="k-${edge.kind}">${markSvg(edge.kind)}</span><h3>${esc(edgeSentence(edge, nodes, window))}</h3>
    <button type="button" class="cm-x" data-act="cm-close" aria-label="Close">×</button></header>
    <ol>${edge.messages.map((m) => `<li class="${m.failed ? 'bad' : ''}"><time>${esc(when(m.at))}</time><p>${esc(m.text || '(no words)')}</p>${m.job ? `<button type="button" class="cm-job-link" data-job="${esc(m.job.id)}">${esc(m.job.title)} <span class="cm-ref">${esc(m.job.ref)}</span></button>` : ''}</li>`).join('')}</ol>`
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
        <div class="cm-seg" role="group" aria-label="Lines from">${[['now', 'Now'], ['24h', '24 h'], ['7d', '7 days']].map(([w, t]) => `<button type="button" data-window="${w}" aria-pressed="false">${t}</button>`).join('')}</div>
        <div class="cm-seg" role="group" aria-label="Show as">${[['picture', 'Map'], ['list', 'List']].map(([m, t]) => `<button type="button" data-mode="${m}" aria-pressed="false">${t}</button>`).join('')}</div>
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
    if (listed) this.list.innerHTML = flowList(flow, { window: this.window })
    else if (width > 0 && height > 0) {
      const layout = layoutFlow(flow, { width, height })
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
    const lines = new Map(before.edges.map((e) => [e.id, `${e.count}|${e.failed}|${e.lastFailed}`]))
    for (const l of layout.lines) {
      if (lines.get(l.id) === `${l.count}|${l.failed}|${l.lastFailed}`) continue
      const path = this.stage.querySelector(`path[data-edge="${CSS.escape(l.id)}"]`)
      if (path) {
        path.setAttribute('stroke-width', l.width)
        path.classList.toggle('bad', Boolean(l.lastFailed))
        path.setAttribute('marker-end', `url(#cm-a-${l.lastFailed ? 'bad' : l.kind})`)
      }
      const chip = this.stage.querySelector(`.cm-chip[data-edge="${CSS.escape(l.id)}"]`)
      if (chip) chip.outerHTML = chipHtml(l, flow.nodes, this.window)
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
    const lines = edge ? flow.edges.filter((e) => e.id === edge) : flow.edges.filter((e) => e.from === id || e.to === id)
    const ends = new Set(lines.flatMap((e) => [e.from, e.to]).concat(id ? [id] : []))
    const ids = new Set(lines.map((e) => e.id))
    this.stage.dataset.hot = '1'
    for (const x of this.stage.querySelectorAll('[data-node]')) x.classList.toggle('hot', ends.has(x.dataset.node))
    for (const x of this.stage.querySelectorAll('[data-edge]')) x.classList.toggle('hot', ids.has(x.dataset.edge))
    for (const x of this.stage.querySelectorAll('.cm-lane-line')) x.classList.toggle('hot', ends.has(x.dataset.from))
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
    if (node) return this._openPop(this.flow.edges.find((x) => x.from === node)?.id, t.closest('[data-node]'))
    const lane = t.closest('[data-lane]')?.dataset.lane
    if (lane) return this.acts.openProject(lane)
    if (!t.closest('.cm-pop')) this._closePop()
  }

  _openPop(edgeId, near) {
    const edge = this.flow?.edges.find((x) => x.id === edgeId)
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
