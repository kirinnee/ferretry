/**
 * One shared item, read in full before anything is installed.
 *
 * The review is the same one the install-from-file sheet shows: every file, every command, every
 * warning, written by the same functions the installing machine uses. "Install on a machine" hands the
 * verified item to the person's OWN paired machine and its normal confirm; the publisher is not asked.
 */

import {
  type CatalogInstallWarning,
  type CatalogReviewEntry,
  catalogItemReview,
  catalogItemWarnings,
  revealHidden,
} from '../../../contract/wire/index.ts';
import { createContext, useContext, useId, useMemo, useState } from 'react';
import type { DaemonConnection } from '../../lib/machine.ts';
import type { OpenedItemValue } from './shared-controller.ts';
import { Button } from '@ferretry/app/ui';
import { CatalogSheet } from '../catalogs/catalog-parts.tsx';
import type { TargetDraft } from '../catalogs/catalog-install-model.ts';
import { MarkedText, ReviewBody, WarningList } from '../catalogs/catalog-review-view.tsx';
import { InstallFromFileSheet, type InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { INSTALL_ON_LABEL, INSTALL_ON_MACHINE, kindLabel, NOT_PAIRED_NOTE } from './shared-screens-model.ts';

/** A machine this browser is paired with, to install on. */
export interface InstallMachine {
  readonly connection: DaemonConnection;
  readonly name: string;
}

export type OpenedSharedItem = OpenedItemValue;

/** A machine the person chose to install on, with the host that reaches it (S10: only the person's choice gives one). */
export interface ChosenInstall {
  readonly machine: InstallMachine;
  readonly host: InstallHost;
}

/** Asks the person which machine to install on; `undefined` when they cancel. */
export type ChooseInstall = () => Promise<ChosenInstall | undefined>;

/**
 * A screen with no machine of its own (the daemon-less /shared) offers Install by asking: this is the shell's picker.
 * Absent where machines are listed up front.
 */
export const ChooseInstallContext = createContext<ChooseInstall | undefined>(undefined);

export function SharedItemSheet({
  shown,
  publisherLabel,
  machines,
  installHost,
  preferredTarget,
  onClose,
}: {
  readonly shown: OpenedSharedItem;
  /** The person's own name for the publisher. */
  readonly publisherLabel: string;
  readonly machines: readonly InstallMachine[];
  readonly installHost?: InstallHost;
  /** Passed to the install sheet as its first choice of place. */
  readonly preferredTarget?: TargetDraft;
  readonly onClose: () => void;
}) {
  const { item, opened, entry } = shown;
  const entries = useMemo<readonly CatalogReviewEntry[]>(() => catalogItemReview(item), [item]);
  const warnings = useMemo<readonly CatalogInstallWarning[]>(() => catalogItemWarnings(item), [item]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [chosen, setChosen] = useState<ChosenInstall | null>(null);
  const choose = useContext(ChooseInstallContext);
  const pickId = useId();
  const listed = machines.find(machine => machine.connection.daemonId === pickedId) ?? machines[0];
  const target = chosen?.machine ?? listed;
  const host = chosen?.host ?? installHost;
  const ask = async (): Promise<void> => {
    const answer = await choose?.();
    if (answer === undefined) return;
    setChosen(answer);
    setInstalling(true);
  };

  if (installing && target !== undefined)
    return (
      <InstallFromFileSheet
        connection={target.connection}
        source={{ opened, itemId: entry.itemId, publisherLabel }}
        {...(host === undefined ? {} : { host })}
        {...(preferredTarget === undefined ? {} : { preferredTarget })}
        onClose={() => {
          setInstalling(false);
          setChosen(null);
        }}
      />
    );

  return (
    <CatalogSheet
      name="shared-item"
      title={revealHidden(entry.name)}
      subtitle={`${kindLabel(entry.kind)} · version ${entry.version} · from ${revealHidden(publisherLabel)}`}
      closeLabel={`Close ${revealHidden(entry.name)}`}
      onClose={onClose}
    >
      <p className="m-0 break-words text-cell text-muted">
        <MarkedText text={entry.summary} />
      </p>
      <WarningList warnings={warnings} />
      <ReviewBody entries={entries} warnings={warnings} audience="installer" />
      {target === undefined && choose !== undefined ? (
        <div className="flex min-w-0 flex-col gap-xs" data-shared-install="">
          <Button type="button" variant="primary" onClick={() => void ask()} data-shared-install-button="">
            {INSTALL_ON_MACHINE}
          </Button>
        </div>
      ) : target === undefined ? (
        <p className="m-0 text-cell text-muted" data-shared-not-paired="">
          {NOT_PAIRED_NOTE}
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-xs" data-shared-install="">
          {machines.length > 1 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={pickId} className="text-meta font-semibold text-muted">
                {INSTALL_ON_LABEL}
              </label>
              <select
                id={pickId}
                className="kt-input"
                value={target.connection.daemonId}
                onChange={event => setPickedId(event.target.value)}
                data-shared-machine=""
              >
                {machines.map(machine => (
                  <option key={machine.connection.daemonId} value={machine.connection.daemonId}>
                    {machine.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <Button type="button" variant="primary" onClick={() => setInstalling(true)} data-shared-install-button="">
            {INSTALL_ON_MACHINE}
          </Button>
        </div>
      )}
    </CatalogSheet>
  );
}
