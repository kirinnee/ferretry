import type { ResumeActor } from './types.ts';

/** What a resume does about a session a person cut off (`fy session revoke-credential`). */
export type CutOffResume = 'proceed' | 'restore' | 'refuse';

/**
 * A cut-off session comes back only when a PERSON resumes it: that resume clears the mark (`restore`), so its
 * relaunch rotates a credential. A peer, the Warden or the daemon's own revive is refused (`refuse`) before anything
 * is touched. A session nobody cut off resumes as it always did (`proceed`).
 */
export function cutOffResume(cutOff: boolean, actor: ResumeActor): CutOffResume {
  if (!cutOff) return 'proceed';
  return actor === 'admin-cli' || actor === 'admin-ui' ? 'restore' : 'refuse';
}
