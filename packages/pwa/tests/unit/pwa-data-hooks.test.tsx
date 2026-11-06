import { describe, expect, it } from 'bun:test';
import {
  useAgendaCount,
  useAgendaItems,
  useAgendaResolutions,
  useAgendaSession,
  useAgendaSnapshot,
} from '../../src/hooks/use-agenda.ts';
import { DaemonAgendaClient } from '../../src/lib/agenda-client.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { render, run } from '../support/react.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const scope = daemonSessionScope(daemon, 'session-a');

const agenda = {
  v: 1 as const,
  sessionId: 'session-a',
  items: [
    {
      id: 'A1',
      source: 'question' as const,
      sourceRef: null,
      subject: 'Question',
      why: 'Decision needed',
      waitingSince: '2026-08-01T00:00:00.000Z',
      howToResolve: 'Answer it',
      raisedBy: 'human' as const,
      raisedBySession: null,
      raisedByName: null,
    },
  ],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function AgendaProbe({ client, currentScope }: { client: DaemonAgendaClient; currentScope: typeof scope | null }) {
  const status = useAgendaSession(client, daemon, currentScope);
  const board = useAgendaSnapshot(client, currentScope);
  const items = useAgendaItems(client, currentScope);
  const resolved = useAgendaResolutions(client, currentScope);
  const count = useAgendaCount(client, daemon, currentScope);
  return <output>{`${status}:${board?.count ?? 0}:${items.length}:${resolved.length}:${count}`}</output>;
}

const output = (renderer: ReturnType<typeof render>): string => renderer.root.findByType('output').children.join('');

describe('daemon-scoped PWA data hooks', () => {
  it('renders full and badge agenda state from one exact scope, including the null-scope fallback', () => {
    const client = new DaemonAgendaClient();
    client.store.applySnapshot(scope, agenda);
    const probe = render(<AgendaProbe client={client} currentScope={scope} />);
    expect(output(probe)).toBe('ready:1:1:0:1');

    run(() => probe.update(<AgendaProbe client={client} currentScope={null} />));
    expect(output(probe)).toBe('idle:0:0:0:0');
  });
});
