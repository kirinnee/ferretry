import type { SitrepPr } from '@ferretry/core-ferrets/contract';
import type { PrLink } from '../../../contract/index.ts';

/**
 * The PR a lead's pack table shows for a card (today's `prOf`): the open — or not yet polled — one when there are
 * several, the newest linked one otherwise, and none for a card with no PR. Links are kept oldest first.
 */
export function prOf(prs: readonly PrLink[]): SitrepPr | undefined {
  const live = prs.filter(pr => pr.state === 'open' || pr.state === 'unknown');
  const pick = live.at(-1) ?? prs.at(-1);
  return pick === undefined
    ? undefined
    : { number: pick.number, url: pick.url, state: pick.state, draft: pick.draft, checks: pick.checks };
}
