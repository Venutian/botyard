/**
 * A run's feed on the map: what the bot said, its thinking where the tool shows it, each tool it ran
 * as one line that opens to its input and result, and what went wrong in red. A run still going is
 * read again every few seconds; the feed follows its end unless the owner has scrolled up to read.
 */
import { markdown } from './markdown.js'

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** A short, steady hash of a text: a feed item keeps its place and its open state across reads. */
function hash(text) {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

/** The key an item keeps from one read to the next (its place in the read moves as the log grows). */
export function feedKey(item, seen) {
  const base = item.kind === 'tool' && item.id ? `t:${item.id}` : `${item.kind}:${hash(item.kind === 'tool' ? `${item.name} ${item.input}` : item.text)}`
  const n = (seen.get(base) || 0) + 1
  seen.set(base, n)
  return n > 1 ? `${base}#${n}` : base
}

const STATE_WORDS = { running: 'Running', done: 'Done', failed: 'Failed', unfinished: 'No result' }

/** One item of the feed, as the inside of its row. `live` says a tool still running is running now. */
export function feedItemHtml(item, { live = false } = {}) {
  const depth = item.depth ? ' sub' : ''
  if (item.kind === 'said') return `<li class="said${depth}"><div class="said doc">${markdown(item.text)}</div></li>`
  if (item.kind === 'thinking') {
    const first = item.text.split('\n').find((l) => l.trim()) || ''
    return `<li class="thinking${depth}"><details><summary><i aria-hidden="true">✻</i><span>${esc(first)}</span></summary><pre>${esc(item.text)}</pre></details></li>`
  }
  if (item.kind === 'error') return `<li class="error${depth}" role="note"><i aria-hidden="true">!</i><pre>${esc(item.text)}</pre></li>`
  if (item.kind === 'note') return `<li class="note${depth}"><i aria-hidden="true">·</i><span>${esc(item.text)}</span></li>`
  if (item.kind === 'tool') {
    const state = item.state === 'running' && !live ? 'unfinished' : item.state
    const body = `${item.input ? `<h5>Input</h5><pre>${esc(item.input)}</pre>` : ''}${item.output ? `<h5>${state === 'failed' ? 'Error' : 'Result'}</h5><pre class="${state === 'failed' ? 'bad' : ''}">${esc(item.output)}</pre>` : state === 'running' ? '<p class="dim">Still running…</p>' : ''}`
    const can = Boolean(item.input || item.output)
    return `<li class="tool ${esc(state)}${depth}"><details ${can ? '' : 'class="empty"'}><summary title="${esc(STATE_WORDS[state] || '')}"><i class="dot" aria-label="${esc(STATE_WORDS[state] || '')}"></i><b>${esc(item.name)}</b><span class="sum">${esc(item.summary)}</span></summary>${can ? `<div class="io">${body}</div>` : ''}</details></li>`
  }
  return ''
}

/** The feed's frame, before its first read: the box the items go in and the line that says how live it is. */
export function feedFrameHtml({ trimmed = false } = {}) {
  return `<div class="run-feed" data-part="run-feed">
    <p class="feed-state"><span class="live-dot" hidden></span><span class="feed-says">Reading the run…</span></p>
    <div class="feed-box" tabindex="0" aria-live="polite">${trimmed ? '<p class="hint feed-cut">Earlier steps are left out: this is the end of a long run.</p>' : ''}<ol class="feed"></ol></div>
    <button class="btn feed-jump" type="button" hidden>New steps below</button>
  </div>`
}

/** The feed in a page: items patched in place, so an opened tool stays open and the scroll stays put. */
export class FeedView {
  constructor(root) {
    this.root = root
    this.box = root.querySelector('.feed-box')
    this.list = root.querySelector('.feed')
    this.says = root.querySelector('.feed-says')
    this.dot = root.querySelector('.live-dot')
    this.jump = root.querySelector('.feed-jump')
    this.rows = new Map()
    this.first = true
    this.follow = true
    this.box.addEventListener('scroll', () => {
      this.follow = this._atEnd()
      if (this.follow) this.jump.hidden = true
    })
    this.jump.addEventListener('click', () => { this.follow = true; this._toEnd(); this.jump.hidden = true })
  }

  _atEnd() { return this.box.scrollHeight - this.box.scrollTop - this.box.clientHeight < 48 }

  _toEnd() { this.box.scrollTop = this.box.scrollHeight }

  /** Show a read of the run. */
  update({ feed = [], live = false, feedTrimmed = false }) {
    const follow = this.first || this.follow
    const seen = new Map()
    const next = []
    let added = 0
    for (const item of feed) {
      const key = feedKey(item, seen)
      const html = feedItemHtml(item, { live })
      const h = hash(html)
      let row = this.rows.get(key)
      if (!row || row.dataset.h !== h) {
        const open = row?.querySelector('details')?.open
        const made = document.createElement('template')
        made.innerHTML = html.trim()
        const fresh = made.content.firstElementChild
        if (!fresh) continue
        fresh.dataset.key = key
        fresh.dataset.h = h
        if (open) fresh.querySelector('details')?.setAttribute('open', '')
        if (!row) added++
        row = fresh
      }
      next.push(row)
    }
    this.rows = new Map(next.map((r) => [r.dataset.key, r]))
    this.list.replaceChildren(...next)
    this.root.querySelector('.feed-cut')?.toggleAttribute('hidden', !feedTrimmed)
    this.dot.hidden = !live
    this.root.classList.toggle('live', live)
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    this.says.textContent = !feed.length
      ? live ? 'Started: nothing written yet. This updates by itself.' : 'The run wrote nothing a person reads.'
      : live ? `Live, read at ${now}. It follows the newest step unless you scroll up.` : `${feed.length} step${feed.length === 1 ? '' : 's'}${feedTrimmed ? ', the end of a long run' : ''}.`
    if (follow) this._toEnd()
    else if (added) this.jump.hidden = false
    this.first = false
  }
}
