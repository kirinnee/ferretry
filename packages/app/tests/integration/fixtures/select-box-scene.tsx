/**
 * The browser entry for SelectBox and Dialog over fake data.
 *
 *   ?theme=<family>-<mode>     the theme the page is drawn in
 *   ?n=<1..120>                how many options the list has (default 5; the first 8 are named, the rest are "Option 9"...)
 *   ?searchable=auto|always|never
 *   ?edge=bottom               the box sits at the foot of the window (the popover must flip up)
 *   ?pane=<px>                 the box sits in a component container (CSS `container-type: inline-size`) of that width
 *   ?dialog=1                  the bare Dialog instead: a sheet of `lines` lines of text (default 3) with a Close button
 *   ?lines=<n>
 *
 * Every pick is recorded on `window.__picks` (an array of values) and echoed in `[data-picks]`.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '../../../src/ui/dialog.tsx';
import { SelectBox, type SelectOption } from '../../../src/ui/select-box.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const NAMED: readonly SelectOption[] = [
  { value: 'automatic', label: 'Automatic', hint: 'Ferretry picks' },
  { value: 'auto-approve', label: 'Auto-approve edits', group: 'Permissions' },
  { value: 'ask', label: 'Ask every time', group: 'Permissions' },
  { value: 'plan', label: 'Plan only', hint: 'reads, never writes', group: 'Permissions' },
  { value: 'read-only', label: 'Read only', group: 'Permissions', disabled: true },
  { value: 'cafe', label: 'Café mode', hint: `long hint ${'that goes on and on '.repeat(6)}` },
  { value: 'fast', label: 'Fast' },
  { value: 'slow', label: 'Slow' },
];

const count = Math.min(120, Math.max(1, Number(params.get('n') ?? '5')));
const OPTIONS: readonly SelectOption[] = Array.from(
  { length: count },
  (_, index) => NAMED[index] ?? { value: `opt-${index + 1}`, label: `Option ${index + 1}` },
);

declare global {
  interface Window {
    __picks: string[];
  }
}
window.__picks = [];

const searchable = (params.get('searchable') ?? 'auto') as 'auto' | 'always' | 'never';

const pane = Number(params.get('pane') ?? '0');

const Box = () => {
  const [value, setValue] = useState('automatic');
  const field = (
    <div
      style={params.get('edge') === 'bottom' ? { position: 'fixed', left: 16, right: 16, bottom: 16 } : { padding: 16 }}
    >
      <label htmlFor="agent-default">Default for new agents</label>
      <div style={{ width: 280, maxWidth: '100%' }}>
        <SelectBox
          id="agent-default"
          label="Default for new agents"
          value={value}
          onChange={next => {
            window.__picks.push(next);
            setValue(next);
            const echo = document.querySelector('[data-picks]');
            if (echo !== null) echo.textContent = window.__picks.join(',');
          }}
          options={OPTIONS}
          searchable={searchable}
        />
      </div>
      <output data-picks="" />
      <button type="button" data-after="">
        After
      </button>
    </div>
  );
  return pane > 0 ? (
    <div data-pane="" style={{ containerType: 'inline-size', width: pane }}>
      {field}
    </div>
  ) : (
    field
  );
};

const Sheet = () => {
  const [open, setOpen] = useState(false);
  const lines = Math.max(1, Number(params.get('lines') ?? '3'));
  return (
    <div style={{ padding: 16 }}>
      <button type="button" data-open="" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="A centred dialog" closeLabel="Close">
        {Array.from({ length: lines }, (_, index) => `Line ${index + 1} of the dialog body.`).map(line => (
          <p key={line} style={{ margin: '0 0 8px' }}>
            {line}
          </p>
        ))}
      </Dialog>
    </div>
  );
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <>
      {params.get('dialog') === '1' ? <Sheet /> : <Box />}
      <div aria-hidden="true" style={{ height: 3000 }} data-filler="" />
    </>,
  );
