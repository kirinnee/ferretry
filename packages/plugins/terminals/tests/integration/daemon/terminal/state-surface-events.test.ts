import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { SURFACE_EVENTS_KEPT_PER_FERRET } from '../../../../contract/index.ts';
import {
  StateSurfaceEvents,
  StateTerminalPanes,
  type TerminalsStateFile,
} from '../../../../daemon/adapters/terminal/state-surface-events.ts';
import manifest from '../../../../manifest.ts';

const file = manifest.data.state[1] as TerminalsStateFile;
const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** The kernel's real state port, over a real temp home, declaring Terminals' own files. */
async function terminalsState() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-terminals-state-'));
  homes.push(home);
  const port = state.createStatePort({
    home,
    pluginId: 'terminals',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
  return { home, port };
}

describe('terminals.json on disk', () => {
  it('should read an empty history and no pane before anything was written', async () => {
    // Arrange
    const { port } = await terminalsState();

    // Act
    const history = await new StateSurfaceEvents(port, file).history('hadi');
    const pane = await new StateTerminalPanes(port, file).of('hadi');

    // Assert
    should(history).deepEqual([]);
    should(pane).be.undefined();
  });

  it('should keep control events and registered panes beside each other across a new port over the same home', async () => {
    // Arrange
    const { home, port } = await terminalsState();
    const pane = { tmuxSession: 'fy-hadi', paneId: '%3', pid: 4242, processStartTicks: 77 };
    await new StateTerminalPanes(port, file).register('hadi', pane);
    await new StateSurfaceEvents(port, file).publish('hadi', 'surface.asked', { surface: 'dev' });
    await new StateTerminalPanes(port, file).register('hadi', { ...pane, paneId: '%4' });

    // Act — a restarted daemon reads the same home with a port of its own.
    const restarted = state.createStatePort({
      home,
      pluginId: 'terminals',
      files: manifest.data.state,
      fs: state.createNodeHostFs(),
    });
    const history = await new StateSurfaceEvents(restarted, file).history('hadi');
    const registered = await new StateTerminalPanes(restarted, file).of('hadi');

    // Assert
    should(history).deepEqual([{ type: 'surface.asked', data: { surface: 'dev' } }]);
    should(registered).deepEqual({ ...pane, paneId: '%4' });
    should(JSON.parse(await readFile(join(home, 'state', 'terminals', 'terminals.json'), 'utf8'))).be.an.Object();
  });

  it('should keep only the newest events of one ferret and leave another ferret’s history alone', async () => {
    // Arrange
    const { port } = await terminalsState();
    const events = new StateSurfaceEvents(port, file);
    await events.publish('other', 'surface.note', { n: 'kept' });
    for (let n = 0; n < SURFACE_EVENTS_KEPT_PER_FERRET + 3; n += 1) await events.publish('hadi', 'surface.tick', { n });

    // Act
    const history = await events.history('hadi');

    // Assert
    should(history).have.length(SURFACE_EVENTS_KEPT_PER_FERRET);
    should(history.at(-1)).deepEqual({ type: 'surface.tick', data: { n: SURFACE_EVENTS_KEPT_PER_FERRET + 2 } });
    should(history[0]).deepEqual({ type: 'surface.tick', data: { n: 3 } });
    should(await events.history('other')).deepEqual([{ type: 'surface.note', data: { n: 'kept' } }]);
  });

  it('should refuse to publish, say why, and refuse to read when the stored document is damaged', async () => {
    // Arrange — a port over a home whose terminals.json is not a document at all.
    const { home, port } = await terminalsState();
    await new StateSurfaceEvents(port, file).publish('hadi', 'surface.asked', {});
    await Bun.write(join(home, 'state', 'terminals', 'terminals.json'), '{ not json');
    const damaged = state.createStatePort({
      home,
      pluginId: 'terminals',
      files: manifest.data.state,
      fs: state.createNodeHostFs(),
    });

    // Act
    const refusals = await Promise.all([
      new StateSurfaceEvents(damaged, file).publish('hadi', 'surface.asked', {}).catch((error: unknown) => error),
      new StateSurfaceEvents(damaged, file).history('hadi').catch((error: unknown) => error),
      new StateTerminalPanes(damaged, file)
        .register('hadi', { tmuxSession: 'fy-hadi', paneId: '%1', pid: 1, processStartTicks: 1 })
        .catch((error: unknown) => error),
      new StateTerminalPanes(damaged, file).of('hadi').catch((error: unknown) => error),
    ]);

    // Assert
    for (const refusal of refusals) {
      should(refusal).be.instanceOf(Error);
      should((refusal as Error).message).match(/cannot be read/);
    }
  });
});
