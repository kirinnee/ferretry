import type { InstallSeams } from '../lib/host.ts';

/**
 * GAP (kernel ports): a program search of `PATH` has no kernel port yet. Read in this ONE daemon-side file so the
 * finding is here and visible; the home directory comes from `kernel.paths`.
 */
export function processSeams(homeDirectory: string): InstallSeams {
  return { homeDirectory, which: name => Bun.which(name) ?? undefined };
}
