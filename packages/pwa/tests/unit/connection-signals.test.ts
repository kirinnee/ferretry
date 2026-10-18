import { describe, expect, it } from 'bun:test';
import '../support/dom.ts';
import {
  browserConnectionSignals,
  type ConnectionSignal,
  type ConnectionSignalEnvironment,
  type ConnectionSignalGlobals,
  type ConnectionSignalTargets,
  watchConnectionSignals,
} from '../../src/lib/connection-signals.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';

const laptop = 'daemon-laptop' as DaemonId;
const workstation = 'daemon-workstation' as DaemonId;

const eventTarget = () => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
};

const fakeBrowser = (visibilityState: DocumentVisibilityState = 'visible') => {
  const window = eventTarget();
  const document = Object.assign(eventTarget(), { visibilityState });
  const connection = eventTarget();
  const globals = {
    window,
    document,
    navigator: { connection },
  } as unknown as ConnectionSignalGlobals;
  return { window, document, connection, globals };
};

describe('watchConnectionSignals', () => {
  const harness = (reconnecting: readonly DaemonId[]) => {
    let emit: ((signal: ConnectionSignal) => void) | undefined;
    let stopped = 0;
    const environment: ConnectionSignalEnvironment = {
      listen: listener => {
        emit = listener;
        return () => {
          stopped += 1;
        };
      },
    };
    const events: string[] = [];
    const targets: ConnectionSignalTargets = {
      reconnecting: () => reconnecting,
      retryNow: daemonId => events.push(`retry ${daemonId}`),
      checkLiveness: () => events.push('liveness'),
    };
    return {
      environment,
      targets,
      events,
      emit: (signal: ConnectionSignal) => emit?.(signal),
      stopped: () => stopped,
    };
  };

  it('checks liveness and retries every reconnecting daemon on each signal', () => {
    const h = harness([laptop, workstation]);
    watchConnectionSignals(h.environment, h.targets);
    h.emit('online');
    expect(h.events).toEqual(['liveness', `retry ${laptop}`, `retry ${workstation}`]);
    h.events.length = 0;
    h.emit('visible');
    h.emit('network-change');
    expect(h.events).toEqual([
      'liveness',
      `retry ${laptop}`,
      `retry ${workstation}`,
      'liveness',
      `retry ${laptop}`,
      `retry ${workstation}`,
    ]);
  });

  it('still checks liveness when nothing is reconnecting, and retries nothing', () => {
    const h = harness([]);
    watchConnectionSignals(h.environment, h.targets);
    h.emit('visible');
    expect(h.events).toEqual(['liveness']);
  });

  it('returns how to stop listening', () => {
    const h = harness([laptop]);
    const stop = watchConnectionSignals(h.environment, h.targets);
    expect(h.stopped()).toBe(0);
    stop();
    expect(h.stopped()).toBe(1);
  });
});

describe('browserConnectionSignals', () => {
  it('reports online when the window says the device came back', () => {
    const browser = fakeBrowser();
    const heard: ConnectionSignal[] = [];
    browserConnectionSignals(browser.globals).listen(signal => heard.push(signal));
    browser.window.emit('online');
    expect(heard).toEqual(['online']);
  });

  it('reports visible only when the page came to the foreground', () => {
    const browser = fakeBrowser('hidden');
    const heard: ConnectionSignal[] = [];
    browserConnectionSignals(browser.globals).listen(signal => heard.push(signal));
    browser.document.emit('visibilitychange');
    expect(heard).toEqual([]);
    browser.document.visibilityState = 'visible';
    browser.document.emit('visibilitychange');
    expect(heard).toEqual(['visible']);
    browser.document.visibilityState = 'hidden';
    browser.document.emit('visibilitychange');
    expect(heard).toEqual(['visible']);
  });

  it('reports network-change when navigator.connection changes', () => {
    const browser = fakeBrowser();
    const heard: ConnectionSignal[] = [];
    browserConnectionSignals(browser.globals).listen(signal => heard.push(signal));
    browser.connection.emit('change');
    expect(heard).toEqual(['network-change']);
  });

  it('removes all three listeners when stopped', () => {
    const browser = fakeBrowser();
    const heard: ConnectionSignal[] = [];
    const stop = browserConnectionSignals(browser.globals).listen(signal => heard.push(signal));
    expect(browser.window.count('online')).toBe(1);
    expect(browser.document.count('visibilitychange')).toBe(1);
    expect(browser.connection.count('change')).toBe(1);
    stop();
    expect(browser.window.count('online')).toBe(0);
    expect(browser.document.count('visibilitychange')).toBe(0);
    expect(browser.connection.count('change')).toBe(0);
    browser.window.emit('online');
    browser.document.emit('visibilitychange');
    browser.connection.emit('change');
    expect(heard).toEqual([]);
  });

  it('works in a browser with no navigator.connection', () => {
    const browser = fakeBrowser();
    const globals: ConnectionSignalGlobals = { ...browser.globals, navigator: {} };
    const heard: ConnectionSignal[] = [];
    const stop = browserConnectionSignals(globals).listen(signal => heard.push(signal));
    browser.window.emit('online');
    expect(heard).toEqual(['online']);
    expect(() => stop()).not.toThrow();
  });

  it('works with no globals at all', () => {
    const heard: ConnectionSignal[] = [];
    const stop = browserConnectionSignals({}).listen(signal => heard.push(signal));
    expect(() => stop()).not.toThrow();
    expect(heard).toEqual([]);
  });

  it('listens to the real page when given no globals', () => {
    const heard: ConnectionSignal[] = [];
    const stop = browserConnectionSignals().listen(signal => heard.push(signal));
    try {
      window.dispatchEvent(new Event('online'));
      expect(heard).toEqual(['online']);
    } finally {
      stop();
    }
    window.dispatchEvent(new Event('online'));
    expect(heard).toEqual(['online']);
  });
});
