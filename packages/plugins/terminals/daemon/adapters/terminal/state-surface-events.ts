import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { RecordedSurfaceEvent, SurfaceEventSink } from '../../lib/agent-tools/types.ts';

/**
 * The control changes (`surface.*`), kept in Terminals' own `terminals.json` (today they rode the session's journal):
 * a takeover or a hand-over outlives a daemon restart. Each event is parsed again on replay (`SurfaceControl`), so a
 * damaged entry is skipped rather than believed. At most {@link KEPT_PER_FERRET} per ferret: the newest decide.
 */
export const KEPT_PER_FERRET = 256;

interface SurfaceEventsDocument {
  readonly events: Readonly<Record<string, readonly RecordedSurfaceEvent[]>>;
}

export class StateSurfaceEvents implements SurfaceEventSink {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<'terminals', unknown>,
  ) {}

  async publish(sessionId: string, type: string, data: unknown): Promise<void> {
    const updated = await this.state.update(this.file, current => {
      const document = documentOf(current);
      const kept = [...(document.events[sessionId] ?? []), { type, data }].slice(-KEPT_PER_FERRET);
      return { events: { ...document.events, [sessionId]: kept } } satisfies SurfaceEventsDocument;
    });
    if (!updated.ok) throw new Error(updated.error.sentence);
  }

  async history(sessionId: string): Promise<readonly RecordedSurfaceEvent[]> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw new Error(read.error.sentence);
    return documentOf(read.value).events[sessionId] ?? [];
  }
}

function documentOf(value: unknown): SurfaceEventsDocument {
  if (typeof value !== 'object' || value === null) return { events: {} };
  const events = (value as { readonly events?: unknown }).events;
  if (typeof events !== 'object' || events === null) return { events: {} };
  const out: Record<string, readonly RecordedSurfaceEvent[]> = {};
  for (const [ferret, list] of Object.entries(events))
    if (Array.isArray(list))
      out[ferret] = list.filter(
        (entry): entry is RecordedSurfaceEvent =>
          typeof entry === 'object' && entry !== null && typeof (entry as { type?: unknown }).type === 'string',
      );
  return { events: out };
}
