/**
 * The models Ollama has installed on the machine, as a login's form and page show them (the provider
 * tile shows only the one-line count): each model with what it is, the daemon's own sentence for any state
 * that is not "found" with the exact command to run, and **Check again** — the only way this re-reads.
 */

import { useId } from 'react';
import { LocalModelsNote } from '../../../components/local-models-note.tsx';
import { LOCAL_TONE_CLASS, type LocalModelsRead, modelDetailWords, tileWords } from '../../../lib/local-models.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { ClipboardWriter } from '../../onboarding/copy-button.tsx';

export interface LocalModelsPanelProps {
  readonly machineName: string;
  readonly read: LocalModelsRead;
  readonly onCheck: () => void;
  readonly write?: ClipboardWriter;
}

export function LocalModelsPanel({ machineName, read, onCheck, write }: LocalModelsPanelProps) {
  const noteId = useId();
  const words = tileWords(read);
  const { snapshot } = read;
  return (
    <section
      aria-label={`Models installed on ${machineName}`}
      className="kt-panel flex min-w-0 max-w-[42rem] flex-col gap-2 p-panel"
      data-local-models-panel={snapshot?.state ?? 'unread'}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h5 className="m-0 text-ui font-semibold text-fg">Installed on {machineName}</h5>
        {words === null ? null : (
          <span className={`text-cell font-semibold ${LOCAL_TONE_CLASS[words.tone]}`} data-local-models-state="">
            {words.text}
          </span>
        )}
      </div>
      {snapshot === null ? null : snapshot.state === 'found' ? (
        <>
          <p className="m-0 text-cell leading-base text-muted">{snapshot.message}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-local-models-list="">
            {snapshot.models.map(model => {
              const detail = modelDetailWords(model);
              return (
                <li
                  key={model.id}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-cell"
                  data-local-model={model.id}
                >
                  <span className="min-w-0 break-all font-mono font-semibold text-fg">{model.label}</span>
                  {detail === '' ? null : <span className="text-muted">{detail}</span>}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <LocalModelsNote id={noteId} local={snapshot} {...(write === undefined ? {} : { write })} />
      {read.error === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-local-models-error="">
          Could not ask {machineName} what Ollama has installed. {read.error}
        </p>
      )}
      <div>
        <Button type="button" disabled={read.checking} data-local-models-check="" onClick={onCheck}>
          {read.checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </section>
  );
}
