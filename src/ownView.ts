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
 *   text     { text, tone? }                            markdown
 *   tiles    { items: [{ label, value, note?, tone? }] }  numbers side by side
 *   chart    { title?, param?, items: [{ label, value, shown?, on?, pick? }] }
 *            bars up from a line; a bar with `pick` opens the view again with `param=pick`
 *   bars     { title?, items: [{ label, value, shown?, note?, mark?, tone? }] }
 *            bars across, longest first as sent; `mark` draws a thin line at that value (a usual amount)
 *   rows     { title?, items: [{ title, detail?, note?, right?, tone? }] }
 *   list     { title?, items: [text] }
 *   choose   { param, value, options: [{ id, name }] }  opens the view again with `param=id`
 *   actions  { items: [{ label, call, body?, kind?, done? }] }
 *            POSTs `body` to the page's own `call` (a path like "/sync"), says `done`, and reads the view again
 *   fold     { title, blocks }                          shut until tapped; holds any block but a fold
 * `tone` is one of good, bad, warn.
 */

export type Tone = '' | 'good' | 'bad' | 'warn';
export type Tile = { label: string; value: string; note: string; tone: Tone };
export type ChartBar = { label: string; value: number; shown: string; on: boolean; pick: string };
export type Bar = { label: string; value: number; shown: string; note: string; mark: number | null; tone: Tone };
export type RowItem = { title: string; detail: string; note: string; right: string; tone: Tone };
export type Action = { label: string; call: string; body: Record<string, unknown>; kind: 'primary' | 'quiet'; done: string };
export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; tone: Tone }
  | { kind: 'tiles'; items: Tile[] }
  | { kind: 'chart'; title: string; param: string; items: ChartBar[] }
  | { kind: 'bars'; title: string; items: Bar[] }
  | { kind: 'rows'; title: string; items: RowItem[] }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'choose'; param: string; value: string; options: { id: string; name: string }[] }
  | { kind: 'actions'; items: Action[] }
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
      return text ? { kind: 'text', text, tone: tone(b.tone) } : null;
    }
    case 'tiles': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const label = str(t?.label, 40);
        const value = str(t?.value, 40);
        return t && label && value ? { label, value, note: str(t.note, 80), tone: tone(t.tone) } : null;
      }, 12);
      return list.length ? { kind: 'tiles', items: list } : null;
    }
    case 'chart': {
      const param = PARAM.test(str(b.param, 24)) ? str(b.param, 24) : '';
      const list = items(b.items, (x) => {
        const t = obj(x);
        const value = num(t?.value);
        const label = str(t?.label, 12);
        return t && label && value !== null ? { label, value: Math.max(0, value), shown: str(t.shown, 24), on: t.on === true, pick: param ? str(t.pick, 40) : '' } : null;
      }, 24);
      return list.length ? { kind: 'chart', title, param, items: list } : null;
    }
    case 'bars': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const value = num(t?.value);
        const label = str(t?.label, 60);
        const mark = num(t?.mark);
        return t && label && value !== null ? { label, value: Math.max(0, value), shown: str(t.shown, 24), note: str(t.note, 80), mark: mark === null ? null : Math.max(0, mark), tone: tone(t.tone) } : null;
      });
      return list.length ? { kind: 'bars', title, items: list } : null;
    }
    case 'rows': {
      const list = items(b.items, (x) => {
        const t = obj(x);
        const rowTitle = str(t?.title, 80);
        return t && rowTitle ? { title: rowTitle, detail: str(t.detail, 160), note: str(t.note, 160), right: str(t.right, 24), tone: tone(t.tone) } : null;
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
      }, 12);
      return PARAM.test(param) && options.length ? { kind: 'choose', param, value: str(b.value, 40), options } : null;
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

/** The address of the view with the owner's choices so far: `/phone?month=2026-10&review=weekly`. */
export function viewPath(choices: Record<string, string>) {
  const query = Object.entries(choices).filter(([k, v]) => PARAM.test(k) && v).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return query ? `/phone?${query}` : '/phone';
}
