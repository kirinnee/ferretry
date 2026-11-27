import { describe, expect, it } from 'bun:test';
import { cloneFolderName } from '../../../contract/index.ts';
import {
  createVerdict,
  defaultProjectName,
  emptyCreateDraft,
  projectFolder,
} from '../../../app/features/create-project/create-project-model.ts';

describe('create-project model', () => {
  it('names the folder a clone makes after the repository', () => {
    expect(cloneFolderName('https://github.com/you/project.git')).toBe('project');
    expect(cloneFolderName('https://github.com/you/project/')).toBe('project');
    expect(cloneFolderName('ssh://git@github.com/you/project.git')).toBe('project');
    expect(cloneFolderName('   ')).toBeNull();
    expect(cloneFolderName('.git')).toBeNull();
  });

  it('says nothing about a draft that is merely unfinished', () => {
    expect(createVerdict(emptyCreateDraft)).toEqual({ request: null, problem: null });
    expect(createVerdict({ ...emptyCreateDraft, source: 'clone' })).toEqual({ request: null, problem: null });
  });

  it('turns a chosen folder into an existing-folder request, with the name only when typed', () => {
    const draft = { ...emptyCreateDraft, folder: '/home/k/work/ferretry' };
    expect(createVerdict(draft).request).toEqual({ kind: 'existing-folder', path: '/home/k/work/ferretry' });
    expect(createVerdict({ ...draft, name: '  Ferretry  ' }).request).toEqual({
      kind: 'existing-folder',
      path: '/home/k/work/ferretry',
      name: 'Ferretry',
    });
    expect(defaultProjectName(draft)).toBe('ferretry');
  });

  it('sends a picked path exactly: a folder ending in a space is not its trimmed sibling', () => {
    const draft = { ...emptyCreateDraft, folder: '/home/k/work/notes ' };
    expect(createVerdict(draft).request).toEqual({ kind: 'existing-folder', path: '/home/k/work/notes ' });
    const clone = { ...draft, source: 'clone' as const, url: 'https://github.com/you/project.git' };
    expect(createVerdict({ ...clone, folder: '/home/k/work/ ' }).request).toEqual({
      kind: 'clone',
      url: 'https://github.com/you/project.git',
      path: '/home/k/work/ /project',
    });
  });

  it('clones into a new folder named after the repository, and judges the address by the contract', () => {
    const draft = {
      ...emptyCreateDraft,
      source: 'clone' as const,
      folder: '/home/k/work',
      url: 'https://github.com/you/project.git',
    };
    expect(projectFolder(draft)).toBe('/home/k/work/project');
    expect(createVerdict(draft).request).toEqual({
      kind: 'clone',
      url: 'https://github.com/you/project.git',
      path: '/home/k/work/project',
    });
    expect(createVerdict({ ...draft, url: 'ext::sh -c evil' }).request).toBeNull();
    expect(createVerdict({ ...draft, url: 'ext::sh -c evil' }).problem).not.toBeNull();
    expect(createVerdict({ ...draft, folder: '/' }).request).toEqual({
      kind: 'clone',
      url: 'https://github.com/you/project.git',
      path: '/project',
    });
  });

  it('says why an address that names no repository cannot be cloned', () => {
    const draft = { ...emptyCreateDraft, source: 'clone' as const, folder: '/home/k', url: 'https://github.com/' };
    expect(createVerdict(draft).request).toBeNull();
    expect(createVerdict(draft).problem).toContain('repository');
  });
});
