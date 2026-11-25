/**
 * A page of the owner's own, on the phone. The phone runs none of a page's code: the page's server file
 * answers `GET /phone` with a view, and the app draws it with its own parts (screens/OwnPage.tsx).
 * This file reads that answer, apart from the screen so it can be tested: anything it does not know is
 * left out, words are cut to a length, lists to a count, and a button can only call the page's own server.
 *
 *   { "title": "Notes", "note": "one line under it", "blocks": [ ... ] }
 *
 * The blocks, drawn top to bottom:
 *   heading  { text }
 *   text     { text, tone?, quiet? }                    markdown; `quiet` is a small grey footnote
 *   hero     { label, value, note?, tone?, open? }      the one number a screen is about, large
 *   alerts   { title?, items: [{ title, text?, tone? }] }  one line each with a coloured mark; a tap shows its text
 *   tiles    { items: [{ label, value, note?, tone?, open? }] }  numbers side by side
 *   chart    { title?, note?, param?, mark?, items: [{ label, value, shown?, on?, pick?, tone?, open? }] }
 *            bars up from a line; a bar with `pick` opens the view again with `param=pick`;
 *            `mark` draws a dashed line across at that value (a usual amount)
 *   bars     { title?, items: [{ label, value, shown?, note?, mark?, tone?, open? }] }
 *            bars across, longest first as sent; `mark` draws a thin line at that value (a usual amount)
 *   split    { title?, items: [{ label, value, shown?, open? }] }
 *            one bar cut into shares (where a whole went), each share with its colour and per cent below
 *   rows     { title?, items: [{ title, detail?, note?, right?, tone?, open? }] }
 *   table    { title?, columns: [text], rows: [{ label, cells: [text], tones?: [tone], tone?, open? }] }
 *            a grid that scrolls sideways, the label column kept in place (months side by side)
 *   list     { title?, items: [text] }
 *   choose   { param, value, options: [{ id, name }] }  opens the view again with `param=id`; more than four
 *            options sit on one row that scrolls sideways (tabs)
 *   search   { param, value?, placeholder? }            a search box: opens the view again with `param=` the words
 *   actions  { items: [{ label, call, body?, kind?, done? }] }
 *            POSTs `body` to the page's own `call` (a path like "/sync"), says `done`, and reads the view again
 *   form     { title?, call, submit, done?, fixed?, fields: [{ name, label, kind, value?, placeholder?, options? }] }
 *            a few fields (kind text, number, or choice with options [{ id, name }]) and one button that POSTs
 *            `fixed` and the fields' values to the page's own `call`, says `done`, and reads the view again
 *   fold     { title, blocks }                          shut until tapped; holds any block but a fold
 * `tone` is one of good, bad, warn.
 * `open` is a few choices at once, `{ "category": "Groceries", "page": "" }`: a tap on that item opens the view again
 * with them (an empty value takes a choice away), and the phone's Back goes back to the view before it.
 */

export type Tone = '' | 'good' | 'bad' | 'warn';
/** Choices a tap opens the view with; an empty value takes that choice away. */
export type Open = Record<string, string>;
export type Tile = { label: string; value: string; note: string; tone: Tone; open: Open | null };
export type ChartBar = { label: string; value: number; shown: string; on: boolean; pick: string; tone: Tone; open: Open | null };
export type Bar = { label: string; value: number; shown: string; note: string; mark: number | null; tone: Tone; open: Open | null };
export type Share = { label: string; value: number; shown: string; open: Open | null };
export type RowItem = { title: string; detail: string; note: string; right: string; tone: Tone; open: Open | null };
export type TableRow = { label: string; cells: string[]; tones: Tone[]; tone: Tone; open: Open | null };
export type FormField = { name: string; label: string; kind: 'text' | 'number' | 'choice'; value: string; placeholder: string; options: { id: string; name: string }[] };
export type Action = { label: string; call: string; body: Record<string, unknown>; kind: 'primary' | 'quiet'; done: string };
export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; tone: Tone; quiet: boolean }
  | { kind: 'hero'; label: string; value: string; note: string; tone: Tone; open: Open | null }
  | { kind: 'alerts'; title: string; items: { title: string; text: string; tone: Tone }[] }
  | { kind: 'tiles'; items: Tile[] }
  | { kind: 'chart'; title: string; note: string; param: string; mark: number | null; items: ChartBar[] }
  | { kind: 'bars'; title: string; items: Bar[] }
  | { kind: 'split'; title: string; items: Share[] }
  | { kind: 'rows'; title: string; items: RowItem[] }
  | { kind: 'table'; title: string; columns: string[]; rows: TableRow[] }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'choose'; param: string; value: string; options: { id: string; name: string }[] }
  | { kind: 'search'; param: string; value: string; placeholder: string }
  | { kind: 'actions'; items: Action[] }
  | { kind: 'form'; title: string; call: string; submit: string; done: string; fixed: Record<string, string>; fields: FormField[] }
  | { kind: 'fold'; title: string; blocks: Block[] };
export type OwnView = { title: string; note: string; blocks: Block[] };

const MAX_BLOCKS = 60;
const MAX_ITEMS = 40;
const PARAM = /^[a-z][a-z0-9_-]{0,23}$/i;
/** A call to the page's own server: a plain path, never a way out of it. */
const CALL = /^\/[a-z0-9][a-z0-9/_-]{0,63}$/i;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const tone = (v: unknown): Tone => (v === 'good' || v === 'bad' || v === 'warn' ? v : '');
const items = <T>(v: unknown, read: (x: unknown) => T | null, max = MAX_ITEMS): T[] =>
  (Array.isArray(v) ? v : []).slice(0, max).map(read).filter((x): x is T => x !== null);
/** An item's `open`: up to four choices with names a view may use; none that holds a usable one is null. */
function readOpen(v: unknown): Open | null {
  const o = obj(v);
  if (!o) return null;
  const out: Open = {};
  for (const [k, val] of Object.entries(o).slice(0, 4)) if (PARAM.test(k) && (typeof val === 'string' || typeof val === 'number')) out[k] = str(val, 60);
  return Object.keys(out).length ? out : null;
}

function block(raw: unknown, inFold = false): Block | null {
  const b = obj(raw);
  if (!b) return null;
  const title = str(b.title, 80);
  switch (b.kind) {
    case 'heading': {
      const text = str(b.text, 80);
      return text ? { kind: 'heading', text } : null;
    }
    case 'text': {
      const text = str(b.text, 4000);
      return text ? { kind: 'text', text, tone: tone(b.tone), quiet: b.quiet === true } : null;
    }
    case 'hero': {
      const label = str(b.label, 60);
      const value = str(b.value, 40);
      return label && value ? { kind: 'hero', label, value, note: str(b.note, 80), tone: tone(b.tone), open: readOpen(b.open) } : null;
    }
    case 'alerts': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const alertTitle = str(t?.title, 80);
        return t && alertTitle ? { title: alertTitle, text: str(t.text, 600), tone: tone(t.tone) } : null;
      }, 12);
      return list.length ? { kind: 'alerts', title, items: list } : null;
    }
    case 'tiles': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const label = str(t?.label, 40);
        const value = str(t?.value, 40);
        return t && label && value ? { label, value, note: str(t.note, 80), tone: tone(t.tone), open: readOpen(t.open) } : null;
      }, 12);
      return list.length ? { kind: 'tiles', items: list } : null;
    }
    case 'chart': {
      const param = PARAM.test(str(b.param, 24)) ? str(b.param, 24) : '';
      const list = items(b.items, (x) => {
        const t = obj(x);
        const value = num(t?.value);
        const label = str(t?.label, 12);
        return t && label && value !== null ? { label, value: Math.max(0, value), shown: str(t.shown, 24), on: t.on === true, pick: param ? str(t.pick, 40) : '', tone: tone(t.tone), open: readOpen(t.open) } : null;
      }, 24);
      const mark = num(b.mark);
      return list.length ? { kind: 'chart', title, note: str(b.note, 80), param, mark: mark === null ? null : Math.max(0, mark), items: list } : null;
    }
    case 'bars': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const value = num(t?.value);
        const label = str(t?.label, 60);
        const mark = num(t?.mark);
        return t && label && value !== null ? { label, value: Math.max(0, value), shown: str(t.shown, 24), note: str(t.note, 80), mark: mark === null ? null : Math.max(0, mark), tone: tone(t.tone), open: readOpen(t.open) } : null;
      });
      return list.length ? { kind: 'bars', title, items: list } : null;
    }
    case 'split': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const value = num(t?.value);
        const label = str(t?.label, 60);
        return t && label && value !== null && value > 0 ? { label, value, shown: str(t.shown, 24), open: readOpen(t.open) } : null;
      }, 10);
      return list.length ? { kind: 'split', title, items: list } : null;
    }
    case 'table': {
      const columns = items(b.columns, (x) => (typeof x === 'string' || typeof x === 'number' ? str(x, 16) : null), 13);
      if (!columns.length) return null;
      const rows = items(b.rows, (x) => {
        const t = obj(x);
        const label = str(t?.label, 40);
        if (!t || !label) return null;
        const cells = columns.map((_, i) => str(Array.isArray(t.cells) ? t.cells[i] : '', 20));
        const tones = columns.map((_, i) => tone(Array.isArray(t.tones) ? t.tones[i] : ''));
        return { label, cells, tones, tone: tone(t.tone), open: readOpen(t.open) };
      });
      return rows.length ? { kind: 'table', title, columns, rows } : null;
    }
    case 'rows': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const rowTitle = str(t?.title, 80);
        return t && rowTitle ? { title: rowTitle, detail: str(t.detail, 160), note: str(t.note, 160), right: str(t.right, 24), tone: tone(t.tone), open: readOpen(t.open) } : null;
      });
      return list.length ? { kind: 'rows', title, items: list } : null;
    }
    case 'list': {
      const list = items(b.items, (x) => str(x, 400) || null);
      return list.length ? { kind: 'list', title, items: list } : null;
    }
    case 'choose': {
      const param = str(b.param, 24);
      const options = items(b.options, (x) => {
        const t = obj(x);
        const id = str(t?.id, 40);
        const name = str(t?.name, 24);
        return t && id && name ? { id, name } : null;
      }, 16);
      return PARAM.test(param) && options.length ? { kind: 'choose', param, value: str(b.value, 40), options } : null;
    }
    case 'search': {
      const param = str(b.param, 24);
      return PARAM.test(param) ? { kind: 'search', param, value: str(b.value, 60), placeholder: str(b.placeholder, 60) } : null;
    }
    case 'actions': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const label = str(t?.label, 32);
        const call = str(t?.call, 64);
        if (!t || !label || !CALL.test(call) || call.includes('//')) return null;
        return { label, call, body: obj(t.body) ?? {}, kind: t.kind === 'quiet' ? 'quiet' as const : 'primary' as const, done: str(t.done, 120) };
      }, 4);
      return list.length ? { kind: 'actions', items: list } : null;
    }
    case 'form': {
      const call = str(b.call, 64);
      if (!CALL.test(call) || call.includes('//')) return null;
      const fields = items(b.fields, (x) => {
        const f = obj(x);
        const name = str(f?.name, 24);
        const label = str(f?.label, 60);
        if (!f || !PARAM.test(name) || !label) return null;
        const kind = f.kind === 'number' || f.kind === 'choice' ? f.kind : 'text';
        const options = kind === 'choice' ? items(f.options, (o) => {
          const t = obj(o);
          const id = str(t?.id, 40);
          const optName = str(t?.name, 32);
          return t && id && optName ? { id, name: optName } : null;
        }, 30) : [];
        if (kind === 'choice' && !options.length) return null;
        return { name, label, kind, value: str(f.value, 300), placeholder: str(f.placeholder, 60), options } as FormField;
      }, 8);
      // Fixed values ride along unseen (which payment, which goal): plain words only, a few of them.
      const fixed: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(b.fixed) ?? {}).slice(0, 4)) if (PARAM.test(k) && (typeof v === 'string' || typeof v === 'number')) fixed[k] = str(v, 60);
      return fields.length ? { kind: 'form', title, call, submit: str(b.submit, 32) || 'Save', done: str(b.done, 120), fixed, fields } : null;
    }
    case 'fold': {
      if (inFold) return null;
      const inner = items(b.blocks, (x) => block(x, true), MAX_BLOCKS);
      return title && inner.length ? { kind: 'fold', title, blocks: inner } : null;
    }
    default:
      return null;
  }
}

/** The view a page's server sent, as the phone may draw it. Anything else is an empty view. */
export function readView(raw: unknown): OwnView {
  const v = obj(raw);
  return { title: str(v?.title, 40), note: str(v?.note, 200), blocks: items(v?.blocks, (x) => block(x), MAX_BLOCKS) };
}

/** The choices after a tap on an item with `open`: its values laid over the ones so far, an empty one taken away. */
export function withOpen(choices: Record<string, string>, opened: Open): Record<string, string> {
  const next = { ...choices };
  for (const [k, v] of Object.entries(opened)) {
    if (v) next[k] = v;
    else delete next[k];
  }
  return next;
}

/** The address of the view with the owner's choices so far: `/phone?month=2026-10&review=weekly`. */
export function viewPath(choices: Record<string, string>) {
  const query = Object.entries(choices).filter(([k, v]) => PARAM.test(k) && v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return query ? `/phone?${query}` : '/phone';
}
