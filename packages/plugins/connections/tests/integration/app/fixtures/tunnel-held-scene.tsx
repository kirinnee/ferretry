/** One machine's Connection preference after "Turn on" for its tunnel was held for the owner. Fake data (a made-up machine). */
import { createRoot } from 'react-dom/client';
import {
  CarrierPreferenceSelector,
  tunnelSwitchOffer,
} from '../../../../app/features/carrier/carrier-preference-selector.tsx';
import { TUNNEL_OFF_SENTENCE } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-dark';

const off = { enabled: false, explicit: false, state: 'off', tunnelUrl: null, sentence: TUNNEL_OFF_SENTENCE } as const;
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16 }}>
      <CarrierPreferenceSelector
        legend="Connection preference"
        value="tunnel"
        onChange={() => undefined}
        availability={{
          webrtc: true,
          tunnel: tunnelSwitchOffer(
            { kind: 'known', view: off },
            async () => ({ kind: 'held', view: off, sentences: ['the tunnel is turned on'] }),
            async () => ({ kind: 'known', view: off }),
          ),
        }}
      />
    </main>,
  );
