/**
 * "Is what I am about to file already somebody's?": asked before a card is created. A STRONG match refuses the create
 * (nothing is made) and says how to go on; anything weaker, or no answer at all, lets the create through, because the
 * check must never be the reason work goes unfiled. The matches are Conversation's (`POST /v1/search/related`).
 */
import { refuse } from './errors.ts';

/** The most weak matches a refusal lists beside the strong ones. */
const MAX_WEAK_LISTED = 3;
const MAX_TEXT_LENGTH = 4000;
const MATCH_WIDTH = 100;

export interface RelatedHit {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly standing: string;
  readonly match: { readonly field: string; readonly line: string };
  readonly ferret?: string | null | undefined;
}

export interface RelatedMatch {
  readonly strength: 'strong' | 'weak';
  readonly hit: RelatedHit;
}

export interface RelatedResponse {
  readonly matches: readonly RelatedMatch[];
}

export interface RelatedGateway {
  related(request: { kind: 'card'; title: string; ask?: string }): Promise<RelatedResponse>;
}

export interface RelatedOutput {
  success(message: string): void;
  diagnostic(message: string): void;
}

export interface RelatedGuardOptions {
  readonly json: boolean | undefined;
  /** The ways out the refusal offers, one per line, each a command the caller can run. */
  readonly choices: readonly string[];
}

const clip = (text: string, width: number): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);
const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Strong matches first, then at most {@link MAX_WEAK_LISTED} weak ones; the daemon's order within each. */
export function listedMatches(response: RelatedResponse): readonly RelatedMatch[] {
  const strong = response.matches.filter(match => match.strength === 'strong');
  const weak = response.matches.filter(match => match.strength === 'weak').slice(0, MAX_WEAK_LISTED);
  return [...strong, ...weak];
}

/** The matches as aligned lines: `&F303  card  In progress  Title — the matching line`. */
export function relatedLines(matches: readonly RelatedMatch[], own: string | undefined): string[] {
  const rows = matches.map(({ hit }) => ({ hit, ref: `${hit.kind === 'card' ? '&' : '!'}${hit.id}` }));
  const refWidth = Math.max(0, ...rows.map(row => row.ref.length));
  const standingWidth = Math.max(0, ...rows.map(row => row.hit.standing.length));
  return rows.map(({ hit, ref }) => {
    const line = hit.match.field === 'id' || hit.match.field === 'title' ? '' : clip(flat(hit.match.line), MATCH_WIDTH);
    const said = line === '' || line === flat(hit.title) ? '' : ` — ${line}`;
    const mine = own !== undefined && hit.ferret === own ? '  (yours: add a note instead)' : '';
    return `${ref.padEnd(refWidth)}  ${hit.kind}  ${hit.standing.padEnd(standingWidth)}  ${flat(hit.title)}${said}${mine}`;
  });
}

export class RelatedCheck {
  constructor(
    private readonly gateway: RelatedGateway,
    private readonly out: RelatedOutput,
    private readonly own: string | undefined,
  ) {}

  /** The daemon's related matches for a new title and ask, or `undefined` when it cannot say (said once on stderr). */
  async matches(title: string, ask: string | undefined): Promise<RelatedResponse | undefined> {
    const trimmedAsk = ask?.trim() ?? '';
    try {
      return await this.gateway.related({
        kind: 'card',
        title: title.trim().slice(0, MAX_TEXT_LENGTH),
        ...(trimmedAsk === '' ? {} : { ask: trimmedAsk.slice(0, MAX_TEXT_LENGTH) }),
      });
    } catch (error) {
      this.out.diagnostic(`related check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  lines(matches: readonly RelatedMatch[]): string[] {
    return relatedLines(matches, this.own);
  }

  /** Refuses when `response` holds a STRONG match, listing it and the ways out; anything weaker returns. */
  refuseStrong(response: RelatedResponse, options: RelatedGuardOptions): void {
    const matches = listedMatches(response);
    if (!matches.some(match => match.strength === 'strong')) return;
    if (options.json === true) {
      this.out.success(JSON.stringify({ related: matches }, null, 2));
      refuse('related work already exists; nothing was created');
    }
    const section = (strength: 'strong' | 'weak'): string[] =>
      this.lines(matches.filter(match => match.strength === strength)).map(line => `  ${line}`);
    const weak = section('weak');
    refuse(
      [
        'Related work already exists, and nothing was created.',
        '',
        'Strong matches:',
        ...section('strong'),
        ...(weak.length === 0 ? [] : ['', 'Weaker matches:', ...weak]),
        '',
        'Instead:',
        ...options.choices.map(choice => `  ${choice}`),
      ].join('\n'),
    );
  }
}
