import {
  type AgendaItem,
  AgendaItemSchema,
  type BoardTask,
  type LaneSet,
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
} from '@ferretry/protocol';
import type { AgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import {
  type WorkAgendaSource,
  type WorkCardSource,
  type WorkRedaction,
  WorkSearchService,
} from '../../../src/lib/work-search/index.ts';
import { card, PROJECT, templateLanes } from '../board/support.ts';

export { card };

export const NOW_MS = Date.parse('2026-10-30T10:00:00.000Z');
export const DAY_MS = 86_400_000;
export const at = (ms: number): string => new Date(ms).toISOString();

/** The live template's lanes: `todo` (backlog), `implement` (active), `closed` (closed). */
export const LANES: LaneSet = templateLanes(PROJECT);

/** An open agent-raised item in `session`. */
export const item = (overrides: Partial<AgendaItem> = {}, session = 'lead'): AgendaItem =>
  AgendaItemSchema.parse({
    id: 'A1',
    source: 'agent-raised',
    sourceRef: null,
    subject: 'Pick a search backend',
    why: 'the board needs one search',
    howToResolve: 'choose one',
    waitingSince: at(NOW_MS),
    raisedBy: 'agent',
    raisedBySession: session,
    raisedByName: null,
    ...overrides,
  });

/** The same item, addressed. */
export const addressed = (open: AgendaItem, overrides: Partial<ResolvedAgendaItem> = {}): ResolvedAgendaItem =>
  ResolvedAgendaItemSchema.parse({
    ...open,
    resolvedAt: at(NOW_MS),
    resolutionNote: null,
    disposition: 'done',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    ...overrides,
  }) as ResolvedAgendaItem;

export const ledger = (
  sessionId: string,
  open: readonly AgendaItem[],
  closed: readonly ResolvedAgendaItem[] = [],
): AgendaLedger => ({
  sessionId,
  nextId: open.length + closed.length + 1,
  updatedAt: at(NOW_MS),
  entries: [
    ...open.map(entry => ({ lifecycle: 'active' as const, origin: { kind: 'human' as const }, item: entry })),
    ...closed.map(entry => ({ lifecycle: 'addressed' as const, origin: { kind: 'human' as const }, item: entry })),
  ],
});

/** Sources under the test's control: replace a card or a ledger object to "write" it. */
export class FakeSources implements WorkCardSource, WorkAgendaSource {
  readonly cardsById = new Map<string, BoardTask>();
  readonly ledgers = new Map<string, AgendaLedger>();
  readonly lanes = new Map<string, LaneSet>([[PROJECT, LANES]]);
  ledgerReads = 0;
  laneReads = 0;

  constructor(cards: readonly BoardTask[] = [], ledgers: readonly AgendaLedger[] = []) {
    for (const entry of cards) this.cardsById.set(entry.id, entry);
    for (const entry of ledgers) this.ledgers.set(entry.sessionId, entry);
  }

  async cards(): Promise<readonly BoardTask[]> {
    return [...this.cardsById.values()];
  }

  async laneSet(projectId: string): Promise<LaneSet | null> {
    this.laneReads += 1;
    return this.lanes.get(projectId) ?? null;
  }

  async sessions(): Promise<readonly string[]> {
    return [...this.ledgers.keys()];
  }

  async ledger(sessionId: string): Promise<AgendaLedger | null> {
    this.ledgerReads += 1;
    return this.ledgers.get(sessionId) ?? null;
  }
}

/** A redactor that masks the values it is given, with an epoch the test moves. */
export class FakeRedaction implements WorkRedaction {
  values: readonly string[] = [];
  generation = 1;
  batches = 0;

  async batch<T>(work: (scrub: (text: string) => string) => T): Promise<T> {
    this.batches += 1;
    const values = this.values;
    return work(text => values.reduce((masked, value) => masked.split(value).join('[redacted]'), text));
  }

  async epoch(): Promise<string> {
    return String(this.generation);
  }
}

export const service = (
  sources: FakeSources,
  options: { readonly redaction?: FakeRedaction; readonly now?: () => number } = {},
): { readonly search: WorkSearchService; readonly warnings: string[] } => {
  const warnings: string[] = [];
  return {
    warnings,
    search: new WorkSearchService({
      cards: sources,
      agenda: sources,
      redaction: options.redaction ?? new FakeRedaction(),
      now: options.now ?? (() => NOW_MS),
      warn: message => warnings.push(message),
    }),
  };
};
