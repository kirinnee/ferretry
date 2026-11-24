/**
 * The browser entry for "the terminal's REAL scrollback": a real `@xterm/xterm` Terminal opened in the plugin's own `kt-webterm`
 * frame, fitted to it and wearing the plugin's own `terminalTheme()` (its background, ink and scrollbar slider), with 200 lines
 * written so there is a scrollback. No daemon, no network, fake text.
 *
 *   ?style=<id>&palette=<id>&mode=light|dark     the look the page wears (default studio, light)
 *
 * `window.__xterm` is set once the lines are written.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { terminalTheme } from '../../../../app/components/session-terminal-deck.tsx';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
const mode = params.get('mode') ?? 'light';
const palette = params.get('palette') ?? 'studio';
root.dataset.style = params.get('style') ?? 'studio';
root.dataset.palette = palette;
root.dataset.mode = mode;
root.dataset.theme = `${palette}-${mode}`;

const mount = document.getElementById('root') as HTMLElement;
mount.innerHTML =
  '<div style="width:640px;height:320px;display:flex"><div class="kt-webterm__stage"><div class="kt-webterm__panel"><div class="kt-webterm__xterm" id="host"></div></div></div></div>';

const terminal = new Terminal({ cursorBlink: false, fontSize: 12.5, scrollback: 1_000, theme: terminalTheme() });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(document.getElementById('host') as HTMLElement);
fit.fit();
terminal.write(`${Array.from({ length: 200 }, (_, line) => `$ build step ${line + 1}  ok`).join('\r\n')}\r\n`, () => {
  (window as unknown as { __xterm: unknown }).__xterm = true;
});
