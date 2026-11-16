/**
 * HOW A REFERENCE CLICK BRINGS FILES ON SCREEN. The chat's reference surface is built above the workspace that holds the
 * `files` panel, so it cannot read the workspace itself; this draws nothing and, from inside the workspace, hands the
 * surface the one thing it may ask: show the `files` panel of THIS ferret (a no-op beside the chat on a desktop; the chip
 * that moves on a phone). A workspace that shows another ferret is never moved.
 */
import { useFerretWorkspace } from '@ferretry/app';
import { type RefObject, useEffect } from 'react';

/** The id Ferrets declares for its file browser on `ferret.side`. */
const FILES_PANEL = 'files';

export function FilesPanelBridge({
  ferretId,
  target,
}: {
  readonly ferretId: string;
  readonly target: RefObject<(() => void) | undefined>;
}) {
  const workspace = useFerretWorkspace();
  useEffect(() => {
    target.current = workspace?.ferret === ferretId ? () => workspace.showPanel(FILES_PANEL) : undefined;
    return () => {
      target.current = undefined;
    };
  }, [workspace, ferretId, target]);
  return null;
}
