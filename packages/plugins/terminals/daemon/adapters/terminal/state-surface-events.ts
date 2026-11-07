import { SURFACE_EVENTS_KEPT_PER_FERRET, type TerminalsState } from '../../../contract/index.ts';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import type { RecordedSurfaceEvent, SurfaceEventSink } from '../../lib/agent-tools/types.ts';
import type { RegisteredTerminalPane } from '../../lib/session/attach/identity.ts';

/** Terminals' own `terminals.json` (`TerminalsStateSchema`, format 1). */
export type TerminalsStateFile = StateFileDef<'terminals', TerminalsState>;

/**
 * The control changes (`surface.*`), kept in Terminals' own `terminals.json` (today they rode the session's journal):
 * a takeover or a hand-over outlives a daemon restart. Each event is parsed again on replay (`SurfaceControl`), so a
 * damaged entry is skipped rather than believed. At most {@link KEPT_PER_FERRET} per ferret: the newest decide.
 */
export const KEPT_PER_FERRET = SURFACE_EVENTS_KEPT_PER_FERRET;

const EMPTY: TerminalsState = { panes: {}, events: {} };

export class StateSurfaceEvents implements SurfaceEventSink {
  constructor(
    private readonly state: StatePort,
    private readonly file: TerminalsStateFile,
  ) {}

  async publish(sessionId: string, type: string, data: unknown): Promise<void> {
    const updated = await this.state.update(this.file, current => {
      const document = current ?? EMPTY;
      const kept = [...(document.events[sessionId] ?? []), { type, data }].slice(-KEPT_PER_FERRET);
      return { ...document, events: { ...document.events, [sessionId]: kept } };
    });
    if (!updated.ok) throw new Error(updated.error.sentence);
  }

  async history(sessionId: string): Promise<readonly RecordedSurfaceEvent[]> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw new Error(read.error.sentence);
    return (read.value ?? EMPTY).events[sessionId] ?? [];
  }
}

/**
 * Each ferret's registered pane, as today's durable terminal pane registration kept it, in `terminals.json`: the tmux
 * runner records the pane it started or adopted, and the processes, console, attach and limits routes read it back
 * after a daemon restart. The whole incarnation is kept, and every reader proves it again before acting on it.
 */
export class StateTerminalPanes {
  constructor(
    private readonly state: StatePort,
    private readonly file: TerminalsStateFile,
  ) {}

  async register(ferret: string, pane: RegisteredTerminalPane): Promise<void> {
    const updated = await this.state.update(this.file, current => {
      const document = current ?? EMPTY;
      return { ...document, panes: { ...document.panes, [ferret]: { ...pane } } };
    });
    if (!updated.ok) throw new Error(updated.error.sentence);
  }

  async of(ferret: string): Promise<RegisteredTerminalPane | undefined> {
    const read = await this.state.read(this.file);
    if (!read.ok) throw new Error(read.error.sentence);
    return (read.value ?? EMPTY).panes[ferret];
  }
}
