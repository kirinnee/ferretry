import { describe, it } from 'bun:test';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';
import should from 'should';
import { type TerminalsState, TerminalsStateSchema } from '../../../../contract/index.ts';
import {
  StateSurfaceEvents,
  StateTerminalPanes,
  type TerminalsStateFile,
} from '../../../../daemon/adapters/terminal/state-surface-events.ts';
import manifest from '../../../../manifest.ts';

/** One state document, parsed by its declared schema on every write, as the kernel's state port does. */
class OneDocument {
  value: TerminalsState | undefined;
  readonly port = {
    read: async () => ok(this.value),
    update: async (
      file: StateFileDef<string, TerminalsState>,
      fn: (current: TerminalsState | undefined) => unknown,
    ) => {
      this.value = file.schema?.parse(fn(this.value)) as TerminalsState;
      return ok(this.value);
    },
  } as unknown as StatePort;
}

const file = manifest.data.state[1] as TerminalsStateFile;

/** Today's durable terminal pane registration, as `DurableTerminalPaneRegistrar` wrote one for a session. */
const TODAYS_REGISTRATION = {
  daemonId: 'd-0123456789abcdef',
  sessionId: 'hadi',
  tmuxSession: 'fy-hadi',
  paneId: '%12',
  pid: 4242,
  processStartTicks: 987_654,
  sessionCreated: 1_762_473_600,
};

describe('terminals.json', () => {
  it('declares a format-1 schema the v4 to v5 conversion can write', () => {
    should(file.name).equal('terminals');
    should(file.path).equal('terminals.json');
    should(file.format).equal(1);
    should(file.schema).equal(TerminalsStateSchema);
    should(TerminalsStateSchema.parse({})).eql({ panes: {}, events: {} });
  });

  it("carries today's pane registration keyed by the ferret, less the ids it was filed under", () => {
    const { daemonId: _daemon, sessionId, ...pane } = TODAYS_REGISTRATION;

    const parsed = TerminalsStateSchema.parse({ panes: { [sessionId]: pane } });

    should(parsed.panes.hadi).eql(pane);
    should(TerminalsStateSchema.safeParse({ panes: { hadi: TODAYS_REGISTRATION } }).success).equal(false);
  });

  it('refuses a pane that is not a whole incarnation: a name for an id, no pid, no start', () => {
    const base = { tmuxSession: 'fy-hadi', paneId: '%1', pid: 1, processStartTicks: 0 };
    for (const broken of [
      { ...base, paneId: 'fy-hadi:0.0' },
      { ...base, pid: 0 },
      { tmuxSession: 'fy-hadi', paneId: '%1', pid: 1 },
    ])
      should(TerminalsStateSchema.safeParse({ panes: { hadi: broken } }).success).equal(false);
  });

  it('keeps the registered panes and the control history beside each other, neither write losing the other', async () => {
    const document = new OneDocument();
    const panes = new StateTerminalPanes(document.port, file);
    const events = new StateSurfaceEvents(document.port, file);
    const pane = { tmuxSession: 'fy-hadi', paneId: '%3', pid: 4242, processStartTicks: 77 };

    await panes.register('hadi', pane);
    await events.publish('hadi', 'surface.asked', { surface: 'dev' });
    await panes.register('hadi', { ...pane, paneId: '%4' });

    should(await panes.of('hadi')).eql({ ...pane, paneId: '%4' });
    should(await panes.of('nobody')).be.undefined();
    should(await events.history('hadi')).eql([{ type: 'surface.asked', data: { surface: 'dev' } }]);
  });
});
