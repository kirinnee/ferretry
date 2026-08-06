/**
 * Add to chat and Use in chat, across every composer a browser really has open.
 *
 * The unit tests prove each surface in isolation against ONE registered
 * composer. That is exactly the arrangement in which a targeting defect cannot
 * appear: with a single target, delivering to "the composer" and delivering to
 * "this session's composer" are the same action. This tier therefore registers
 * the arrangement the PWA actually runs — several composers mounted at once,
 * because retained background panes keep theirs mounted, including two daemons
 * carrying the SAME session id and one daemon carrying two sessions — and
 * requires each delivery to land in exactly one of them.
 *
 * The stakes differ per reference and both are real. A task id is session-local,
 * so `&F12` delivered to the wrong session names different work and the agent
 * reading it cannot tell. A skill invocation is harness-local, so `/name`
 * delivered to a Codex session types a command that harness does not have.
 *
 * Nothing here renders a component: the fact under test is which draft a
 * delivery reaches, and a rendered row would only add a way for the test to
 * pass while the delivery is wrong.
 */

import { afterEach, describe, it } from 'bun:test';
import should from 'should';

import { skillInsertText } from '../../../src/features/skills/skills-catalog.ts';
import { addSkillInvocationToComposer } from '../../../src/features/skills/skills-composer.ts';
import { addReferenceMessage, addReferenceToComposer } from '../../../src/lib/composer-references.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';

const laptop = daemonConnection({
  daemonId: 'daemon/laptop',
  baseUrl: 'https://laptop.example.test',
  deviceToken: 'token-laptop',
});
const workstation = daemonConnection({
  daemonId: 'daemon/workstation',
  baseUrl: 'https://workstation.example.test',
  deviceToken: 'token-workstation',
});

/** Same session id on two daemons, and two sessions on one daemon. */
const LAPTOP_A = daemonSessionScope(laptop, 'session-a');
const LAPTOP_B = daemonSessionScope(laptop, 'session-b');
const WORKSTATION_A = daemonSessionScope(workstation, 'session-a');

const disposers: Array<() => void> = [];

/** Every scope above, mounted at once, keyed the way the registry keys them. */
const openComposers = (drafts: Partial<Record<string, string>> = {}): Map<DaemonSessionScope, { draft: string }> => {
  const states = new Map<DaemonSessionScope, { draft: string }>();
  for (const scope of [LAPTOP_A, LAPTOP_B, WORKSTATION_A]) {
    const state = { draft: drafts[`${scope.daemonId}:${scope.sessionId}`] ?? '' };
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

const draftsOf = (states: Map<DaemonSessionScope, { draft: string }>): readonly string[] =>
  [...states.values()].map(state => state.draft);

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe('Add to chat delivers a task reference to exactly one session', () => {
  it('reaches the composer of the daemon AND session the row was read under', () => {
    const states = openComposers({ 'daemon/laptop:session-a': 'look at' });

    const outcome = addReferenceToComposer({ kind: 'task', id: 'F12' }, LAPTOP_A);

    should(outcome).equal('added');
    should(states.get(LAPTOP_A)?.draft).equal('look at &F12 ');
    // The other two are the whole point: same id on another daemon, and another
    // session on this one.
    should(states.get(WORKSTATION_A)?.draft).equal('');
    should(states.get(LAPTOP_B)?.draft).equal('');
  });

  it('distinguishes two sessions of the same daemon', () => {
    const states = openComposers();

    should(addReferenceToComposer({ kind: 'task', id: 'F12' }, LAPTOP_B)).equal('added');

    should(states.get(LAPTOP_B)?.draft).equal('&F12 ');
    should(states.get(LAPTOP_A)?.draft).equal('');
  });

  it('refuses an id the grammar cannot write down, leaving every draft untouched', () => {
    const states = openComposers({ 'daemon/laptop:session-a': 'look at' });

    const outcome = addReferenceToComposer({ kind: 'task', id: 'nonsense-12' }, LAPTOP_A);

    should(outcome).equal('rejected');
    should(addReferenceMessage(outcome, '&nonsense-12')).equal(
      'That reference cannot be written down, so it was not added.',
    );
    // Pasting it in anyway would leave prose that never resolves to a task.
    should(draftsOf(states)).deepEqual(['look at', '', '']);
  });

  it('says nothing was delivered when that session has no composer mounted', () => {
    const states = openComposers();

    const outcome = addReferenceToComposer(
      { kind: 'task', id: 'F12' },
      daemonSessionScope(laptop, 'session-never-opened'),
    );

    should(outcome).equal('no-composer');
    should(addReferenceMessage(outcome, '&F12')).equal(
      'No message box is open for this session, so there is nowhere to add it.',
    );
    should(draftsOf(states)).deepEqual(['', '', '']);
  });
});

describe('Use in chat delivers the invocation the target harness understands', () => {
  it('keeps Claude and Codex syntax apart across two live sessions', () => {
    const states = openComposers();

    // Each session's own catalog decides the sigil; the surface never picks one
    // for both.
    should(addSkillInvocationToComposer(skillInsertText('claude', 'floop'), LAPTOP_A)).equal('added');
    should(addSkillInvocationToComposer(skillInsertText('codex', 'floop'), LAPTOP_B)).equal('added');

    should(states.get(LAPTOP_A)?.draft).equal('/floop ');
    // NOT canonicalised to `/floop`: Codex browses with `/skills` and invokes
    // with `$name`, so the canonical rendering would type a missing command.
    should(states.get(LAPTOP_B)?.draft).equal('$floop ');
    should(states.get(WORKSTATION_A)?.draft).equal('');
  });

  it('treats the two authored aliases as one reference already in the draft', () => {
    const states = openComposers({ 'daemon/laptop:session-a': 'please /floop ' });

    const outcome = addSkillInvocationToComposer('$floop', LAPTOP_A);

    should(outcome).equal('duplicate');
    should(addReferenceMessage(outcome, '$floop')).equal('$floop is already in this message.');
    should(states.get(LAPTOP_A)?.draft).equal('please /floop ');
  });

  it('refuses a bare name and anything that is not a skill reference', () => {
    const states = openComposers();

    should(addSkillInvocationToComposer('floop', LAPTOP_A)).equal('rejected');
    should(addSkillInvocationToComposer('/not a skill', LAPTOP_A)).equal('rejected');
    // A proved reference of the WRONG KIND is refused too: the task grammar
    // accepts `&F12`, and this action delivers skills.
    should(addSkillInvocationToComposer('&F12', LAPTOP_A)).equal('rejected');
    should(draftsOf(states)).deepEqual(['', '', '']);
  });

  it('appends to the reader sentence rather than replacing it', () => {
    const states = openComposers({ 'daemon/laptop:session-a': 'before you start,' });

    should(addSkillInvocationToComposer('/floop', LAPTOP_A)).equal('added');

    should(states.get(LAPTOP_A)?.draft).equal('before you start, /floop ');
  });
});
