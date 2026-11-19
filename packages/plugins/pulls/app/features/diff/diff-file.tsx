import { ExternalLink } from '@ferretry/app/ui';
import { Fragment, useMemo, useState } from 'react';
import type { PullFile } from '../../../contract/index.ts';
import { parsePatch } from '../../../contract/diff-hunks.ts';
import { type LineExtras, SplitHunk, UnifiedHunk } from './diff-rows.tsx';
import { languageOf } from './language.ts';
import { useWide } from './use-wide.ts';

/** A diff longer than this many characters waits behind a button, so opening a PR never lays out a huge file by itself. */
const LARGE_PATCH_CHARS = 120_000;

const STATUS_WORD: Readonly<Record<PullFile['status'], string>> = {
  added: 'Added',
  removed: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  copied: 'Copied',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

/** What a file with no hunks to draw says, and why: GitHub sends no `patch` for a binary or a very large file. */
function Hollow({ file }: { readonly file: PullFile }) {
  const renameOnly = file.status === 'renamed' && file.additions === 0 && file.deletions === 0;
  return (
    <p className="m-0 px-3 py-2 text-meta leading-base text-muted" data-diff-hollow={file.status}>
      {renameOnly
        ? 'Renamed with no changes to its content.'
        : file.additions === 0 && file.deletions === 0
          ? 'No text changes to show (a binary file, or only its mode changed).'
          : 'Too large or binary to show here.'}{' '}
      {file.url === undefined ? null : (
        <ExternalLink className="text-accent underline-offset-4 hover:underline" href={file.url}>
          Open on GitHub
        </ExternalLink>
      )}
    </p>
  );
}

export function DiffFile({
  file,
  split,
  viewed,
  onViewed,
  extras,
}: {
  readonly file: PullFile;
  readonly split: boolean;
  readonly viewed: boolean;
  readonly onViewed: (viewed: boolean) => void;
  readonly extras?: LineExtras | undefined;
}) {
  const large = (file.patch?.length ?? 0) > LARGE_PATCH_CHARS;
  const [open, setOpen] = useState(!viewed);
  const [showLarge, setShowLarge] = useState(false);
  const patch = useMemo(
    () => (open && file.patch !== undefined ? parsePatch(file.patch) : undefined),
    [open, file.patch],
  );
  const lang = languageOf(file.path);
  // On a phone the path takes the header's first row and its numbers and tick the second, the same in every card.
  const wide = useWide();
  const title = file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`;
  return (
    <section
      aria-label={file.path}
      className="min-w-0 overflow-hidden rounded-panel border border-border-soft bg-surface"
      data-diff-file={file.path}
      data-viewed={viewed ? 'true' : 'false'}
      id={fileAnchor(file.path)}
    >
      <header className="flex flex-wrap items-center gap-x-sm gap-y-1 border-b border-border-soft bg-code-bg px-3 py-1.5">
        <button
          aria-expanded={open}
          className="flex-1 bg-transparent p-0 text-left font-mono text-cell text-fg"
          onClick={() => setOpen(value => !value)}
          // Inline: the shell gives every button a touch-target minimum width that a utility class does not beat. A path asks
          // for room to wrap after a slash before the file's numbers take the line, and breaks inside a name only as a last resort.
          style={{ minWidth: '12rem', overflowWrap: 'anywhere', ...(wide ? {} : { flexBasis: '100%' }) }}
          title={title}
          type="button"
        >
          <span aria-hidden="true" className="pr-1 text-faint">
            {open ? '▾' : '▸'}
          </span>
          <BreakablePath text={title} />
        </button>
        <span className="text-meta text-faint">{STATUS_WORD[file.status]}</span>
        {file.additions === 0 && file.deletions === 0 ? null : (
          <>
            <span className="text-meta tabular-nums text-ok">+{file.additions}</span>
            <span className="text-meta tabular-nums text-err">−{file.deletions}</span>
          </>
        )}
        <label className="flex cursor-pointer items-center gap-1 text-meta text-muted">
          <input
            checked={viewed}
            onChange={event => {
              onViewed(event.currentTarget.checked);
              setOpen(!event.currentTarget.checked);
            }}
            type="checkbox"
          />
          Viewed
        </label>
      </header>
      {!open ? null : file.patch === undefined || file.patch === '' ? (
        <Hollow file={file} />
      ) : large && !showLarge ? (
        <p className="m-0 px-3 py-2 text-meta text-muted">
          This is a large diff.{' '}
          <button
            className="bg-transparent p-0 text-accent hover:underline"
            onClick={() => setShowLarge(true)}
            type="button"
          >
            Show it anyway
          </button>
        </p>
      ) : (
        <div className="overflow-x-auto" data-diff-body={split ? 'split' : 'unified'}>
          {patch?.hunks.map(hunk =>
            split ? (
              <SplitHunk extras={extras} hunk={hunk} key={hunk.header + hunk.oldStart} lang={lang} path={file.path} />
            ) : (
              <UnifiedHunk extras={extras} hunk={hunk} key={hunk.header + hunk.oldStart} lang={lang} path={file.path} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** A path that wraps after a `/` first, and inside a name only when one name is wider than the line. */
function BreakablePath({ text }: { readonly text: string }) {
  return (
    <>
      {text.split('/').map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a path never reorder
        <Fragment key={index}>
          {index === 0 ? null : (
            <>
              /<wbr />
            </>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** An element id for a file's card, so the tree can scroll to it. */
export const fileAnchor = (path: string): string => `pulls-file-${path.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
