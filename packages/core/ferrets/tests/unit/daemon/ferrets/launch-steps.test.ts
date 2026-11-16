import { describe, expect, test } from 'bun:test';
import { fenced, ferretId } from '../../../../contract/testing/index.ts';
import {
  LaunchStepRegistry,
  RESERVED_PANE_VARIABLES,
  type SessionStore,
  paneVariables,
} from '../../../../daemon/lib/ferrets/launch-steps.ts';

/** The stores half of what a launch asks of its features: the registry's boot faults and the runner's answers. */

const store = (id: string, variable: `FY_${string}`, locate?: SessionStore['locate']): SessionStore => ({
  id,
  variable,
  locate: locate ?? (async ferret => fenced(`/sessions/${ferret}/${id}`)),
});

describe('the registry', () => {
  test('is empty and unsealed until boot says otherwise, and keeps registration order', () => {
    const registry = new LaunchStepRegistry();
    expect(registry.sealed()).toBe(false);
    expect(registry.stores()).toEqual([]);
    registry.paneVariable(store('b', 'FY_B_ONE'));
    registry.paneVariable(store('a', 'FY_A_ONE'));
    expect(registry.stores().map(held => held.id)).toEqual(['b', 'a']);
    registry.seal();
    expect(registry.sealed()).toBe(true);
  });

  test('refuses a store registered after boot sealed it, naming the store', () => {
    const registry = new LaunchStepRegistry();
    registry.seal();
    expect(() => registry.paneVariable(store('late', 'FY_LATE'))).toThrow('late');
    expect(registry.stores()).toEqual([]);
  });

  test('refuses a repeated id and a repeated variable, naming both stores', () => {
    const registry = new LaunchStepRegistry();
    registry.paneVariable(store('one', 'FY_ONE'));
    expect(() => registry.paneVariable(store('one', 'FY_OTHER'))).toThrow('two launch stores are called one');
    expect(() => registry.paneVariable(store('two', 'FY_ONE'))).toThrow('one and two both set FY_ONE');
    expect(registry.stores().map(held => held.id)).toEqual(['one']);
  });

  test.each([...RESERVED_PANE_VARIABLES])('refuses the variable a launch sets itself: %s', variable => {
    const registry = new LaunchStepRegistry();
    expect(() => registry.paneVariable(store('bad', variable as `FY_${string}`))).toThrow('a launch sets itself');
    expect(registry.stores()).toEqual([]);
  });

  test.each(['PATH', 'fy_lower', 'FY_', 'FY_HAS SPACE', 'FY-DASH'])(
    'refuses %s, which is not an FY_* name',
    variable => {
      const registry = new LaunchStepRegistry();
      expect(() => registry.paneVariable(store('bad', variable as `FY_${string}`))).toThrow('not an FY_* variable');
    },
  );
});

describe('paneVariables', () => {
  test('answers each store’s variable, asking in registration order', async () => {
    const asked: string[] = [];
    const locate =
      (name: string): SessionStore['locate'] =>
      async ferret => {
        asked.push(name);
        return fenced(`/sessions/${ferret}/${name}`);
      };
    const variables = await paneVariables(
      [store('one', 'FY_ONE', locate('one')), store('two', 'FY_TWO', locate('two'))],
      ferretId('f1'),
    );
    expect(variables).toEqual({ FY_ONE: '/sessions/f1/one', FY_TWO: '/sessions/f1/two' });
    expect(asked).toEqual(['one', 'two']);
  });

  test('a store that throws or names nothing sets no variable and never stops the next one', async () => {
    const variables = await paneVariables(
      [
        store('throws', 'FY_THROWS', async () => {
          throw new Error('FIXTURE_SECRET could not be made');
        }),
        store('nothing', 'FY_NOTHING', async () => undefined),
        store('fine', 'FY_FINE'),
      ],
      ferretId('f1'),
    );
    expect(variables).toEqual({ FY_FINE: '/sessions/f1/fine' });
  });

  test('no stores, no variables', async () => {
    expect(await paneVariables([], ferretId('f1'))).toEqual({});
  });
});
