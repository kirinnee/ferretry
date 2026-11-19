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
      <Segmented
        label="Where a change is saved"
        value={scope}
        options={[
          { id: 'all', label: SCOPE_WORDS.all, title: 'Every device that follows the shared layout changes too.' },
          {
            id: 'device',
            label: SCOPE_WORDS.device,
            title: 'Only this browser changes; other devices keep the shared layout.',
          },
        ]}
        onChange={onChange}
      />
      <p className="fy-lr-caption" data-layout-caption="">
        {scope === 'all'
          ? 'Every device that follows the shared layout changes with it.'
          : changes === 0
            ? 'This device follows the shared layout. Change a row to make it different here.'
            : `This device has ${changes} ${changes === 1 ? 'change' : 'changes'} of its own. The other devices keep the shared layout.`}
      </p>
    </div>
  );
}
