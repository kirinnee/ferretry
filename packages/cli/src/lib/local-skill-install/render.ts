import type { LocalSkillInstall, LocalSkillPreview } from '@ferretry/protocol';

const indent = (text: string, by: string): string =>
  text
    .split('\n')
    .map(line => `${by}${line}`)
    .join('\n');

const whereFrom = (origin: LocalSkillInstall['origin']): string =>
  `${origin.kind === 'account' ? 'account' : 'project'} ${origin.owner} (${origin.harness}), ${origin.path}`;

/** The whole review, in words: nothing the skill brings is left out or shortened. */
export const renderPreview = (preview: LocalSkillPreview): string => {
  const lines = [`${preview.name} copied from ${whereFrom(preview.origin)}`, `Lands in: ${preview.destination}`];
  if (preview.replaces !== undefined) lines.push(`Replaces the copy you made there (${preview.replaces.installId})`);
  if (preview.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of preview.warnings) lines.push(`  ! ${warning.text}`);
  }
  if (preview.skipped.length > 0) {
    lines.push('', 'Not copied:');
    for (const problem of preview.skipped) lines.push(`  ${problem.subject}: ${problem.reason}`);
  }
  lines.push('', 'What it brings:');
  for (const entry of preview.review)
    lines.push(
      entry.document ? `  ${entry.label}:\n${indent(entry.text, '    | ')}` : `  ${entry.label}: ${entry.text}`,
    );
  return lines.join('\n');
};

export const renderInstalls = (installs: readonly LocalSkillInstall[]): string => {
  if (installs.length === 0) return 'No skills were copied from this machine.';
  return installs
    .map(install =>
      [
        `${install.installId}  ${install.name} from ${whereFrom(install.origin)}`,
        `  in ${install.destination} (${install.files.length} files)`,
      ].join('\n'),
    )
    .join('\n');
};
