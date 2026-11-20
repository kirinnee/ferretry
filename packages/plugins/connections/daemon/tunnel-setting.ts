import type { ConfigPort } from '@ferretry/kernel/contract';

/** What writing the tunnel setting came to: in the document, or held for the owner (not a failure). */
export type TunnelSettingWrite =
  | { readonly kind: 'written' }
  | { readonly kind: 'held'; readonly sentences: readonly string[] };

/**
 * The tunnel's on/off setting, written to its own document through the kernel's one config writer. Turning the tunnel
 * ON loosens how this machine is reached, so that write is HELD for the owner: the document keeps the earlier version in
 * effect until it is confirmed. A held write is an answer, not a failure, so it is returned with the kernel's own
 * sentences. A refused write throws a sentence: the kernel's own words are kept (a link or a file that is not UTF-8 is
 * said as it is), because "could not be written" alone names no cause.
 */
export async function writeTunnelSetting(
  config: Pick<ConfigPort, 'writeAsOwner'>,
  def: Parameters<ConfigPort['write']>[0],
  enabled: boolean,
): Promise<TunnelSettingWrite> {
  // The owner's patch: made to both versions of a file with an edit held, so switching the tunnel never puts another
  // caller's held edit of this file into effect (docs/config-files.md rule 3).
  const outcome = await config.writeAsOwner(def, undefined, { patch: { tunnel: { enabled } } });
  if (outcome.kind === 'held') return { kind: 'held', sentences: outcome.sentences };
  if (outcome.kind === 'written') return { kind: 'written' };
  const said =
    outcome.kind === 'refused'
      ? outcome.issues.map(issue =>
          issue.fix === undefined || issue.fix === '' ? issue.message : `${issue.message}: ${issue.fix}`,
        )
      : [];
  throw new Error(
    said.length === 0
      ? 'the tunnel setting could not be written to its document'
      : `the tunnel setting could not be written to its document: ${said.join('; ')}`,
  );
}
