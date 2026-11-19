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
  done(): void;
  busy(label: string | null): void;
  next(): void;
  back(): void;
}
