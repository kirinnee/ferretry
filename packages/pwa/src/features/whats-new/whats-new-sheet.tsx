/**
 * "WHAT'S NEW" — the recent releases of the build the reader is running, newest first.
 *
 * One frame, two shapes: a bottom sheet on a phone and a centred dialog everywhere else, each modal
 * with Escape, focus-in, focus-back and a Tab trap from the app's one dialog hook. The body is the same
 * in both.
 *
 * ## WRITTEN FOR SKIMMING
 *
 * Each release is a version, a date and (when this device has not seen it) a "New" chip, then short
 * groups — New, Fixed, Faster — of one-line changes. The commit scope is a small tag rather than a
 * `feat(scope):` prefix, and the pull request is a quiet link. A dozen releases show at first; older
 * ones are one tap away so the page never opens as a wall.
 *
 * Nothing here reads the network or storage: the releases and the set of new versions are handed in.
 */

import { ExternalLink, Sparkles, X } from 'lucide-react';
import { Fragment, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import { useScrimDismiss } from '../../hooks/use-scrim-dismiss.ts';
import { type ChangelogChange, type ChangelogRelease, releaseDateLabel } from '../../lib/changelog.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Badge } from '../../shell/primitives.tsx';

const WHATS_NEW_TITLE = 'What’s new';
const WHATS_NEW_DESCRIPTION = 'The latest changes to Ferretry, newest first.';
/** How many releases show before "Show older versions". */
export const WHATS_NEW_FIRST_PAGE = 12;

export type WhatsNewPresentation = 'sheet' | 'dialog';

export interface WhatsNewSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly releases: readonly ChangelogRelease[];
  /** Versions this device has not viewed yet. */
  readonly fresh: ReadonlySet<string>;
  readonly presentation: WhatsNewPresentation;
}

const EXTERNAL = { target: '_blank', rel: 'noreferrer noopener' } as const;

/** `code` spans in a subject, rendered as code; everything else stays text. */
function Words({ text }: { readonly text: string }) {
  return (
    <>
      {text.split('`').map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a split of one string, never reordered
          <code key={index} className="rounded-sm bg-surface-2 px-1 font-mono text-[0.92em]">
            {part}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a split of one string, never reordered
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Change({ change }: { readonly change: ChangelogChange }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-cell leading-base text-fg" data-whats-new-change="">
      {change.scope === undefined ? null : (
        <span
          className="shrink-0 rounded-sm border border-border-soft px-1.5 text-meta text-muted"
          data-whats-new-scope=""
        >
          {change.scope}
        </span>
      )}
      <span className="min-w-0 break-words">
        <Words text={change.text} />
        {change.pr === undefined ? null : (
          <>
            {' '}
            <a
              className="whitespace-nowrap text-meta text-faint underline"
              href={change.pr.url}
              aria-label={`Pull request ${String(change.pr.number)}`}
              {...EXTERNAL}
            >
              #{change.pr.number}
            </a>
          </>
        )}
      </span>
    </li>
  );
}

function ReleaseBlock({ release, fresh }: { readonly release: ChangelogRelease; readonly fresh: boolean }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
      data-whats-new-release={release.version}
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id={headingId} className="m-0 font-display text-row font-semibold text-fg">
          {release.version}
        </h3>
        <time className="text-meta text-faint" dateTime={release.date}>
          {releaseDateLabel(release.date)}
        </time>
        {fresh ? (
          <Badge tone="accent" data-whats-new-new="">
            New
          </Badge>
        ) : null}
      </header>
      {release.groups.length === 0 ? (
        <p className="m-0 text-cell text-muted">Behind-the-scenes fixes only.</p>
      ) : (
        release.groups.map(group => (
          <div key={group.kind} className="flex min-w-0 flex-col gap-1" data-whats-new-group={group.kind}>
            <h4 className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">{group.title}</h4>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {group.changes.map(change => (
                <Change key={`${change.scope ?? ''}|${change.text}`} change={change} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function Body({ releases, fresh }: Pick<WhatsNewSheetProps, 'releases' | 'fresh'>) {
  const [shown, setShown] = useState(WHATS_NEW_FIRST_PAGE);
  const visible = releases.slice(0, shown);
  const newest = releases[0];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4 pt-3" data-whats-new-body="">
      {releases.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-whats-new-empty="">
          This build has no release notes.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          {visible.map(release => (
            <ReleaseBlock key={release.version} release={release} fresh={fresh.has(release.version)} />
          ))}
          {releases.length > visible.length ? (
            <button
              type="button"
              className="kt-btn min-h-[44px] w-full"
              data-whats-new-older=""
              onClick={() => setShown(count => count + WHATS_NEW_FIRST_PAGE)}
            >
              Show older versions
            </button>
          ) : null}
        </div>
      )}
      {newest?.releaseUrl === undefined ? null : (
        <a
          className="mt-4 inline-flex min-h-[44px] items-center gap-1 text-cell text-accent underline"
          href={newest.releaseUrl}
          data-whats-new-github=""
          {...EXTERNAL}
        >
          Full release on GitHub
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

function Heading({ id }: { readonly id: string }) {
  return (
    <div className="flex min-w-0 items-center gap-sm">
      <Sparkles aria-hidden="true" className="shrink-0 text-accent" size={16} />
      <h2 id={id} className="m-0 min-w-0 truncate font-display text-title font-semibold tracking-display text-fg">
        {WHATS_NEW_TITLE}
      </h2>
    </div>
  );
}

function WhatsNewDialog({ open, onClose, releases, fresh }: WhatsNewSheetProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(open, dialogRef, onClose);
  const scrim = useScrimDismiss(onClose);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-2"
      data-whats-new="dialog"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close what’s new"
        className="absolute inset-0 cursor-default"
        {...scrim}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="kt-panel relative flex max-h-[min(86dvh,820px)] w-full max-w-xl flex-col overflow-hidden p-0 shadow-popover focus:outline-none"
      >
        <header className="flex min-w-0 items-start gap-sm border-b border-border-soft px-panel py-3">
          <div className="min-w-0 flex-1">
            <Heading id={titleId} />
            <p className="mb-0 mt-1 text-ui leading-base text-muted">{WHATS_NEW_DESCRIPTION}</p>
          </div>
          <button
            type="button"
            aria-label="Close what’s new"
            className="kt-btn h-9 w-9 shrink-0 p-0"
            data-whats-new-close=""
            onClick={onClose}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <Body releases={releases} fresh={fresh} />
      </div>
    </div>
  );
}

function WhatsNewBottomSheet({ open, onClose, releases, fresh }: WhatsNewSheetProps) {
  const titleId = useId();
  return (
    <BottomSheet
      id="whats-new"
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      closeLabel="Close what’s new"
      panelClassName="kt-details bg-surface"
      maxHeight="min(90dvh, calc(var(--app-h, 100dvh) - var(--gap-xs)))"
      zIndexClass="z-50"
    >
      <header
        className="flex min-w-0 shrink-0 items-start gap-sm border-b border-border-soft px-panel pb-row-y"
        data-whats-new="sheet"
      >
        <div className="min-w-0 flex-1">
          <Heading id={titleId} />
          <p className="mb-0 mt-1 text-ui leading-base text-muted">{WHATS_NEW_DESCRIPTION}</p>
        </div>
        <button
          type="button"
          aria-label="Close what’s new"
          className="kt-btn h-11 w-11 shrink-0 p-0"
          data-whats-new-close=""
          onClick={onClose}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>
      {open ? <Body releases={releases} fresh={fresh} /> : null}
    </BottomSheet>
  );
}

/** What's new, in a sheet on a phone and a dialog elsewhere. */
export function WhatsNewSheet(props: WhatsNewSheetProps) {
  return props.presentation === 'sheet' ? <WhatsNewBottomSheet {...props} /> : <WhatsNewDialog {...props} />;
}
