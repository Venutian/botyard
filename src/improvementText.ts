// The words of the Improvements page, shared by the phone screen and its test. No imports: plain functions.
export type Step = { by: string; status: string; at: number };
type Finding = { status: string; decidedBy?: string; decidedAt?: number; history?: Step[] };

export const STATUS_NAMES: Record<string, string> = { new: 'New', ask: 'Ask me', accepted: 'Accepted', done: 'Done', rejected: 'Rejected', stale: 'Stale' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "16 Nov" from a time in seconds. */
export const shortDate = (seconds: number): string => {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** Who a decision was by, in words: 'you' for the owner, else the lead bot by its name. */
const whoDecided = (by: string, lead: string): string => (by === 'owner' ? 'you' : lead || 'the lead');

/** "Decided by Lead, 16 Nov" or "Decided by you, 17 Nov"; '' when nobody has decided. */
export const decidedLine = (i: Finding, lead = ''): string =>
  i.decidedBy ? `Decided by ${whoDecided(i.decidedBy, lead)}${i.decidedAt ? `, ${shortDate(i.decidedAt)}` : ''}` : '';

/** "Lead rejected 16 Nov; you accepted 17 Nov"; '' when there is at most one decision. */
export const historyLine = (i: Finding, lead = ''): string => {
  const steps: Step[] = [...(i.history ?? [])];
  if (i.decidedBy && !steps.some((h) => h.at === i.decidedAt && h.by === i.decidedBy)) steps.push({ by: i.decidedBy, status: i.status, at: i.decidedAt ?? 0 });
  if (steps.length < 2) return '';
  const verb: Record<string, string> = { accepted: 'accepted', rejected: 'rejected', ask: 'asked about', new: 'reopened' };
  const text = steps.map((h) => `${whoDecided(h.by, lead)} ${verb[h.status] ?? h.status}${h.at ? ` ${shortDate(h.at)}` : ''}`).join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
