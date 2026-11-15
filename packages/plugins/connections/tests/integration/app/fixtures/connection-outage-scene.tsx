/** One machine's Connection card in an outage: lost-for time, attempt count, Retry now. Fake data (a made-up machine). */
import { createRoot } from 'react-dom/client';
import { ActiveCarrierCard } from '../../../../app/features/carrier/active-carrier-card.tsx';
import { chooseConnection } from '../../../../app/lib/connection.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const choice = chooseConnection([{ method: { kind: 'direct', daemonUrl: 'https://studio.example' }, reachable: true }]);
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16 }}>
      <ActiveCarrierCard
        choice={choice}
        relayAdvertised
        machine="Studio"
        now={1_000 + 125_000}
        onRetry={() => undefined}
        health={{
          kind: 'reconnecting',
          since: 1_000,
          attempt: 3,
          nextAttemptAt: null,
          failures: [
            { label: 'Direct', detail: 'refused' },
            { label: 'Hosted relay', detail: 'the machine is not connected to it' },
          ],
          cause: 'daemon-unreachable',
          stalled: false,
        }}
      />
    </main>,
  );
