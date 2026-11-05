import { describe, it } from 'bun:test';
import should from 'should';
import {
  harnessPrefixed,
  LOGIN_NAME_MAX,
  loginIdFor,
  loginLabelTaken,
  loginNameProblem,
  runtimeNameFor,
} from '../../src/lib/fleet-names.ts';

describe('harnessPrefixed', () => {
  it('adds the harness once', () => {
    should(harnessPrefixed('claude', 'default')).equal('claude-default');
    should(harnessPrefixed('claude', 'claude-default')).equal('claude-default');
    should(harnessPrefixed('claude', 'claude')).equal('claude');
  });

  it('checks the prefix per harness', () => {
    should(harnessPrefixed('claude', 'codex-x')).equal('claude-codex-x');
  });
});

describe('loginIdFor', () => {
  it('makes the id from the name', () => {
    should(loginIdFor('claude', 'work', new Set())).equal('claude-work');
    should(loginIdFor('claude', 'Claude Work', new Set())).equal('claude-work');
    should(loginIdFor('claude', 'claude-work', new Set())).equal('claude-work');
    should(loginIdFor('claude', 'Work Mac!', new Set())).equal('claude-work-mac');
  });

  it('falls back to login when there is no name', () => {
    should(loginIdFor('claude', '', new Set())).equal('claude-login');
    should(loginIdFor('codex', undefined, new Set(['codex-login', 'codex-login-2']))).equal('codex-login-3');
  });

  it('numbers past ids that are taken', () => {
    should(loginIdFor('claude', 'work', new Set(['claude-work']))).equal('claude-work-2');
    should(loginIdFor('claude', 'work', new Set(['claude-work', 'claude-work-2']))).equal('claude-work-3');
  });

  it('keeps a long name within the id grammar', () => {
    const id = loginIdFor('claude', 'x'.repeat(100), new Set());
    should(id.length).be.belowOrEqual(64);
    should(/^[a-z0-9-]+$/u.test(id)).be.true();
    should(id.endsWith('-')).be.false();
  });
});

describe('runtimeNameFor', () => {
  it('names the runtime after its login, prefix once', () => {
    should(runtimeNameFor('claude', 'claude-work', new Set())).equal('claude-work');
    should(runtimeNameFor('claude', 'work', new Set(['claude-work']))).equal('claude-work-2');
  });

  it('never doubles the prefix of a profile', () => {
    should(runtimeNameFor('claude', 'claude-default', new Set())).equal('claude-default');
    should(runtimeNameFor('claude', 'claude-default', new Set(['claude-default']))).equal('claude-default-2');
    should(runtimeNameFor('claude', '!!!', new Set())).equal('claude-runtime');
  });
});

describe('loginNameProblem', () => {
  const personal = { id: 'claude', harness: 'claude', label: 'personal', email: 'you@personal.com' } as const;

  it('is required when another login of this tool exists, optional otherwise', () => {
    should(loginNameProblem('', 'claude', [personal])).equal('Give it a name so you can tell the two apart.');
    should(loginNameProblem('  ', 'claude', [personal])).equal('Give it a name so you can tell the two apart.');
    should(loginNameProblem('', 'claude', [])).be.null();
    should(loginNameProblem('', 'codex', [personal])).be.null();
  });

  it('needs a letter or digit and at most the limit', () => {
    should(loginNameProblem('---', 'claude', [])).equal('Use at least one letter or digit.');
    should(loginNameProblem('x'.repeat(LOGIN_NAME_MAX + 1), 'claude', [])).equal('Keep it to 40 characters.');
    should(loginNameProblem('x'.repeat(LOGIN_NAME_MAX), 'claude', [])).be.null();
  });

  it('refuses a label another login of the same tool has, any case', () => {
    should(loginNameProblem('Personal', 'claude', [personal])).equal(
      'You already have a Claude Code login named Personal. Pick another name.',
    );
    should(loginNameProblem('work', 'claude', [personal])).be.null();
  });

  it('does not let a Codex login block a Claude one', () => {
    should(loginNameProblem('work', 'claude', [{ harness: 'codex', label: 'work' }])).be.null();
    should(loginLabelTaken('work', 'claude', [{ harness: 'codex', label: 'work' }])).be.false();
  });

  it('leaves the login being renamed out of the clash', () => {
    should(loginLabelTaken('work', 'claude', [{ id: 'a', harness: 'claude', label: 'work' }], 'a')).be.false();
  });
});
