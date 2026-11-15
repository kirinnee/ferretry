/**
 * Edit a login's environment after it is made. Each variable is a row: a plain value is edited in place; a secret or a
 * hidden one has no value on this screen, so it is kept as it is unless a `${secret:NAME}` reference is typed over it.
 * A key itself is refused before anything is sent (see `environment-edit.ts`); the daemon refuses it again.
 */

import { useMemo, useRef, useState } from 'react';
import type { LoginEnvironment } from '../../contract/index.ts';
import { type EditRow, editRows, envChange, rowsChanged } from '../lib/environment-edit.ts';
import type { LoginChanges } from '../lib/login-changes.ts';
import { Button, ChangeApplyPanel } from '../ui.ts';

export interface EnvironmentEditorProps {
  readonly loginId: string;
  readonly environment: LoginEnvironment;
  readonly machineName: string;
  readonly changes: LoginChanges;
  readonly reload: () => Promise<void>;
  readonly onDone: () => void;
}

const KEPT: Readonly<Record<'secret' | 'hidden', string>> = {
  secret: `Kept as it is. Type a \${secret:NAME} reference to replace it.`,
  hidden: `Hidden, kept as it is. Type a \${secret:NAME} reference to replace it.`,
};

export function EnvironmentEditor({
  loginId,
  environment,
  machineName,
  changes,
  reload,
  onDone,
}: EnvironmentEditorProps) {
  const start = useMemo(() => editRows(environment), [environment]);
  const [rows, setRows] = useState<readonly EditRow[]>(start);
  const added = useRef(0);

  const patch = (index: number, change: Partial<EditRow>): void => {
    changes.clear();
    setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  };

  const save = async (): Promise<void> => {
    const edit = envChange(loginId, rows);
    if (edit.kind === 'refused') {
      changes.refuse(edit.sentence);
      return;
    }
    const result = await changes.apply(edit.change);
    if (result.kind === 'applied') {
      await reload();
      // A held edit has not taken effect: keep the editor open, so the sentence that says so stays on screen.
      if (result.outcome.outcome !== 'held') onDone();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-login-env-editor={loginId}>
      {rows.map((row, index) => (
        <div key={row.key} className="flex min-w-0 flex-col gap-1" data-env-row={row.name}>
          {row.kind === 'new' ? (
            <input
              className="kt-input font-mono"
              aria-label="New variable name"
              autoComplete="off"
              placeholder="NAME"
              value={row.name}
              onChange={event => patch(index, { name: event.target.value })}
            />
          ) : (
            <span className="break-all font-mono text-cell font-semibold text-fg">{row.name}</span>
          )}
          {row.removed ? (
            <span className="text-meta text-muted" data-env-removed="">
              Removed when you save.
            </span>
          ) : (
            <input
              className="kt-input"
              aria-label={`${row.name === '' ? 'New variable' : row.name} value`}
              autoComplete="off"
              spellCheck={false}
              placeholder={row.kind === 'secret' || row.kind === 'hidden' ? '(kept)' : ''}
              value={row.value}
              onChange={event => patch(index, { value: event.target.value })}
            />
          )}
          {row.kind === 'secret' || row.kind === 'hidden' ? (
            <span className="text-meta leading-base text-muted">{KEPT[row.kind]}</span>
          ) : null}
          <div>
            <Button type="button" data-env-remove={row.name} onClick={() => patch(index, { removed: !row.removed })}>
              {row.removed ? 'Keep it' : 'Remove'}
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          type="button"
          data-env-add=""
          onClick={() => {
            added.current += 1;
            setRows([...rows, { key: `new:${added.current}`, name: '', kind: 'new', value: '', removed: false }]);
          }}
        >
          Add a variable
        </Button>
      </div>
      <p className="m-0 text-meta leading-base text-muted">
        A key is never typed here: put it in Settings › Secrets and write its NAME as {`\${secret:NAME}`}.
      </p>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Saving…"
        refusal={changes.refusal}
        submitLabel="Save variables"
        disabled={!rowsChanged(start, rows)}
        onSubmit={() => void save()}
      >
        <Button type="button" data-env-cancel="" onClick={onDone}>
          Cancel
        </Button>
      </ChangeApplyPanel>
    </div>
  );
}
