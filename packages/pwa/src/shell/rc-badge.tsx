/**
 * Remote Control indicator. Ported from kteam `ui/src/components/RcBadge.tsx`.
 *
 * RC is ON by default for claude sessions, so "is this session steerable from my
 * phone / claude.ai?" is a question the UI should answer at a glance rather than
 * something you infer from a launch flag. Two states, deliberately distinct:
 *
 *   rc + url    — the harness has ANNOUNCED its RC surface (bridge_status
 *                 record). Rendered as a real link: one tap opens the session on
 *                 another device. This is the answer to "does the UI come with
 *                 RC" being visibly yes.
 *   rc          — launched with --rc, but the surface has not announced itself
 *                 yet (early boot) or the transcript predates the field. Shown
 *                 as a plain badge, tooltipped, so the absence of a link never
 *                 reads as "RC is off".
 *
 * Nothing renders when the session was not launched with RC — that is a real
 * distinction (codex sessions never have it) and a greyed-out badge everywhere
 * would just be noise.
 */

import { Radio } from 'lucide-react';
import { cn } from '../lib/class-names.ts';
import { Badge } from './primitives.tsx';

const LINKED_HINT = 'Remote Control is active — open this session on claude.ai or your phone';
const PENDING_HINT = 'launched with Remote Control (--rc) — waiting for the harness to announce its RC link';

export interface RcBadgeProps {
  readonly remoteControl?: boolean;
  readonly url?: string;
  /** `sm` drops the label and keeps the dot+icon, for dense mobile rows. */
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

export function RcBadge({ remoteControl, url, size = 'md', className = '' }: RcBadgeProps) {
  if (!remoteControl && !url) return null;

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        title={`${LINKED_HINT}\n${url}`}
        // A card/row can be wrapped in a link; stop the click so opening RC
        // never also navigates the SPA underneath.
        onClick={event => event.stopPropagation()}
        // `.kt-badge[data-tone=ok]` carries the geometry + tone; hover moves to
        // `--accent` because `--accent-border` is decorative tint only now.
        data-tone="ok"
        className={cn('kt-badge shrink-0 transition-colors hover:border-accent hover:text-accent', className)}
      >
        <Radio size={11} />
        {size === 'md' && 'rc'}
      </a>
    );
  }

  return (
    <Badge tone="pend" title={PENDING_HINT} className={cn('shrink-0', className)}>
      <Radio size={11} />
      {size === 'md' && 'rc'}
    </Badge>
  );
}
