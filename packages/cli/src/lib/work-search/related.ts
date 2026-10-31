import {
  MAX_WORK_RELATED_TEXT_LENGTH,
  type WorkKind,
  type WorkRelatedRequest,
  type WorkRelatedResponse,
} from '@ferretry/protocol';
import { refuse } from '../tasks/errors';
import type { IWorkSearchGateway, IWorkSearchOutput } from './ports';
import { renderHits } from './render';

/** The most weak matches a refusal lists beside the strong ones. */
const MAX_WEAK_LISTED = 3;

/** Said once on stderr by a create that went ahead because the daemon cannot check yet. */
export const RELATED_CHECK_UNAVAILABLE = 'related check skipped: this daemon has no search yet';

export interface RelatedGuardOptions {
  /** The session the CLI acts as, so a match it owns can be labelled as such. */
  readonly as: string | undefined;
  readonly json: boolean | undefined;
  /** The ways out the refusal offers, one per line, each a command the caller can run. */
  readonly choices: readonly string[];
}

const clip = (text: string): string => text.slice(0, MAX_WORK_RELATED_TEXT_LENGTH);

/** Strong matches first, then at most {@link MAX_WEAK_LISTED} weak ones; the daemon's order within each. */
export function listedMatches(response: WorkRelatedResponse): WorkRelatedResponse['matches'] {
  const strong = response.matches.filter(match => match.strength === 'strong');
  const weak = response.matches.filter(match => match.strength === 'weak').slice(0, MAX_WEAK_LISTED);
  return [...strong, ...weak];
}

/**
 * "Is what I am about to file already somebody's?" — asked before a card or an agenda item is created. A
 * STRONG match refuses the create (nothing is made) and says how to go on; anything weaker, or no answer
 * at all, lets the create through, because the check must never be the reason work goes unfiled.
 */
export class RelatedCheck {
  constructor(
    private readonly gateway: Pick<IWorkSearchGateway, 'related' | 'search' | 'sessions'>,
    private readonly out: IWorkSearchOutput,
    readonly binary: string,
  ) {}

  /** Who holds agenda item `id`: the one hit whose id it is, with the callsign the directory knows it by. */
  async agendaOwner(id: string, as: string | undefined): Promise<{ sessionId: string; callsign: string } | undefined> {
    const answer = await this.gateway.search({ q: id, kind: 'agenda', open: false }, as);
    const hit = answer.hits.flatMap(each => (each.kind === 'agenda' && each.id === id ? [each] : []))[0];
    if (hit === undefined) return undefined;
    const { sessionId } = hit;
    const callsign = (await this.gateway.sessions()).find(entry => entry.id === sessionId)?.callsign;
    return { sessionId, callsign: callsign ?? sessionId };
  }

  async guard(kind: WorkKind, title: string, ask: string | undefined, options: RelatedGuardOptions): Promise<void> {
    const trimmedAsk = ask?.trim() ?? '';
    const request: WorkRelatedRequest = {
      kind,
      title: clip(title.trim()),
      ...(trimmedAsk === '' ? {} : { ask: clip(trimmedAsk) }),
    };
    let response: WorkRelatedResponse | undefined;
    try {
      response = await this.gateway.related(request, options.as);
    } catch (error) {
      this.out.diagnostic(`related check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (response === undefined) {
      this.out.diagnostic(RELATED_CHECK_UNAVAILABLE);
      return;
    }
    const matches = listedMatches(response);
    if (!matches.some(match => match.strength === 'strong')) return;
    if (options.json === true) {
      this.out.success(JSON.stringify({ related: matches }, null, 2));
      return refuse('related work already exists; nothing was created');
    }
    const context = { directory: await this.gateway.sessions(), own: options.as, binary: this.binary };
    const section = (strength: 'strong' | 'weak'): string[] => {
      const chosen = matches.filter(match => match.strength === strength).map(match => match.hit);
      return chosen.length === 0 ? [] : renderHits(chosen, context).map(line => `  ${line}`);
    };
    const weak = section('weak');
    return refuse(
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
