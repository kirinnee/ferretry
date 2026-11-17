import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretId, FerretRecord, RunnerHandle } from '../../../../../contract/index.ts';
import { fleetOf } from '../../../../support/daemon/turn-watch-fleet.ts';

/**
 * The registry follows the RECORDED turn, not only its changes (FX5): a resumed ferret whose document still held the
 * last run's `your-turn` (the resume beat the tick that would have cleared it) was moved to `working` by the launch, and
 * every look after that agreed with the document, so nothing was recorded and the ferret read `working` for ever while
 * it sat at its prompt (the Warden nudged it every 5.5 min). Fixture values only.
 */

type Turn = 'working' | 'your-turn' | 'needs-input';

const following = async (turnState: 'your-turn' | 'working', registry: 'working' | 'idle') => {
  const observed: { readonly ferret: FerretId; readonly turn: Turn }[] = [];
  let records: Map<string, FerretRecord> | undefined;
  const fleet = await fleetOf(
    turnState,
    1,
    {},
    {
      registry,
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
