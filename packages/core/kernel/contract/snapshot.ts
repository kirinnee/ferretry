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
}

/** Frozen after every build (§7.6 step 5). */
export interface PostBuildSnapshot {
  readonly instructions: readonly InstructionEntry[];
  readonly words: readonly (Word & { readonly plugin: PluginId })[];
  readonly nav: readonly NavEntry[];
  readonly doctor: readonly DoctorEntry[];
  readonly onboarding: readonly OnboardingEntry[];
}
