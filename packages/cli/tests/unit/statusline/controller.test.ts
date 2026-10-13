import { describe, it } from 'bun:test';
import type { PassiveUsageRecord } from '@ferretry/fleet';
import should from 'should';
import {
  StatuslineController,
  type StatuslineDeps,
  statuslineUsageRecord,
} from '../../../src/lib/statusline/controller.ts';

const AT = 1_790_000_000_000;

const PAYLOAD = JSON.stringify({
  model: { id: 'claude-opus-5-5' },
  rate_limits: {
    five_hour: { used_percentage: 42, resets_at: 1_790_003_600 },
    seven_day: { used_percentage: 7.5, resets_at: 1_790_400_000 },
  },
});

interface Harness {
  readonly deps: StatuslineDeps;
  readonly writes: { readonly id: string; readonly record: PassiveUsageRecord }[];
  readonly chained: { readonly command: string; readonly stdin: string }[];
  readonly exitCodes: number[];
}

function harness(
  overrides: {
    readonly payload?: string;
    readonly read?: () => Promise<string>;
    readonly environment?: Record<string, string | undefined>;
    readonly sinkThrows?: boolean;
    readonly chainCode?: number;
  } = {},
): Harness {
  const writes: Harness['writes'][number][] = [];
  const chained: Harness['chained'][number][] = [];
  const exitCodes: number[] = [];
  const deps: StatuslineDeps = {
    input: { read: overrides.read ?? (async () => overrides.payload ?? PAYLOAD) },
    sink: {
      write: async (id, record) => {
        if (overrides.sinkThrows === true) throw new Error('disk full');
        writes.push({ id, record });
      },
    },
    chain: {
      run: async (command, stdin) => {
        chained.push({ command, stdin });
        return overrides.chainCode ?? 0;
      },
    },
    environment: overrides.environment ?? { FY_CREDENTIAL: 'claude-you' },
    now: () => AT,
    setExitCode: code => {
      exitCodes.push(code);
    },
  };
  return { deps, writes, chained, exitCodes };
}

describe('statuslineUsageRecord', () => {
  it('should turn the rate_limits block into a passive claude-statusline record', () => {
    // Act
    const record = statuslineUsageRecord(PAYLOAD, AT);

    // Assert
    should(record).eql({
      version: 1,
      source: 'claude-statusline',
      at: AT,
      fiveHour: { usedPercent: 42, resetAt: 1_790_003_600_000 },
      weekly: { usedPercent: 7.5, resetAt: 1_790_400_000_000 },
    });
  });

  it('should keep only the window that was measured', () => {
    // Act
    const record = statuslineUsageRecord(JSON.stringify({ rate_limits: { seven_day: { used_percentage: 3 } } }), AT);

    // Assert
    should(record).eql({ version: 1, source: 'claude-statusline', at: AT, weekly: { usedPercent: 3 } });
  });

  it('should record nothing for input that is not JSON', () => {
    should(statuslineUsageRecord('not json', AT)).be.undefined();
  });

  it('should record nothing for a payload with no rate limits, never a 0%', () => {
    should(statuslineUsageRecord(JSON.stringify({ model: { id: 'x' } }), AT)).be.undefined();
  });
});

describe('StatuslineController', () => {
  it('should write the reading under the credential named by FY_CREDENTIAL', async () => {
    // Arrange
    const h = harness({ environment: { FY_CREDENTIAL: '  claude-you  ' } });

    // Act
    await new StatuslineController(h.deps).run({});

    // Assert
    should(h.writes.map(write => write.id)).eql(['claude-you']);
    should(h.writes[0]?.record.source).equal('claude-statusline');
    should(h.chained).be.empty();
    should(h.exitCodes).be.empty();
  });

  it('should write nothing when FY_CREDENTIAL is missing', async () => {
    // Arrange
    const h = harness({ environment: {} });

    // Act
    await new StatuslineController(h.deps).run({});

    // Assert
    should(h.writes).be.empty();
  });

  it('should write nothing when FY_CREDENTIAL is not a credential id', async () => {
    // Arrange
    const h = harness({ environment: { FY_CREDENTIAL: '../../etc' } });

    // Act
    await new StatuslineController(h.deps).run({});

    // Assert
    should(h.writes).be.empty();
  });

  it('should write nothing for a payload that measured nothing', async () => {
    // Arrange
    const h = harness({ payload: 'garbage' });

    // Act
    await new StatuslineController(h.deps).run({});

    // Assert
    should(h.writes).be.empty();
  });

  it("should chain the person's own command with the same stdin and take its exit code", async () => {
    // Arrange
    const h = harness({ chainCode: 3 });

    // Act
    await new StatuslineController(h.deps).run({ own: '  my-statusline --short  ' });

    // Assert
    should(h.chained).eql([{ command: 'my-statusline --short', stdin: PAYLOAD }]);
    should(h.exitCodes).eql([3]);
    should(h.writes).have.length(1);
  });

  it('should still chain when recording the reading fails', async () => {
    // Arrange
    const h = harness({ sinkThrows: true });

    // Act
    await new StatuslineController(h.deps).run({ own: 'mine' });

    // Assert
    should(h.chained).eql([{ command: 'mine', stdin: PAYLOAD }]);
    should(h.exitCodes).eql([0]);
  });

  it('should treat unreadable input as empty and still chain', async () => {
    // Arrange
    const h = harness({
      read: async () => {
        throw new Error('stdin closed');
      },
    });

    // Act
    await new StatuslineController(h.deps).run({ own: 'mine' });

    // Assert
    should(h.writes).be.empty();
    should(h.chained).eql([{ command: 'mine', stdin: '' }]);
  });

  it('should not chain a blank command', async () => {
    // Arrange
    const h = harness();

    // Act
    await new StatuslineController(h.deps).run({ own: '   ' });

    // Assert
    should(h.chained).be.empty();
    should(h.exitCodes).be.empty();
  });
});
