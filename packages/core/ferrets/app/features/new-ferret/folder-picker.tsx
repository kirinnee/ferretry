/**
 * THE FOLDER FIELD. A text box that offers folders this daemon's ferrets were recently started in beside it.
 *
 * It reads nothing itself (the page hands it the read) and writes nothing: choosing a row types a path, and the typed
 * text is what the page submits. Today's `DaemonProjectPicker`, narrowed to the one kind of row Ferrets can name.
 */

import { FolderClock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, PickerCombobox } from '../../ui.ts';
import { type FolderOption, type FolderRead, folderSource } from './recent-folders.ts';

/**
 * WHAT AN EMPTY FOLDER LIST SAYS, once for both channels: the visible notice and the spoken status are a pair on
 * purpose, and written once here so two literals that must agree cannot drift apart.
 */
const EMPTY_COPY = 'No ferret on this daemon has been started in a folder yet. Type a path instead.';

/**
 * The absolute path IS the submitted value, and two folders can share every visible character of a truncated one,
 * so a phone wraps it (`break-all`) rather than cutting it.
 */
function FolderRow(option: FolderOption): ReactNode {
  return (
    <span
      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 sm:flex-row sm:justify-between sm:gap-sm"
      data-picker-row="folder"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-current">{option.name}</span>
        <span
          className={cn('mono text-meta text-muted', 'break-all sm:break-normal sm:truncate')}
          data-picker-identity="path"
        >
          {option.value}
        </span>
      </span>
      <span
        className="kt-label flex shrink-0 items-center gap-1 rounded-badge border border-border-soft bg-surface px-1.5 py-0.5 text-faint"
        title="a folder a ferret was started in — choosing it registers nothing"
      >
        <FolderClock aria-hidden="true" size={11} />
        Recent
      </span>
    </span>
  );
}

export interface FolderPickerProps {
  /** Used verbatim, so the page's own `<label htmlFor>` keeps pointing at it. */
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  readonly read: FolderRead;
}

export function FolderPicker({ read, ...field }: FolderPickerProps): ReactNode {
  return (
    <PickerCombobox
      emptyNotice={EMPTY_COPY}
      emptyStatus={EMPTY_COPY}
      id={field.id}
      label={field.label}
      onValueChange={field.onValueChange}
      placeholder={field.placeholder}
      renderOption={FolderRow}
      source={folderSource(read)}
      value={field.value}
    />
  );
}
