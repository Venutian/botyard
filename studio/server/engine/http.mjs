/**
 * The engine's reading side: each path the crew and the map read, answered from Botyard's store.
 *
 * `handle(store, method, pathWithQuery)` gives `{ status, body }` and never throws. It only reads:
 * anything but GET is refused here, and `api.mjs` adds every path that changes something.
 */
import http from 'node:http'
import * as read from './read.mjs'

const one = '([^/]+)'
/** Each read path in use, and the function that answers it. `p` are the path's parts, `q` its query. */
const ROUTES = [
  ['/companies', (s) => read.companies(s)],
  [`/companies/${one}`, (s, p) => read.company(s, p[0])],
  [`/companies/${one}/agents`, (s, p, q) => read.agents(s, p[0], q)],
  [`/agents/${one}`, (s, p) => read.agent(s, p[0])],
  [`/agents/${one}/task-sessions`, (s, p) => read.taskSessions(s, p[0])],
  [`/agents/${one}/config-revisions`, (s, p) => read.configRevisions(s, p[0])],
  [`/companies/${one}/projects`, (s, p) => read.projects(s, p[0])],
  [`/projects/${one}`, (s, p) => read.project(s, p[0])],
  [`/companies/${one}/issues`, (s, p, q) => read.jobs(s, p[0], q)],
  [`/issues/${one}`, (s, p) => read.job(s, p[0])],
  [`/issues/${one}/comments`, (s, p, q) => read.comments(s, p[0], q)],
  [`/issues/${one}/interactions`, (s, p) => read.cards(s, p[0])],
  [`/issues/${one}/documents`, (s, p, q) => read.documents(s, p[0], q)],
  [`/issues/${one}/documents/${one}`, (s, p) => read.document(s, p[0], p[1])],
  [`/issues/${one}/documents/${one}/revisions`, (s, p) => read.documentRevisions(s, p[0], p[1])],
  [`/issues/${one}/attachments`, (s, p) => read.attachments(s, p[0])],
  [`/issues/${one}/runs`, (s, p) => read.jobRuns(s, p[0])],
  [`/issues/${one}/live-runs`, (s, p) => read.jobLiveRuns(s, p[0])],
  [`/companies/${one}/heartbeat-runs`, (s, p, q) => read.runs(s, p[0], q)],
  [`/heartbeat-runs/${one}`, (s, p) => read.run(s, p[0])],
  [`/companies/${one}/live-runs`, (s, p, q) => read.liveRuns(s, p[0], q)],
  [`/companies/${one}/routines`, (s, p) => read.routines(s, p[0])],
  [`/routines/${one}`, (s, p) => read.routine(s, p[0])],
  [`/routines/${one}/runs`, (s, p) => read.routineRuns(s, p[0])],
  [`/routines/${one}/revisions`, (s, p) => read.routineRevisions(s, p[0])],
  [`/execution-workspaces/${one}`, (s, p) => read.workspace(s, p[0])],
  [`/companies/${one}/chats`, (s, p) => read.chats(s, p[0])],
  [`/companies/${one}/chats/${one}`, (s, p) => read.chat(s, p[0], p[1])],
  [`/companies/${one}/costs/(by-agent|by-agent-model|by-provider|by-project)`, (s, p, q, now) => read.costs(s, p[0], p[1], q, now)],
]

/** The paths answered here, as patterns: for the compare script and for a person reading. */
export const READ_PATHS = ROUTES.map(([pattern]) => pattern.replaceAll(one, ':id'))

const MATCHERS = ROUTES.map(([pattern, answer]) => [new RegExp(`^${pattern}$`), answer])

/**
 * Answer one request. The path may start with `/api` or not; a query's first value of each name counts.
 */
export function handle(store, method, pathWithQuery, { now = Date.now() } = {}) {
  if (String(method).toUpperCase() !== 'GET') return { status: 405, body: { error: 'The engine only reads so far' } }
  let url
  try {
    url = new URL(pathWithQuery, 'http://engine.local')
  } catch {
    return { status: 400, body: { error: 'Not a path' } }
  }
  const where = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'
  const query = {}
  for (const [key, value] of url.searchParams) if (!(key in query)) query[key] = value
  for (const [pattern, answer] of MATCHERS) {
    const match = pattern.exec(where)
    if (!match) continue
    try {
      const parts = match.slice(1).map((part) => decodeURIComponent(part))
      return { status: 200, body: answer(store, parts, query, now) }
    } catch (err) {
      if (err instanceof read.Refused) return { status: err.status, body: { error: err.message } }
      if (err instanceof URIError) return { status: 400, body: { error: 'Not a path' } }
      return { status: 500, body: { error: 'Internal server error' } }
    }
  }
  return { status: 404, body: { error: 'API route not found' } }
}

/**
 * Serve the engine on a port of this machine only. Not called by anything yet: the plan gives the
 * engine port 3210 once the map reads from it.
 */
export function listen(store, port, host = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    const { status, body } = handle(store, req.method, req.url || '/')
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}
