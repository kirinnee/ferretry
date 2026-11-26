/**
 * The harnesses an install from a catalog can land in, and what each one reads: the ONE place that says which harnesses
 * Catalogs has a project layout for.
 *
 * Why this file exists (runtimes plan U4b). A catalog item and an install target name a harness by the word a catalog
 * names it (`claude`, `codex`; Runtimes' catalog half). A harness key that reaches Catalogs OPEN has no row here until its
 * layout is known, and it is REFUSED by name ({@link unsupportedInstallHarnessSentence}), never quietly given Claude's
 * folders or Codex's. Every behaviour that differs between the two shipped harnesses is a field of its row, so no consumer
 * compares a harness to a literal. The words on the wire are unchanged: only what derives them moved here.
 *
 * A third harness arrives by adding its row to {@link INSTALL_HARNESSES}.
 */
import { z } from 'zod';

/** What one harness reads from a project, and how it says so. */
export interface InstallHarnessFacts {
  /** What a person reads: "Claude Code". */
  readonly name: string;
  /** The short name for a sentence or a choice: "Claude". */
  readonly short: string;
  /** The harness's plugin key, as a ferret's skills inventory names it. */
  readonly key: string;
  /** The folder in a project whose `skills` folder the harness loads (`.claude`, `.agents`). */
  readonly projectFolder: string;
  /** Whether the harness reads a project's `.mcp.json`. */
  readonly readsProjectMcp: boolean;
  /** Whether a skill installed into the project is active in a ferret that is already running. */
  readonly skillsActiveInRunningFerret: boolean;
}

/** The harnesses Catalogs installs into, by the word a catalog names them (Claude first). The only table. */
const INSTALL_HARNESSES = {
  claude: {
    name: 'Claude Code',
    short: 'Claude',
    key: 'claude-code',
    projectFolder: '.claude',
    readsProjectMcp: true,
    skillsActiveInRunningFerret: true,
  },
  codex: {
    name: 'Codex',
    short: 'Codex',
    key: 'codex',
    projectFolder: '.agents',
    readsProjectMcp: false,
    skillsActiveInRunningFerret: false,
  },
} as const satisfies Readonly<Record<string, InstallHarnessFacts>>;

/** The word of a harness Catalogs installs into: derived from the table, so no second list can drift from it. */
export type InstallHarness = keyof typeof INSTALL_HARNESSES;

/** The words of every harness Catalogs installs into, Claude first. */
export const installHarnesses = (): readonly InstallHarness[] => Object.keys(INSTALL_HARNESSES) as InstallHarness[];

/** Whether Catalogs has a layout for the harness word `word`. */
export const isInstallHarness = (word: string): word is InstallHarness => Object.hasOwn(INSTALL_HARNESSES, word);

/** The harness words on the wire an install target and an item carry (unchanged: `claude` or `codex`). */
export const InstallHarnessSchema = z.enum(Object.keys(INSTALL_HARNESSES) as [InstallHarness, ...InstallHarness[]]);

/** What Catalogs knows of a harness it installs into. Total over {@link InstallHarness}. */
export const installHarnessFacts = (harness: InstallHarness): InstallHarnessFacts => INSTALL_HARNESSES[harness];

/** The install word of a harness plugin key (`claude-code` → `claude`), or `undefined` for a harness Catalogs has no layout for. */
export const installHarnessOfKey = (key: string): InstallHarness | undefined =>
  installHarnesses().find(word => INSTALL_HARNESSES[word].key === key);

/** What a harness is called when an install is refused for it: one sentence, written once. */
export const unsupportedInstallHarnessSentence = (harness: string): string =>
  `${harness} is not a harness a catalog can install into yet`;

/** Thrown where a harness Catalogs has no layout for reaches code that would otherwise have assumed one of the two. */
export class UnsupportedInstallHarnessError extends Error {
  constructor(readonly harness: string) {
    super(unsupportedInstallHarnessSentence(harness));
    this.name = 'UnsupportedInstallHarnessError';
  }
}
