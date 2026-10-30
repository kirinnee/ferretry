/** THE ICONS A CARD AND THE COUNTS BAR WEAR: drawn from the app's icon set, so they look the same on every machine. */

import {
  Activity,
  Check,
  Clock,
  FlaskConical,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hourglass,
  Link2,
  ListChecks,
  OctagonPause,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react';
import type { BoardIconName } from '../../lib/board-present.ts';

const ICONS: Readonly<Record<BoardIconName, typeof Activity>> = {
  active: Activity,
  'to-test': FlaskConical,
  stale: TriangleAlert,
  'waiting-on-you': OctagonPause,
  waiting: Hourglass,
  orphaned: Unplug,
  blocked: Link2,
  subs: ListChecks,
  'pr-merged': GitMerge,
  'pr-closed': GitPullRequestClosed,
  'pr-draft': GitPullRequestDraft,
  'pr-pass': Check,
  'pr-fail': X,
  'pr-pending': Clock,
};

export function BoardIcon({ name, size = 11 }: { readonly name: BoardIconName; readonly size?: number }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" className="fy-board-icon" size={size} />;
}
