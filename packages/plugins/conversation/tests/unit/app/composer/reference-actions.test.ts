/**
 * Add to chat, across every composer a browser really has open.
 *
 * The other composer-reference tests prove each surface in isolation against ONE registered composer. That is exactly
 * the arrangement in which a targeting defect cannot appear: with a single target, delivering to "the composer" and
 * delivering to "this ferret's composer" are the same action. This suite therefore registers the arrangement the app
 * actually runs — several composers mounted at once, because retained background panes keep theirs mounted,
 * including two daemons carrying the SAME ferret id and one daemon carrying two ferrets — and requires each delivery
 * to land in exactly one of them.
 *
 * A task id is ferret-local, so `&F12` delivered to the wrong ferret names different work and the agent reading it
 * cannot tell.
 *
 * Nothing here renders a component: the fact under test is which draft a delivery reaches, and a rendered row would
 * only add a way for the test to pass while the delivery is wrong.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerComposerQuoteTarget } from '@ferretry/app';
import { addReferenceMessage, addReferenceToComposer } from '../../../../app/composer/composer-references.ts';
import { daemonConnection, type DaemonFerretScope, daemonFerretScope } from '../../../../app/composer/seam.ts';

const laptop = daemonConnection('daemon/laptop');
const workstation = daemonConnection('daemon/workstation');

/** Same ferret id on two daemons, and two ferrets on one daemon. */
const LAPTOP_A = daemonFerretScope(laptop, 'ferret-a');
const LAPTOP_B = daemonFerretScope(laptop, 'ferret-b');
const WORKSTATION_A = daemonFerretScope(workstation, 'ferret-a');

const disposers: Array<() => void> = [];

/** Every scope above, mounted at once, keyed the way the registry keys them. */
const openComposers = (drafts: Partial<Record<string, string>> = {}): Map<DaemonFerretScope, { draft: string }> => {
  const states = new Map<DaemonFerretScope, { draft: string }>();
  for (const scope of [LAPTOP_A, LAPTOP_B, WORKSTATION_A]) {
    const state = { draft: drafts[`${scope.daemonId}:${scope.ferretId}`] ?? '' };
    states.set(scope, state);
    disposers.push(
      registerComposerQuoteTarget({
        ...scope,
        draft: () => state.draft,
        replaceDraft: next => {
          state.draft = next;
        },
      }),
    );
  }
  return states;
};

const draftsOf = (states: Map<DaemonFerretScope, { draft: string }>): readonly string[] =>
  [...states.values()].map(state => state.draft);

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe('Add to chat delivers a task reference to exactly one ferret', () => {
  test('reaches the composer of the daemon AND ferret the row was read under', () => {
    const states = openComposers({ 'daemon/laptop:ferret-a': 'look at' });

    const outcome = addReferenceToComposer({ kind: 'task', id: 'F12' }, LAPTOP_A);

    expect(outcome).toBe('added');
    expect(states.get(LAPTOP_A)?.draft).toBe('look at &F12 ');
    // The other two are the whole point: same id on another daemon, and another ferret on this one.
    expect(states.get(WORKSTATION_A)?.draft).toBe('');
    expect(states.get(LAPTOP_B)?.draft).toBe('');
  });

  test('distinguishes two ferrets of the same daemon', () => {
    const states = openComposers();

    expect(addReferenceToComposer({ kind: 'task', id: 'F12' }, LAPTOP_B)).toBe('added');

    expect(states.get(LAPTOP_B)?.draft).toBe('&F12 ');
    expect(states.get(LAPTOP_A)?.draft).toBe('');
  });

  test('refuses an id the grammar cannot write down, leaving every draft untouched', () => {
    const states = openComposers({ 'daemon/laptop:ferret-a': 'look at' });

    const outcome = addReferenceToComposer({ kind: 'task', id: 'nonsense-12' }, LAPTOP_A);

    expect(outcome).toBe('rejected');
    expect(addReferenceMessage(outcome, '&nonsense-12')).toBe(
      'That reference cannot be written down, so it was not added.',
    );
    // Pasting it in anyway would leave prose that never resolves to a task.
    expect(draftsOf(states)).toEqual(['look at', '', '']);
  });

  test('says nothing was delivered when that ferret has no composer mounted', () => {
    const states = openComposers();

    const outcome = addReferenceToComposer(
      { kind: 'task', id: 'F12' },
      daemonFerretScope(laptop, 'ferret-never-opened'),
    );

    expect(outcome).toBe('no-composer');
    expect(addReferenceMessage(outcome, '&F12')).toBe(
      'No message box is open for this ferret, so there is nowhere to add it.',
    );
    expect(draftsOf(states)).toEqual(['', '', '']);
  });
});
