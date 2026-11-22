import { MachineNameSchema } from '../contract/kernel.ts';
import type { ConfigPort } from '../contract/ports/config.ts';
import { HostConfigFile } from '../plugin.ts';

/** The name `host.yaml` holds in effect, or undefined when it names none or is not readable (a broken file keeps its last good one). */
function nameInEffect(port: ConfigPort): string | undefined {
  try {
    return port.file(HostConfigFile)?.name;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the name a person typed on the pair screen as this machine's name, and answers the name the machine goes by
 * AFTERWARDS (`current`), whoever put it there.
 *
 * The write is conditional on the file as it is on disk right now: it must be valid (or not there) and name nothing,
 * and the write itself carries that disk's etag, so a file that moved in between (the owner's rename, another
 * pairing's) is a `conflict` and nothing is written. A malformed, held or unreadable file is never replaced: the write
 * is not even tried. Every refusal leaves the owner's file as it was, and the answer is the authoritative current name.
 */
export async function nameUnnamedMachine(
  port: ConfigPort | undefined,
  typed: string,
  current: () => string,
): Promise<string> {
  const name = MachineNameSchema.safeParse(typed);
  if (port === undefined || !name.success) return current();
  const etag = await port.etag(HostConfigFile);
  const { state } = port.fileState(HostConfigFile);
  if ((state === 'valid' || state === 'absent') && nameInEffect(port) === undefined)
    await port.write(HostConfigFile, undefined, { patch: { name: name.data } }, { ifMatch: etag });
  return current();
}
