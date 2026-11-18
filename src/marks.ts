/**
 * The phone's review reckoning, apart from the screen so it can be tested: where a selection is in
 * lines, a box from a drag on a picture, and what the studio is sent. The PC page reckons the same
 * way (studio/src/ui/marks-core.js), so a mark means the same place from either.
 */
import type { DraftMark, ReviewSend, ReviewSources } from './api';

/** The lines (from 1) a selection covers. A selection that ends at the very start of a line ends on the line before. */
export function linesOf(text: string, start: number, end: number) {
  const from = Math.max(0, Math.min(start, end));
  let to = Math.max(start, end);
  if (to > from && text[to - 1] === '\n') to -= 1;
  const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;
  return { line: lineAt(from), lineEnd: lineAt(Math.max(from, to)) };
}

/** The words selected, trimmed; '' when only space was. */
export const quoteOf = (text: string, start: number, end: number) => text.slice(Math.min(start, end), Math.max(start, end)).trim();

/** A box on a picture from where a finger went down and where it came up, as fractions; a short drag is a point. */
export function boxOf(a: { x: number; y: number }, b: { x: number; y: number }, size: { width: number; height: number }) {
  const fx = (x: number) => Math.min(1, Math.max(0, x / size.width));
  const fy = (y: number) => Math.min(1, Math.max(0, y / size.height));
  const box = { x: Math.min(fx(a.x), fx(b.x)), y: Math.min(fy(a.y), fy(b.y)), w: Math.abs(fx(b.x) - fx(a.x)), h: Math.abs(fy(b.y) - fy(a.y)) };
  if (box.w * size.width < 10 && box.h * size.height < 10) return { x: fx(a.x), y: fy(a.y), w: 0, h: 0 };
  return box;
}

/** Where a mark is, said short. */
export function whereOf(mark: DraftMark) {
  if (mark.kind === 'picture') return mark.box.w || mark.box.h ? 'a box on the picture' : 'a point on the picture';
  return mark.lineEnd !== mark.line ? `lines ${mark.line}–${mark.lineEnd}` : `line ${mark.line}`;
}

/** Every mark, each with its own piece, as the studio takes them. */
export function reviewOf(src: ReviewSources, marks: DraftMark[], note: string, verdict: 'back' | 'approve', current: string, gateTo?: string): ReviewSend {
  const used = [...new Set(marks.map((m) => m.pieceId))];
  const only = used.length === 1 ? src.pieces.find((p) => p.id === used[0]) : null;
  const first = only || src.pieces.find((p) => p.id === current) || src.pieces[0];
  const piece = only || !marks.length
    ? { kind: first?.kind || 'work', ref: first?.ref || '', title: first?.title || src.title }
    : { kind: 'work', ref: '', title: `${src.ref ? `${src.ref} ` : ''}${src.title}`.trim() };
  return {
    jobId: src.jobId,
    verdict,
    note: note.trim(),
    piece,
    ...(src.gate ? { gate: { tripId: src.gate.tripId, ...(gateTo ? { to: gateTo } : {}) } } : {}),
    marks: marks.map((m) => {
      const p = src.pieces.find((x) => x.id === m.pieceId);
      const own = { kind: p?.kind || 'work', ref: p?.ref || '' };
      return m.kind === 'text'
        ? { kind: 'text' as const, comment: m.comment, piece: own, quote: m.quote, line: m.line, lineEnd: m.lineEnd }
        : { kind: 'picture' as const, comment: m.comment, piece: own, attachmentId: p?.ref || '', box: m.box };
    }),
  };
}
