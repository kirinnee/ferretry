/**
 * THE NOTICE THAT AN UPDATE WAS REFUSED, OR THAT THE APP'S CHECKER ITSELF WAS REPLACED.
 *
 * Raised by `hooks/use-release-integrity.ts`. Plain words only: the reader is told what happened,
 * that the version they have is still the one running, and what to do — never "manifest", "hash" or
 * "service worker". The two kinds differ in weight on purpose:
 *
 *   - a REFUSED update is reassuring news with a cause: nothing changed, keep working;
 *   - an UNSIGNED worker is the one this design cannot stop, only report, so it is an alert and it
 *     cannot be dismissed — the reader has to see it every time until it is resolved.
 */

import { ShieldAlert } from 'lucide-react';
import type { ReleaseNotice } from '../hooks/use-release-integrity.ts';
import { RELEASE_REFUSAL_WORDS } from '../lib/release-verification.ts';
import { Button } from './primitives.tsx';

/** The words, as data, so a suite can assert them without rendering. */
export const releaseNoticeWords = (notice: ReleaseNotice): { readonly title: string; readonly body: string } => {
  if (notice.kind === 'unsigned-worker') {
    return {
      title: 'This app may have been tampered with',
      body:
        'A new version of the part of this app that checks updates was installed, and it is not one Ferretry signed. ' +
        'Do not approve anything you did not start. Close this tab, then open Ferretry again from the address you trust.',
    };
  }
  const reason = RELEASE_REFUSAL_WORDS[notice.refusal];
  return {
    title: 'An update failed verification',
    body: notice.hadRelease
      ? `An update to this app was blocked because ${reason}. You are still using the version you had, which is safe to keep using.`
      : `This copy of the app could not be checked because ${reason}. It works, but it is not protected against a changed update until a signed version arrives.`,
  };
};

export interface ReleaseNoticeBannerProps {
  readonly notice: ReleaseNotice;
  readonly onDismiss: () => void;
}

export function ReleaseNoticeBanner({ notice, onDismiss }: ReleaseNoticeBannerProps) {
  const { title, body } = releaseNoticeWords(notice);
  const alarm = notice.kind === 'unsigned-worker';
  return (
    <div
      role={alarm ? 'alert' : 'status'}
      data-release-notice={notice.kind}
      className={`mx-1 mt-1 flex items-start gap-2 rounded-md border px-3 py-2 text-ui sm:mx-3 ${
        alarm ? 'border-err-border bg-err-bg text-fg' : 'border-warn-border bg-warn-bg text-fg'
      }`}
    >
      <ShieldAlert aria-hidden="true" className={`mt-[2px] size-4 shrink-0 ${alarm ? 'text-err' : 'text-warn'}`} />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-semibold">{title}</p>
        <p className="m-0 mt-[2px] text-muted">{body}</p>
      </div>
      {alarm ? null : (
        <Button size="sm" variant="ghost" className="shrink-0" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  );
}
