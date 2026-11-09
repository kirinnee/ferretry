import type { ConfigPort } from '@ferretry/kernel/contract';

/**
 * The tunnel's on/off setting, written to its own document through the kernel's one config writer. A write that is held
 * or refused throws a sentence: the kernel's own words are kept (a link or a file that is not UTF-8 is said as it is),
 * because "could not be written" alone names no cause.
 */
export async function writeTunnelSetting(
  config: Pick<ConfigPort, 'write'>,
  def: Parameters<ConfigPort['write']>[0],
  enabled: boolean,
): Promise<void> {
  const outcome = await config.write(def, undefined, { patch: { tunnel: { enabled } } });
  if (outcome.kind === 'held')
    throw new Error('turning the tunnel on widens how this daemon is reached: it waits for the owner to confirm');
  if (outcome.kind === 'written') return;
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
