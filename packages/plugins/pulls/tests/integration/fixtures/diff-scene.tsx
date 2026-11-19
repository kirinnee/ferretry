/**
 * The browser entry for the Files tab over FAKE data (no network, no real repository). `?case=` picks the scene:
 *   split (default)   a PR with a tree, a split diff, a renamed file and a binary file
 *   large             a file GitHub sent no patch for ("too large or binary")
 *   threads           two review threads drawn under their lines through `lineExtras`
 *   viewed            the same PR with two files ticked as viewed
 * `?theme=<family>-<mode>` sets the theme.
 */
import { createRoot } from 'react-dom/client';
import { PullFilesView } from '../../../app/features/diff/index.ts';
import type { PullsClient } from '../../../app/features/diff/use-pull-files.ts';
import { tickStorageKey, viewedKey } from '../../../app/features/diff/viewed.ts';
import type { PullFile, PullFilesAnswer } from '../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'split';

const TS_PATCH = [
  '@@ -1,9 +1,12 @@ export function greet(',
  ' import { format } from "./format";',
  ' ',
  '-export function greet(name: string) {',
  '-  return "Hello, " + name;',
  '+export function greet(name: string, loud = false) {',
  '+  const text = format("Hello, " + name);',
  '+  return loud ? text.toUpperCase() : text;',
  ' }',
  ' ',
  '+// Say it twice.',
  '+export const twice = (name: string) => greet(name) + greet(name);',
  ' export default greet;',
].join('\n');

const CSS_PATCH = '@@ -1,3 +1,3 @@\n .row {\n-  padding: 4px;\n+  padding: 8px;\n   color: var(--fg);\n }';
const FILES: readonly PullFile[] = [
  {
    path: 'src/greet.ts',
    status: 'modified',
    additions: 6,
    deletions: 2,
    patch: TS_PATCH,
    url: 'https://github.com/octo/widgets/blob/abc/src/greet.ts',
  },
  { path: 'src/styles/row.css', status: 'modified', additions: 1, deletions: 1, patch: CSS_PATCH },
  { path: 'docs/guide.md', status: 'renamed', previousPath: 'docs/intro.md', additions: 0, deletions: 0 },
  {
    path: 'assets/logo.png',
    status: 'added',
    additions: 0,
    deletions: 0,
    url: 'https://github.com/octo/widgets/blob/abc/assets/logo.png',
  },
];
const LARGE: readonly PullFile[] = [
  {
    path: 'data/fixtures.json',
    status: 'modified',
    additions: 48210,
    deletions: 12,
    url: 'https://github.com/octo/widgets/blob/abc/data/fixtures.json',
  },
  FILES[0] as PullFile,
];

const answer = (files: readonly PullFile[]): PullFilesAnswer => ({
  files: [...files],
  truncated: false,
  unreadable: 0,
  fromCache: false,
});
const client: PullsClient = {
  call: (async () => answer(scene === 'large' ? LARGE : FILES)) as PullsClient['call'],
};

if (scene === 'viewed')
  try {
    localStorage.setItem(
      tickStorageKey('shot.11111111-1111-4111-8111-111111111111.octo.widgets.7'),
      JSON.stringify([viewedKey(FILES[1] as PullFile), viewedKey(FILES[2] as PullFile)]),
    );
  } catch {
    // no storage: the scene shows no ticks
  }

const thread = (who: string, text: string, resolved = false) => (
  <div className="m-1.5 rounded-panel border border-border-soft bg-bg p-2 font-body text-cell" data-thread>
    <div className="text-meta text-muted">
      {who}
      {resolved ? ' · resolved' : ''}
    </div>
    <div>{text}</div>
  </div>
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="mx-auto max-w-[1280px] p-3" data-scene={scene}>
    <PullFilesView
      client={client}
      daemon="shot"
      lineExtras={
        scene === 'threads'
          ? at =>
              at.path === 'src/greet.ts' && at.side === 'right' && at.line === 4
                ? thread('@reviewer', 'Should `loud` default to false, or come from the caller’s settings?')
                : at.path === 'src/greet.ts' && at.side === 'left' && at.line === 4
                  ? thread('@author', 'The old greeting had no formatter at all.', true)
                  : null
          : undefined
      }
      number={7}
      project="11111111-1111-4111-8111-111111111111"
      repo={{ provider: 'github', owner: 'octo', name: 'widgets' }}
    />
  </div>,
);
