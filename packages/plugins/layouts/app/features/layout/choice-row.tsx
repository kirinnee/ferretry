/** A key that takes one word: the name, its choices as a segmented control beside it, and the preview next to that. */
import { Segmented } from '@ferretry/app';
import { useId, useState } from 'react';
import type { Layout } from '../../../contract/index.ts';
import { type ChoiceSetting, choiceOf } from '../../lib/layout-model.ts';
import type { Change } from '../../lib/list-places.ts';
import { LayoutRow } from './layout-row.tsx';
import { LayoutPreview } from './previews/layout-preview.tsx';

/** Saves one or more keys together; answers the reason it was refused, or `undefined` once it is saved. */
export type Apply = (changes: readonly Change[]) => Promise<string | undefined>;

export function ChoiceRow({
  setting,
  layout,
  apply,
  busy,
}: {
  readonly setting: ChoiceSetting;
  readonly layout: Layout;
  readonly apply: Apply;
  readonly busy: boolean;
}) {
  const id = useId();
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const value = choiceOf(layout, setting.path);
  return (
    <LayoutRow
      id={id}
      name={setting.name}
      hint={setting.hint}
      caption={setting.options.find(option => option.id === value)?.title}
      preview={<LayoutPreview setting={setting} value={value} />}
      control={() => (
        <Segmented
          label={setting.name}
          value={value}
          options={setting.options}
          disabled={busy}
          onChange={async word => setRefusal(await apply([{ path: setting.path, value: word }]))}
        />
      )}
    >
      {refusal === undefined ? null : (
        <p role="alert" className="m-0 pt-2 text-meta text-err">
          {refusal}
        </p>
      )}
    </LayoutRow>
  );
}
