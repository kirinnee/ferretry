/**
 * "What's new" on a page of its own (`?whats-new`): the real sheet — a bottom sheet on a phone, a
 * dialog elsewhere — over a quiet page, fed a fixed changelog so every capture reads the same.
 *
 * The releases are written here rather than read from `Changelog.md`: a capture must not change when
 * a release lands. Their shape is exactly what `parseChangelog` returns for the real file.
 */

import { useState } from 'react';
import { WhatsNewSheet } from '../src/features/whats-new/whats-new-sheet.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import { type ChangelogRelease, parseChangelog } from '../src/lib/changelog.ts';

/** `?whats-new` names this page. */
export const isWhatsNewPage = (search: string): boolean => new URLSearchParams(search).has('whats-new');

const REPO = 'https://github.com/example/ferretry';
const line = (scope: string, text: string, pr: number): string =>
  `* **${scope}:** ${text} ([#${String(pr)}](${REPO}/issues/${String(pr)})) ([abcdef${String(pr).padStart(1, '0')}](${REPO}/commit/abcdef0))`;
const heading = (version: string, previous: string, date: string): string =>
  `## [${version}](${REPO}/compare/v${previous}...v${version}) (${date})`;

const SAMPLE = [
  heading('4.93.0', '4.92.1', '2026-10-29'),
  '### Features',
  line('attention', 'batch your answers to a ferret into one message', 817),
  line('sessions', 'find any session from the finder with `Ctrl+K`', 818),
  '### Fixes',
  line('chat', 'show a reply as the agent writes it, block by block', 815),
  heading('4.92.1', '4.92.0', '2026-10-28'),
  '### Fixes',
  line('daemon', 'keep a ferret’s raise so your answer reaches it', 813),
  heading('4.92.0', '4.91.0', '2026-10-27'),
  '### Features',
  line('daemon', 'raise a harness parked on its own prompt as an Attention item', 814),
  '### Performance',
  line('pwa', 'open long sessions without a replay storm', 683),
  ...Array.from({ length: 12 }, (_, index) => [
    heading(`4.${String(91 - index)}.0`, `4.${String(90 - index)}.0`, '2026-10-20'),
    '### Fixes',
    line('fleet', `tidy a small rough edge, part ${String(index + 1)}`, 700 + index),
  ]).flat(),
].join('\n\n');

const RELEASES: readonly ChangelogRelease[] = parseChangelog(SAMPLE);
/** The two newest are what this device has not viewed. */
const FRESH: ReadonlySet<string> = new Set(['4.93.0', '4.92.1']);

export function WhatsNewHarness() {
  useAppViewport();
  const phone = useLayoutMode() === 'drawer';
  const [open, setOpen] = useState(true);
  return (
    <div className="kt-shell flex overflow-hidden" id="harness-whats-new">
      <main className="min-h-0 flex-1 p-panel text-cell text-muted">The page goes here.</main>
      <WhatsNewSheet
        fresh={FRESH}
        onClose={() => setOpen(false)}
        open={open}
        presentation={phone ? 'sheet' : 'dialog'}
        releases={RELEASES}
      />
    </div>
  );
}
