/**
 * "+ Add skills", in place: the skills on other accounts and projects on THIS MACHINE that this ferret does not have, each
 * with Install (or Installed, once it was copied) — the copy route's preview → review → passkey → apply, Skills' own
 * (G172–G175). Catalog subscriptions are Catalogs'; they are not on this page (ports-pending: skills).
 */
import { Button, SidePaneSearch } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FerretSkillsInventory, LocalSkillInstall, MachineSkillsInventory } from '../../contract/index.ts';
import { listSkillInstalls, readMachineSkills } from '../lib/client.ts';
import {
  ADD_SKILLS_BACK,
  ADD_SKILLS_TITLE,
  filterMachineRows,
  INSTALL_BUTTON,
  INSTALLED_LABEL,
  MACHINE_NOTE,
  MACHINE_TRUNCATED,
  MACHINE_UNREADABLE,
  type MachineSkillRow,
  machineRows,
  NO_MACHINE_MATCH,
  NO_MACHINE_SKILLS,
  ON_THIS_MACHINE,
  READING_MACHINE,
  REFRESH_BUTTON,
  rowFromLine,
  targetOptions,
} from '../lib/skills-model.ts';
import { LocalInstallSheet } from './local-install-sheet.tsx';

/** `undefined`: still reading. `null`: the machine's skills could not be read. */
type Machine = { readonly inventory: MachineSkillsInventory; readonly copied: ReadonlySet<string> } | null | undefined;

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

export function AddSkills({
  client,
  ferret,
  onBack,
}: {
  readonly client: Pick<PluginClient, 'call'>;
  readonly ferret: Pick<FerretSkillsInventory, 'skills'>;
  readonly onBack: () => void;
}) {
  const [machine, setMachine] = useState<Machine>(undefined);
  const [query, setQuery] = useState('');
  const [installing, setInstalling] = useState<MachineSkillRow | null>(null);
  const [attempt, setAttempt] = useState(0);

  // `attempt` is in the list although the body never reads it: bumping it IS the refresh.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the refresh trigger
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [inventory, installs] = await Promise.all([readMachineSkills(client), listSkillInstalls(client)]);
        if (live) setMachine({ inventory, copied: new Set(installs.installs.map(install => install.origin.path)) });
      } catch {
        if (live) setMachine(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [client, attempt]);

  const all = useMemo(
    () => (machine ? machineRows(machine.inventory, ferret, machine.copied) : undefined),
    [machine, ferret],
  );
  const shown = useMemo(() => (all === undefined ? undefined : filterMachineRows(all, query)), [all, query]);
  const rows: readonly MachineSkillRow[] | null | undefined = machine === null ? null : shown;
  const options = useMemo(() => (machine ? targetOptions(machine.inventory) : { projects: [] }), [machine]);
  const done = useCallback((installed: LocalSkillInstall | null) => {
    setInstalling(null);
    if (installed !== null) setAttempt(value => value + 1);
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-sm" data-add-skills="">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-xs">
        <Button type="button" size="sm" onClick={onBack} data-add-skills-back="">
          <ArrowLeft size={14} aria-hidden="true" /> {ADD_SKILLS_BACK}
        </Button>
        <Button type="button" size="sm" onClick={() => setAttempt(value => value + 1)} data-add-skills-refresh="">
          <RefreshCw size={14} aria-hidden="true" /> {REFRESH_BUTTON}
        </Button>
      </div>
      <h2 className="m-0 text-row font-semibold text-fg">{ADD_SKILLS_TITLE}</h2>
      <SidePaneSearch
        ariaLabel="Search skills on this machine"
        placeholder="Search skills on this machine…"
        value={query}
        onChange={setQuery}
      />
      <section className="flex min-w-0 flex-col gap-xs" aria-label={ON_THIS_MACHINE} data-add-skills-machine="">
        <h3 className="m-0 text-cell font-semibold text-fg">{ON_THIS_MACHINE}</h3>
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
            {(all?.length ?? 0) === 0 ? NO_MACHINE_SKILLS : NO_MACHINE_MATCH}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label={ON_THIS_MACHINE}>
            {rows.map(row => (
              <li key={row.path} className="min-w-0">
                <MachineRowView row={row} onInstall={() => setInstalling(row)} />
              </li>
            ))}
          </ul>
        )}
        {machine?.inventory.truncated === true ? (
          <p className="m-0 text-meta text-muted" data-add-skills-machine-truncated="">
            {MACHINE_TRUNCATED}
          </p>
        ) : null}
      </section>
      {installing === null ? null : (
        <LocalInstallSheet client={client} row={installing} options={options} onClose={done} />
      )}
    </div>
  );
}
