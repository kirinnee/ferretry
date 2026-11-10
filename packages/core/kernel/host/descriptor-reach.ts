import type { HostFs } from './adapters/node-fs.ts';
import type { DoctorLine } from './host.ts';

/**
 * The ONE doctor line for a host that cannot hold every folder it reads by descriptor (boot asks once, never per call):
 * the `imports` root (a project's skills folder and `.mcp.json`) reads by descriptor where it can, and where it cannot it
 * keeps the by-path read behind the link walk, because refusing would stop a read that works today. The line names what
 * the host lacks and the consequence; `undefined` when the host reaches everything (or is not the real disk, which does
 * not say).
 */
export async function descriptorReachNote(fs: HostFs): Promise<DoctorLine | undefined> {
  const reach = await fs.descriptorReach?.().catch(() => undefined);
  if (reach === undefined || reach.path) return undefined;
  const consequence =
    "a folder swapped for a link in the instant between the link check and the look can let one listing or stat show the outside folder's names and sizes " +
    "(no file's text is read through it, nothing is written through it, and a swap between two calls is refused at the next one)";
  if (!reach.calls)
    return {
      plugin: 'kernel',
      state: 'warn',
      detail:
        "This host reaches an open folder by neither /proc/self/fd nor the C library's descriptor calls (they could not " +
        `be loaded), so a project's skills folder and .mcp.json are read by path after the link check: ${consequence}.`,
      fix: 'Nothing is needed for ordinary use; run the daemon where the C library loads to read them by descriptor.',
    };
  if (!reach.bracket)
    return {
      plugin: 'kernel',
      state: 'warn',
      detail:
        "This host loaded the C library's descriptor calls but not the working-directory bracket, so a project's skills " +
        `folder is listed by path once the folder is proven (reads and stats still go by descriptor): ${consequence}.`,
      fix: 'Nothing is needed for ordinary use; run the daemon where the bracket loads to list them by descriptor.',
    };
  return undefined;
}
