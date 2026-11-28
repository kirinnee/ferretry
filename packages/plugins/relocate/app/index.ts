import { implementApp, type PanelProps } from '@ferretry/kernel/manifest';
import { createElement } from 'react';
import manifest from '../manifest.ts';
import { MovedMark } from './features/moved-mark.tsx';
import { createMovedStore } from './lib/moved-store.ts';
import { createMoveMachineRowPanel } from './slots/move-machine-row.tsx';

/**
 * Relocate (app half): "Move to another machine…" in a ferret's Actions menu, where another machine is paired, the move
 * itself (a dialog: pick, review, move, open), and "Moved to <machine>" on the stub a move leaves in the fleet list. The
 * app holds a session on both machines and carries ciphertext between them; this half never holds a key or a secret.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const store = createMovedStore(client);
    return {
      panels: {
        'move-machine-row': createMoveMachineRowPanel(client, store),
        // `props` are Ferrets' (`ferrets.list-row-mark`): narrowed here, a row that hands none draws nothing.
        'moved-mark': (props: PanelProps & { readonly ferret?: string }) =>
          typeof props.ferret === 'string' ? createElement(MovedMark, { store, ferret: props.ferret }) : null,
      },
    };
  },
});
