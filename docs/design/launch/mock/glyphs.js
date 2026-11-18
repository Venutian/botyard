/* State marks and words shared by the directions. */
window.G = {
  ok: '<svg class="g g-ok" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="currentColor" stroke="var(--edge)" stroke-width="1.5"/></svg>',
  go: '<svg class="g g-go" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 1.4a4.6 4.6 0 0 1 0 9.2z" fill="currentColor"/></svg>',
  yours: '<svg class="g g-yours" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .6l4.8 2.7v5.4L6 11.4 1.2 8.7V3.3z" fill="currentColor" stroke="var(--edge)" stroke-width="1.4"/></svg>',
  bad: '<svg class="g g-bad" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .9l5.3 9.6H.7z" fill="currentColor" stroke="var(--edge)" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  none: '<svg class="g g-none" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 1.8"/></svg>',
}
/* Which mark a cell gets: by what it means, not by how it was stored. */
window.markOf = (c) => (c.how === 'none' ? 'none' : c.tone === 'ok' ? 'ok' : c.tone === 'bad' ? 'bad' : c.tone === 'look' && c.how !== 'told' ? 'yours' : c.tone === 'go' ? 'go' : 'none')
window.esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
window.ICON = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>',
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
}
