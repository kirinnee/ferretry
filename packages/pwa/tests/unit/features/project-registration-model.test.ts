import { describe, expect, it } from 'bun:test';

import {
  ABSOLUTE_PATH_REQUIRED,
  CLONE_ADDRESS_UNUSABLE,
  CLONE_PATIENCE,
  confirmDiscoveryRequest,
  DISCOVERY_PROMISE,
  emptyProjectRegistrationDraft,
  NEW_FOLDER_ONE_LEVEL,
  PROJECT_REGISTRATION_MODES,
  projectDraftVerdict,
  projectModeDescriptor,
  projectSourceLabel,
  type ProjectRegistrationDraft,
  registrationPendingFor,
} from '../../../src/features/projects/project-registration-model.ts';

const draft = (patch: Partial<ProjectRegistrationDraft> = {}): ProjectRegistrationDraft => ({
  ...emptyProjectRegistrationDraft,
  ...patch,
});

describe('PROJECT_REGISTRATION_MODES', () => {
  it('offers exactly the three form arms, least destructive first', () => {
    expect(PROJECT_REGISTRATION_MODES.map(mode => mode.mode)).toEqual(['existing-folder', 'new-folder', 'clone']);
  });

  it('says what each mode does to the filesystem, and pairs a label with the path field', () => {
    expect(PROJECT_REGISTRATION_MODES[0]?.detail).toContain('Nothing is written to disk');
    expect(PROJECT_REGISTRATION_MODES[1]?.detail).toContain('Creates the folder');
    expect(PROJECT_REGISTRATION_MODES[2]?.detail).toContain('git clone');
    expect(projectModeDescriptor('clone').pathLabel).toBe('Clone into');
    expect(projectModeDescriptor('new-folder').pathLabel).toBe('Folder to create');
    expect(projectModeDescriptor('existing-folder').pathPlaceholder.startsWith('/')).toBe(true);
  });
});

describe('projectDraftVerdict', () => {
  it('says nothing about an empty draft: an unfinished path is not a mistake', () => {
    expect(projectDraftVerdict(emptyProjectRegistrationDraft)).toEqual({ request: null, problem: null });
    expect(projectDraftVerdict(draft({ path: '   ' }))).toEqual({ request: null, problem: null });
  });

  it('waits for a clone URL before complaining, even with a good path', () => {
    expect(projectDraftVerdict(draft({ mode: 'clone', path: '/work/p' }))).toEqual({ request: null, problem: null });
  });

  it('builds the existing-folder arm and drops a blank name rather than sending one', () => {
    expect(projectDraftVerdict(draft({ path: '  /work/ferretry  ', name: '   ' })).request).toEqual({
      kind: 'existing-folder',
      path: '/work/ferretry',
    });
  });

  it('carries a typed display name through, trimmed', () => {
    expect(projectDraftVerdict(draft({ path: '/work/ferretry', name: '  Ferretry  ' })).request).toEqual({
      kind: 'existing-folder',
      path: '/work/ferretry',
      name: 'Ferretry',
    });
  });

  it('builds the new-folder arm with the Git flag the reader chose', () => {
    expect(
      projectDraftVerdict(draft({ mode: 'new-folder', path: '/work/fresh', initializeGit: true })).request,
    ).toEqual({ kind: 'new-folder', path: '/work/fresh', initializeGit: true });
    expect(projectDraftVerdict(draft({ mode: 'new-folder', path: '/work/fresh' })).request).toEqual({
      kind: 'new-folder',
      path: '/work/fresh',
      initializeGit: false,
    });
  });

  it('builds the clone arm from a URL and a destination', () => {
    expect(
      projectDraftVerdict(draft({ mode: 'clone', path: '/work/p', url: ' https://github.com/you/p.git ' })).request,
    ).toEqual({ kind: 'clone', url: 'https://github.com/you/p.git', path: '/work/p' });
  });

  it('accepts a file:// clone source, so a local mirror needs no network', () => {
    expect(
      projectDraftVerdict(draft({ mode: 'clone', path: '/work/p', url: 'file:///srv/mirror.git' })).request,
    ).not.toBeNull();
  });

  it('refuses a relative path in every mode, and says why the daemon cannot take it', () => {
    for (const mode of ['existing-folder', 'new-folder', 'clone'] as const) {
      const verdict = projectDraftVerdict(draft({ mode, path: 'work/ferretry', url: 'https://example.test/p.git' }));
      expect(verdict.request).toBeNull();
      expect(verdict.problem).toBe(ABSOLUTE_PATH_REQUIRED);
    }
  });

  it('refuses git’s scp shorthand as a clone address and names the URL form to use', () => {
    const verdict = projectDraftVerdict(draft({ mode: 'clone', path: '/work/p', url: 'git@github.com:you/p.git' }));

    expect(verdict.request).toBeNull();
    expect(verdict.problem).toBe(CLONE_ADDRESS_UNUSABLE);
    expect(CLONE_ADDRESS_UNUSABLE).toContain('ssh://git@host/path');
  });

  it('sends a name-only difference as a real change rather than treating drafts as equal', () => {
    const first = projectDraftVerdict(draft({ path: '/work/p', name: 'One' })).request;
    const second = projectDraftVerdict(draft({ path: '/work/p', name: 'Two' })).request;

    expect(first).not.toEqual(second);
  });
});

describe('confirmDiscoveryRequest', () => {
  it('confirms one path and carries no browser-derived name', () => {
    expect(confirmDiscoveryRequest('/home/k/scratch')).toEqual({
      kind: 'confirmed-discovery',
      path: '/home/k/scratch',
    });
  });

  it('refuses a blank path rather than sending an unnamed confirmation', () => {
    expect(() => confirmDiscoveryRequest('   ')).toThrow();
  });
});

describe('registrationPendingFor', () => {
  const request = { kind: 'confirmed-discovery', path: '/a' } as const;

  it('is true only while THIS path is the one being written', () => {
    expect(registrationPendingFor({ phase: 'submitting', request }, '/a')).toBe(true);
    expect(registrationPendingFor({ phase: 'submitting', request }, '/b')).toBe(false);
    expect(registrationPendingFor(null, '/a')).toBe(false);
  });

  it('is false once the write has settled either way', () => {
    expect(registrationPendingFor({ phase: 'refused', request, message: 'no' }, '/a')).toBe(false);
    expect(
      registrationPendingFor(
        {
          phase: 'registered',
          request,
          project: {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'a',
            path: '/a',
            source: 'confirmed-discovery',
            createdAt: '2026-08-01T10:00:00.000Z',
          },
          alreadyRegistered: false,
        },
        '/a',
      ),
    ).toBe(false);
  });
});

describe('projectSourceLabel', () => {
  it('names every source the protocol can report', () => {
    expect(projectSourceLabel('existing-folder')).toBe('existing folder');
    expect(projectSourceLabel('clone')).toBe('cloned');
    expect(projectSourceLabel('new-folder')).toBe('created here');
    expect(projectSourceLabel('confirmed-discovery')).toBe('confirmed discovery');
  });

  it('answers null for a row that carries no source, rather than guessing one', () => {
    expect(projectSourceLabel(undefined)).toBeNull();
  });
});

describe('the sentences the surface must not paraphrase', () => {
  it('warns about the clone wait before it happens, and admits there is no cancel', () => {
    expect(CLONE_PATIENCE).toContain('minutes');
    expect(CLONE_PATIENCE).toContain('no way to cancel');
  });

  it('states the one-level mkdir limit as a refusal rather than as advice', () => {
    expect(NEW_FOLDER_ONE_LEVEL).toContain('parent must already exist');
    expect(NEW_FOLDER_ONE_LEVEL).toContain('refused, not created');
  });

  it('promises that a discovery is not enrolled until somebody confirms it', () => {
    expect(DISCOVERY_PROMISE).toContain('registers none of them on its own');
  });
});
