import { describe, expect, it } from 'bun:test';
import { connectorLinkPath } from '../../../../src/features/connector/connector-deep-link.ts';
import { bannerSentence, connectorTargetFromSearch } from '../../../../src/features/connector/connector-model.ts';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';

const records = [{ daemonId: 'alpha' }, { daemonId: 'beta' }] as unknown as readonly DaemonConnectionRecord[];
const nameOf = (record: DaemonConnectionRecord): string => `Machine ${String(record.daemonId)}`;

describe('connector deep link', () => {
  it('reads ?connector=<daemonId>', () => {
    expect(connectorTargetFromSearch('?connector=alpha')).toBe('alpha');
    expect(connectorTargetFromSearch('?x=1&connector=beta')).toBe('beta');
    expect(connectorTargetFromSearch('')).toBeNull();
    expect(connectorTargetFromSearch('?connector=')).toBeNull();
  });

  it('opens that machine’s Connectors panel', () => {
    const path = connectorLinkPath('?connector=beta', records, nameOf);
    expect(path).toBe('/d/beta/settings#machines/Machine%20beta/machine/connector');
  });

  it('does nothing for a machine this browser is not paired with', () => {
    expect(connectorLinkPath('?connector=nope', records, nameOf)).toBeNull();
    expect(connectorLinkPath('?agent=A1', records, nameOf)).toBeNull();
  });

  it('words the banner for one and for several', () => {
    expect(bannerSentence(1, 'Studio')).toBe('Claude wants to connect to Studio.');
    expect(bannerSentence(2, 'Studio')).toBe('2 Claude sign-ins are waiting on Studio.');
  });
});

describe('the exact link the daemon builds', () => {
  it('follows `/?connector=<encoded id>#connector` and the target drops query and hash', () => {
    const encoded = [{ daemonId: 'a b/c' }] as unknown as readonly DaemonConnectionRecord[];
    const search = `?connector=${encodeURIComponent('a b/c')}`;
    const path = connectorLinkPath(search, encoded, nameOf);
    expect(path).not.toBeNull();
    expect(path).not.toContain('?');
    expect(path?.endsWith('/machine/connector')).toBe(true);
  });
});
