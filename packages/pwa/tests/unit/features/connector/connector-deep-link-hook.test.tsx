import '../../../support/dom.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { useConnectorDeepLink } from '../../../../src/features/connector/connector-deep-link.ts';
import type { DaemonConnectionRecord } from '../../../../src/lib/connections.ts';
import { mount } from '../../../support/dom.ts';

const records = [{ daemonId: 'alpha' }, { daemonId: 'beta' }] as unknown as readonly DaemonConnectionRecord[];
const nameOf = (record: DaemonConnectionRecord): string => `Machine ${String(record.daemonId)}`;

interface Move {
  readonly to: string;
  readonly replace: boolean | undefined;
}

function Follower(props: { readonly connections: readonly DaemonConnectionRecord[]; readonly moves: Move[] }): null {
  useConnectorDeepLink(
    props.connections,
    nameOf,
    (to, options) => void props.moves.push({ to, replace: options?.replace }),
  );
  return null;
}

const openAt = (search: string): void => window.history.replaceState({}, '', `/${search}`);

afterEach(() => openAt(''));

describe('useConnectorDeepLink', () => {
  it('opens the named machine’s Connectors panel once, replacing the address', async () => {
    openAt('?connector=beta');
    const moves: Move[] = [];
    const shown = await mount(<Follower connections={records} moves={moves} />);
    expect(moves).toEqual([{ to: '/d/beta/settings#machines/Machine%20beta/machine/connector', replace: true }]);
    // Pairings changing afterwards does not follow the link a second time.
    await shown.render(<Follower connections={[...records]} moves={moves} />);
    expect(moves).toHaveLength(1);
    await shown.unmount();
  });

  it('waits for the pairings to be known before following', async () => {
    openAt('?connector=alpha');
    const moves: Move[] = [];
    const shown = await mount(<Follower connections={[]} moves={moves} />);
    expect(moves).toEqual([]);
    await shown.render(<Follower connections={records} moves={moves} />);
    expect(moves.map(move => move.to)).toEqual(['/d/alpha/settings#machines/Machine%20alpha/machine/connector']);
    await shown.unmount();
  });

  it('does nothing for an address that names no connector, or a machine this browser is not paired with', async () => {
    for (const search of ['', '?connector=stranger']) {
      openAt(search);
      const moves: Move[] = [];
      const shown = await mount(<Follower connections={records} moves={moves} />);
      expect(moves).toEqual([]);
      await shown.unmount();
    }
  });
});
