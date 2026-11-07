import { describe, expect, test } from 'bun:test';
import {
  defineWorkerExtension,
  extensionScope,
  onThisOrigin,
  UNHANDLED_PUSH,
  type WorkerGlobals,
  WorkerExtensionHost,
  type WorkerWindow,
} from '../../../src/worker/extensions.ts';

const ORIGIN = 'https://app.example.test';

function globals(windows: WorkerWindow[] = []) {
  const shown: { title: string; body?: string }[] = [];
  const opened: string[] = [];
  const value: WorkerGlobals = {
    origin: ORIGIN,
    indexedDB: {} as IDBFactory,
    now: () => 7,
    registration: {
      scope: `${ORIGIN}/`,
      showNotification: async (title, options) => void shown.push({ title, ...(options.body ? { body: options.body } : {}) }),
      getNotifications: async () => [],
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async url => void opened.push(url),
    },
  };
  return { value, shown, opened };
}

function window(url: string): WorkerWindow & { navigated: string[]; focused: boolean } {
  const navigated: string[] = [];
  return {
    url,
    focused: false,
    visibilityState: 'visible',
    navigated,
    focus: async () => undefined,
    navigate: async target => void navigated.push(target),
    postMessage: () => {},
  };
}

describe('the worker extension point', () => {
  test('a push goes to each extension in order until one handles it', async () => {
    const seen: string[] = [];
    const host = new WorkerExtensionHost([
      defineWorkerExtension({ id: 'access', push: () => (seen.push('access'), false) }),
      defineWorkerExtension({
        id: 'agenda',
        push: async (push, scope) => {
          seen.push('agenda');
          await scope.showNotification('Agenda', { body: String((push.payload as { title: string }).title) });
          return true;
        },
      }),
      defineWorkerExtension({ id: 'board', push: () => (seen.push('board'), true) }),
    ]);
    const g = globals();
    await host.push({ payload: { title: 'Card moved' } }, extensionScope(g.value));
    expect(seen).toEqual(['access', 'agenda']);
    expect(g.shown).toEqual([{ title: 'Agenda', body: 'Card moved' }]);
  });

  test('a push nobody handles, or whose handler throws, still shows something (a silent push gets revoked)', async () => {
    const host = new WorkerExtensionHost([
      defineWorkerExtension({
        id: 'agenda',
        push: () => {
          throw new Error('bad payload');
        },
      }),
    ]);
    const g = globals();
    await host.push({ payload: null }, extensionScope(g.value));
    expect(g.shown).toEqual([{ title: UNHANDLED_PUSH.title, body: UNHANDLED_PUSH.body }]);
  });

  test('one extension per plugin: a second with the same id is dropped', () => {
    const host = new WorkerExtensionHost([
      defineWorkerExtension({ id: 'agenda' }),
      defineWorkerExtension({ id: 'agenda' }),
      defineWorkerExtension({ id: 'access' }),
    ]);
    expect(host.ids).toEqual(['agenda', 'access']);
  });

  test('an extension opens and navigates to this origin only', async () => {
    const open = window(`${ORIGIN}/app/`);
    const foreign = window('https://elsewhere.example.test/');
    const g = globals([open, foreign]);
    const scope = extensionScope(g.value);
    await scope.openWindow('https://evil.example.test/phish');
    await scope.openWindow('/app/d/one/agenda');
    expect(g.opened).toEqual([`${ORIGIN}/app/d/one/agenda`]);
    const windows = await scope.windows();
    expect(windows.map(w => w.url)).toEqual([`${ORIGIN}/app/`]);
    await windows[0]?.navigate('javascript:alert(1)');
    await windows[0]?.navigate('/app/board');
    expect(open.navigated).toEqual([`${ORIGIN}/app/board`]);
  });

  test('a tap nobody claims opens the app itself, never what the notification named', async () => {
    const host = new WorkerExtensionHost([]);
    const g = globals();
    await host.notificationClick({ tag: 't', data: { url: 'https://evil.example.test/' }, action: '' }, extensionScope(g.value));
    expect(g.opened).toEqual([`${ORIGIN}/app/`]);
  });

  test('the scope carries no fetch, caches or registration control', () => {
    const scope = extensionScope(globals().value) as unknown as Record<string, unknown>;
    for (const name of ['fetch', 'caches', 'skipWaiting', 'update', 'unregister', 'registration', 'clients']) {
      expect(scope[name]).toBeUndefined();
    }
    expect(Object.isFrozen(scope)).toBe(true);
    expect(onThisOrigin('//evil.example.test/x', ORIGIN)).toBeUndefined();
  });
});
