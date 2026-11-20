/**
 * Where the Warden's first-run page draws the Jev key: Voice's own `speedup-key` panel, placed by the shell in the
 * `settings` slot, for the subject `jev`. Voice draws the write-only field, Save and Test; the Warden never holds the
 * key or what is typed, and mounts no link to Settings. Where no panel is placed (Voice off) nothing is drawn.
 */
import { PanelSlot } from '@ferretry/app';

/** The one panel this slot may show: Voice's key row. */
const isKeyRow = (ref: { readonly plugin: string; readonly id: string }): boolean =>
  ref.plugin === 'voice' && ref.id === 'speedup-key';

export function JevKeyRow({ daemon }: { readonly daemon: string }) {
  return <PanelSlot daemon={daemon} slot="settings" subject="jev" include={isKeyRow} />;
}
