/**
 * WHICH `composer.tools` PANELS ARE READOUTS. The slot is drawn in two places: the controls you act with (attach, the
 * mic) stay in the row beside the text box; the readouts of the session — Runtimes' model, thinking and speed chip and
 * Usage's quota — go on the status line under the row, so a plugin's readout never takes the text box's room.
 */

/** The panels that are readouts, as `<plugin>.<id>`; every other panel in the slot is a control in the row. */
const STATUS_PANELS: ReadonlySet<string> = new Set(['runtimes.runtime-picker', 'usage.composer-quota']);

export const isStatusPanel = (panel: { readonly plugin: string; readonly id: string }): boolean =>
  STATUS_PANELS.has(`${panel.plugin}.${panel.id}`);
