/** Settings › Warden › "Screens Ferretry clears", over a FIXED FAKE screen (no real pane, ferret or secret). */
import { createRoot } from 'react-dom/client';
import { WardenDialogRulesView } from '../../../../app/features/warden/warden-dialog-rules.tsx';
import { FAKE_PROPOSAL, FAKE_VIEW } from '../../../support/app/dialog-rules.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const held = params.get('state') === 'held';

const noop = (): void => undefined;
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16 }}>
      <WardenDialogRulesView
        view={FAKE_VIEW}
        proposal={
          held
            ? {
                ...FAKE_PROPOSAL,
                rows: FAKE_PROPOSAL.rows.map(row => ({ ...row, pressed: row.number === 1 })),
                rule: undefined,
                held: true,
                note: 'that row grants, trusts or approves something, so it is held: a rule never presses one. Choose a row that declines, or answer it at the terminal.',
              }
            : FAKE_PROPOSAL
        }
        busy={false}
        onLearn={noop}
        onConfirm={noop}
      />
    </main>,
  );
