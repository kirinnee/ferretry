/**
 * The browser entry for "the menu looks the same everywhere": the REAL `ContextMenu` (open, its rows drawn with the shared
 * `kt-menu-item` class), a native dropdown and the page they float over. Fake data; no daemon.
 *
 *   ?theme=<family>-<mode>   [&touch=1]   [&picker=1: the picker's option list instead of the context menu]
 */
import { createRoot } from 'react-dom/client';
import { ContextMenu } from '../../../src/ui/context-menu.tsx';
import { defaultPickerRow, PickerCombobox } from '../../../src/ui/picker-combobox.tsx';
import type { PickerOption } from '../../../src/ui/picker-model.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const touch = params.get('touch') === '1';

const noop = () => undefined;

const accounts: readonly PickerOption[] = [
  { value: 'claude-auto-loge', label: 'claude-auto-loge', search: 'claude', detail: '5h 12% · resets in a while' },
  { value: 'codex-auto-atomi', label: 'codex-auto-atomi', search: 'codex', detail: 'account default' },
  { value: 'glm-mass', label: 'glm-mass', search: 'glm', disabled: true, disabledReason: 'no wrapper on PATH' },
];

const picker = (
  <main className="bg-bg text-fg" style={{ minHeight: '100vh', padding: 16 }}>
    <div style={{ position: 'relative', width: 320 }}>
      <PickerCombobox
        label="Account"
        onValueChange={noop}
        renderOption={defaultPickerRow}
        source={{ kind: 'ready', options: accounts }}
        value=""
      />
    </div>
  </main>
);

createRoot(document.getElementById('root') as HTMLElement).render(
  params.get('picker') === '1' ? (
    picker
  ) : (
    <main className="bg-bg text-fg" style={{ minHeight: '100vh', padding: 16 }}>
      <p>Fixture ferret · muriel</p>
      <label>
        Machine{' '}
        <select defaultValue="workshop-host">
          <option>workshop-host</option>
          <option>laptop</option>
        </select>
      </label>
      <ContextMenu
        anchor={{ x: 24, y: 120 }}
        ariaLabel="Ferret actions"
        items={[
          { key: 'resume', label: 'Resume', onSelect: noop },
          { key: 'rename', label: 'Rename…', detail: 'F2', onSelect: noop },
          { key: 'move', label: 'Move to project…', hint: 'Changes where it runs next time', onSelect: noop },
          { key: 'pin', label: 'Pin', disabled: true, onSelect: noop },
          { key: 'stop', label: 'Stop ferret', danger: true, separatorBefore: true, onSelect: noop },
        ]}
        onClose={noop}
        open
        touch={touch}
      />
    </main>
  ),
);
