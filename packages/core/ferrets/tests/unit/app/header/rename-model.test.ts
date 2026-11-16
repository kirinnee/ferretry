import { describe, expect, it } from 'bun:test';
import { renameErrorsFor, renamePatch } from '../../../../app/features/header/rename-model.ts';
import { ferretSummary } from './support.ts';

const source = () => ferretSummary('same-ferret', { name: 'original', title: 'Original Task' });

describe('renamePatch', () => {
  it('normalises changed fields and omits unchanged values', () => {
    expect(renamePatch(source(), ' Original Task ', ' ORIGINAL ')).toEqual({});
    expect(renamePatch(source(), '  Better Task  ', ' New-Name ')).toEqual({
      title: 'Better Task',
      name: 'new-name',
    });
  });

  it('treats a ferret with no task as having an empty one', () => {
    expect(renamePatch(ferretSummary('f', { name: 'hadi' }), '', 'hadi')).toEqual({});
    expect(renamePatch(ferretSummary('f', { name: 'hadi' }), 'A task', 'hadi')).toEqual({ title: 'A task' });
  });

  it('places named daemon failures beside their field and leaves unknown failures at form level', () => {
    expect(renameErrorsFor(new Error('callsign already belongs to a ferret'))).toEqual({
      name: 'callsign already belongs to a ferret',
    });
    expect(renameErrorsFor(new Error('task title is too long'))).toEqual({ title: 'task title is too long' });
    expect(renameErrorsFor('daemon offline')).toEqual({ form: 'daemon offline' });
  });
});
