/**
 * The Files tab's rendered surfaces, ported from
 * `ui/src/components/FilesTab.tsx`.
 *
 * The directory is the front door. Opening a file immediately shows its useful
 * form: Markdown as prose, recognised code with the app's existing highlighter,
 * everything else as text. Raw bytes and the git diff are icon actions ON that
 * file, never modes the reader must pick before seeing it. Git status stays in
 * the listing as a compact dot plus line counts instead of a second ceremony.
 *
 * Everything here is phone-first and measured at 360px: one vertical scroller
 * per pane, 44px rows, and wide content (long paths, long diff lines, wide
 * tables) scrolls INSIDE its own container so the page itself never scrolls
 * sideways. The measurements live in `files.css`.
 */

import { CornerLeftUp, FileText, Folder, Link2Off, Loader2, Lock, RefreshCw, X } from 'lucide-react';
import { useMemo, type ReactNode, type RefObject } from 'react';
import { highlightToHtml } from '../lib/highlight.ts';
import { langFromPath } from '../lib/tool-extract.ts';
import type { FsChange, FsFile, FsListing } from './files-api.ts';
import {
  baseName,
  entryRefusal,
  formatBytes,
  isMarkdownPath,
  joinRel,
  parentRel,
  renderableDiffLines,
  sortFsEntries,
  splitHighlightedLines,
  statusChip,
  type ParsedDiff,
} from './files-model.ts';
import {
  changeDescription,
  fileRefusal,
  HIGHLIGHT_LIMIT,
  type FileLineSelection,
  type OpenFileTab,
} from './files-tab-model.ts';
import { Markdown, type MarkdownProps } from './markdown.tsx';

/** Everything the Markdown renderer needs that only the pane's host can prove. */
export type FilesMarkdownContext = Omit<MarkdownProps, 'text' | 'className'>;

export interface NoteProps {
  tone?: 'plain' | 'warn' | 'err';
  role?: 'status' | 'alert';
  children: ReactNode;
}

export const Note = ({ tone = 'plain', role, children }: NoteProps) => (
  <div className="kt-fs-note" data-tone={tone === 'plain' ? undefined : tone} role={role}>
    {children}
  </div>
);

export const Loading = ({ what }: { what: string }) => (
  <Note role="status">
    <span className="inline-flex items-center gap-2">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      Loading {what}…
    </span>
  </Note>
);

export interface FailedProps {
  what: string;
  error: string;
  onRetry: () => void;
}

export const Failed = ({ what, error, onRetry }: FailedProps) => (
  <Note tone="err" role="alert">
    <span>
      Could not load {what}: {error}
    </span>
    <button
      type="button"
      className="kt-btn kt-btn--sm kt-fs-retry"
      onClick={onRetry}
      aria-label={`Retry loading ${what}`}
    >
      <RefreshCw size={13} aria-hidden="true" />
      Retry
    </button>
  </Note>
);

/**
 * The condensed git marker. `role="img"` rather than a bare span: the dot and
 * the counts are a single glyph whose whole meaning is in its label, and a
 * `<span aria-label>` with no role is not addressable by anything.
 */
export const ChangeIndicator = ({ change }: { change: FsChange }) => {
  const chip = statusChip(change.status);
  const knownAdd = change.additions !== undefined;
  const knownDel = change.deletions !== undefined;
  const showAdd = (change.additions ?? 0) > 0 || (knownAdd && ['A', '?'].includes(chip.code));
  const showDel = (change.deletions ?? 0) > 0 || (knownDel && chip.code === 'D');
  const unknownAdd = !knownAdd && ['A', '?', 'C'].includes(chip.code);
  const unknownDel = !knownDel && chip.code === 'D';
  const label = changeDescription(change);

  return (
    <span className="kt-fs-change" role="img" aria-label={label} title={label}>
      <span className="kt-fs-change-dot" data-tone={chip.tone} aria-hidden="true" />
      {(showAdd || unknownAdd) && (
        <span className="kt-fs-change-count" data-kind="add" aria-hidden="true">
          +{showAdd ? change.additions : ''}
        </span>
      )}
      {(showDel || unknownDel) && (
        <span className="kt-fs-change-count" data-kind="del" aria-hidden="true">
          −{showDel ? change.deletions : ''}
        </span>
      )}
    </span>
  );
};

export interface BrowseListProps {
  listing: FsListing;
  dir: string;
  changes?: ReadonlyMap<string, FsChange>;
  onEnter: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export const BrowseList = ({ listing, dir, changes, onEnter, onOpenFile }: BrowseListProps) => {
  const entries = useMemo(() => sortFsEntries(listing.entries), [listing]);

  return (
    <ul className="m-0 list-none p-0">
      {dir && (
        <li>
          <button
            type="button"
            className="kt-fs-row"
            onClick={() => onEnter(parentRel(dir))}
            aria-label={`Up to ${parentRel(dir) || 'the session root'}`}
          >
            <CornerLeftUp size={15} className="kt-fs-icon" aria-hidden="true" />
            <span className="kt-fs-name">
              <span className="kt-fs-strong">..</span>
            </span>
          </button>
        </li>
      )}
      {entries.map(entry => {
        const refusal = entryRefusal(entry);
        const path = joinRel(dir, entry.name);
        const isDir = entry.type === 'dir';
        const openable = !refusal;
        const change = openable && !isDir ? changes?.get(path) : undefined;
        const icon = entry.escapes ? (
          <Link2Off size={15} className="kt-fs-icon" aria-hidden="true" />
        ) : refusal ? (
          <Lock size={15} className="kt-fs-icon" aria-hidden="true" />
        ) : isDir ? (
          <Folder size={15} className="kt-fs-icon" aria-hidden="true" />
        ) : (
          <FileText size={15} className="kt-fs-icon" aria-hidden="true" />
        );
        const body = (
          <>
            {icon}
            <span className="kt-fs-name">
              <span className="kt-fs-name-line">
                <span className="kt-fs-strong">
                  {entry.name}
                  {isDir ? '/' : ''}
                </span>
                {change && <ChangeIndicator change={change} />}
              </span>
              {refusal && <span className="kt-fs-dim">{refusal}</span>}
            </span>
            <span className="kt-fs-meta">{isDir ? '' : formatBytes(entry.size)}</span>
          </>
        );
        if (!openable)
          return (
            <li key={entry.name}>
              {/* Not a disabled button: a control that exists only to refuse is
                  a worse answer than a row that states the reason. */}
              <div className="kt-fs-row" data-inert="true">
                {body}
              </div>
            </li>
          );
        return (
          <li key={entry.name}>
            <button
              type="button"
              className="kt-fs-row"
              onClick={() => (isDir ? onEnter(path) : onOpenFile(path))}
              aria-label={
                isDir
                  ? `Open folder ${entry.name}`
                  : `Open file ${entry.name}${entry.size != null ? `, ${formatBytes(entry.size)}` : ''}${
                      change ? `, ${changeDescription(change)}` : ''
                    }`
              }
            >
              {body}
            </button>
          </li>
        );
      })}
      {listing.truncated && (
        <li>
          <div className="kt-fs-note" role="status">
            Listing truncated by the daemon — this directory has more entries than the viewer serves at once.
          </div>
        </li>
      )}
      {!entries.length && (
        <li>
          {/* Also at depth: a nested empty folder shows the `..` row, so without
              this the pane would look like a list that failed to load. */}
          <div className="kt-fs-note" role="status">
            This folder is empty.
          </div>
        </li>
      )}
    </ul>
  );
};

export const DiffBody = ({ parsed }: { parsed: ParsedDiff }) => (
  <div className="kt-fs-code scroll-thin">
    <div className="kt-fs-diff">
      {renderableDiffLines(parsed).map(line => {
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : '';
        const isRow = line.kind === 'add' || line.kind === 'del' || line.kind === 'ctx';
        return (
          <div
            // Old/new line numbers plus the kind address a diff row exactly; the
            // original keyed on array position, which reshuffles on a reload.
            key={`${line.kind}:${line.oldNo ?? ''}:${line.newNo ?? ''}:${line.text}`}
            className="kt-fs-diff-line"
            data-kind={line.kind}
          >
            {isRow && (
              <>
                <span className="kt-fs-gutter" aria-hidden="true">
                  {line.oldNo ?? ''}
                </span>
                <span className="kt-fs-gutter" aria-hidden="true">
                  {line.newNo ?? ''}
                </span>
              </>
            )}
            {isRow && <span className="kt-fs-sign">{sign}</span>}
            <span className="kt-fs-diff-text">{line.text || ' '}</span>
          </div>
        );
      })}
    </div>
  </div>
);

export interface SourceLinesProps {
  content: string;
  html: string | null;
  lang?: string;
  selection: FileLineSelection;
  targetLineRef?: RefObject<HTMLSpanElement | null>;
}

/**
 * A programmatic code-reference landing is source-oriented even for Markdown: a
 * prose renderer cannot honestly map source line 42 to a DOM paragraph. The
 * compact location rail states what landed, and the line rows carry a stable
 * address plus a persistent (not flashing) range treatment.
 */
export const SourceLines = ({ content, html, lang, selection, targetLineRef }: SourceLinesProps) => {
  const sourceLines = useMemo(() => content.split(/\r?\n/u), [content]);
  const highlightedLines = useMemo(() => (html === null ? null : splitHighlightedLines(html)), [html]);
  const lineCount = sourceLines.length;
  const requestedEnd = selection.endLine ?? selection.line;
  const valid = selection.line <= lineCount;
  const visibleEnd = valid ? Math.min(requestedEnd, lineCount) : selection.line;
  const location =
    selection.endLine === undefined
      ? `Line ${selection.line}${selection.column === undefined ? '' : `, column ${selection.column}`}`
      : `Lines ${selection.line}–${selection.endLine}`;

  return (
    <>
      <div className="kt-fs-location" data-tone={valid ? undefined : 'warn'} role="status">
        {valid
          ? requestedEnd > lineCount
            ? `${location} requested; this file ends at line ${lineCount}. Highlighting through the final line.`
            : `${location} highlighted.`
          : `${location} does not exist; this file has ${lineCount.toLocaleString()} ${lineCount === 1 ? 'line' : 'lines'}.`}
      </div>
      <div className="kt-fs-code scroll-thin">
        <pre className="kt-fs-pre kt-fs-pre--lines">
          {sourceLines.map((line, index) => {
            const lineNumber = index + 1;
            const selected = valid && lineNumber >= selection.line && lineNumber <= visibleEnd;
            const first = selected && lineNumber === selection.line;
            const lineHtml = highlightedLines?.[index];
            return (
              <span
                key={lineNumber}
                ref={first ? targetLineRef : undefined}
                className="kt-fs-source-line"
                data-line={lineNumber}
                data-highlighted={selected || undefined}
                data-column={first && selection.column !== undefined ? selection.column : undefined}
                aria-current={first ? 'location' : undefined}
              >
                <span className="kt-fs-source-gutter" aria-hidden="true">
                  {lineNumber}
                </span>
                {lineHtml === undefined ? (
                  <code className="kt-fs-source-text">{line || ' '}</code>
                ) : (
                  <code
                    className={`kt-fs-source-text hljs${lang ? ` language-${lang}` : ''}`}
                    // Safe: Highlight.js escaped the source, and
                    // splitHighlightedLines only balances the spans it emitted.
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted output is the registry's own escaped markup, re-split line by line
                    dangerouslySetInnerHTML={{ __html: lineHtml || ' ' }}
                  />
                )}
              </span>
            );
          })}
        </pre>
      </div>
    </>
  );
};

export interface FileBodyProps {
  file: FsFile;
  path: string;
  raw?: boolean;
  selection?: FileLineSelection;
  targetLineRef?: RefObject<HTMLSpanElement | null>;
  markdown?: FilesMarkdownContext;
}

export const FileBody = ({ file, path, raw = false, selection, targetLineRef, markdown }: FileBodyProps) => {
  const refusal = fileRefusal(file);
  const content = file.content ?? '';
  const lang = file.lang ?? langFromPath(path);
  const renderedMarkdown = isMarkdownPath(path) && selection === undefined;
  const html = useMemo(
    () => (refusal || raw || renderedMarkdown ? null : highlightToHtml(content, lang)),
    [refusal, raw, renderedMarkdown, content, lang],
  );
  const highlightingOff = !raw && html === null && lang !== undefined && content.length > HIGHLIGHT_LIMIT;
  const highlightNote = highlightingOff ? (
    <div className="kt-fs-note" role="status">
      Syntax highlighting is off above {HIGHLIGHT_LIMIT.toLocaleString()} characters.
    </div>
  ) : null;

  if (refusal)
    return (
      <Note tone="warn" role="status">
        {refusal}
      </Note>
    );
  if (!content) return <Note role="status">This file is empty.</Note>;
  if (!raw && renderedMarkdown)
    return (
      <div className="kt-fs-md">
        <Markdown text={content} {...markdown} />
      </div>
    );
  if (selection)
    return (
      <>
        {highlightNote}
        <SourceLines content={content} html={html} lang={lang} selection={selection} targetLineRef={targetLineRef} />
      </>
    );
  return (
    <>
      {highlightNote}
      <div className="kt-fs-code scroll-thin">
        {raw || html === null ? (
          // Escaped by React — raw HTML is inserted ONLY for highlighter output,
          // which escapes its own input (the same rule markdown.tsx follows).
          <pre className="kt-fs-pre">{content}</pre>
        ) : (
          <pre className="kt-fs-pre">
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlighted output is the registry's own escaped markup; the raw branch above never forwards caller text */}
            <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        )}
      </div>
    </>
  );
};

export interface OpenFileTabsProps {
  tabs: readonly OpenFileTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}

/**
 * `role="toolbar"`, not `role="group"`: a group on a div is rewritten by the
 * semantic-elements rule into a `<fieldset>`, which is for form controls and
 * would break this rail's flex layout. A toolbar is what a row of activation
 * and close controls actually is, and it supports the label directly.
 */
export const OpenFileTabs = ({ tabs, activePath, onActivate, onClose }: OpenFileTabsProps) => (
  <div className="kt-fs-tabs scroll-thin" role="toolbar" aria-label="Open files">
    {tabs.map(tab => {
      const active = tab.path === activePath;
      return (
        <span key={tab.path} className="kt-fs-tab" data-active={active || undefined}>
          <button
            type="button"
            className="kt-fs-tab-open"
            aria-pressed={active}
            aria-label={`Show ${tab.path}`}
            onClick={() => onActivate(tab.path)}
            title={tab.path}
          >
            <FileText size={14} aria-hidden="true" />
            <span>{baseName(tab.path)}</span>
          </button>
          <button
            type="button"
            className="kt-fs-tab-close"
            onClick={() => onClose(tab.path)}
            aria-label={`Close ${tab.path}`}
            title={`Close ${tab.path}`}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      );
    })}
  </div>
);
