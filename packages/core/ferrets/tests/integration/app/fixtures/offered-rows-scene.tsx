/**
 * The browser entry for "the Actions menu's offered rows": the REAL `ActionsMenu`, with the rows other plugins offer
 * (`ferrets.actions-row`) turned into menu entries by the REAL `contributionOf`. Fake data, no daemon.
 *
 *   ?theme=<family>-<mode>
 *   ?compact=1   the phone layout
 *   ?move=1      Relocate's row, "Move to another machine…", in the Move group, as the menu draws it
 */

import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { createRoot } from 'react-dom/client';
import { ActionsMenu } from '../../../../app/features/header/actions-menu.tsx';
import { contributionOf } from '../../../../app/features/header/offered-rows.ts';
import { ferretActionSections } from '../../../../app/features/header/registry.ts';
import '../../../../app/features/header/ferret-actions.css';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const run = (id: string, label: string, group: ActionsRowOffer['group'], order: number): ActionsRowOffer => ({
  kind: 'run',
  id,
  label,
  group,
  order,
  run: () => undefined,
});
const confirm = (id: string, label: string, order: number): ActionsRowOffer => ({
  kind: 'confirm',
  id,
  label,
  group: 'ferret',
  order,
  danger: true,
  question: `${label}?`,
  consequence: 'It stops what it is doing.',
  confirmLabel: label,
  run: () => undefined,
});

const OFFERS: readonly ActionsRowOffer[] = [
  confirm('interrupt-turn', 'Interrupt', 10),
  run('add-skills', 'Add skills…', 'ferret', 20),
  run('add-mcp', 'Add MCP server…', 'ferret', 30),
  run('warden-investigate', 'Ask the Warden…', 'ferret', 40),
  run('open-queue', 'Open the queue', 'ferret', 50),
  run('clear-stuck-messages', 'Clear stuck messages', 'ferret', 60),
  run('dismiss-cancelled-messages', 'Dismiss cancelled messages', 'ferret', 70),
  run('something-new', 'A row the menu has not heard of', 'ferret', 80),
];

const offers =
  params.get('move') === '1' ? [...OFFERS, run('move-machine', 'Move to another machine…', 'move', 30)] : OFFERS;
const sections = ferretActionSections(offers.map(contributionOf), {} as never);

function Scene() {
  return (
    <div style={{ padding: 16, display: 'flex', justifyContent: 'flex-end' }}>
      <ActionsMenu
        compact={params.get('compact') === '1'}
        form={null}
        name="Zoe"
        onFormChange={() => undefined}
        sections={sections}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
