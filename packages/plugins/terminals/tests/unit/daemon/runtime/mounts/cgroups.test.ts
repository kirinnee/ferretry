import { describe, it } from 'bun:test';
import should from 'should';
import manifest from '../../../../../manifest.ts';
import { type LimitsView, LimitsViewSchema } from '../../../../../daemon/lib/protocol/limits.ts';
import { limitsHandler, type LimitsSubsystem } from '../../../../../daemon/lib/runtime/mounts/cgroups.ts';

/**
 * Ferret limits: the read the settings surface and `fy daemon status` make. Who may reach it is the descriptor's — a
 * Warden must not read it (a supervision ferret has no business with the cap on the fleet it supervises), which the
 * operator minimum and the kernel's admission hold.
 */

const GIB = 1073741824;
const VIEW = {
  switchedOn: true,
  enforcement: 'cgroups',
  explicit: false,
  platform: 'linux',
  budget: {
    ceilingBytes: 48 * GIB,
    physicalBytes: 61 * GIB,
    swapBytes: 32 * GIB,
    cpus: 32,
    pidMax: 4_194_304,
    source: 'memory.high of user-1000.slice',
    reserveBytes: 4 * GIB,
  },
  fleet: {
    cpuWeight: 50,
    memoryHighBytes: 44 * GIB,
    memoryMaxBytes: 46 * GIB,
    swapMaxBytes: Math.floor(4.8 * GIB),
    tasksMax: 16_384,
    cpuPercent: null,
  },
  perFerret: {
    cpuWeight: 100,
    interactiveCpuWeight: 200,
    memoryHighBytes: 12 * GIB,
    memoryMaxBytes: Math.floor(14.4 * GIB),
    tasksMax: 4_096,
    cpuPercent: null,
  },
  daemonCpuWeight: 1000,
  voiceCpuWeight: 200,
  voiceState: 'running',
  disk: { ionice: true, scheduler: 'none', effect: 'none' },
  throttled: [],
  killed: [],
  overBudget: [],
  file: 'limits.yaml',
  lines: [
    'ferrets: memory 44 GiB soft / 46 GiB hard of a 48 GiB user budget · CPU weight 50 (daemon 1000, voice 200) · disk priority: no effect on this disk (scheduler none)',
  ],
  warnings: [],
} satisfies LimitsView;

class FakeLimits implements LimitsSubsystem {
  async view(): Promise<LimitsView> {
    return VIEW;
  }
}

const limitRoutes = () => manifest.actions.routes.filter(route => route.key.includes('/v1/cgroups/'));

describe('reading the ferret limits', () => {
  it('should answer with a body the client can parse', async () => {
    // Arrange / Act
    const response = await limitsHandler(new FakeLimits())();

    // Assert
    should(response.status).equal(200);
    should(LimitsViewSchema.parse(JSON.parse(response.body))).deepEqual(VIEW);
  });

  it('should never be cached, and govern the read with the fleet capability on the use axis', () => {
    // Arrange / Act
    const routes = limitRoutes();

    // Assert — the live part (ferrets slowed or killed for memory) is a measurement of this moment.
    should(routes.map(route => [route.noStore, route.minimum, route.capability])).deepEqual([
      [true, 'operator', { capability: 'fleet', axis: 'use' }],
    ]);
  });

  it('should have no save: limits.yaml is the one writer, and its writer holds a loosening for the owner', () => {
    // Arrange / Act / Assert
    should(limitRoutes().map(route => route.key)).deepEqual(['GET /v1/cgroups/config']);
  });
});
