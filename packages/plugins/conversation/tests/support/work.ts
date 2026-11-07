import type { Instant } from '@ferretry/std';
import { WorkSearchQuerySchema, type WorkSearchQuery } from '../../contract/index.ts';
import { askKey, cardKey, workDocument, type RawWork, type WorkDocument } from '../../daemon/search/lib/documents.ts';
import type { WorkField } from '../../daemon/search/lib/documents.ts';
import type { WorkRedaction, WorkSource } from '../../daemon/search/lib/service.ts';

export const NOW_MS = Date.parse('2026-10-30T10:00:00.000Z');
export const DAY_MS = 86_400_000;
export const at = (ms: number): Instant => new Date(ms).toISOString() as Instant;
export const same = (text: string): string => text;

export const query = (q: string, rest: Partial<WorkSearchQuery> = {}): WorkSearchQuery =>
  WorkSearchQuerySchema.parse({ q, ...rest });

interface WorkInput {
  readonly id: string;
  readonly title: string;
  readonly state?: 'open' | 'closed' | 'dropped';
  readonly standing?: string;
  readonly updatedAtMs?: number;
  readonly fields?: Partial<Record<WorkField, string>>;
}

/** A card as its source hands it over. */
export const cardWork = (input: WorkInput & { readonly project?: string; readonly ferret?: string | null }): RawWork => ({
  key: cardKey(input.id),
  kind: 'card',
  updatedAtMs: input.updatedAtMs ?? NOW_MS,
  identity: {
    kind: 'card',
    id: input.id,
    project: input.project ?? 'p1',
    ferret: input.ferret ?? null,
    title: input.title,
    state: input.state ?? 'open',
    standing: input.standing ?? 'Todo',
    updatedAt: at(input.updatedAtMs ?? NOW_MS),
  },
  fields: [['id', input.id], ['title', input.title], ...(Object.entries(input.fields ?? {}) as [WorkField, string][])],
});

/** An ask as its source hands it over. */
export const askWork = (input: WorkInput & { readonly ferret?: string }): RawWork => ({
  key: askKey(input.id),
  kind: 'ask',
  updatedAtMs: input.updatedAtMs ?? NOW_MS,
  identity: {
    kind: 'ask',
    id: input.id,
    ferret: input.ferret ?? 'lead',
    title: input.title,
    state: input.state ?? 'open',
    standing: input.standing ?? 'open',
    updatedAt: at(input.updatedAtMs ?? NOW_MS),
  },
  fields: [['id', input.id], ['title', input.title], ...(Object.entries(input.fields ?? {}) as [WorkField, string][])],
});

export const doc = (work: RawWork, scrub: (text: string) => string = same): WorkDocument => workDocument(work, scrub);

/** A source under the test's control: replace a piece of work's object to "write" it. */
export class FakeSource implements WorkSource {
  readonly works = new Map<string, RawWork>();
  reads = 0;
  failing = false;

  constructor(
    readonly id: string,
    works: readonly RawWork[] = [],
    readonly cheap?: true,
  ) {
    for (const work of works) this.works.set(work.key, work);
  }

  async list(): Promise<readonly RawWork[]> {
    this.reads += 1;
    if (this.failing) throw new Error('the source is unreadable');
    return [...this.works.values()];
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
