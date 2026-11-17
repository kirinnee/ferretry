/**
 * The browser entry for E9's two visible fixes, over fake data:
 *
 *   ?theme=<family>-<mode>
 *   ?scene=line   the REAL `AgendaLine` pill with the held-replies notice beside it (the chevron must stay whole)
 *   ?scene=held   the REAL `AgendaConfigChange` block of a held config write, with its link to the held text
 */

import { createRoot } from 'react-dom/client';
import { AgendaConfigChange } from '../../../../app/features/agenda/agenda-config-change.tsx';
import { AgendaLine } from '../../../../app/features/agenda/agenda-line.tsx';
import { AgendaRepliesNotice } from '../../../../app/features/agenda/agenda-replies-notice.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const confirms = {
  path: 'warden.yaml',
  etag: 'a'.repeat(64),
  changes: [
    'the Jev price the cap counts with goes down from 2 to 0.042',
    'the Warden may now spend on AI investigations',
  ],
};

function Scene() {
  if (params.get('scene') === 'held')
    return (
      <div style={{ padding: 16 }}>
        <AgendaConfigChange daemonId="studio" item={{ confirms }} />
      </div>
    );
  return (
    <div className="kt-chat-surface" style={{ paddingBlock: 16 }}>
      <AgendaLine
        controls="drawer"
        counts={{ blocking: 2, needYou: 5, withFerret: 2 }}
        ferret="Zoe"
        onToggle={() => undefined}
        open={false}
        repliesSlot={<AgendaRepliesNotice ferret="Zoe" onSendNow={() => undefined} secondsLeft={120} sending={false} />}
        sending={{ count: 0, headings: [] }}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
