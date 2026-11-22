/** The buzz policy: a ferret that goes idle with asks waiting is stopped on the owner, and gets one buzz for the stop. */
import { manifestFragment } from '@ferretry/kernel/manifest';
import { AgendaBuzzed } from '../../contract/index.ts';
import { AskAnswered } from '@ferretry/core-asks/contract';
import { FerretChanged } from '@ferretry/core-ferrets/contract';
import { TurnEnded } from '@ferretry/plugin-conversation/contract';

export default manifestFragment({
  hooks: {
    takes: [
      { hook: FerretChanged },
      // A ferret's round ended: the turn-end check reads its last reply (Conversation's `turn.ended`).
      { hook: TurnEnded },
    ],
  },
  data: { publishes: [AgendaBuzzed], subscribes: [AskAnswered] },
});
