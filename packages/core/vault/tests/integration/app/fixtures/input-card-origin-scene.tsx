/**
 * The browser entry for the input card whose form now sends what is typed to another site (E-314), over FAKE data (no
 * daemon, no browser): the REAL `InputCard` over a recording client. The warning is the daemon's amber page risk; its
 * words are pinned by the daemon's own test (`service-replaced-field.test.ts`), so a change there is a change here.
 *
 *   ?theme=<family>-<mode>   ?style=<style id>
 */
import { createRoot } from 'react-dom/client';
import { InputCard } from '../../../../app/features/input/input-card.tsx';
import { pageRequest, recordingClient } from '../../../support/app/input-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.style = params.get('style') ?? 'studio';

const MOVED =
  'The form this field belongs to now sends what you type to another site than when you were asked: do not send unless you meant that.';
const NOW = Date.parse('2026-11-10T00:00:00.000Z');
const request = pageRequest({
  risk: { level: 'red', reason: 'This is a plain value: the ferret can see it as soon as you send it.' },
  risks: [
    { level: 'amber', reason: MOVED },
    {
      level: 'amber',
      reason:
        'The page loaded a new document since you were asked: check the picture, and open the page if you are not sure it is the one you meant.',
    },
  ],
  fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
  expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
});
const { client } = recordingClient(async () => ({}));

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-xl p-4" data-scene-ready="">
      <InputCard client={client as never} now={NOW} onDone={() => undefined} request={request} />
    </div>,
  );
