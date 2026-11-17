import { describe, it } from 'bun:test';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import should from 'should';
import type { FerretId, FerretRecord, RunnerHandle } from '../../../../../contract/index.ts';
import { FLEET_NOW, fleetOf } from '../../../../support/daemon/turn-watch-fleet.ts';

/**
 * The registry follows the RECORDED turn, not only its changes (FX5): a resumed ferret whose document still held the
 * last run's `your-turn` (the resume beat the tick that would have cleared it) was moved to `working` by the launch, and
 * every look after that agreed with the document, so nothing was recorded and the ferret read `working` for ever while
 * it sat at its prompt (the Warden nudged it every 5.5 min). Fixture values only.
 */

type Turn = 'working' | 'your-turn' | 'needs-input';

const following = async (
  turnState: 'your-turn' | 'working' | 'needs-input',
  registry: 'working' | 'idle',
  more: { readonly openTurn?: boolean; readonly stateAt?: Instant } = {},
) => {
  const observed: { readonly ferret: FerretId; readonly turn: Turn }[] = [];
  let records: Map<string, FerretRecord> | undefined;
  const fleet = await fleetOf(
    turnState,
    1,
    {},
    {
      registry,
      ...more,
      // FerretsService.turnObserved, reduced: the registry takes the state the turn says.
      turnObserved: async (ferret, turn) => {
        observed.push({ ferret, turn });
        const record = records?.get(ferret);
        if (record !== undefined)
          records?.set(ferret, { ...record, state: turn === 'working' ? 'working' : 'idle' } as FerretRecord);
      },
    },
  );
  records = fleet.records;
  const settle = async () => await new Promise<void>(resolve => setTimeout(resolve, 0));
  return { fleet, observed, settle };
};

describe('the turn watch moves a registry state that disagrees with an agreeing look', () => {
  it('should make a resumed ferret idle when its document kept the last run’s your-turn and every look shows its prompt', async () => {
    // Arrange: the launch left the registry `working`; the document says `your-turn`; the pane is at its prompt and the
    // transcript's last turn is complete (the fake reply landed between two looks).
    const { fleet, observed, settle } = await following('your-turn', 'working');
    const [id] = [...fleet.records.keys()];

    // Act
    for (let n = 0; n < 3; n += 1) await fleet.tick(() => undefined, n);
    await settle();

    // Assert: told once, and the registry is idle.
    should(observed).deepEqual([{ ferret: id, turn: 'your-turn' }]);
    should(fleet.records.get(id as string)?.state).equal('idle');
  });

  it('should make a resumed ferret idle when its document kept needs-input and its pane still asks', async () => {
    // Arrange: a permission prompt is up (confirmed needs-input), as the document records; the launch said `working`.
    const { fleet, observed, settle } = await following('needs-input', 'working');
    const [id] = [...fleet.records.keys()];
    const asking = (handle: RunnerHandle) =>
      fleet.runner.screens.set(handle, { frame: 'ask', working: false, atPrompt: false, permission: true });

    // Act
    for (let n = 0; n < 3; n += 1) await fleet.tick(asking, n);
    await settle();

    // Assert
    should(observed).deepEqual([{ ferret: id, turn: 'needs-input' }]);
    should(fleet.records.get(id as string)?.state).equal('idle');
  });

  it('should make jajuan idle: registry working after a resume, document your-turn, pane at its prompt, transcript ending on a reply with no boundary', async () => {
    // Arrange: slot 8's jajuan (FX6). The fake Claude writes no `stop_reason`, so its transcript never proves the turn
    // ended and every look at its prompt is an UNCONFIRMED your-turn. The daemon was restarted, so no look is remembered.
    const { fleet, observed, settle } = await following('your-turn', 'working', { openTurn: true });
    const [id] = [...fleet.records.keys()];

    // Act: the first look alone is no agreement; the second frame agrees with it, as two frames record a your-turn.
    await fleet.tick(() => undefined, 0);
    await settle();
    const afterOne = [...observed];
    for (let n = 1; n < 3; n += 1) await fleet.tick(() => undefined, n);
    await settle();

    // Assert
    should(afterOne).deepEqual([]);
    should(observed).deepEqual([{ ferret: id, turn: 'your-turn' }]);
    should(fleet.records.get(id as string)?.state).equal('idle');
  });

  it('should not take two frames as agreement when the older one was looked at before the launch moved the registry', async () => {
    // Arrange: a kill and a resume inside one tick: the launch moved the registry 1 s after the first look, so that
    // look may be the old pane's. Only two frames taken after the launch may agree.
    const launchedAt = instantFromEpochMs(Date.parse(FLEET_NOW) + 1_000);
    const { fleet, observed, settle } = await following('your-turn', 'working', {
      openTurn: true,
      stateAt: launchedAt,
    });
    const [id] = [...fleet.records.keys()];

    // Act
    for (let n = 0; n < 2; n += 1) await fleet.tick(() => undefined, n);
    await settle();
    const straddling = [...observed];
    // The quiet pane backs off: its third look is due 4 s after its second (two more ticks).
    for (let n = 2; n < 4; n += 1) await fleet.tick(() => undefined, n);
    await settle();

    // Assert
    should(straddling).deepEqual([]);
    should(observed).deepEqual([{ ferret: id, turn: 'your-turn' }]);
  });

  it('should not take a confirmed look taken before the launch moved the registry as agreement', async () => {
    // Arrange: the registry moved after the only look began (a launch landing mid-look).
    const launchedAt = instantFromEpochMs(Date.parse(FLEET_NOW) + 1_000);
    const { fleet, observed, settle } = await following('your-turn', 'working', { stateAt: launchedAt });

    // Act
    await fleet.tick(() => undefined, 0);
    await settle();

    // Assert
    should(observed).deepEqual([]);
  });

  it('should not take a single unconfirmed your-turn as agreement', async () => {
    // Arrange: a spinner-shaped line over a transcript whose turn ended is a weak your-turn (unconfirmed), and one
    // weak frame between two spinner redraws must never end a turn.
    const { fleet, observed, settle } = await following('your-turn', 'working');
    const spinner = (handle: RunnerHandle) =>
      fleet.runner.screens.set(handle, {
        frame: 'spin',
        working: true,
        spinnerOnly: true,
        atPrompt: false,
        permission: false,
      });

    // Act
    await fleet.tick(spinner, 0);
    await settle();

    // Assert
    should(observed).deepEqual([]);
    should([...fleet.records.values()].map(record => record.state)).deepEqual(['working']);
  });

  it('should write nothing while the registry already agrees with the recorded turn', async () => {
    // Arrange
    const { fleet, observed, settle } = await following('your-turn', 'idle');

    // Act
    for (let n = 0; n < 3; n += 1) await fleet.tick(() => undefined, n);
    await settle();

    // Assert
    should(observed).deepEqual([]);
  });

  it('should leave a working ferret working while its pane draws, as the document records', async () => {
    // Arrange
    const { fleet, observed, settle } = await following('working', 'working');
    const drawing = (handle: RunnerHandle, n: number) =>
      fleet.runner.screens.set(handle, { frame: `w${n}`, working: true, atPrompt: false, permission: false });

    // Act
    for (let n = 0; n < 3; n += 1) await fleet.tick(drawing, n);
    await settle();

    // Assert
    should(observed).deepEqual([]);
    should([...fleet.records.values()].map(record => record.state)).deepEqual(['working']);
  });
});
