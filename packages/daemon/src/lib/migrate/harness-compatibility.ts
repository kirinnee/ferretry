import { HarnessSchema } from '@ferretry/protocol';

/**
 * Whether a migration may move a session onto a given account.
 *
 * A MIGRATION IS SAME-KIND, and until now only the CLI said so: `fy session migrate` describes itself
 * as continuing a session "on another same-kind fleet account", while the daemon resolved the account
 * the caller named and rebuilt the launch argv from `account.kind` without ever comparing it to the
 * harness the session is running. So the one constraint the product promised was the one nothing
 * checked, and a Claude session could be migrated onto a Codex account or the reverse.
 *
 * WHY IT IS A CORRECTNESS BUG rather than a documentation one. The session keeps its id, its
 * directory, its journal and its whole conversation — that is what a migration is for — and it keeps
 * them across a harness that cannot read them. The transcript is the clearest case: the migrator
 * re-captures provenance for the target precisely because a Codex parser must not be pointed at a
 * Claude record, and the honest result of crossing families is a session whose entire history is
 * unreadable by the harness now answering for it. The turn counter, the open-tool ids the preflight
 * gates on, the resume arguments, the composer quirks and the pane matchers are all per-harness too.
 * Nothing about that is recoverable by trying again, which is why it must be refused before the pane
 * is destroyed rather than reported afterwards.
 *
 * AN UNRECOGNISED KIND IS A REFUSAL, NOT A DEFAULT. Both sides arrive here as strings — the session's
 * recorded harness and the manifest's declared account kind — and this is deliberately not written as
 * `source !== target`, because that comparison calls two values equal when it understands neither. A
 * document written by a future daemon, or a manifest declaring a family this build has never heard of,
 * is exactly the case where "they look the same" is worth nothing: the answer is that this daemon
 * cannot prove the move is safe, so it does not make it.
 */
export interface HarnessMigrationSubject {
  /** The harness family the session is running now, from its own configuration document. */
  readonly sourceHarness: string;
  /** The family the resolved account declares in the fleet manifest. */
  readonly targetHarness: string;
  /** The account the caller named, so the refusal says which account it refused. */
  readonly targetAgent: string;
}

/** The `HarnessSchema` families spelled out, for a refusal that can say what it does understand. */
const KNOWN_HARNESSES = HarnessSchema.options.join(', ');

/**
 * The reason a migration is refused, or `undefined` when the target is the session's own family.
 *
 * A string rather than a thrown error: the taxonomy a refusal is answered in belongs to the mount
 * that owns the route, and this decides only whether there is one.
 */
export function harnessMigrationRefusal(subject: HarnessMigrationSubject): string | undefined {
  const source = HarnessSchema.safeParse(subject.sourceHarness);
  if (!source.success)
    return (
      `this session records harness ${JSON.stringify(subject.sourceHarness)}, which this daemon does not ` +
      `recognise (it knows ${KNOWN_HARNESSES}); a migration must know the family it is moving FROM before it ` +
      'can prove the account it is moving to matches, and it will not destroy a pane to find out'
    );
  const target = HarnessSchema.safeParse(subject.targetHarness);
  if (!target.success)
    return (
      `account ${subject.targetAgent} declares harness ${JSON.stringify(subject.targetHarness)}, which this ` +
      `daemon does not recognise (it knows ${KNOWN_HARNESSES}); it cannot be shown to be the same family as ` +
      `this ${source.data} session, so the migration is refused rather than guessed at`
    );
  if (source.data === target.data) return undefined;
  return (
    `this session runs the ${source.data} harness and ${subject.targetAgent} is a ${target.data} account; a ` +
    'migration continues one conversation under a new account, and the transcript, the turn counter and the ' +
    `open tool calls it carries are all ${source.data}'s — a ${target.data} harness cannot read them. Start a ` +
    `new ${target.data} session instead, or migrate onto a ${source.data} account.`
  );
}
