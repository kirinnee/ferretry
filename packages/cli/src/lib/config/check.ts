/**
 * `fy config check`: every file under `config/` checked as the daemon would, with no daemon. Each file is evaluated by the
 * Kernel's own rule (`evaluateConfig`): YAML, the raw-secret scan, the schema, last good, and a loosening held — so the
 * answer here and `fy config status` cannot disagree about a file. Pure: the caller reads the disk and the accepted record.
 */
import { config } from '@ferretry/kernel/host';
import type { ConfigFilesPort } from './ports.ts';
import type { ConfigReport, PendingEdit } from './render.ts';

export interface CheckInput {
  readonly declarations: readonly config.ConfigDeclaration[];
  readonly files: Awaited<ReturnType<ConfigFilesPort['list']>>;
  readonly accepted: Awaited<ReturnType<ConfigFilesPort['accepted']>>;
  readonly digest: ConfigFilesPort['digest'];
  readonly binary: string;
}

export function checkConfigDirectory(input: CheckInput): ConfigReport {
  const issues: config.ConfigIssue[] = [];
  const pending: PendingEdit[] = [];
  const evaluate = (
    path: string,
    target: NonNullable<ReturnType<typeof config.targetOfPath>>,
    disk: config.DiskState,
  ): boolean => {
    const record = input.accepted[path];
    // A record is in effect for the plugin it was accepted for and for no other (the daemon's own rule).
    const accepted = record !== undefined && record.plugin === target.plugin ? record : undefined;
    const evaluated = config.evaluateConfig({
      def: target.def,
      path,
      disk,
      accepted: accepted === undefined ? undefined : { etag: accepted.etag, text: accepted.text },
      digest: input.digest,
      binary: input.binary,
    });
    issues.push(...evaluated.issues);
    if (evaluated.held !== undefined)
      pending.push({ path, etag: evaluated.held.etag, changes: [...evaluated.held.sentences] });
    return evaluated.state !== 'absent';
  };

  let files = 0;
  const seen = new Set<string>();
  for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
    seen.add(file.path);
    const target = config.targetOfPath(input.declarations, file.path);
    if (target === undefined) {
      files += 1;
      issues.push({
        path: file.path,
        severity: 'warning',
        message: 'no plugin declares this file, so nothing reads it',
        fix: `rename it to a file a plugin declares (${input.binary} config guide lists them), or delete it`,
      });
      continue;
    }
    if (evaluate(file.path, target, file.disk)) files += 1;
  }
  // A file that was in effect and is gone is a deletion, which is an edit to the defaults: judged the same way.
  for (const path of Object.keys(input.accepted).sort()) {
    if (seen.has(path)) continue;
    const target = config.targetOfPath(input.declarations, path);
    if (target !== undefined) evaluate(path, target, { kind: 'absent' });
  }
  return { files, issues, pending };
}
