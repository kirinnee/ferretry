import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type DetailsTab,
  readDetailsTab,
  resetDetailsTabMemory,
  touchDetailsTab,
  writeDetailsTab,
} from '../../src/hooks/use-details-tab.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b-token' });

describe('details-tab memory', () => {
  beforeEach(() => resetDetailsTabMemory());

  it('defaults an unseen daemon/session pair to identity without creating an entry', () => {
    const memory = new Map<string, DetailsTab>();
    const scope = daemonSessionScope(daemonA, 'session-a');

    expect(readDetailsTab(memory, scope)).toBe('identity');
    touchDetailsTab(memory, scope);
    expect(memory.size).toBe(0);
  });

  it('keeps matching session IDs isolated between daemons', () => {
    const memory = new Map<string, DetailsTab>();
    const a = daemonSessionScope(daemonA, 'same-session');
    const b = daemonSessionScope(daemonB, 'same-session');

    writeDetailsTab(memory, a, 'budget');

    expect(readDetailsTab(memory, a)).toBe('budget');
    expect(readDetailsTab(memory, b)).toBe('identity');
  });

  it('touches recency so a chosen tab survives an LRU eviction', () => {
    const memory = new Map<string, DetailsTab>();
    const first = daemonSessionScope(daemonA, 'first');
    const second = daemonSessionScope(daemonA, 'second');
    writeDetailsTab(memory, first, 'runtime', 2);
    writeDetailsTab(memory, second, 'progress', 2);

    touchDetailsTab(memory, first);
    writeDetailsTab(memory, daemonSessionScope(daemonA, 'third'), 'budget', 2);

    expect(readDetailsTab(memory, first)).toBe('runtime');
    expect(readDetailsTab(memory, second)).toBe('identity');
  });
});
