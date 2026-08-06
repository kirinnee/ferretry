import { describe, expect, it } from 'bun:test';
import { useEffect } from 'react';

import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  composeTaskReferenceResolvers,
  createBoardAggregateTaskReferenceResolver,
  createLocalSessionTaskReferenceResolver,
  createTaskReferenceResolver,
  TaskReferenceProvider,
  useTaskReferenceResolver,
} from '../../src/lib/task-reference-context.tsx';
import { render } from '../support/react.ts';

const daemonA = 'daemon-a' as DaemonId;
const daemonB = 'daemon-b' as DaemonId;
const scope = (daemonId: DaemonId = daemonA, sessionId = 'session-1'): DaemonSessionScope => ({
  daemonId,
  sessionId,
});

describe('task reference context', () => {
  it('uses local rows for bare and explicitly-current lookups only', () => {
    const resolve = createLocalSessionTaskReferenceResolver(scope(), [{ id: 'f12' }, { id: 'B9' }]);

    expect(resolve({ form: 'local', id: 'F12' })).toEqual({
      daemonId: daemonA,
      sessionId: 'session-1',
      id: 'F12',
    });
    expect(resolve({ form: 'qualified', id: 'b9', sessionId: 'session-1' })).toEqual({
      daemonId: daemonA,
      sessionId: 'session-1',
      id: 'B9',
    });
    expect(resolve({ form: 'qualified', id: 'F12', sessionId: 'session-2' })).toBeNull();
    expect(resolve({ form: 'local', id: 'I4' })).toBeNull();
  });

  it('makes aggregate rows structurally unable to satisfy a bare lookup', () => {
    const resolve = createBoardAggregateTaskReferenceResolver(daemonA, [
      { sessionId: 'Session_A', id: 'F1' },
      { sessionId: 'session-b', id: 'F1' },
    ]);

    expect(resolve({ form: 'local', id: 'F1' })).toBeNull();
    expect(resolve({ form: 'qualified', id: 'f1', sessionId: 'Session_A' })).toEqual({
      daemonId: daemonA,
      sessionId: 'Session_A',
      id: 'F1',
    });
    expect(resolve({ form: 'qualified', id: 'F1', sessionId: 'session-b' })).toEqual({
      daemonId: daemonA,
      sessionId: 'session-b',
      id: 'F1',
    });
    expect(resolve({ form: 'qualified', id: 'F1', sessionId: 'session_a' })).toBeNull();
  });

  it('composes local/current proof separately from authorized foreign board proof', () => {
    const resolve = createTaskReferenceResolver({
      scope: scope(),
      localTasks: [{ id: 'F12' }],
      boardTasks: [
        { sessionId: 'session-1', id: 'F99' },
        { sessionId: 'session-2', id: 'F12' },
      ],
    });

    expect(resolve({ form: 'local', id: 'F12' })?.sessionId).toBe('session-1');
    expect(resolve({ form: 'local', id: 'F99' })).toBeNull();
    expect(resolve({ form: 'qualified', id: 'F12', sessionId: 'session-1' })?.sessionId).toBe('session-1');
    expect(resolve({ form: 'qualified', id: 'F99', sessionId: 'session-1' })).toBeNull();
    expect(resolve({ form: 'qualified', id: 'F12', sessionId: 'session-2' })?.sessionId).toBe('session-2');
  });

  it('consults exactly one proof source for each lookup form and owner', () => {
    let localCalls = 0;
    let boardCalls = 0;
    const resolve = composeTaskReferenceResolvers(
      scope(),
      lookup => {
        localCalls += 1;
        return { daemonId: daemonA, sessionId: 'session-1', id: lookup.id };
      },
      lookup => {
        boardCalls += 1;
        return {
          daemonId: daemonA,
          sessionId: lookup.form === 'qualified' ? lookup.sessionId : 'wrong-source',
          id: lookup.id,
        };
      },
    );

    expect(resolve({ form: 'local', id: 'F12' })?.sessionId).toBe('session-1');
    expect(resolve({ form: 'qualified', id: 'F12', sessionId: 'session-1' })?.sessionId).toBe('session-1');
    expect(localCalls).toBe(2);
    expect(boardCalls).toBe(0);

    expect(resolve({ form: 'qualified', id: 'F12', sessionId: 'session-2' })?.sessionId).toBe('session-2');
    expect(localCalls).toBe(2);
    expect(boardCalls).toBe(1);
  });

  it('drops qualified foreign proof when aggregate evidence is absent', () => {
    const resolve = createTaskReferenceResolver({ scope: scope(), localTasks: [{ id: 'F12' }] });

    expect(resolve({ form: 'local', id: 'F12' })).not.toBeNull();
    expect(resolve({ form: 'qualified', id: 'F12', sessionId: 'session-2' })).toBeNull();
  });

  it('stamps identical session/task pairs with the daemon that supplied the evidence', () => {
    const a = createTaskReferenceResolver({ scope: scope(daemonA), localTasks: [{ id: 'F12' }] });
    const b = createTaskReferenceResolver({ scope: scope(daemonB), localTasks: [{ id: 'F12' }] });

    expect(a({ form: 'local', id: 'F12' })?.daemonId).toBe(daemonA);
    expect(b({ form: 'local', id: 'F12' })?.daemonId).toBe(daemonB);
  });

  it('makes both host snapshots available to nested Markdown consumers', () => {
    let resolve: ReturnType<typeof useTaskReferenceResolver> | undefined;
    const Probe = (): null => {
      const current = useTaskReferenceResolver();
      useEffect(() => {
        resolve = current;
      }, [current]);
      return null;
    };

    render(
      <TaskReferenceProvider
        boardTasks={[{ sessionId: 'session-2', id: 'C1' }]}
        scope={scope()}
        tasks={[{ id: 'F12' }]}
      >
        <Probe />
      </TaskReferenceProvider>,
    );
    expect(resolve?.({ form: 'local', id: 'F12' })?.sessionId).toBe('session-1');
    expect(resolve?.({ form: 'qualified', id: 'C1', sessionId: 'session-2' })?.sessionId).toBe('session-2');
    expect(resolve?.({ form: 'local', id: 'C1' })).toBeNull();
  });
});
