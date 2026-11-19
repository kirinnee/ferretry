/**
 * The browser entry for the review-thread shots over FAKE data (no daemon): a stand-in diff, the real `LineThreads`
 * under its rows and the real `OutdatedThreads` below.
 *
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import type { ReviewThread } from '../../../../contract/index.ts';
import {
  LineThreads,
  OutdatedThreads,
  placeThreads,
  type DiffRows,
  type DiffSide,
} from '../../../../app/features/threads/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const comment = (id: string, login: string, body: string, at: string) => ({
  id,
  author: { login },
  body,
  createdAt: at,
  url: `https://github.com/octo/demo/pull/7#discussion_${id}`,
});

const THREADS: readonly ReviewThread[] = [
  {
    id: 'T1',
    resolved: false,
    outdated: false,
    path: 'src/a.ts',
    line: 11,
    side: 'right',
    comments: [
      comment('c1', 'reviewer-one', 'Please name this by what it holds, not how it is used.', '2026-11-01T10:00:00Z'),
      comment('c2', 'octo-author', 'Good catch, renamed.', '2026-11-01T11:30:00Z'),
    ],
  },
  {
    id: 'T2',
    resolved: true,
    outdated: false,
    path: 'src/a.ts',
    line: 12,
    side: 'right',
    comments: [comment('c3', 'reviewer-two', 'Nit: trailing space.', '2026-11-01T10:05:00Z')],
  },
  {
    id: 'T3',
    resolved: false,
    outdated: true,
    path: 'src/b.ts',
    line: 40,
    startLine: 38,
    side: 'right',
    comments: [comment('c4', 'reviewer-one', 'This block moved; is the guard still needed?', '2026-10-30T09:00:00Z')],
  },
];

const ROWS: ReadonlyArray<{
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly sign: ' ' | '+' | '-';
  readonly text: string;
}> = [
  { oldLine: 10, newLine: 10, sign: ' ', text: 'const shelf = loadShelf(options);' },
  { oldLine: 11, sign: '-', text: 'const data = shelf.read();' },
  { newLine: 11, sign: '+', text: 'const entries = shelf.read();' },
  { newLine: 12, sign: '+', text: 'return entries.length;' },
  { oldLine: 12, newLine: 13, sign: ' ', text: '}' },
];

const rows: DiffRows = {
  hasLine: (path: string, side: DiffSide, line: number) =>
    path === 'src/a.ts' && ROWS.some(row => (side === 'left' ? row.oldLine : row.newLine) === line),
};
const placement = placeThreads(THREADS, rows);

// Inline styles: this is a stand-in for E5's diff rows, not product CSS.
const TINT = {
  '+': 'color-mix(in srgb, var(--ok) 14%, transparent)',
  '-': 'var(--warn-bg)',
  ' ': 'transparent',
} as const;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto grid max-w-3xl gap-md p-4" data-scene-ready="">
      <div className="overflow-hidden rounded-md border border-border-strong" data-diff="src/a.ts">
        <div className="mono bg-surface-2 px-sm py-xs text-meta text-fg-soft">src/a.ts</div>
        {ROWS.map(row => (
          <div key={`${row.oldLine}-${row.newLine}`}>
            <div
              className="mono text-meta"
              style={{
                display: 'grid',
                gridTemplateColumns: '2.5rem 2.5rem 1rem minmax(0, 1fr)',
                background: TINT[row.sign],
              }}
            >
              <span className="px-1 text-right text-faint">{row.oldLine ?? ''}</span>
              <span className="px-1 text-right text-faint">{row.newLine ?? ''}</span>
              <span>{row.sign}</span>
              <span className="min-w-0 break-all">{row.text}</span>
            </div>
            {row.newLine !== undefined && (
              <LineThreads placement={placement} path="src/a.ts" side="right" line={row.newLine} />
            )}
            {row.oldLine !== undefined && row.sign === '-' && (
              <LineThreads placement={placement} path="src/a.ts" side="left" line={row.oldLine} />
            )}
          </div>
        ))}
      </div>
      <OutdatedThreads placement={placement} />
    </div>,
  );
