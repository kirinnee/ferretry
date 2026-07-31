import { beforeEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  type DetailsTab,
  readDetailsTab,
  resetDetailsTabMemory,
  touchDetailsTab,
  useDetailsTab,
  writeDetailsTab,
} from '../../src/hooks/use-details-tab.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'a-token' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'b-token' });

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it('keeps hook state scoped to the active daemon and session', () => {
    let setTab: ((tab: DetailsTab) => void) | undefined;
    let tab: DetailsTab | undefined;
    let renderer: ReactTestRenderer | undefined;

    const Probe = ({ daemon, sessionId, open }: { daemon: typeof daemonA; sessionId: string; open: boolean }) => {
      const [currentTab, setCurrentTab] = useDetailsTab(daemon, sessionId, open);
      tab = currentTab;
      setTab = setCurrentTab;
      return null;
    };

    act(() => {
      renderer = create(createElement(Probe, { daemon: daemonA, sessionId: 'same-session', open: true }));
    });
    expect(tab).toBe('identity');

    act(() => setTab?.('budget'));
    expect(tab).toBe('budget');

    act(() => {
      renderer?.update(createElement(Probe, { daemon: daemonB, sessionId: 'same-session', open: true }));
    });
    expect(tab).toBe('identity');

    act(() => renderer?.unmount());
  });
});
