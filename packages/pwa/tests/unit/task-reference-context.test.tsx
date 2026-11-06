import { describe, expect, it } from 'bun:test';

import { createTaskReferenceResolver } from '../../src/lib/task-reference-context.tsx';

describe('task reference context', () => {
  it('proves only ids from the supplied daemon-scoped board, case-insensitively', () => {
    const resolve = createTaskReferenceResolver([{ id: 'F12' }, { id: 'B9' }]);
    expect(resolve('f12')).toBeTrue();
    expect(resolve('B9')).toBeTrue();
    expect(resolve('I4')).toBeFalse();
  });

  it('proves a card by its own id only, so an id from an old transcript stays plain text', () => {
    const resolve = createTaskReferenceResolver([{ id: 'F96' }, { id: 'F97' }]);
    expect(resolve('F96')).toBeTrue();
    expect(resolve('F12')).toBeFalse();
  });

  it('proves a card on another project from the machine-wide ids, and still not an unknown one', () => {
    const resolve = createTaskReferenceResolver([{ id: 'F12' }], new Set(['F364', 'B9']));
    expect(resolve('f364')).toBeTrue();
    expect(resolve('B9')).toBeTrue();
    expect(resolve('F12')).toBeTrue();
    expect(resolve('F13')).toBeFalse();
  });

  it('proves from the ids alone, and from the slice beside them', () => {
    const ids = createTaskReferenceResolver(undefined, new Set(['F1']));
    expect(ids('F1')).toBeTrue();
    expect(ids('F2')).toBeFalse();
    const both = createTaskReferenceResolver([{ id: 'F96' }], new Set(['F1']));
    expect(both('f96')).toBeTrue();
    expect(both('F1')).toBeTrue();
  });
});
