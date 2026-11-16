/**
 * Proves the planner (`speed-planner.ts`): it turns a device into a plan, learns from a failure so the
 * next plan changes, and is shared per page.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { SpeedMemoryStore } from '../../../../app/lib/stt/speed-memory.ts';
import { flatSpeedPlanner, SpeedPlanner, speedPlannerFor } from '../../../../app/lib/stt/speed-planner.ts';
import { NO_SIGNALS } from '../../../../app/lib/stt/speed-plan.ts';

const ISOLATED = { ...NO_SIGNALS, crossOriginIsolated: true, hardwareConcurrency: 8, deviceMemoryGb: 8 };

describe('SpeedPlanner', () => {
  it('asks for threads on an isolated device, and for one thread elsewhere', () => {
    const memory = new SpeedMemoryStore(null);
    should(new SpeedPlanner({ signals: ISOLATED, memory, now: () => 5 }).threadsFor('parakeet')).equal(4);
    should(new SpeedPlanner({ signals: NO_SIGNALS, memory, now: () => 5 }).threadsFor('parakeet')).equal(1);
    should(flatSpeedPlanner().planFor('parakeet').path).equal('wasm-single');
  });

  it('plans one thread after threads failed, and tells Settings why', () => {
    const planner = new SpeedPlanner({ signals: ISOLATED, memory: new SpeedMemoryStore(null), now: () => 5 });
    should(planner.planFor('parakeet').path).equal('wasm-threads');
    planner.threadsFailed('parakeet');
    should(planner.planFor('parakeet')).deepEqual({ path: 'wasm-single', threads: 1, reason: 'failed-before' });
    should(planner.planFor('whisper-base-en').path).equal('wasm-threads');
  });

  it('reads the page’s own signals and storage', () => {
    const items = new Map<string, string>();
    const page = {
      crossOriginIsolated: true,
      navigator: { hardwareConcurrency: 8, deviceMemory: 8 },
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
      },
    };
    const planner = speedPlannerFor(page);
    should(planner.planFor('parakeet').path).equal('wasm-threads');
    planner.threadsFailed('parakeet');
    should([...items.keys()]).deepEqual(['fy:voice:speed-memory']);
    should(speedPlannerFor(page)).equal(planner);
  });

  it('survives storage that throws on access', () => {
    const page = {
      get localStorage(): never {
        throw new Error('blocked');
      },
    };
    should(speedPlannerFor(page).planFor('parakeet').path).equal('wasm-single');
  });

  it('takes the GPU into account once probed, and never rejects', async () => {
    const planner = new SpeedPlanner({ signals: NO_SIGNALS, memory: new SpeedMemoryStore(null), now: () => 5 });
    await planner.probe({ navigator: { gpu: { requestAdapter: async () => ({}) } } });
    should(planner.planFor('parakeet').path).equal('wasm-single');
  });
});
