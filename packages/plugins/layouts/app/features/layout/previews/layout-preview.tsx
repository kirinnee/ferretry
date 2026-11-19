/**
 * THE PREVIEW BESIDE A LAYOUT CHOICE: the little app that shows what the word on the row does. It loops from the word
 * before to the word now, and replays when the person picks another (`SettingPreview` owns when it moves; the scene is
 * `mini-shell.tsx`). One for every choice key of the tab, the phone ones included. It draws only what the shell draws
 * today, and a word the shell draws the same as another says so in a line under the frame (`captionFor`).
 */
import { SettingPreview } from '@ferretry/app';
import { useState } from 'react';
import type { ChoiceSetting } from '../../../lib/layout-model.ts';
import { MiniShell } from './mini-shell.tsx';
import { captionFor, stateFor, wordBefore } from './scene.ts';
import './previews.css';

export function LayoutPreview({ setting, value }: { readonly setting: ChoiceSetting; readonly value: string }) {
  // The word chosen before this one, so the loop plays "what it was → what it is". Kept the way React asks for a value
  // derived from a prop that changes: set during render, not in an effect that would draw a frame of the old one.
  const [seen, setSeen] = useState<{ readonly value: string; readonly before: string | undefined }>({
    value,
    before: undefined,
  });
  if (seen.value !== value) setSeen({ value, before: seen.value });
  const before = seen.before ?? wordBefore(setting.options, value);
  const label = setting.options.find(option => option.id === value)?.label ?? value;
  const caption = captionFor(setting.path, value);
  return (
    <span className="fy-ls-wrap">
      <SettingPreview
        className="fy-ls"
        label={`${setting.name}: ${label}`}
        value={value}
        before={<MiniShell state={stateFor(setting.path, before)} />}
        after={<MiniShell state={stateFor(setting.path, value)} />}
      />
      {caption === undefined ? null : (
        <span className="fy-ls-caption" data-ls-caption="">
          {caption}
        </span>
      )}
    </span>
  );
}
