import { describe, it } from 'bun:test';
import should from 'should';
import { describeActivity, type UpdateActivity } from '../../../src/lib/update/activity';
import { NixProgressTracker, parseNixLine } from '../../../src/lib/update/nix-progress';
import { stepObserver } from '../../../src/lib/update/step-observer';
import { RecordingProgress } from '../progress/fixtures';

const nix = (event: object): string => `@nix ${JSON.stringify(event)}`;

/** A recorded `nix profile upgrade --log-format internal-json -v` that downloads two paths, abridged. */
const UPGRADE: readonly string[] = [
  nix({ action: 'msg', level: 3, msg: "upgrading 'ferretry' from flake 'github:kirinnee/ferretry'" }),
  nix({ action: 'start', id: 1, level: 0, type: 0, text: '' }),
  nix({ action: 'start', id: 2, level: 4, type: 103, text: 'copying 2 paths' }),
  nix({ action: 'result', id: 2, type: 106, fields: [100, 2_000_000] }),
  nix({ action: 'result', id: 2, type: 105, fields: [0, 2, 0, 0] }),
  nix({
    action: 'start',
    id: 3,
    level: 3,
    type: 100,
    text: "copying path '/nix/store/aaa-ferretry' from 'https://cache.nixos.org'",
  }),
  nix({ action: 'result', id: 3, type: 105, fields: [500_000, 1_500_000, 0, 0] }),
  nix({ action: 'result', id: 3, type: 105, fields: [1_500_000, 1_500_000, 0, 0] }),
  nix({ action: 'stop', id: 3 }),
  nix({ action: 'result', id: 2, type: 105, fields: [1, 2, 0, 0] }),
  nix({ action: 'start', id: 4, level: 3, type: 100, text: "copying path '/nix/store/bbb-lib'" }),
  nix({ action: 'result', id: 4, type: 105, fields: [500_000, 500_000, 0, 0] }),
  nix({ action: 'stop', id: 4 }),
  nix({ action: 'result', id: 2, type: 105, fields: [2, 2, 0, 0] }),
  nix({ action: 'stop', id: 2 }),
];

function feedAll(lines: readonly string[]): { activities: UpdateActivity[]; tracker: NixProgressTracker } {
  const tracker = new NixProgressTracker();
  const activities: UpdateActivity[] = [];
  for (const line of lines) {
    const activity = tracker.feed(line);
    if (activity !== undefined) activities.push(activity);
  }
  return { activities, tracker };
}

describe('parseNixLine', () => {
  it('reads each kind of event', () => {
    should(parseNixLine(nix({ action: 'start', id: 1, type: 100, text: 'copying' }))).match({
      action: 'start',
      id: 1,
      type: 100,
    });
    should(parseNixLine(nix({ action: 'stop', id: 1 }))).match({ action: 'stop', id: 1 });
    should(parseNixLine(nix({ action: 'result', id: 1, type: 105, fields: [1, 2] }))).match({
      action: 'result',
      fields: [1, 2],
    });
    should(parseNixLine(nix({ action: 'msg', level: 0, msg: 'error: boom' }))).match({
      action: 'msg',
      msg: 'error: boom',
    });
  });

  it('answers undefined for anything that is not an event it knows', () => {
    should(parseNixLine('warning: unlocked flake')).be.undefined();
    should(parseNixLine('@nix {not json')).be.undefined();
    should(parseNixLine(nix({ action: 'setPhase', phase: 'x' }))).be.undefined();
    should(parseNixLine(nix({ action: 'start', id: 'x' }))).be.undefined();
  });
});

describe('NixProgressTracker', () => {
  it('follows a download from "preparing" to numbers that only grow', () => {
    const { activities } = feedAll(UPGRADE);
    should(activities[0]).match({ phase: 'preparing' });
    const downloading = activities.filter(a => a.phase === 'downloading');
    should(downloading.length).be.above(2);
    const mid = downloading.find(a => a.bytes?.done === 500_000);
    should(mid?.bytes).deepEqual({ done: 500_000, expected: 2_000_000 });
    should(mid?.packages).deepEqual({ done: 0, expected: 2 });
    const done = downloading.map(a => a.bytes?.done ?? 0);
    should(done).deepEqual([...done].sort((a, b) => a - b));
  });

  it('ends on the switch with every package counted', () => {
    const { activities } = feedAll(UPGRADE);
    should(activities.at(-1)).match({ phase: 'switching', packages: { done: 2, expected: 2 } });
    should(activities.at(-1)?.bytes?.done).equal(2_000_000);
  });

  it('reports a change once and nothing for a repeat', () => {
    const tracker = new NixProgressTracker();
    const start = nix({ action: 'start', id: 5, type: 100, text: 'x' });
    should(tracker.feed(start)).not.be.undefined();
    should(tracker.feed(nix({ action: 'result', id: 5, type: 105, fields: [0, 0] }))).be.undefined();
  });

  it('shows a build and its last log line', () => {
    const { activities } = feedAll([
      nix({ action: 'start', id: 1, type: 105, text: 'building ferretry' }),
      nix({ action: 'result', id: 1, type: 101, fields: ['compiling main.go'] }),
      nix({ action: 'result', id: 1, type: 101, fields: ['   '] }),
    ]);
    should(activities.at(-1)).match({ phase: 'building', line: 'compiling main.go' });
  });

  it("keeps nix's words for a failure and drops the events and chatter", () => {
    const { tracker } = feedAll([
      nix({ action: 'msg', level: 5, msg: 'debug chatter' }),
      nix({ action: 'msg', level: 3, msg: 'verbose chatter' }),
      nix({ action: 'msg', level: 0, msg: 'error: flake not found' }),
      nix({ action: 'msg', level: 1, msg: '   ' }),
      'warning: a plain line',
      '',
    ]);
    should(tracker.messages).deepEqual(['error: flake not found', 'warning: a plain line']);
  });

  it('survives an event it has never heard of', () => {
    const { activities } = feedAll([
      nix({ action: 'setPhase', phase: 'x' }),
      nix({ action: 'start', id: 1, type: 999, text: '' }),
    ]);
    should(activities.length).be.belowOrEqual(1);
  });

  it('treats unreadable numeric fields as zero', () => {
    const { activities } = feedAll([
      nix({ action: 'start', id: 1, type: 103, text: '' }),
      nix({ action: 'result', id: 1, type: 105, fields: ['x', 'y'] }),
    ]);
    should(activities.at(-1)?.packages).deepEqual({ done: 0, expected: 0 });
  });

  it('calls a finished fetch with no copying a switch, and a download that has not begun "preparing"', () => {
    const idle = new NixProgressTracker();
    should(idle.activity()).deepEqual({ phase: 'preparing' });
    const { activities } = feedAll([
      nix({ action: 'start', id: 1, type: 108, text: 'substituting' }),
      nix({ action: 'stop', id: 1 }),
    ]);
    should(activities.at(-1)?.phase).equal('switching');
  });
});

describe('describeActivity', () => {
  it('puts packages and bytes in the detail, in that order', () => {
    should(
      describeActivity(
        {
          phase: 'downloading',
          packages: { done: 23, expected: 41 },
          bytes: { done: 48_000_000, expected: 120_000_000 },
        },
        '4.69.4',
      ),
    ).deepEqual({ step: 'Downloading 4.69.4', detail: '23/41 packages, 48/120 MB' });
  });

  it("falls back to the tool's last line, cleaned", () => {
    should(describeActivity({ phase: 'upgrading', line: '\u001b[32m==> Upgrading\u001b[0m' }, '4.69.4')).deepEqual({
      step: 'Upgrading with Homebrew',
      detail: '==> Upgrading',
    });
    should(describeActivity({ phase: 'upgrading', line: '  ' }, 'x').detail).be.undefined();
  });

  it('names every phase', () => {
    const steps = (
      [
        'preparing',
        'downloading',
        'building',
        'verifying',
        'unpacking',
        'switching',
        'refreshing',
        'upgrading',
      ] as const
    ).map(phase => describeActivity({ phase }, '1.0.0').step);
    should(steps).deepEqual([
      'Preparing 1.0.0',
      'Downloading 1.0.0',
      'Building 1.0.0',
      'Verifying the download',
      'Unpacking 1.0.0',
      'Switching the nix profile',
      'Refreshing the Homebrew tap',
      'Upgrading with Homebrew',
    ]);
  });

  it('ignores a count with nothing expected', () => {
    should(describeActivity({ phase: 'downloading', packages: { done: 0, expected: 0 } }, 'x').detail).be.undefined();
  });
});

describe('stepObserver', () => {
  it('names a step per phase, moves only forward, and keeps the numbers moving', () => {
    const progress = new RecordingProgress();
    const observe = stepObserver(progress, '4.69.4');
    for (const activity of feedAll(UPGRADE).activities) observe(activity);
    observe({ phase: 'preparing' });
    should(progress.steps).deepEqual(['Preparing 4.69.4', 'Downloading 4.69.4', 'Switching the nix profile']);
    should(progress.events).containEql('detail 0/2 packages, 0.5/2.0 MB');
    should(progress.events.at(-1)).equal('detail 2/2 packages, 2.0/2.0 MB');
  });

  it('does not restart a step for a repeat of its own phase', () => {
    const progress = new RecordingProgress();
    const observe = stepObserver(progress, '1.0.0');
    observe({ phase: 'downloading' });
    observe({ phase: 'downloading', bytes: { done: 1, expected: 2 } });
    should(progress.steps).deepEqual(['Downloading 1.0.0']);
  });
});
