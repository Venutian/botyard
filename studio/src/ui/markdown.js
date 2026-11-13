/**
 * The little Markdown a bot writes in a chat, as safe HTML.
 *
 * Everything is escaped first and only then marked up, so nothing a bot (or a file it quotes)
 * writes can become a tag of its own. Links open only http and https. This is not a full
 * Markdown: it is headings, lists (nested by indent, numbered from where they start, ticked),
 * quotes, code, tables, bold, italic, struck-out text and links, which is what replies use.
 */

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Marks inside one line. Code spans are lifted out first so nothing inside them is touched. */
function inline(text, base, jobs) {
  const spans = []
  let out = esc(text).replace(/`([^`\n]+)`/g, (_, code) => `\u0000${spans.push(`<code>${code}</code>`) - 1}\u0000`)
  out = out
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  // A link that starts with a slash is a page of the board the bot works on. On the map a job's page
  // opens in the map itself; any other board page is just its words.
  if (jobs) {
    out = out.replace(/\[([^\]\n]+)\]\((\/[^\s)/][^\s)]*)\)/g, (_, label, href) => {
      const ref = /\/issues\/([A-Z]{2,6}-\d{1,6})(?:[#?][^\s)]*)?$/.exec(href)?.[1]
      return ref ? `<button class="link" data-act="open-job" data-id="${ref}">${label}</button>` : label
    })
  } else if (base) out = out.replace(/\[([^\]\n]+)\]\((\/[^\s)/][^\s)]*)\)/g, `<a href="${esc(base)}$2" target="_blank" rel="noopener noreferrer">$1</a>`)
  out = out
    // A bare address is a link too: bots paste them more often than they write [text](url).
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_\n]*)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)])
}

const QUOTE = /^\s*>\s?(.*)$/
const ITEM = /^(\s*)(?:([-*•+])|(\d+)[.)])\s+(.*)$/
/** A table row: text between pipes. The line under the head is dashes and colons only. */
const ROW = /^\s*\|.*\|\s*$/
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))

/** A run of list lines as nested lists: deeper indent is a list inside the item above it. */
function list(items, mark) {
  let html = ''
  const open = []
  for (const { depth, ordered, start, text } of items) {
    while (open.length && depth < open.at(-1).depth) html += `</li></${open.pop().tag}>`
    const top = open.at(-1)
    if (!top || depth > top.depth) {
      const tag = ordered ? 'ol' : 'ul'
      html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`
      open.push({ depth, tag })
    } else {
      html += '</li>'
    }
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text)
    html += task ? `<li class="task"><input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${mark(task[2])}` : `<li>${mark(text)}`
  }
  while (open.length) html += `</li></${open.pop().tag}>`
  return html
}

export function markdown(source, { base = '', jobs = false } = {}) {
  const mark = (text) => inline(text, base, jobs)
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const html = []
  let para = []
  const flush = () => {
    if (para.length) html.push(`<p>${para.map(mark).join('<br>')}</p>`)
    para = []
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      flush()
      const code = []
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i += 1) code.push(lines[i])
      html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { flush(); continue }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      // A chat bubble has no room for six sizes: a title, and everything under it.
      html.push(`<h4 class="${heading[1].length <= 2 ? 'big' : ''}">${mark(heading[2])}</h4>`)
      continue
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { flush(); html.push('<hr>'); continue }
    if (ROW.test(line) && DIVIDER.test(lines[i + 1] || '')) {
      flush()
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''))
      const td = (tag, text, n) => `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ''}>${mark(text)}</${tag}>`
      const body = []
      for (i += 2; i < lines.length && ROW.test(lines[i]); i += 1) body.push(cells(lines[i]))
      i -= 1
      // Wide tables scroll inside the bubble instead of pushing it wider than the drawer.
      html.push(`<div class="table"><table><thead><tr>${head.map((c, n) => td('th', c, n)).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${head.map((_, n) => td('td', row[n] ?? '', n)).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    if (QUOTE.test(line)) {
      flush()
      const quoted = []
      for (; i < lines.length && QUOTE.test(lines[i]); i += 1) quoted.push(QUOTE.exec(lines[i])[1])
      i -= 1
      html.push(`<blockquote>${markdown(quoted.join('\n'), { base, jobs })}</blockquote>`)
      continue
    }
    if (ITEM.test(line)) {
      flush()
      const items = []
      for (; i < lines.length; i += 1) {
        const m = ITEM.exec(lines[i])
        if (m) {
          items.push({ depth: m[1].replace(/\t/g, '    ').length, ordered: !m[2], start: Number(m[3] || 1), text: m[4] })
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items.at(-1).text += ` ${lines[i].trim()}`
        } else break
      }
      i -= 1
      html.push(list(items, mark))
      continue
    }
    para.push(line)
  }
  flush()
  return html.join('')
}
