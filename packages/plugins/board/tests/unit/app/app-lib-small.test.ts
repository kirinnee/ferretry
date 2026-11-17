import { afterEach, describe, expect, it } from 'bun:test';

import { displayCallsign } from '../../../app/lib/callsign.ts';
import { type DaemonId, THIS_MACHINE, pairingKey } from '../../../app/lib/machine.ts';
import { navigateTo } from '../../../app/lib/navigate.ts';
import { agendaAskPath, boardTaskPath, taskPagePath, ferretPath, projectLanesPath } from '../../../app/lib/paths.ts';
import { plainPreview } from '../../../app/lib/plain-label.ts';
import { compareReleaseVersions } from '../../../app/lib/release-order.ts';

const KEYS = ['history', 'dispatchEvent', 'PopStateEvent', 'CustomEvent', 'location'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const key of KEYS) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));

const setBrowser = (key: (typeof KEYS)[number], value: unknown): void => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};

afterEach(() => {
  for (const key of KEYS) {
    const descriptor = saved.get(key);
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

describe('displayCallsign', () => {
  it('keeps the prefix and uppercases the hex digits of a callsign Ferretry gave a ferret', () => {
    expect(displayCallsign('warden-00002a')).toBe('warden-00002A');
  });

  it('title-cases a stored callsign and treats an all-zero system callsign as a plain one', () => {
    expect(displayCallsign('ms-98')).toBe('Ms-98');
    expect(displayCallsign('warden-000000')).toBe('Warden-000000');
    expect(displayCallsign('  ')).toBe('');
    expect(displayCallsign(null)).toBe('');
    expect(displayCallsign('a--b')).toBe('A--B');
  });
});

describe('machine', () => {
  it('keys a set of machines by their sorted ids', () => {
    const b = { daemonId: 'b' as DaemonId };
    expect(pairingKey([b, THIS_MACHINE])).toBe('b\u0000this');
  });
});

describe('navigateTo', () => {
  it('pushes the address and tells the router the location moved', () => {
    const pushed: string[] = [];
    const events: string[] = [];
    class FakePopStateEvent {
      constructor(readonly type: string) {}
    }
    setBrowser('history', { pushState: (_state: unknown, _title: string, url: string) => pushed.push(url) });
    setBrowser('PopStateEvent', FakePopStateEvent);
    setBrowser('dispatchEvent', (event: FakePopStateEvent) => {
      events.push(event.type);
      return true;
    });
    navigateTo('/d/x/board');
    expect(pushed).toEqual(['/d/x/board']);
    expect(events).toEqual(['popstate']);
  });

  it('does nothing without a history or a popstate event', () => {
    setBrowser('history', undefined);
    setBrowser('PopStateEvent', undefined);
    setBrowser('dispatchEvent', undefined);
    expect(navigateTo('/d/x/board')).toBeUndefined();
  });
});

describe('ferretPath', () => {
  it('is the chat of a ferret under the daemon the address bar is under', () => {
    setBrowser('location', { pathname: '/d/box/board' });
    expect(ferretPath(undefined, 'ms 98')).toBe('/d/box/ferrets/ms%2098/chat');
  });
});

describe('agendaAskPath', () => {
  it('opens one ask at its ferret agenda, under the named machine or else the one the address bar is under', () => {
    setBrowser('location', { pathname: '/d/box/board' });
    expect(agendaAskPath('ms 98', 'A 1')).toBe('/d/box/agenda/ms%2098/A%201');
    expect(agendaAskPath('ms98', 'A1', 'other')).toBe('/d/other/agenda/ms98/A1');
  });
});

describe('card and lanes paths', () => {
  it('open a card on the board, a card on its own page, and a project lanes editor', () => {
    setBrowser('location', { pathname: '/d/box/board' });
    expect(boardTaskPath(undefined, 'F 12')).toBe('/d/box/board/F%2012');
    expect(taskPagePath('F 12')).toBe('/d/box/task/F%2012');
    expect(taskPagePath('F12', 'other')).toBe('/d/other/task/F12');
    expect(projectLanesPath('p 1')).toBe('/d/box/board/p%201?lanes=1');
    expect(projectLanesPath('p1', 'other')).toBe('/d/other/board/p1?lanes=1');
  });
});

describe('plainPreview', () => {
  it('keeps the lines inside a fenced block and drops the fence marks', () => {
    expect(plainPreview('before\n```ts\n  const a = 1;\n```\nafter')).toBe('before const a = 1; after');
  });

  it('drops a table rule line and flattens the rest', () => {
    expect(plainPreview('| a | b |\n| - | - |\n| 1 | 2 |')).toBe('a b 1 2');
  });
});

describe('compareReleaseVersions', () => {
  it('is undefined when either side is not a release version', () => {
    expect(compareReleaseVersions('nope', '1.0.0')).toBeUndefined();
    expect(compareReleaseVersions('1.0.0', 'nope')).toBeUndefined();
  });

  it('orders the core numbers first', () => {
    expect(compareReleaseVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareReleaseVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareReleaseVersions('1.2.3', '1.10.0')).toBe(-1);
  });

  it('puts a prerelease before its release', () => {
    expect(compareReleaseVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareReleaseVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareReleaseVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('orders prerelease parts: numeric by value, numeric before text, text by text, shorter first', () => {
    expect(compareReleaseVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareReleaseVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareReleaseVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareReleaseVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareReleaseVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareReleaseVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1);
    expect(compareReleaseVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareReleaseVersions('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
  });
});
