/**
 * The Connectors screens of the Studio sheet, as HTML: the list (what is connected, what the bots'
 * own engines are signed in to, what can be added), one connector's page (who may use it, which
 * tools), and the page that adds one. Pure functions of what the server sent, like `studio-work.js`.
 */
import { esc, when } from './studio-crew.js'

const STATE_CLASS = { ready: 'done', 'signed-out': 'bad', 'signing-in': 'warn', trouble: 'bad' }
const stateHtml = (c) => `<span class="state ${STATE_CLASS[c.state] || ''}">${esc(c.stateWords)}</span>`
const LEVELS = [['off', 'No'], ['read', 'May look'], ['write', 'May change things']]
const KINDS = { developer: 'Building', data: 'Data', analytics: 'Numbers', content: 'Content', productivity: 'Planning', communication: 'Messages', commerce: 'Selling', ai: 'AI', other: 'Other' }

/** "What can the crew reach outside this computer, and is every sign-in still good?" */
export function connectorsScreen(d, { q = '' } = {}) {
  const given = (c) => c.bots.filter((b) => b.level !== 'off')
  const mine = d.connectors.map((c) => `<tr class="go-row" data-act="open-connector" data-id="${esc(c.id)}" tabindex="0">
      <td><b>${esc(c.name)}</b><small>${esc(c.address.replace(/^https?:\/\//, ''))}</small></td>
      <td>${stateHtml(c)}${c.trouble ? `<small>${esc(c.trouble)}</small>` : ''}</td>
      <td>${given(c).length ? esc(given(c).map((b) => b.name.split(' ')[0]).join(', ')) : '<span class="dim">Nobody yet</span>'}<small>${c.reads} to look, ${c.changes} that change things</small></td>
    </tr>`).join('')
  const engines = d.engines.map((e) => `<tr><td><b>${esc(e.name)}</b><small>${esc(e.for)}</small></td>
      <td><span class="state ${e.ok ? 'done' : 'bad'}">${e.ok ? 'Signed in' : 'Needs sign-in'}</span></td>
      <td>${esc(e.words)}${e.fix ? `<small class="warnish">${esc(e.fix)}</small>` : ''}</td></tr>`).join('')
  const want = q.trim().toLowerCase()
  const found = d.catalogue.filter((a) => !want || `${a.name} ${a.about} ${KINDS[a.kind] || ''}`.toLowerCase().includes(want))
  const adds = found.map((a) => `<button class="pick-row" data-act="connector-new" data-from="${esc(a.id)}"><b>${esc(a.name)}</b><span>${esc(a.about)}</span><i>${esc(KINDS[a.kind] || 'Other')}</i></button>`).join('')
  return `${d.connectors.length
    ? `<div class="grid-wrap"><table class="grid"><thead><tr><th>Service</th><th>Sign-in</th><th>Who may use it</th></tr></thead><tbody>${mine}</tbody></table></div>`
    : '<p class="none">Nothing is connected yet. Pick a service below: you sign in on its own page, then choose which bots may use it.</p>'}
    <h3>What the bots run on</h3>
    <div class="grid-wrap"><table class="grid slim"><tbody>${engines}</tbody></table></div>
    <h3>Add a service</h3>
    <form class="filters" data-part="connector-find" role="search"><input class="search" name="q" value="${esc(q)}" placeholder="Find a service" aria-label="Find a service" autocomplete="off"></form>
    <div class="pick-list">${adds || '<p class="none">No service by that name is on the list. Add it by its address.</p>'}
      <button class="pick-row other" data-act="connector-new" data-from=""><b>Another service</b><span>Any service with an MCP server, by its address</span><i>Address</i></button></div>`
}

/** The page that adds one: how you sign in to it, said before anything is sent. */
export function connectorNewScreen(app) {
  if (!app) {
    return `<form class="fields" data-part="connector-add">
      <p class="hint">Give the address of the service's MCP server. If it has a sign-in page, Botyard opens it next; if it wants a key, paste it here.</p>
      <label class="stack">What to call it<input name="name" maxlength="60" required placeholder="The service's name"></label>
      <label class="stack">Address<input name="address" type="url" required placeholder="https://…/mcp"></label>
      <label class="stack">Key, if it uses one<input name="key" type="password" autocomplete="off" placeholder="Leave empty to sign in on its page"></label>
      <div class="acts"><button class="btn primary" type="submit">Add it</button></div>
    </form>`
  }
  const signin = app.ways.find((w) => w.kind === 'signin')
  const open = app.ways.find((w) => w.kind === 'open')
  const key = app.ways.find((w) => w.kind === 'key')
  return `<p class="lead">${esc(app.about)}</p>
    ${signin ? `<section class="way"><h3>Sign in on ${esc(app.name)}'s own page</h3>
      <p class="hint">A tab opens on ${esc(app.name)}. You sign in there and say what Botyard may reach; Botyard never sees your password. No bot can use it until you choose which.</p>
      <div class="acts"><button class="btn primary" data-act="connector-add" data-from="${esc(app.id)}" data-how="signin">Sign in to ${esc(app.name)}</button></div></section>` : ''}
    ${open && !signin ? `<section class="way"><h3>No sign-in needed</h3>
      <p class="hint">${esc(app.name)} is open to anyone. No bot can use it until you choose which.</p>
      <div class="acts"><button class="btn primary" data-act="connector-add" data-from="${esc(app.id)}" data-how="open">Add ${esc(app.name)}</button></div></section>` : ''}
    ${key ? `<section class="way"><h3>${signin || open ? 'Or use a key' : 'Use a key'}</h3>
      <form class="fields" data-part="connector-add" data-from="${esc(app.id)}">
        <p class="hint">A key made on ${esc(app.name)}, limited there to what the bots should reach. It is kept on this computer, outside every project folder, and no bot can read it.${key.keysPage ? ` <a href="${esc(key.keysPage)}" target="_blank" rel="noopener">Where keys are made</a>` : ''}</p>
        <label class="stack">${esc(key.keyLabel || 'Key')}<input name="key" type="password" autocomplete="off" required></label>
        <div class="acts"><button class="btn${signin || open ? '' : ' primary'}" type="submit">Add ${esc(app.name)} with this key</button></div>
      </form></section>` : ''}`
}

/** One connector: is its sign-in good, who may use it, and which of its tools. */
export function connectorScreen(c) {
  const acts = `<div class="acts">
      ${c.how === 'signin' ? `<button class="btn ${c.state === 'ready' ? '' : 'primary'}" data-act="connector-signin" data-id="${esc(c.id)}">${c.state === 'ready' ? 'Sign in again' : 'Sign in'}</button>` : ''}
      <button class="btn ghost" data-act="connector-check" data-id="${esc(c.id)}">Check it now</button>
      <button class="btn ghost danger" data-act="connector-remove" data-id="${esc(c.id)}">Remove</button></div>`
  const facts = [
    ['Sign-in', `${stateHtml(c)}${c.trouble ? `<small class="warnish">${esc(c.trouble)}</small>` : c.state === 'signing-in' ? '<small>Finish on the service\'s page, in the tab that opened.</small>' : c.signedInAt ? `<small>${c.how === 'key' ? 'Key added' : c.how === 'open' ? 'Added' : 'Signed in'} ${esc(when(c.signedInAt))}${c.checkedAt ? `, checked ${esc(when(c.checkedAt))}` : ''}</small>` : ''}`],
    ['Address', `<code>${esc(c.address)}</code>`],
  ]
  const who = c.bots.map((b) => `<tr><td><b>${esc(b.name)}</b></td><td><span class="seg" role="radiogroup" aria-label="${esc(b.name)}">${LEVELS.map(([v, words]) => `<label><input type="radio" name="level-${esc(b.id)}" data-part="connector-level" data-bot="${esc(b.id)}" value="${v}" ${b.level === v ? 'checked' : ''}><span>${words}</span></label>`).join('')}</span></td></tr>`).join('')
  const reads = c.tools.filter((t) => t.reads)
  const changes = c.tools.filter((t) => !t.reads)
  const tool = (t) => `<li><code>${esc(t.name)}</code><span>${esc(t.about)}</span></li>`
  return `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${acts}
    <h3>Who may use it</h3>
    <p class="hint">"May look" gives a bot the tools that only read. "May change things" adds the tools you tick below, and nothing else. A change here reaches a bot at its next run.</p>
    <div class="grid-wrap"><table class="grid slim who"><tbody>${who}</tbody></table></div>
    ${c.tools.length ? `
    <h3>Tools that change things <small>${changes.filter((t) => t.allowed).length} of ${changes.length} allowed</small></h3>
    ${changes.length ? `<p class="hint">Off until you tick them. A tool that sends, posts or publishes for you still asks you on a card first.</p>
    <ul class="tools ticks">${changes.map((t) => `<li><label><input type="checkbox" data-part="connector-write" value="${esc(t.name)}" ${t.allowed ? 'checked' : ''}><code>${esc(t.name)}</code><span>${esc(t.about)}</span></label></li>`).join('')}</ul>` : '<p class="none">It has none.</p>'}
    <details class="fold"><summary>Tools that only look <small>${reads.length}</small></summary><ul class="tools">${reads.map(tool).join('')}</ul></details>`
    : `<p class="none">${c.state === 'ready' ? 'It offers no tools.' : 'Its tools are read once it is signed in.'}</p>`}`
}
