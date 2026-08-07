import { ACTOR_AUTHORITY_SPLIT_SEMANTICS, type TaskActivity } from '@ferretry/protocol';

/**
 * Marking the completion attestations that were written while the daemon could not tell a human
 * from an authorized agent.
 *
 * A shared-board `mark_done` grant used to satisfy the human predicate outright, so a peer's
 * `live → done` was journalled as `verifiedByHuman` and a peer's advance out of research or design
 * as `approvedByHuman`. Those records are already written, on real boards, and they claim something
 * nobody established.
 *
 * WHY A STAMP AND NOT A DATE. The obvious classifier — "written before the fix landed" — cannot be
 * written down, because the instant the fix reaches a given daemon is not knowable when the code is
 * authored. Old code keeps running until its host is upgraded, so any date chosen in advance is a
 * date the old code writes conflated records AFTER, and every one of those would read as trustworthy.
 * That is fail-OPEN, and on the one question this exists to answer.
 *
 * So the direction is inverted. Code that keeps normalized API actor classification and authority
 * apart stamps every attestation it writes with {@link ACTOR_AUTHORITY_SPLIT_SEMANTICS}; absence of
 * that stamp is the classifier. The stamp attests to that code-path separation, not to a
 * cryptographically authenticated human principal. A record is trustworthy only on POSITIVE
 * evidence it was written under the split, never on the absence of evidence that it was not — so a
 * conflated record written a year from now by an un-upgraded host is still marked, and no clock has
 * to be right.
 *
 * WHY THIS IS A READ AND NOT A REWRITE. The stored bytes are evidence, and a repair that edited them
 * would replace one unfounded claim with another — this cannot recover which attestations were
 * genuine, only that it cannot know. So nothing on disk changes and nothing is reclassified as human
 * or agent: every affected entry is handed to its reader carrying an explicit marker, and the reader
 * decides. An entry's `actor` was always recorded honestly and stays the one fact that distinguishes
 * a peer from an operator.
 *
 * A doc note would not have done this. A reader that never opens the doc still learns the damage,
 * because it arrives attached to the entry.
 */

/**
 * When the identity/authority split landed, carried on the marker for a reader's orientation.
 *
 * DOCUMENTATION, NOT THE CLASSIFIER. Nothing compares an entry's `time` against this — see above for
 * why that comparison cannot be sound. It is here because a reader that meets a marked entry deserves
 * to know when the defect was fixed, and because Hadi asked the marker to be dated.
 */
export const ACTOR_AUTHORITY_SPLIT_LANDED_AT = '2026-08-06T00:00:00.000Z';

/** Whether this entry claims a human attestation the pre-split code could have written falsely. */
const claimsHumanAttestation = (activity: TaskActivity): boolean => {
  if (activity.type !== 'status') return false;
  const data = activity.data;
  return data.verifiedByHuman === true || data.approvedByHuman === true;
};

/** Whether the writer positively declared it kept identity and authority apart. */
const writtenUnderTheSplit = (activity: TaskActivity): boolean =>
  activity.type === 'status' && activity.data.attestationSemantics === ACTOR_AUTHORITY_SPLIT_SEMANTICS;

/**
 * Attaches the legacy marker to every human attestation lacking the positive stamp, and to nothing
 * else.
 *
 * Pure and idempotent: it derives the marker from the entry each time rather than persisting it, so
 * a record can never acquire the marker in storage and then keep it after the reason is gone.
 */
export const markLegacyAttestations = (activity: readonly TaskActivity[]): readonly TaskActivity[] =>
  activity.map(entry =>
    claimsHumanAttestation(entry) && !writtenUnderTheSplit(entry)
      ? {
          ...entry,
          data: {
            ...entry.data,
            legacyAttestation: {
              reason: 'predates-actor-authority-split' as const,
              splitLandedAt: ACTOR_AUTHORITY_SPLIT_LANDED_AT,
            },
          },
        }
      : entry,
  ) as readonly TaskActivity[];
