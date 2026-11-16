/** One SKILL.md, read when opened and shown as the document it is: the front matter as its lines, the body as Markdown. */
import { Markdown } from '@ferretry/app';
import { ContextFailure, ContextNote, useContextRead } from '@ferretry/app/ui';
import { useCallback } from 'react';
import type { SkillEntry, SkillFile } from '../../contract/index.ts';
import { splitFrontMatter } from '../lib/skills-model.ts';
import { SkillSheet } from './skill-sheet.tsx';

/** Reads one SKILL.md for Open. */
export type SkillFileLoader = (path: string, signal: AbortSignal) => Promise<SkillFile>;

/** The front matter as the lines it is, then the body as the document it is. */
function SkillDocument({ content }: { readonly content: string }) {
  const { frontMatter, body } = splitFrontMatter(content);
  return (
    <div className="flex min-w-0 flex-col gap-sm overflow-auto">
      {frontMatter === null || frontMatter.trim() === '' ? null : (
        <pre
          className="m-0 whitespace-pre-wrap break-words rounded-control bg-surface-2 p-xs font-mono text-2xs text-muted"
          data-context-skill-front-matter=""
        >
          {frontMatter}
        </pre>
      )}
      <Markdown text={body} />
    </div>
  );
}

export function SkillFileSheet({
  skill,
  load,
  machineName,
  onClose,
}: {
  readonly skill: Pick<SkillEntry, 'name' | 'path'>;
  readonly load: SkillFileLoader;
  readonly machineName: string;
  readonly onClose: () => void;
}) {
  const reader = useCallback((signal: AbortSignal) => load(skill.path, signal), [load, skill.path]);
  const file = useContextRead(reader, true);
  return (
    <SkillSheet name="file" title={skill.name} closeLabel="Close SKILL.md" onClose={onClose}>
      <div className="flex min-w-0 flex-col gap-sm" data-context-skill-file={skill.name}>
        <p className="m-0 break-all font-mono text-2xs text-faint">{skill.path}</p>
        {file.load.kind === 'failed' ? (
          <ContextFailure
            machineName={machineName}
            what={`open ${skill.name}’s SKILL.md`}
            reason={file.load.reason}
            onRetry={file.reload}
          />
        ) : file.load.kind === 'ready' ? (
          <SkillDocument content={file.load.value.content} />
        ) : (
          <ContextNote>Reading SKILL.md…</ContextNote>
        )}
      </div>
    </SkillSheet>
  );
}
