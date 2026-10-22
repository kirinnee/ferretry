import { formatByteProgress, plainLine } from '../progress/index.ts';

/** The phase of an update a person is told about; the order is roughly the order they happen in. */
export type UpdatePhase =
  | 'preparing'
  | 'downloading'
  | 'building'
  | 'verifying'
  | 'unpacking'
  | 'switching'
  | 'refreshing'
  | 'upgrading';

export interface Count {
  readonly done: number;
  readonly expected: number;
}

/** What a package manager is doing right now, in the terms the progress line shows. */
export interface UpdateActivity {
  readonly phase: UpdatePhase;
  readonly packages?: Count;
  readonly bytes?: Count;
  /** The tool's last output line, when it has nothing structured to say. */
  readonly line?: string;
}

/** Told about each change, never required: a caller that does not care passes nothing. */
export type UpdateObserver = (activity: UpdateActivity) => void;

export interface DescribedActivity {
  readonly step: string;
  readonly detail: string | undefined;
}

/** The step label and detail for an activity: `Downloading 4.69.4` and `23/41 packages, 48/120 MB`. */
export function describeActivity(activity: UpdateActivity, target: string): DescribedActivity {
  return { step: stepFor(activity.phase, target), detail: detailFor(activity) };
}

function stepFor(phase: UpdatePhase, target: string): string {
  switch (phase) {
    case 'preparing':
      return `Preparing ${target}`;
    case 'downloading':
      return `Downloading ${target}`;
    case 'building':
      return `Building ${target}`;
    case 'verifying':
      return 'Verifying the download';
    case 'unpacking':
      return `Unpacking ${target}`;
    case 'switching':
      return 'Switching the nix profile';
    case 'refreshing':
      return 'Refreshing the Homebrew tap';
    case 'upgrading':
      return 'Upgrading with Homebrew';
  }
}

function detailFor(activity: UpdateActivity): string | undefined {
  const parts: string[] = [];
  if (activity.packages !== undefined && activity.packages.expected > 0) {
    parts.push(`${String(activity.packages.done)}/${String(activity.packages.expected)} packages`);
  }
  if (activity.bytes !== undefined && activity.bytes.expected > 0) {
    parts.push(formatByteProgress(activity.bytes.done, activity.bytes.expected));
  }
  if (parts.length > 0) return parts.join(', ');
  const line = activity.line === undefined ? '' : plainLine(activity.line);
  return line === '' ? undefined : line;
}
