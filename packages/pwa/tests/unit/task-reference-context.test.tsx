import { describe, expect, it } from 'bun:test';
import { useEffect } from 'react';

import {
  createTaskReferenceResolver,
  TaskReferenceProvider,
  useTaskReferenceResolver,
} from '../../src/lib/task-reference-context.tsx';
import { render } from '../support/react.ts';

describe('task reference context', () => {
  it('proves only ids from the supplied daemon-scoped board, case-insensitively', () => {
    const resolve = createTaskReferenceResolver([{ id: 'F12' }, { id: 'B9' }]);
    expect(resolve('f12')).toBeTrue();
    expect(resolve('B9')).toBeTrue();
    expect(resolve('I4')).toBeFalse();
  });

  it('proves the old id of an imported task, and nothing for a card without one', () => {
    const resolve = createTaskReferenceResolver([
      { id: 'F96', legacyId: 'F12' },
      { id: 'F97', legacyId: null },
      { id: 'F98' },
    ]);
    expect(resolve('f12')).toBeTrue();
    expect(resolve('F96')).toBeTrue();
    expect(resolve('F13')).toBeFalse();
  });

  it('proves a card on another project from the machine-wide ids, and still not an unknown one', () => {
    const resolve = createTaskReferenceResolver([{ id: 'F12' }], new Set(['F364', 'B9']));
    expect(resolve('f364')).toBeTrue();
    expect(resolve('B9')).toBeTrue();
    expect(resolve('F12')).toBeTrue();
    expect(resolve('F13')).toBeFalse();
  });

  it('proves from the ids alone, and keeps an old id working beside them', () => {
    const ids = createTaskReferenceResolver(undefined, new Set(['F1']));
    expect(ids('F1')).toBeTrue();
    expect(ids('F2')).toBeFalse();
    const both = createTaskReferenceResolver([{ id: 'F96', legacyId: 'F12' }], new Set(['F1']));
    expect(both('f12')).toBeTrue();
    expect(both('F1')).toBeTrue();
  });

  it('makes the host snapshot available to nested Markdown consumers', () => {
    let resolve: ReturnType<typeof useTaskReferenceResolver> | undefined;
    const Probe = (): null => {
      const current = useTaskReferenceResolver();
      useEffect(() => {
        resolve = current;
      }, [current]);
      return null;
    };

    render(
      <TaskReferenceProvider tasks={[{ id: 'F12' }]}>
        <Probe />
      </TaskReferenceProvider>,
    );
    expect(resolve?.('F12')).toBeTrue();
    expect(resolve?.('C1')).toBeFalse();
  });
});
