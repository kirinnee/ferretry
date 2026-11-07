/**
 * How a copy settles each sign-in the source carries. The daemon's planner and the app's Done screen both
 * call this one rule, so they cannot disagree about which login a sign-in became.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CloneTargetLogin,
  freeCloneName,
  matchCloneSignIn,
  planCloneLogins,
} from '../../../daemon/lib/clone-logins.ts';

const here = (
  id: string,
  harness: CloneTargetLogin['harness'],
  fields: Partial<CloneTargetLogin> = {},
): CloneTargetLogin => ({
  id,
  harness,
  ...fields,
});

describe('matchCloneSignIn', () => {
  it('should match the same CLI by email ignoring case and spacing, never another CLI', () => {
    const targets = [
      here('claude-mine', 'claude-code', { email: ' Me@Work.Example ' }),
      here('codex-mine', 'codex', { email: 'me@work.example' }),
    ];
    should(matchCloneSignIn({ harness: 'claude-code', email: 'me@work.example' }, targets)).eql({
      kind: 'one',
      id: 'claude-mine',
    });
  });

  it('should fall back to the label only when neither side has an email', () => {
    const targets = [
      here('codex-mine', 'codex', { label: 'Work' }),
      here('codex-mail', 'codex', { label: 'Work', email: 'a@b.c' }),
    ];
    should(matchCloneSignIn({ harness: 'codex', label: 'Work' }, targets)).eql({ kind: 'one', id: 'codex-mine' });
    should(matchCloneSignIn({ harness: 'codex', label: 'Work', email: 'x@y.z' }, targets)).eql({ kind: 'none' });
  });

  it('should never match an API-key login', () => {
    const targets = [here('env', 'claude-code', { store: 'environment', email: 'me@work.example' })];
    should(matchCloneSignIn({ harness: 'claude-code', email: 'me@work.example' }, targets)).eql({ kind: 'none' });
  });

  it('should answer many, sorted, when two or more fit', () => {
    const targets = [here('codex-you', 'codex', { label: 'Work' }), here('codex-other', 'codex', { label: 'Work' })];
    should(matchCloneSignIn({ harness: 'codex', label: 'Work' }, targets)).eql({
      kind: 'many',
      ids: ['codex-other', 'codex-you'],
    });
  });
});

describe('freeCloneName', () => {
  it('should keep a free name and number a taken one from 2', () => {
    should(freeCloneName('a', () => false)).equal('a');
    should(freeCloneName('a', name => name === 'a' || name === 'a-2')).equal('a-3');
  });
});

describe('planCloneLogins', () => {
  it('should reuse a match, and give any other sign-in its own id, renamed when taken', () => {
    const targets = [
      here('claude-mine', 'claude-code', { email: 'me@work.example' }),
      here('codex-you', 'codex', { email: 'someone@else.example' }),
    ];
    const settled = planCloneLogins(
      [
        { id: 'claude-you', harness: 'claude-code', email: 'ME@work.example' },
        { id: 'codex-you', harness: 'codex', email: 'new@work.example' },
      ],
      targets,
    );
    should([...settled]).eql([
      ['claude-you', { kind: 'matched', id: 'claude-mine' }],
      ['codex-you', { kind: 'new', id: 'codex-you-2' }],
    ]);
  });

  it('should ask, with the candidates, and still make a free slot when two logins fit', () => {
    const targets = [here('codex-you', 'codex', { label: 'Work' }), here('codex-other', 'codex', { label: 'Work' })];
    const settled = planCloneLogins([{ id: 'codex-you', harness: 'codex', label: 'Work' }], targets);
    should(settled.get('codex-you')).eql({ kind: 'new', id: 'codex-you-2', candidates: ['codex-other', 'codex-you'] });
  });

  it('should not hand an id one source login took to the next, API-key logins included', () => {
    const settled = planCloneLogins(
      [
        { id: 'glm', harness: 'claude-code', store: 'environment' },
        { id: 'glm-2', harness: 'codex', label: 'Other' },
      ],
      [here('glm', 'claude-code', { store: 'environment' })],
    );
    should([...settled.values()]).eql([
      { kind: 'new', id: 'glm-2' },
      { kind: 'new', id: 'glm-2-2' },
    ]);
  });
});
