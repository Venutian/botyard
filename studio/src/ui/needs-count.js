/**
 * THE "Needs you" number on the page: cards that wait for the owner's answer (an approval or a question),
 * not archived. The server's rule is the same (server/lib/cards.mjs `waitingCount`), and a test holds the
 * two together, so the badge, the crew map's owner plate, the bay tags, the sheet and the phone agree.
 */
export const isDecision = (item = {}) => item.kind === 'approval' || item.kind === 'question'
export const waitingCount = (items = []) => items.filter((item) => isDecision(item) && !item.archived).length
