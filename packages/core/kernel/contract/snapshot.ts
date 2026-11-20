import type { PluginId } from './ids.ts';

/** A glossary entry (§1.3): one meaning per word; owned once (`words` check). */
export interface Word {
  readonly word: string;
  readonly means: string;
  readonly insteadOf?: readonly string[];
}

/** Who an instruction is for. */
export interface InstructionWhen {
  readonly role?: 'any' | 'lead' | 'helper';
  readonly harness?: string;
}

export interface InstructionEntry {
  readonly plugin: PluginId;
  readonly id: string;
  /** Markdown text, already read from the plugin's `instructions/<file>.md`. */
  readonly text: string;
  readonly when: InstructionWhen;
}

export interface NavEntry {
  readonly plugin: PluginId;
  readonly screen: string;
  readonly label: string;
  readonly icon?: string;
  readonly order: number;
}

export interface DoctorEntry {
  readonly plugin: PluginId;
  readonly id: string;
}

export interface OnboardingEntry {
  readonly plugin: PluginId;
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly side?: 'daemon' | 'client';
  readonly group?: string;
  /** See `OnboardingDecl.stepHost`. */
  readonly stepHost?: true;
}

/** Frozen after every build (§7.6 step 5). */
export interface PostBuildSnapshot {
  readonly instructions: readonly InstructionEntry[];
  readonly words: readonly (Word & { readonly plugin: PluginId })[];
  readonly nav: readonly NavEntry[];
  readonly doctor: readonly DoctorEntry[];
  readonly onboarding: readonly OnboardingEntry[];
}

/** What one plugin's earlier onboarding answers left for its later pages, e.g. `{ importMode: 'everything' }`. */
export type StepSegmentMemory = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * What the onboarding shell hands a page it draws as a step (`PanelProps.step`). A page never imports the shell: it
 * tells the host what it decided. `ready` lifts the loading cover; `skip` moves on with nothing drawn; `done` records
 * the answer; `busy` shows a label and locks Next during a long act. It lives here, beside `OnboardingEntry`, because
 * `PanelProps` (the kernel's) carries it and a contract may import only the kernel's contract leaf; the onboarding
 * contract re-exports it with its own words (`step-host.ts`).
 */
export interface StepHost {
  readonly phase: 'daemon' | 'client';
  /** More than one daemon, or a subset of the paired ones, makes the shell highlight the step. */
  readonly appliesTo: readonly { readonly daemon: string; readonly name: string }[];
  readonly segment: StepSegmentMemory;
  /**
   * Adds to this plugin's segment memory for its later pages: held in memory for this run only; never stored, never a
   * secret.
   */
  remember(patch: StepSegmentMemory): void;
  ready(): void;
  skip(why: 'not-needed' | 'already-set'): void;
  /**
   * "This page is not needed for THIS run, given the answers so far": the run passes over it in both directions. Unlike
   * `skip`, it is NOT recorded on the machine and survives nothing (run-only, like the segment memory): see rule 7 in the
   * onboarding contract's `step-host.ts`.
   */
  notNeeded(): void;
  done(): void;
  busy(label: string | null): void;
  /**
   * Registers what the footer's Next must SAVE before it moves on (null clears it). On Next the shell runs it under
   * busy('Saving…'): resolved → done() is recorded and the flow moves on; rejected with an Error → the page stays, the
   * error's message shows on the page, Next stays enabled to try again. A page calls it whenever its pick changes.
   */
  commit(save: (() => Promise<void>) | null): void;
  next(): void;
  back(): void;
}
