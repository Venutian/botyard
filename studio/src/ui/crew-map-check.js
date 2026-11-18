/**
 * What the crew map promises about its picture, checked on a layout: no line passes through a plate, no
 * pill lies on a plate or on another pill, and everything is inside the box. Used by the tests, and by
 * anyone checking a real yard's picture (`node -e` on a saved flow).
 */
export function checkLayout(layout) {
  const problems = []
  const cards = [...layout.box.entries()]
  const inside = (x, y, b) => x > b.x + 1 && x < b.x + b.w - 1 && y > b.y + 1 && y < b.y + b.h - 1
  for (const l of layout.lines) {
    for (let i = 0; i < l.points.length - 1; i++) {
      const p = l.points[i]; const q = l.points[i + 1]
      const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2))
      for (const [id, b] of cards) {
        for (let s = 0; s <= steps; s++) {
          const x = p.x + (q.x - p.x) * s / steps; const y = p.y + (q.y - p.y) * s / steps
          if (inside(x, y, b)) { problems.push(`line ${l.id} crosses ${id}`); break }
        }
      }
    }
  }
  const pills = layout.lines.map((l) => ({ id: l.id, x: l.chip.x - l.chip.w / 2, y: l.chip.y - 12, w: l.chip.w, h: 24 }))
  const hits = (r, q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h
  pills.forEach((p, i) => {
    for (const q of pills.slice(i + 1)) if (hits(p, q)) problems.push(`pill ${p.id} on pill ${q.id}`)
    for (const [id, b] of cards) if (hits(p, b)) problems.push(`pill ${p.id} on ${id}`)
    if (p.x < 0 || p.x + p.w > layout.chartW + 4 || p.y < 0 || p.y + p.h > layout.height) problems.push(`pill ${p.id} outside`)
  })
  return [...new Set(problems)]
}
