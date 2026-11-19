/**
 * The browser entry for the GitHub accounts screen over FAKE data (no daemon): the REAL surface, read from a scripted client.
 *
 *   ?theme=<family>-<mode>   ?accounts=none|two   ?poll=pending|expired|done   (the clock is pinned at 08:00, 15:00 left)
 */
import { createRoot } from 'react-dom/client';
import { AccountsSurface } from '../../../../app/features/accounts/accounts-surface.tsx';
import { hubot, NOW, octo, scriptedGithub } from '../../../support/scripted-github.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const poll = params.get('poll') ?? 'pending';
const script = scriptedGithub({
  accounts: params.get('accounts') === 'two' ? [octo, hubot] : [],
  polls: [poll === 'expired' ? { status: 'expired' } : { status: 'pending', interval: 1 }],
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-3xl p-4" data-scene-ready="">
      <AccountsSurface client={script.client} pollDelay={() => 300} now={() => NOW} />
    </div>,
  );
