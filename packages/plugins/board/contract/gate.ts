/**
 * A CARD'S GATE: the lane stage the owner answers, and what an ask about it says (docs/board.md § Cards show progress;
 * their asks ride the agenda). Copied from today's `protocol/src/lib/{agenda-gate,agenda-gate-wording}.ts` and the gate
 * members of `agenda.ts` / `agenda-card-asks.ts` / `agenda-card.ts`, with the words renamed (agenda item -> ask,
 * `reopen-with-agenda` -> `reopen-with-ask`) and the follow-up and swipe-direction members of the old agenda model dropped.
 *
 * Pure and total. Nothing here moves a card: the labels it picks are the ones the Board service already answers. The
 * Agenda plugin draws the ask; Board owns what a gate is, so both ends read the wording here.
 */
import { PositiveIntegerSchema } from '@ferretry/std';
import { BoardInstantSchema as InstantSchema } from './refs.ts';
import { z } from 'zod';

export const MAX_GATE_ASK_OPTIONS = 3;
export const MAX_GATE_OPTION_ID_LENGTH = 24;
export const MAX_GATE_TITLE_LENGTH = 60;

/**
 * Where a gate option sends the card as the Board applies the owner's answer: on to the next lane of its workflow, to a
 * named lane, back to rework with the owner's words, or to the board's closed lane.
 */
export const CardGateOutcomeSchema = z.enum(['next', 'lane', 'reopen-with-ask', 'close']);
export type CardGateOutcome = z.infer<typeof CardGateOutcomeSchema>;

/** One of the gate's options: its label is the ask option the owner chooses. */
export const CardGateOptionSchema = z.strictObject({
  id: z.string().min(1).max(MAX_GATE_OPTION_ID_LENGTH),
  label: z
    .string()
    .trim()
    .min(1)
    .max(MAX_GATE_OPTION_ID_LENGTH)
    .regex(/^[^\r\n]*$/u, 'one line'),
  outcome: CardGateOutcomeSchema,
});
export type CardGateOption = z.infer<typeof CardGateOptionSchema>;

/** THE GATE AN ASK IS ABOUT: an owner-asked card entered a lane whose stage is a gate. */
export const CardGateSchema = z.strictObject({
  cardId: z.string().min(1).max(64),
  laneId: z.string().min(1).max(64),
  laneName: z.string().min(1).max(80),
  /** The card history's `seq` of the event that put the card in the lane: one ask per entry. */
  entry: PositiveIntegerSchema,
  projectId: z.string().min(1).max(128),
  projectName: z.string().min(1).max(120).optional(),
  /** The card's title, so an ask can name the card: "Badge colour is ready to test". */
  cardTitle: z.string().min(1).max(MAX_GATE_TITLE_LENGTH).optional(),
  options: z.array(CardGateOptionSchema).min(1).max(MAX_GATE_ASK_OPTIONS),
});
export type CardGate = z.infer<typeof CardGateSchema>;

/** The answer an owner gave to a gate, as the Board applies it (the ask's `choice` and `text`). */
export const CardGateAnswerSchema = z.strictObject({
  choice: z.string().trim().min(1).max(MAX_GATE_OPTION_ID_LENGTH).optional(),
  text: z.string().trim().min(1).optional(),
  at: InstantSchema,
});
export type CardGateAnswer = z.infer<typeof CardGateAnswerSchema>;

// ─── the gate's reference ────────────────────────────────────────────────────────────────────────────────────────

const GATE_REFERENCE_PREFIX = 'gate:';
const CARD_ID = /^[BFIC][1-9][0-9]{0,8}$/u;
const LANE_ID = /^[^\s:]{1,64}$/u;
const ENTRY = /^[1-9][0-9]{0,8}$/u;

/** What a gate ask's entry id names: the card, the gate lane, and the history entry that put it there. */
export interface GateReference {
  readonly cardId: string;
  readonly laneId: string;
  readonly entry: number;
}

/**
 * The Asks entry id of a gate ask: `gate:<card>:<lane>:<entry>`. One per entry into the gate, so raising it again (a
 * restart, a second write that finds the card still there) is the same ask: Asks raises are idempotent by
 * `(source, entry)`.
 */
export const gateReference = (gate: GateReference): string =>
  `${GATE_REFERENCE_PREFIX}${gate.cardId}:${gate.laneId}:${String(gate.entry)}`;

/** The card, lane and entry an entry id names, or `undefined` for any other id. Total. */
export const parseGateReference = (entry: string | null | undefined): GateReference | undefined => {
  if (typeof entry !== 'string' || !entry.startsWith(GATE_REFERENCE_PREFIX)) return undefined;
  const parts = entry.slice(GATE_REFERENCE_PREFIX.length).split(':');
  if (parts.length !== 3) return undefined;
  const [cardId = '', laneId = '', at = ''] = parts;
  if (!CARD_ID.test(cardId) || !LANE_ID.test(laneId) || !ENTRY.test(at)) return undefined;
  return { cardId, laneId, entry: Number(at) };
};

// ─── what a chosen label means ───────────────────────────────────────────────────────────────────────────────────

/**
 * The extra answer a gate with ONE option offers, because a choice needs two: the card stays where it is; any words
 * the owner gave reach the card's ferret. It is never one of `gate.options`, which is how a client tells it apart.
 */
export const GATE_NOT_YET_LABEL = 'Not yet';
const GATE_NOT_YET_FALLBACK = 'Not now';

/** The "not yet" label of a gate with one option, or `undefined` when its options are already a choice. */
export const gateNotYetLabel = (gate: Pick<CardGate, 'options'>): string | undefined => {
  if (gate.options.length !== 1) return undefined;
  const taken = gate.options.some(option => option.label.trim().toLowerCase() === GATE_NOT_YET_LABEL.toLowerCase());
  return taken ? GATE_NOT_YET_FALLBACK : GATE_NOT_YET_LABEL;
};

const isForward = (option: CardGateOption): boolean => option.outcome !== 'reopen-with-ask';

/**
 * The ask's option labels in SWIPE order (the owner's decision !A205: → Done, ← Not good): ← the reopen option (else
 * "Not yet"), ↑ a third, → the first option that moves the card on (next, a lane, close). A choice card lays its
 * options out in the order of its ask; `gate.options` keeps the lane's own order; "Not yet" is the one label it lacks.
 */
export const gateAskLabels = (gate: Pick<CardGate, 'options'>): string[] => {
  const notYet = gateNotYetLabel(gate);
  const labels = [...gate.options.map(option => option.label), ...(notYet === undefined ? [] : [notYet])];
  const forward = gate.options.find(isForward)?.label;
  const back = gate.options.find(option => !isForward(option))?.label ?? notYet;
  const rest = labels.filter(label => label !== forward && label !== back);
  const right = forward ?? rest.shift();
  const left = back ?? rest.shift();
  const up = rest.shift();
  return [left, up, right].flatMap(label => (label === undefined ? [] : [label]));
};

/** What a chosen label means on this gate: one of its options, "Not yet", or nothing it offers. */
export type GateChoice =
  | { readonly kind: 'option'; readonly option: CardGateOption }
  | { readonly kind: 'not-yet' }
  | { readonly kind: 'unknown' };

/** The gate's reading of the label the owner chose, compared as options are compared. Total. */
export const gateChoice = (gate: Pick<CardGate, 'options'>, label: string): GateChoice => {
  const wanted = label.trim();
  const option = gate.options.find(candidate => candidate.label.trim() === wanted);
  if (option !== undefined) return { kind: 'option', option };
  return gateNotYetLabel(gate) === wanted ? { kind: 'not-yet' } : { kind: 'unknown' };
};

/** The gate's reopen option, when it has one: what an answer in the owner's own words means. */
export const gateReopenOption = (gate: Pick<CardGate, 'options'>): CardGateOption | undefined =>
  gate.options.find(option => option.outcome === 'reopen-with-ask');

/** What an ask needs of the owner: a test to try (its gate can send the card back with words), else a plan to approve. */
export const gateStage = (gate: Pick<CardGate, 'options'>): 'test' | 'plan' =>
  gate.options.some(option => option.outcome === 'reopen-with-ask') ? 'test' : 'plan';

// ─── what an ask says ────────────────────────────────────────────────────────────────────────────────────────────

/** How a gate is answered: tried (it can send the card back with words) or approved (it can only move on or wait). */
export type GateStyle = 'try-it' | 'approval';

/** The style of a gate: a try-it when one of its options reopens the card, else an approval. */
export const gateStyle = (gate: Pick<CardGate, 'options'>): GateStyle =>
  gateReopenOption(gate) === undefined ? 'approval' : 'try-it';

/** The lane's own pass label that reads as "Good" on a try-it. A lane that says something else keeps its words. */
const DEFAULT_PASS_LABEL = 'Done';
export const GATE_GOOD_LABEL = 'Good';

/**
 * What a button says for a gate option. A try-it's pass reads **Good** when the lane left its default "Done"; every
 * other label is the lane's own. The answer SENT is always the option's real label.
 */
export const gateButtonLabel = (gate: Pick<CardGate, 'options'>, option: CardGateOption): string =>
  gateStyle(gate) === 'try-it' && option.outcome === 'close' && option.label.trim() === DEFAULT_PASS_LABEL
    ? GATE_GOOD_LABEL
    : option.label;

/** The options one tap answers: every one but the one that sends the card back, which is answered in words. */
export const gateTapOptions = (gate: Pick<CardGate, 'options'>): readonly CardGateOption[] =>
  gate.options.filter(option => option.outcome !== 'reopen-with-ask');

/** The answer typed words are: the reopen option ("Not good"), else "Not yet" (the card waits, the ferret reads them). */
export const gateTypedLabel = (gate: Pick<CardGate, 'options'>): string | undefined =>
  gateReopenOption(gate)?.label ?? gateNotYetLabel(gate);

/** What the owner is told to do with words, one plain sentence, under the buttons. */
export const gateTypedLead = (gate: Pick<CardGate, 'options'>): string =>
  gateStyle(gate) === 'try-it'
    ? 'Not good? Type what is wrong below and send.'
    : 'Want something changed first? Type it in the box below, then send. The ferret reads your words first, and nothing is built yet.';

/** The words under a card's buttons when the owner is looking at several asks: which answer a typed message is. */
export const gateTypedPlaceholder = (gate: Pick<CardGate, 'options'>): string =>
  gateStyle(gate) === 'try-it' ? 'What is wrong, or what needs changing?' : 'What should change first?';

/** The ask in one line, in the lane's words: "Try it: <what>" at a try-it, else "<option>? <what>". */
export const gateAskLine = (gate: Pick<CardGate, 'options' | 'laneName'>, said: string): string =>
  gateStyle(gate) === 'try-it' ? `Try it: ${said}` : `${gate.options[0]?.label ?? gate.laneName}? ${said}`;

/**
 * One line of at most `limit` characters, cut at the last word that fits and ending in an ellipsis; a single word
 * longer than the limit is cut where it stands.
 */
export const clipAtWord = (text: string, limit: number): string => {
  const line = text.replaceAll(/\s+/gu, ' ').trim();
  if (line.length <= limit) return line;
  const room = line.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:.\-–—]+$/u, '')}…`;
};

/** What a card's history reason begins with when the daemon closes a card with nothing to try. */
export const NOTHING_TO_TRY_PREFIX = 'Nothing to try: ';

// ─── everything needed to try it ─────────────────────────────────────────────────────────────────────────────────

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
 * `fy card link <card> --doc <url>` records; nothing invents one, so a card with no preview says where to try it for real.
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
 * EVERYTHING SOMEONE COLD NEEDS TO TRY IT, as Markdown, from the card alone: the preview link first when there is one
 * (**Try it on the preview**), else a line saying where to try it for real; the card's own How to test (where / do /
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
