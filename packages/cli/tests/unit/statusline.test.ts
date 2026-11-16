import { describe, it } from 'bun:test';
import should from 'should';
import { runFy } from '../../src/lib/run.ts';
import type { StatuslinePorts, StatuslineUsageRecord } from '../../src/lib/commands/statusline.ts';
import { fakeWorld } from './fakes.ts';

const CREDENTIAL = 'claude-main';
const PAYLOAD = JSON.stringify({
  model: { id: 'claude-opus-5-5' },
  rate_limits: {
    five_hour: { used_percentage: 41.5, resets_at: 1_800_000_000 },
    seven_day: { used_percentage: 12, resets_at: 1_800_500_000 },
  },
});

function harness(
  options: { stdin?: string; environment?: Record<string, string>; chainExit?: number; stdinFails?: boolean } = {},
) {
  const written: { id: string; record: StatuslineUsageRecord }[] = [];
  const chained: { command: string; stdin: string }[] = [];
  const ports: StatuslinePorts = {
    writeUsage: async (id, record) => {
      written.push({ id, record });
    },
    chain: async (command, stdin) => {
      chained.push({ command, stdin });
      return options.chainExit ?? 0;
    },
    now: () => 1_700_000_000_000,
  };
  const built = fakeWorld({ environment: options.environment ?? { FY_CREDENTIAL: CREDENTIAL } });
  const encoder = new TextEncoder();
  const world = {
    ...built.world,
    statusline: ports,
    host: {
      ...built.world.host,
      stdin: () =>
        (async function* () {
          yield encoder.encode(options.stdin ?? PAYLOAD);
          if (options.stdinFails === true) throw new Error('the pipe broke');
        })(),
    },
  };
  return { world, io: built.io, written, chained, connects: built.connects };
}

describe('fy statusline', () => {
  it('V-0446: should be a known verb that records the five-hour and weekly windows for the credential', async () => {
    const h = harness();

    const code = await runFy(['statusline'], h.world);

    should(code).equal(0);
    should(h.io.stderr()).equal('');
    should(h.written).eql([
      {
        id: CREDENTIAL,
        record: {
          version: 1,
          source: 'claude-statusline',
          at: 1_700_000_000_000,
          fiveHour: { usedPercent: 41.5, resetAt: 1_800_000_000_000 },
          weekly: { usedPercent: 12, resetAt: 1_800_500_000_000 },
        },
      },
    ]);
    should(h.connects).eql([]);
  });

  it('should run the own command after recording, with the same stdin, and exit with its code', async () => {
    const h = harness({ chainExit: 3 });

    const code = await runFy(['statusline', '--then', 'my-line --short'], h.world);

    should(code).equal(3);
    should(h.chained).eql([{ command: 'my-line --short', stdin: PAYLOAD }]);
    should(h.written.length).equal(1);
  });

  it('should record nothing and still exit 0 when the input is not JSON, has no limits or no credential is set', async () => {
    const notJson = harness({ stdin: 'not json' });
    const noLimits = harness({ stdin: JSON.stringify({ model: { id: 'x' } }) });
    const noCredential = harness({ environment: {} });

    should(await runFy(['statusline'], notJson.world)).equal(0);
    should(await runFy(['statusline'], noLimits.world)).equal(0);
    should(await runFy(['statusline'], noCredential.world)).equal(0);

    should(notJson.written).eql([]);
    should(noLimits.written).eql([]);
    should(noCredential.written).eql([]);
  });

  it('should never fail the status line when the write fails', async () => {
    const h = harness({ chainExit: 0 });
    const failing = {
      ...h.world,
      statusline: {
        ...(h.world.statusline as StatuslinePorts),
        writeUsage: async () => {
          throw new Error('disk full');
        },
      },
    };

    const code = await runFy(['statusline', '--then', 'echo mine'], failing);

    should(code).equal(0);
    should(h.chained.length).equal(1);
  });

  it('should read ISO-8601 reset times, and leave a reset time it cannot read unrecorded', async () => {
    const iso = harness({
      stdin: JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 20, resets_at: '2027-01-15T08:00:00.000Z' },
          seven_day: { used_percentage: 30, resets_at: 'next tuesday' },
        },
      }),
    });

    should(await runFy(['statusline'], iso.world)).equal(0);

    should(iso.written.length).equal(1);
    should(iso.written[0]?.record.fiveHour).eql({ usedPercent: 20, resetAt: Date.parse('2027-01-15T08:00:00.000Z') });
    should(iso.written[0]?.record.weekly?.usedPercent).equal(30);
    should(iso.written[0]?.record.weekly?.resetAt).equal(undefined);
  });

  it('should keep what it read when the input stream breaks part-way, and still record and chain it', async () => {
    const h = harness({ stdinFails: true });

    should(await runFy(['statusline', '--then', 'my-line'], h.world)).equal(0);

    should(h.chained).eql([{ command: 'my-line', stdin: PAYLOAD }]);
    should(h.written.length).equal(1);
    should(h.written[0]?.record.fiveHour?.usedPercent).equal(41.5);
  });
});
