import { describe, expect, it } from 'bun:test';
import { fleetFromFiles } from '../../../daemon/lib/service/fleet-from-files.ts';

type Outcome = 'applied' | 'unchanged' | 'skipped' | undefined;

/** A publish the test finishes by hand, so a change can arrive while one is running. */
function gated() {
  const gates: (() => void)[] = [];
  let runs = 0;
  const warnings: string[] = [];
  const publisher = fleetFromFiles({
    republish: async (): Promise<Outcome> => {
      runs += 1;
      await new Promise<void>(resolve => gates.push(resolve));
      return 'applied';
    },
    warn: message => warnings.push(message),
  });
  return { publisher, gates, warnings, runs: () => runs };
}

const tick = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('publishing the fleet from the files', () => {
  it('now() publishes once and resolves when it is done', async () => {
    let runs = 0;
    const publisher = fleetFromFiles({
      republish: async () => {
        runs += 1;
        return 'unchanged';
      },
      warn: () => undefined,
    });

    await publisher.now();

    expect(runs).toBe(1);
  });

  it('a burst of changes during one publish earns exactly one more publish, not one each', async () => {
    const { publisher, gates, runs } = gated();

    publisher.soon();
    await tick();
    publisher.soon();
    publisher.soon();
    publisher.soon();
    expect(runs()).toBe(1);
    gates[0]?.();
    await tick();
    await tick();
    expect(runs()).toBe(2);
    gates[1]?.();
    await tick();
    await tick();

    expect(runs()).toBe(2);
  });

  it('a now() that arrives during a publish waits for it and for the one change it owes', async () => {
    const { publisher, gates, runs } = gated();
    publisher.soon();
    await tick();

    let finished = false;
    const waiting = publisher.now().then(() => {
      finished = true;
    });
    await tick();
    expect(finished).toBe(false);
    gates[0]?.();
    await tick();
    await tick();
    gates[1]?.();
    await waiting;

    expect(runs()).toBe(2);
    expect(finished).toBe(true);
  });

  it('says a refusal once and never rejects, so the next change publishes again', async () => {
    const said: string[] = [];
    let fail = true;
    const publisher = fleetFromFiles({
      republish: async () => {
        if (fail) throw new Error('a runtime file does not parse');
        return 'applied';
      },
      warn: message => said.push(message),
    });

    await publisher.now();
    fail = false;
    await publisher.now();

    expect(said).toEqual([
      'the fleet could not be published from its configuration files: a runtime file does not parse',
    ]);
  });
});
