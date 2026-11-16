/**
 * The browser entry for the two cards above the composer: the REAL `PermissionCard` and `DialogCard` over a fixed fake
 * request and a fixed fake dialog, in the chat's own input column, above a stand-in composer box (the composer itself is
 * Conversation's and is not what is looked at here). Nothing reads a network: the client answers from memory. Every name,
 * path and id below is made up.
 *
 * Parameters:
 *
 *   ?card=permission|dialog|both   which card to draw (default both)
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import type { HarnessDialog, PermissionRequest } from '../../../../contract/index.ts';
import { DialogCard, PermissionCard } from '../../../../app/views/prompt-cards.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const card = params.get('card') ?? 'both';

const REQUEST: PermissionRequest = {
  id: '0123456789abcdef',
  harness: 'claude-code',
  tool: 'Bash',
  action: 'run',
  what: 'bun test packages/example/tests/unit',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', kind: 'allow' },
    { number: 2, label: "Yes, and don't ask again for bun test commands in /work/example", kind: 'allow-always' },
    { number: 3, label: 'No', kind: 'deny' },
  ],
  selected: 1,
};

const DIALOG: HarnessDialog = {
  id: 'fedcba9876543210',
  harness: 'claude-code',
  kind: 'directory-trust',
  title: 'Do you trust the files in this folder?',
  body: 'The folder /work/example has not been opened here before.',
  options: [
    { number: 1, label: 'Yes, I trust this folder', grantsTrust: true },
    { number: 2, label: 'No, exit', grantsTrust: false },
  ],
  selected: 2,
};

const client = {
  call: async (
    route: string,
    init?: { readonly body?: { readonly requestId?: string; readonly dialogId?: string } },
  ) => {
    if (route.endsWith('/permission')) return { requestId: init?.body?.requestId ?? '', cleared: true };
    return { dialogId: init?.body?.dialogId ?? '', cleared: true };
  },
  subscribe: () => () => undefined,
} as never;

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="scene-chat">
    <div className="scene-log">
      <p>denisha: I changed the retry flag. Running the unit tests next.</p>
    </div>
    <div className="fy-chat-input" data-safe-bottom="">
      <div className="fy-chat-input__column">
        {card === 'dialog' ? null : (
          <PermissionCard agentName="denisha" client={client} ferret="mvuc7tsf-0c3d50df" request={REQUEST} />
        )}
        {card === 'permission' ? null : (
          <DialogCard agentName="denisha" client={client} dialog={DIALOG} ferret="mvuc7tsf-0c3d50df" />
        )}
        <div className="scene-composer">Message denisha</div>
      </div>
    </div>
  </div>,
);
