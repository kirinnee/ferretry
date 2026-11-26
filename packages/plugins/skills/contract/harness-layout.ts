/**
 * How each harness lays out and invokes skills, and the ONE place that says which harnesses Skills has a layout for.
 *
 * Why this file exists (runtimes plan U4b). A harness key reaches Skills OPEN (`HarnessKey`); this file is the door. A key
 * with no row here is REFUSED by name ({@link UnsupportedSkillsHarnessError}) or listed as unusable, and is never quietly
 * handed Claude's folders, Claude's `/name` or Claude's scope rules. Every behaviour that differs between the two shipped
 * harnesses is a field of the row, so a consumer reads {@link skillsLayout} and never compares a harness to a literal.
 *
 * A third harness arrives by adding its row to {@link LAYOUTS}; the compiler then lists nothing else to edit, and a
 * harness without a row stays refused everywhere.
 */
import { z } from 'zod';

/** What one harness does with skills. */
export interface SkillsLayout {
  /** The folder in a project that holds the skills it loads (`.claude`, `.agents`): the skills sit in `<folder>/skills`. */
  readonly projectFolder: string;
  /** What a person types to invoke one: `/` before the name for Claude, `$` for Codex (Codex uses `/skills` to browse). */
  readonly invocationPrefix: string;
  /** The one-line reminder of which harness a reader inserts for ("Claude · inserts /name"). */
  readonly label: string;
  /** Whether a skill in the harness's home hides a project skill of the same name. */
  readonly homeShadowsProject: boolean;
  /** Why a skill cannot be switched off from here. */
  readonly toggleReason: string;
}

/** The harnesses Skills has a layout for, by plugin key (Claude Code first). The only table: its rows are the ones Skills can read. */
const LAYOUTS = {
  'claude-code': {
    projectFolder: '.claude',
    invocationPrefix: '/',
    label: 'Claude · inserts /name',
    // INFERRED, not verified against a running harness: Claude documents personal skills overriding project skills.
    homeShadowsProject: true,
    toggleReason: 'Claude has no per-skill switch Ferretry can verify',
  },
  codex: {
    projectFolder: '.agents',
    invocationPrefix: '$',
    label: 'Codex · inserts $name',
    // Codex lists skills of the same name from both scopes without merging them, so nothing shadows anything.
    homeShadowsProject: false,
    toggleReason: "Codex's skills.config switch lives in config.toml, which Ferretry regenerates on every apply",
  },
} as const satisfies Readonly<Record<string, SkillsLayout>>;

/** The key of a harness Skills has a layout for: derived from the table, so no second list can drift from it. */
export type SkillsHarnessKey = keyof typeof LAYOUTS;

/** The keys of the harnesses Skills has a layout for, in the order it lists them. */
export const skillsHarnessKeys = (): readonly SkillsHarnessKey[] => Object.keys(LAYOUTS) as SkillsHarnessKey[];

/** Whether Skills has a layout for the harness `key`: the entry check where an open key meets Skills' typed code. */
export const isSkillsHarnessKey = (key: string): key is SkillsHarnessKey => Object.hasOwn(LAYOUTS, key);

/**
 * A harness a wire document names, as Skills reads it. Any key but the ones in the table is refused where the document is
 * parsed, so a skill listing never carries a harness whose folders and invocation Skills does not know.
 */
export const SkillsHarnessKeySchema = z.enum(Object.keys(LAYOUTS) as [SkillsHarnessKey, ...SkillsHarnessKey[]]);

/** The layout of a harness Skills has one for. Total over {@link SkillsHarnessKey}. */
export const skillsLayout = (key: SkillsHarnessKey): SkillsLayout => LAYOUTS[key];

/** What a harness is called when Skills refuses it: one sentence. */
export const unsupportedSkillsHarnessSentence = (harness: string): string =>
  `${harness} is not supported by Skills yet: it has no skills layout for it`;

/** Thrown where a harness Skills has no layout for reaches code that would otherwise have assumed one of the two. */
export class UnsupportedSkillsHarnessError extends Error {
  constructor(readonly harness: string) {
    super(unsupportedSkillsHarnessSentence(harness));
    this.name = 'UnsupportedSkillsHarnessError';
  }
}

/** The key of a harness Skills has a layout for; refuses any other by name. */
export const skillsHarnessOf = (harness: string): SkillsHarnessKey => {
  if (!isSkillsHarnessKey(harness)) throw new UnsupportedSkillsHarnessError(harness);
  return harness;
};
