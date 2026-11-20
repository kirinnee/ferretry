/**
 * THE ONE SWITCH of the Layout page: "Same on all my devices" or "Just this device". The page has one set of rows;
 * this says where a change is saved. It is never a second page and never a second menu entry.
 */
import { Segmented } from '@ferretry/app';
import { SCOPE_WORDS, type Scope } from '../../lib/layout-model.ts';

export function ScopeSwitch({
  scope,
  onChange,
  changes,
}: {
  readonly scope: Scope;
  readonly onChange: (next: Scope) => void;
  /** How many keys this device holds of its own. */
  readonly changes: number;
}) {
  return (
    <div className="fy-lr-scope" data-layout-scope={scope}>
      {/* The page's scope chip, drawn here and not by the shell: it follows the switch, so it can never contradict it. */}
      <div className="fy-lr-scope-head">
        <span className="fy-lr-scope-title">Where a change is saved</span>
        <span
          className="fy-lr-scope-chip"
          data-scope={scope === 'all' ? 'machine' : 'device'}
          data-layout-scope-chip=""
        >
          {scope === 'all' ? 'This machine · every device' : 'Only this browser'}
        </span>
      </div>
      <Segmented
        label="Where a change is saved"
        value={scope}
        options={[
          {
            id: 'all',
            label: SCOPE_WORDS.all,
            title: 'Saved on this computer; every phone or browser that opens it follows this layout.',
          },
          {
            id: 'device',
            label: SCOPE_WORDS.device,
            title: 'Only this browser changes; other devices keep this computer’s layout.',
          },
        ]}
        onChange={onChange}
      />
      <p className="fy-lr-caption" data-layout-caption="">
        {scope === 'all'
          ? 'Saved on this computer — every phone or browser that opens it gets this layout.'
          : changes === 0
            ? 'This device follows this computer’s layout. Change a row to make it different here.'
            : `This device has ${changes} ${changes === 1 ? 'change' : 'changes'} of its own. The other devices keep this computer’s layout.`}
      </p>
    </div>
  );
}
