import { describe, it } from 'bun:test';
import should from 'should';
import {
  PANE_PROOF_FORMAT,
  type PaneSighting,
  type PaneStamp,
  paneProofArguments,
  parsePaneSighting,
  provePane,
  stampToRecord,
  type TmuxCommandPort,
  type TmuxCommandResult,
  TmuxController,
} from '../../../src/lib/index.ts';

const CREATED = 1_792_626_406;

class FakeTmux implements TmuxCommandPort {
  readonly received: string[][] = [];

  constructor(private readonly result: TmuxCommandResult) {}

  async execute(arguments_: readonly string[]): Promise<TmuxCommandResult> {
    this.received.push([...arguments_]);
    return this.result;
  }
}

describe('parsePaneSighting', () => {
  it.each([
    [
      'a live pane',
      `%12|4821|0|${String(CREATED)}\n`,
      { paneId: '%12', pid: 4821, dead: false, sessionCreated: CREATED },
    ],
    [
      'a dead pane on tmux 3.8, which prints no pid',
      `%12||1|${String(CREATED)}`,
      { paneId: '%12', dead: true, sessionCreated: CREATED },
    ],
    [
      'a dead pane before 3.8, which keeps the pid',
      `%12|4821|1|${String(CREATED)}`,
      { paneId: '%12', pid: 4821, dead: true, sessionCreated: CREATED },
    ],
    ['a pane whose session time is unreadable', '%0|4821|0|', { paneId: '%0', pid: 4821, dead: false }],
  ])('should read %s', (_name, input, expected) => {
    // Act + Assert
    should(parsePaneSighting(input)).deepEqual(expected);
  });

  it.each([
    ['too few fields', '%12 4821'],
    ['too many fields', `%12|4821|0|${String(CREATED)}|x`],
    ['no pane id', `12|4821|0|${String(CREATED)}`],
    ['a padded pane id', `%01|4821|0|${String(CREATED)}`],
    ['a pid that is not a number', `%12|abc|0|${String(CREATED)}`],
    ['pid 1', `%12|1|0|${String(CREATED)}`],
    ['an unreadable dead flag', `%12|4821|yes|${String(CREATED)}`],
    ['nothing', ''],
  ])('should refuse %s', (_name, input) => {
    // Act + Assert
    should(parsePaneSighting(input)).be.undefined();
  });
});

describe('provePane and stampToRecord', () => {
  const stamp: PaneStamp = { paneId: '%12', pid: 4821, sessionCreated: CREATED };
  const legacy: PaneStamp = { paneId: '%12', pid: 4821 };
  const sighting = (fields: Partial<PaneSighting>): PaneSighting => ({
    paneId: '%12',
    pid: 4821,
    dead: false,
    sessionCreated: CREATED,
    ...fields,
  });
  const deadOn38 = (fields: Partial<PaneSighting> = {}): PaneSighting => {
    const { pid: _pid, ...rest } = sighting({ dead: true, ...fields });
    return rest;
  };

  it.each([
    ['the live pane it registered', sighting({}), stamp, 'proven'],
    ['that pane dead, before tmux 3.8', sighting({ dead: true }), stamp, 'proven'],
    ['that pane dead on tmux 3.8, by its session creation second', deadOn38(), stamp, 'proven'],
    ['another pane id', sighting({ paneId: '%13' }), stamp, 'refuted'],
    ['another pid', sighting({ pid: 4822 }), stamp, 'refuted'],
    ['a session created in another second', sighting({ sessionCreated: CREATED + 1 }), stamp, 'refuted'],
    ['a dead pane on tmux 3.8 in another session', deadOn38({ sessionCreated: CREATED + 1 }), stamp, 'refuted'],
    ['a live pane with no pid', { paneId: '%12', dead: false, sessionCreated: CREATED }, stamp, 'refuted'],
    ['a registration with no creation second, by its pid', sighting({ dead: true }), legacy, 'proven'],
    ['a registration with no creation second, dead on tmux 3.8', deadOn38(), legacy, 'pane-id-only'],
    ['another pane, dead on tmux 3.8, against that registration', deadOn38({ paneId: '%13' }), legacy, 'refuted'],
  ])('should say how %s is proven the registered pane', (_name, seen, registered, expected) => {
    // Act + Assert
    should(provePane(seen as PaneSighting, registered as PaneStamp)).equal(expected);
  });

  it.each([
    ['a live pane proven by pid, for a registration with no creation second', sighting({}), legacy, CREATED],
    ['a registration that already has one', sighting({}), stamp, undefined],
    ['a dead pane, which can no longer be proven by pid', sighting({ dead: true }), legacy, undefined],
    ['another pid', sighting({ pid: 4822 }), legacy, undefined],
    ['another pane id', sighting({ paneId: '%13' }), legacy, undefined],
    ['a pane whose session time tmux did not print', { paneId: '%12', pid: 4821, dead: false }, legacy, undefined],
  ])('should give the creation second to record for %s', (_name, seen, registered, expected) => {
    // Act + Assert
    should(stampToRecord(seen as PaneSighting, registered as PaneStamp)).equal(expected);
  });
});

describe('TmuxController.paneSighting', () => {
  it('should ask the one proof format of the pane a session names, and read its answer', async () => {
    // Arrange
    const tmux = new FakeTmux({ code: 0, stdout: `%12||1|${String(CREATED)}\n`, stderr: '' });

    // Act
    const actual = await new TmuxController(tmux).paneSighting('work-1');

    // Assert
    should(actual).deepEqual({ paneId: '%12', dead: true, sessionCreated: CREATED });
    should(tmux.received).deepEqual([paneProofArguments('work-1')]);
    should(paneProofArguments('work-1')).deepEqual(['display-message', '-p', '-t', 'work-1', PANE_PROOF_FORMAT]);
  });

  it('should answer no sighting when tmux could not say', async () => {
    // Act
    const actual = await new TmuxController(
      new FakeTmux({ code: 1, stdout: '', stderr: "can't find session" }),
    ).paneSighting('work-1');

    // Assert
    should(actual).be.undefined();
  });
});
