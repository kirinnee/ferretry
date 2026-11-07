/**
 * WHAT A CARD ASK SAYS, FROM ITS LANE'S WORKFLOW (docs/agenda.md § One ask, docs/board.md § Cards show progress).
 *
 * The agenda item is the ONLY place a gated card is answered, so it speaks for the lane in its own words: a lane the
 * owner TRIES things in says "try it" and answers Good (one tap) or words (what is wrong); a lane the owner APPROVES
 * says what is approved and answers the lane's option or words (what to change first). Both ends read the wording
 * here, from the gate alone — never from a lane's name — so a workflow's style is the lane's stage, nothing else.
 *
 * Pure and total. Nothing here moves a card: the labels it picks are the ones the daemon already answers.
 */
import type { AgendaGate, AgendaGateOption } from './agenda.ts';
import { gateNotYetLabel, gateReopenOption } from './agenda-gate.ts';

/** How a gate is answered: tried (it can send the card back with words) or approved (it can only move on or wait). */
export type GateStyle = 'try-it' | 'approval';

/** The style of a gate: a try-it when one of its options reopens the card, else an approval. */
export const gateStyle = (gate: Pick<AgendaGate, 'options'>): GateStyle =>
  gateReopenOption(gate) === undefined ? 'approval' : 'try-it';

/** The lane's own pass label that reads as "Good" on a try-it. A lane that says something else keeps its words. */
const DEFAULT_PASS_LABEL = 'Done';
export const GATE_GOOD_LABEL = 'Good';

/**
 * What a button says for a gate option. A try-it's pass reads **Good** when the lane left its default "Done" (the
 * owner's verb for a test is good or not good); every other label is the lane's own. The answer SENT is always the
 * option's real label.
 */
export const gateButtonLabel = (gate: Pick<AgendaGate, 'options'>, option: AgendaGateOption): string =>
  gateStyle(gate) === 'try-it' && option.outcome === 'close' && option.label.trim() === DEFAULT_PASS_LABEL
    ? GATE_GOOD_LABEL
    : option.label;

/** The options one tap answers: every one but the one that sends the card back, which is answered in words. */
export const gateTapOptions = (gate: Pick<AgendaGate, 'options'>): readonly AgendaGateOption[] =>
  gate.options.filter(option => option.outcome !== 'reopen-with-agenda');

/** The answer typed words are: the reopen option ("Not good"), else "Not yet" (the card waits, the ferret reads them). */
export const gateTypedLabel = (gate: Pick<AgendaGate, 'options'>): string | undefined =>
  gateReopenOption(gate)?.label ?? gateNotYetLabel(gate);

/** What the owner is told to do with words, one plain sentence, under the buttons. */
export const gateTypedLead = (gate: Pick<AgendaGate, 'options'>): string =>
  gateStyle(gate) === 'try-it'
    ? 'Not good? Type what is wrong below and send.'
    : 'Want something changed first? Type it in the box below, then send. The ferret reads your words first, and nothing is built yet.';

/** The words under a card's buttons when the owner is looking at several asks: which answer a typed message is. */
export const gateTypedPlaceholder = (gate: Pick<AgendaGate, 'options'>): string =>
  gateStyle(gate) === 'try-it' ? 'What is wrong, or what needs changing?' : 'What should change first?';

/** The ask in one line, in the lane's words: "Try it: <what>" at a try-it, else "<option>? <what>". */
export const gateAskLine = (gate: Pick<AgendaGate, 'options' | 'laneName'>, said: string): string =>
  gateStyle(gate) === 'try-it' ? `Try it: ${said}` : `${gate.options[0]?.label ?? gate.laneName}? ${said}`;

// ---------------------------------------------------------------------------------------------------
// Everything needed to try it
// ---------------------------------------------------------------------------------------------------

/** A PR as the guide reads it: the facts the board already keeps, nothing polled again. */
interface GuidePr {
  readonly url: string;
  readonly state: 'unknown' | 'open' | 'closed' | 'merged';
  readonly releasedIn: { readonly version: string } | null;
}

/** The parts of a card the guide reads. */
export interface TryItCard {
  readonly howToTest: string | null | undefined;
  readonly links: { readonly prs: readonly GuidePr[]; readonly docs?: readonly string[] };
}

/**
 * The preview environment a card links, when it has one: a link that is a Cloudflare Pages PREVIEW of a project
 * (`https://<branch-or-hash>.<project>.pages.dev/…`), never the production host (`<project>.pages.dev`). It is what
 * `fy task link <card> --doc <url>` records; nothing invents one, so a card with no preview says where to try it for real.
 */
export const previewUrlOf = (card: Pick<TryItCard, 'links'>): string | undefined => {
  for (const link of card.links.docs ?? []) {
    try {
      const url = new URL(link.trim());
      const labels = url.hostname.split('.');
      if (url.protocol === 'https:' && url.hostname.endsWith('.pages.dev') && labels.length >= 4) return url.href;
    } catch {
      // not a URL: not a preview
    }
  }
  return undefined;
};

/**
 * The product the guide is written by: its release repository (`<owner>/<product>`, from the caller's own single
 * source) and the name said in prose. Only a PR of THAT repository is shipped in it, and only then does updating it
 * install the change; a card on another project's board names that project's repository and release instead.
 */
export interface GuideProduct {
  readonly repository: string;
  readonly name: string;
}

/** The `<owner>/<repo>` a GitHub pull request URL belongs to, or `undefined` for any other link. */
const pullRepository = (url: string): string | undefined =>
  /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/u.exec(url.trim())?.[1];

/** The line for a released PR: the product's own with how to update to it, any other project's by its repository. */
const releasedLine = (pr: GuidePr, version: string, product: GuideProduct | undefined): string => {
  const repository = pullRepository(pr.url);
  if (product !== undefined && repository?.toLowerCase() === product.repository.toLowerCase())
    return `Shipped in ${product.name} v${version} (${pr.url}). Update to it to try it for real: run fy daemon update, then reload the app.`;
  return `Released in ${repository ?? 'its project'} v${version} (${pr.url}). Try it with that release.`;
};

/** The sentence that says where the work stands, for someone who knows nothing of the card. */
const standing = (prs: readonly GuidePr[], product: GuideProduct | undefined): readonly string[] => {
  const lines: string[] = [];
  for (const pr of prs) {
    if (pr.state === 'merged') {
      lines.push(
        pr.releasedIn === null
          ? `Merged, not released yet: ${pr.url}`
          : releasedLine(pr, pr.releasedIn.version, product),
      );
    } else if (pr.state === 'open') {
      lines.push(`Not merged yet, so not shipped: ${pr.url}. Wait for it, or say what is wrong.`);
    } else {
      lines.push(`Pull request: ${pr.url}`);
    }
  }
  return lines;
};

/**
 * EVERYTHING SOMEONE COLD NEEDS TO TRY IT, as Markdown, from the card alone: the preview link first when there is
 * one (**Try it on the preview**), else a line saying where to try it for real; the card's own How to test (where / do /
 * see) as written; then where the work stands (the shipped version, the PR). Too long a How to test is a pointer to the
 * card, never a cut-off copy. `limit` is the most characters the text may have.
 */
export const tryItText = (
  card: TryItCard,
  pointer: (length: number) => string,
  limit: number,
  product?: GuideProduct,
): string => {
  const preview = previewUrlOf(card);
  const steps = card.howToTest?.trim() ?? '';
  const head =
    preview === undefined
      ? 'There is no preview for this one. Try it for real: the steps below say where.'
      : `**Try it on the preview:** ${preview}`;
  const tail = standing(card.links.prs, product).join('\n');
  const frame = [head, tail].filter(text => text !== '');
  const used = frame.join('\n\n').length + 2;
  const middle =
    steps === ''
      ? 'No steps were written yet. Ask its ferret, in the reply box, how to try it.'
      : steps.length + used <= limit
        ? steps
        : pointer(steps.length);
  return [head, middle, tail].filter(text => text !== '').join('\n\n');
};
