import type { SurfaceOpener, TerminalView, TerminalsApi } from '../../contract/index.ts';
import { USE } from '../../contract/index.ts';
import {
  type ReferenceCatalogEntry,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '@ferretry/plugin-conversation/contract';

/** How a row says who opened the shell (today's `describeSurfaceOwnership` text, lower-cased as the row printed it). */
const ownershipText = (opener: SurfaceOpener | undefined): string => {
  if (opener === undefined) return 'owner unrecorded';
  if (opener.by === 'agent') return 'opened by an agent';
  if (opener.by === 'human') return 'opened from a paired device';
  return 'opened on the daemon host';
};

/** How a reference addresses a terminal: its name when it has one, else its id (today's `sessionSurfaces`). */
const keyOf = (terminal: TerminalView): string => terminal.name ?? terminal.id;

/** The entry schema's own bounds: a program sets a pane's title, so a long one is cut rather than failing the whole menu. */
const clip = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/**
 * THE `%terminal` MENU OF A FERRET'S COMPOSER (reference.catalog, lead decision Q6): the terminals this ferret holds,
 * as the composer offered them before, in the order Terminals lists them (creation order: a row must not move out from
 * under a finger).
 *
 * Today's rows, copied: the token is the terminal's name (else its id), the label its title, and the detail says how many
 * viewers are attached and WHO OPENED IT — the one thing a reader must know before typing into a shell an agent may be
 * driving. A terminal with no recorded opener reads "owner unrecorded", never a guess. A query narrows by the key or the
 * title, case ignored.
 *
 * Only running terminals are listed (Terminals lists no other), so no entry is `closed`.
 *
 * DEMAND: `terminal` use — exactly what `GET /v1/ferrets/:ferretId/terminals` declares, so a caller that could not list
 * the terminals through that route is refused here before `entries` runs. Titles are set by programs in the pane; the
 * answer is masked by Conversation. Only keys, titles, viewer counts and an opener CLASS leave: never a device id, a
 * session id, a pane's text, a token or a digest.
 */
export class TerminalsReferenceMenu implements ReferenceCatalogProvider {
  readonly demand = USE.terminal;

  constructor(private readonly terminals: Pick<TerminalsApi, 'of'>) {}

  async entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]> {
    const wanted = input.query?.trim().toLowerCase() ?? '';
    return (await this.terminals.of(input.ferret as Parameters<TerminalsApi['of']>[0]))
      .filter(terminal => wanted === '' || `${keyOf(terminal)} ${terminal.title}`.toLowerCase().includes(wanted))
      .slice(0, referenceCatalogLimit('%terminal'))
      .map(terminal => ({
        token: clip(keyOf(terminal), 512),
        label: clip(terminal.title, 256),
        detail: `${terminal.viewers === 1 ? '1 viewer' : `${String(terminal.viewers)} viewers`} · ${ownershipText(terminal.openedBy)}`,
      }));
  }
}
