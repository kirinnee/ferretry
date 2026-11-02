/**
 * The "On this machine" group of the Add skills page: skills on other accounts and projects here that this
 * session does not have, each with Install (or Installed, once it was copied).
 */

import { Button } from '../../shell/primitives.tsx';
import { INSTALL_BUTTON, INSTALLED_LABEL } from './add-skills-model.ts';
import {
  MACHINE_NOTE,
  MACHINE_TRUNCATED,
  MACHINE_UNREADABLE,
  type MachineSkillRow,
  NO_MACHINE_MATCH,
  NO_MACHINE_SKILLS,
  ON_THIS_MACHINE,
  READING_MACHINE,
  rowFromLine,
} from './machine-skills-model.ts';

/** `undefined`: still reading. `null`: the machine's skills could not be read. */
export type MachineRows = readonly MachineSkillRow[] | null | undefined;

export function MachineGroup({
  rows,
  all,
  truncated,
  onInstall,
}: {
  /** The rows the search leaves. */
  readonly rows: MachineRows;
  /** How many rows there are before the search. */
  readonly all: number;
  readonly truncated: boolean;
  readonly onInstall: (row: MachineSkillRow) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-xs" aria-label={ON_THIS_MACHINE} data-add-skills-machine="">
      <h2 className="m-0 text-cell font-semibold text-fg">{ON_THIS_MACHINE}</h2>
      <p className="m-0 break-words text-meta text-muted">{MACHINE_NOTE}</p>
      {rows === undefined ? (
        <p className="m-0 text-cell text-muted" role="status">
          {READING_MACHINE}
        </p>
      ) : rows === null ? (
        <p className="m-0 break-words text-cell text-err" data-add-skills-machine-failed="">
          {MACHINE_UNREADABLE}
        </p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-add-skills-machine-none="">
          {all === 0 ? NO_MACHINE_SKILLS : NO_MACHINE_MATCH}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={ON_THIS_MACHINE}>
          {rows.map(row => (
            <li key={row.path} className="min-w-0">
              <MachineRowView row={row} onInstall={() => onInstall(row)} />
            </li>
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="m-0 text-meta text-muted" data-add-skills-machine-truncated="">
          {MACHINE_TRUNCATED}
        </p>
      ) : null}
    </section>
  );
}

function MachineRowView({ row, onInstall }: { readonly row: MachineSkillRow; readonly onInstall: () => void }) {
  return (
    <div className="kt-panel flex min-w-0 items-start gap-xs px-control-x py-2" data-add-skills-machine-row={row.path}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words text-cell font-semibold text-fg">{row.name}</span>
        <span className="break-words text-meta text-muted">{rowFromLine(row)}</span>
        <span className="break-words text-meta text-muted">{row.description}</span>
      </div>
      {row.installed ? (
        <span className="shrink-0 text-cell text-ok" data-add-skills-machine-installed="">
          {INSTALLED_LABEL}
        </span>
      ) : (
        <Button type="button" size="sm" variant="primary" onClick={onInstall} data-add-skills-machine-install="">
          {INSTALL_BUTTON}
          <span className="sr-only"> {row.name}</span>
        </Button>
      )}
    </div>
  );
}
