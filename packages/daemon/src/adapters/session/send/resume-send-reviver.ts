import type { SessionId } from '../../../lib/session-id.ts';
import type { SessionResumeService } from '../../../lib/session/resume/service.ts';
import { ResumeRefused, ReviveDedupeConflict } from '../../../lib/session/resume/types.ts';
import { ReviveRefusedForSend, type SendReviver } from '../../../lib/session/send/types.ts';

/**
 * The revive a send falls back to when there is no live agent to type into.
 *
 * ONE RESUME SERVICE, not a second one built for this caller. Its per-session executor and its launch
 * gate are what stop two relaunches of one session racing, and a private copy would give the send
 * path its own idea of both — so a send-triggered revive and an operator's revive could replace the
 * same pane at the same moment.
 *
 * THE ACTOR IS `peer`, which is a policy decision rather than a label. A send is somebody asking for
 * this specific session by name, so it must not be suppressed by the duplicate-work heuristic that
 * exists for AUTOMATIC recovery: that heuristic looks at a batch label and a checkout, and two
 * teammates sharing a label can be doing entirely unrelated work.
 *
 * A REFUSAL IS TRANSLATED, NOT SWALLOWED. `ResumeRefused` means the relaunch was declined on policy,
 * which the send domain answers by holding the message durably — so it is restated in that domain's
 * own vocabulary. Anything else is a genuine failure and travels unchanged.
 */
export class ResumeSendReviver implements SendReviver {
  constructor(private readonly resume: SessionResumeService) {}

  async revive(id: SessionId, message: string): Promise<void> {
    try {
      await this.resume.resume({ id, message, actor: 'peer' });
    } catch (error) {
      if (error instanceof ReviveDedupeConflict) throw new ReviveRefusedForSend(error.message, error.conflict.id);
      if (error instanceof ResumeRefused) throw new ReviveRefusedForSend(error.message);
      throw error;
    }
  }
}
