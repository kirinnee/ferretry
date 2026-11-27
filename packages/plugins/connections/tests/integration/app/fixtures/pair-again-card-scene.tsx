/** A relay-only machine's Connection card after a long outage: the line and Pair again. Fake data (a made-up machine). */
import { createRoot } from 'react-dom/client';
import { ActiveCarrierCard } from '../../../../app/features/carrier/active-carrier-card.tsx';
import { PAIR_AGAIN_AFTER_MS } from '../../../../app/features/connection/connection-copy.ts';
import { chooseConnection } from '../../../../app/lib/connection.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.style = params.get('style') ?? 'studio';
document.documentElement.dataset.motion = 'reduced';

const choice = chooseConnection([
  { method: { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' }, reachable: true },
]);
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16 }}>
      <ActiveCarrierCard
        choice={choice}
        relayAdvertised
        machine="Studio"
        now={1_000 + PAIR_AGAIN_AFTER_MS}
        onRetry={() => undefined}
        onPairAgain={() => undefined}
        health={{
          kind: 'reconnecting',
          since: 1_000,
          attempt: 62,
          nextAttemptAt: null,
          failures: [{ label: 'Hosted relay', detail: 'the machine is not connected to it (4404)' }],
          cause: 'daemon-unreachable',
          stalled: true,
        }}
      />
    </main>,
  );
