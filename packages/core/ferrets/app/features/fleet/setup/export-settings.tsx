/**
 * Export settings (spec R6; build plan P9): this machine's configuration files as one zip, without
 * secrets — for a backup, or to read and edit by hand. The rules are `export-settings-model.ts`.
 *
 * The zip is built in this browser from the files the machine already serves, so the export is
 * exactly what `GET /v1/config/file` answers and nothing more; a file the daemon refused (which can
 * hold a pasted key) is left out and named.
 */

import { secretReference } from '@ferretry/protocol';
import { ChevronLeft, Download } from 'lucide-react';
import { useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { readConfigFile, readConfigStatus } from '../../config-files/config-files-api.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import {
  type ExportFile,
  type ExportPlan,
  exportFileName,
  exportManifest,
  exportPlan,
  zipFiles,
} from './export-settings-model.ts';
import { SetupCommand, SetupNote, SetupSection } from './setup-ui.tsx';
import { countWords } from './setup-words.ts';

/** Hands the finished zip to the person. */
export type SaveFile = (fileName: string, bytes: Uint8Array) => void;

/** The browser's own download: an object URL on a link that is clicked once, then let go. */
export const downloadFile: SaveFile = (fileName, bytes) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
};

export interface ExportSettingsProps {
  readonly connection: DaemonConnection;
  readonly machineName: string;
  readonly createClient: FleetClientFactory;
  /** Back to the Machine tab. */
  readonly onLeave?: () => void;
  /** Tests and the harness keep the zip instead of downloading it. */
  readonly save?: SaveFile;
  readonly now?: () => Date;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'saved'; readonly name: string; readonly files: readonly ExportFile[]; readonly plan: ExportPlan }
  | { readonly kind: 'failed'; readonly reason: string };

export function ExportSettings({
  connection,
  machineName,
  createClient,
  onLeave,
  save = downloadFile,
  now = () => new Date(),
}: ExportSettingsProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const run = (): void => {
    setPhase({ kind: 'reading' });
    void (async () => {
      try {
        const client = await createClient(connection);
        const plan = exportPlan(await readConfigStatus(client));
        const files: ExportFile[] = [];
        for (const path of plan.include) files.push({ path, text: (await readConfigFile(client, path)).text });
        const when = now();
        const name = exportFileName(machineName, when);
        save(name, zipFiles(files, when));
        setPhase({ kind: 'saved', name, files, plan });
      } catch (error) {
        setPhase({ kind: 'failed', reason: changeRefusalSentence(error) });
      }
    })();
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-export-settings="" aria-labelledby="export-settings-heading">
      {onLeave === undefined ? null : (
        <div>
          <Button type="button" variant="ghost" className="kt-btn--flush-start" data-export-back="" onClick={onLeave}>
            <ChevronLeft size={16} aria-hidden="true" />
            Machine
          </Button>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id="export-settings-heading" className="m-0 text-row font-semibold text-fg">
          Export settings
        </h3>
        <p className="m-0 text-cell leading-base text-muted">
          A zip of <span className="font-mono">{machineName}</span>’s YAML configuration files — Warden, Learning,
          Voice, logins, profiles, components and runtimes — without secrets. A file only ever names a secret as{' '}
          <span className="font-mono">{secretReference('NAME')}</span>, never its value. Device settings are not
          included.
        </p>
      </div>
      <div>
        <Button type="button" variant="primary" data-export-run="" disabled={phase.kind === 'reading'} onClick={run}>
          <Download size={16} aria-hidden="true" />
          {phase.kind === 'reading' ? 'Reading the files…' : 'Export settings'}
        </Button>
      </div>
      {phase.kind === 'failed' ? (
        <SetupNote live tone="err" name="export-failed" title="Couldn’t export">
          <span>{phase.reason}</span>
        </SetupNote>
      ) : null}
      {phase.kind === 'saved' ? (
        <>
          <SetupNote live tone="ok" name="export-saved" title={`Saved ${phase.name}`}>
            <span>{countWords(phase.files.length, 'file')}. Secrets: none.</span>
          </SetupNote>
          <SetupSection title="In the zip" name="export-manifest">
            <SetupCommand>{exportManifest(phase.name, phase.files)}</SetupCommand>
          </SetupSection>
          {phase.plan.leftOut.length === 0 ? null : (
            <SetupNote
              tone="warn"
              name="export-left-out"
              title={`${countWords(phase.plan.leftOut.length, 'file')} left out`}
            >
              {phase.plan.leftOut.map(entry => (
                <span key={entry.path} className="[overflow-wrap:anywhere]">
                  <span className="font-mono">{entry.path}</span>: {entry.reason}
                </span>
              ))}
            </SetupNote>
          )}
        </>
      ) : null}
    </section>
  );
}
