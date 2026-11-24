/**
 * "PERMISSIONS" AS DATA (pure: no React, no storage, no clock, no network).
 *
 * One page asks how every harness the person picked handles a command it is about to run: Ferretry's autonomous defaults
 * for all of them (one tick), or, under "Change", Auto mode (asks first) / Skip permissions (never asks) per harness. Each
 * harness keeps its answer in ONE key, `permissionMode`, of its own config file (`config/harness-<harness>.yaml`, whose
 * owners are the Claude Code and Codex plugins' contracts); this page only reads and sets that one key, through the kernel's
 * config route and the shared one-key editor, so every other key and comment stays as it was. A harness this page does not
 * know has no file here and is simply not listed.
 */
import { editConfigText, readConfigText } from '@ferretry/std/yaml';

export type Mode = 'auto' | 'skip';

/** The harnesses whose permission mode this page sets: their config file, their words and the real flag Skip means. */
export interface PermissionHarness {
  readonly key: string;
  readonly label: string;
  /** The file the config route names (under `config/`). */
  readonly file: string;
  /** The harness's own flag for "never ask": named beside the warning, so nobody is told "autonomous" without knowing what it allows. */
  readonly flag: string;
}

const HARNESSES: readonly PermissionHarness[] = [
  {
    key: 'claude-code',
    label: 'Claude Code',
    file: 'harness-claude-code.yaml',
    flag: '--dangerously-skip-permissions',
  },
  { key: 'codex', label: 'Codex', file: 'harness-codex.yaml', flag: '--dangerously-bypass-approvals-and-sandbox' },
];

/** The harnesses of the pick this page covers, in the order the run walks them (a harness it has no file for is left out). */
export const coveredBy = (on: readonly string[]): readonly PermissionHarness[] =>
  HARNESSES.filter(harness => on.includes(harness.key));

/** The mode a harness's file says: the default (`skip`, owner !A525) when it says none, `null` when it cannot be told safely. */
export function modeOf(text: string): Mode | null {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const { value } = read.read;
  if (value === null || value === undefined) return 'skip';
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const said = (value as Record<string, unknown>).permissionMode;
  if (said === undefined || said === null) return 'skip';
  return said === 'auto' || said === 'skip' ? said : null;
}

/** The file's text with ONLY `permissionMode` set. It throws on a text it cannot read, rather than replacing the file. */
export function withMode(text: string, mode: Mode): string {
  const read = readConfigText(text);
  if (!read.ok || modeOf(text) === null) throw new Error('the file cannot be edited here');
  const { value } = read.read;
  const now = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return editConfigText(text, { ...now, permissionMode: mode }, now, undefined);
}

/** Ferretry's autonomous defaults are on exactly when every covered harness is set to Skip. */
export const isAutonomous = (modes: Readonly<Record<string, Mode>>): boolean =>
  Object.values(modes).every(mode => mode === 'skip');

/** Every covered harness set to one mode: what ticking (Skip) or unticking (Auto) the one box means. */
export const allSetTo = (keys: readonly string[], mode: Mode): Readonly<Record<string, Mode>> =>
  Object.fromEntries(keys.map(key => [key, mode] as const));
