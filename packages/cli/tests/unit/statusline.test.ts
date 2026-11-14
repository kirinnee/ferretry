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

function harness(options: { stdin?: string; environment?: Record<string, string>; chainExit?: number } = {}) {
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
});
