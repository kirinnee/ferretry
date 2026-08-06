import { afterEach, describe, expect, it } from 'bun:test';
import { addSkillInvocationToComposer } from '../../../src/features/skills/skills-composer.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { registerComposerQuoteTarget } from '../../../src/lib/quote.ts';

const daemon = daemonConnection({
  daemonId: 'skills-daemon',
  baseUrl: 'https://skills.example.test',
  deviceToken: 'device-token',
});
const scope = daemonSessionScope(daemon, 'session-a');
const disposers: Array<() => void> = [];

const composer = (draft = '') => {
  const state = { draft };
  disposers.push(
    registerComposerQuoteTarget({
      ...scope,
      draft: () => state.draft,
      replaceDraft: next => {
        state.draft = next;
      },
    }),
  );
  return state;
};

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

describe('addSkillInvocationToComposer', () => {
  it('preserves the harness-specific sigil and existing prose', () => {
    const target = composer('please use');

    expect(addSkillInvocationToComposer('$floop', scope)).toBe('added');
    expect(target.draft).toBe('please use $floop ');
  });

  it('treats the two authored aliases as one skill reference', () => {
    const target = composer('/floop ');

    expect(addSkillInvocationToComposer('$floop', scope)).toBe('duplicate');
    expect(target.draft).toBe('/floop ');
  });

  it('refuses prose and a scope with no composer', () => {
    expect(addSkillInvocationToComposer('floop', scope)).toBe('rejected');
    expect(addSkillInvocationToComposer('/floop', scope)).toBe('no-composer');
  });
});
