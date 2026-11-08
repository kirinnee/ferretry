/** The pull requests of the cards a nudge can name. */
export interface CardPullRequests {
  readonly id: string;
  readonly prs?: readonly { readonly number: number; readonly url: string }[];
}

const CARD = /&([A-Za-z]+\d+)/u;
const PR = /\bPR #(\d+)\b/gu;

/**
 * The nudge's one line with each `PR #n` it names turned into a link to that pull request, when the card it
 * is about links one. The card reference itself is the reader's to prove and open (docs/reference-standard.md);
 * a PR the card does not link stays plain words.
 * @pending board: linkNudgePullRequests in app/lib/board-nudge.ts is imported by the unmerged branch rebuild/port-ferrets-b (core/ferrets/app/components/agent-message-rows.tsx), so it stays until that branch lands
 */
export function linkNudgePullRequests(text: string, cards: readonly CardPullRequests[] | undefined): string {
  const written = CARD.exec(text)?.[1]?.toUpperCase();
  const prs = written === undefined ? undefined : cards?.find(card => card.id.toUpperCase() === written)?.prs;
  if (prs === undefined) return text;
  return text.replace(PR, (named, number: string) => {
    const pr = prs.find(candidate => candidate.number === Number(number));
    return pr === undefined ? named : `[${named}](${pr.url})`;
  });
}
