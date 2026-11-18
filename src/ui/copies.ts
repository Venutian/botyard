/**
 * A bot with copies of itself on other AIs is one card. The tag names the AI the running copy is on; a bot
 * that holds several jobs says how many ("checking 3"). The same words as the PC page.
 */
import type { BotCopy } from '../api';

const VERB: Record<string, string> = { checking: 'checking', building: 'building', fix: 'fixing', fixing: 'fixing', ruling: 'ruling' };

/** "checking 3", or "on 3 jobs" when they are of several kinds; '' when the bot holds one job or none. */
export function busyWords(jobs?: { stage: string }[]): string {
  if (!jobs || jobs.length < 2) return '';
  const verbs = new Set(jobs.map((j) => VERB[(j.stage || '').split(' ')[0].toLowerCase()] ?? ''));
  const verb = verbs.size === 1 ? [...verbs][0] : '';
  return verb ? `${verb} ${jobs.length}` : `on ${jobs.length} jobs`;
}

/** The tag for a bot with copies: the AI its running copy is on; '' for a bot with none. */
export function copyTag(bot: { copies?: BotCopy[]; on?: string }): string {
  return bot.copies && bot.copies.length > 1 ? bot.on ?? '' : '';
}

/** One line for a screen reader: which AI runs it and how many copies it has. */
export function copySentence(bot: { copies?: BotCopy[]; on?: string }): string {
  return copyTag(bot) ? `On ${bot.on}, one of ${bot.copies!.length} copies.` : '';
}
