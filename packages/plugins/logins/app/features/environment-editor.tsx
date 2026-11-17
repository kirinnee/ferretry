/**
 * Edit a login's environment after it is made. Each variable is a row: a plain value is edited in place; a secret or a
 * hidden one has no value on this screen, so it is kept as it is unless a `${secret:NAME}` reference is typed over it.
 * A key itself is refused before anything is sent (see `environment-edit.ts`); the daemon refuses it again.
 *
 * WHAT IS TYPED OVER A SECRET, OR INTO A NEW ROW, IS MASKED AND UNCONTROLLED. The editor cannot tell what a new
 * variable will hold, and a replacement is meant to be a reference but may be pasted as the key itself, so those values
 * live only in the input node's own value (never in `rows`, never in a `value` attribute a DOM snapshot would show). They
 * are read when Save is pressed and emptied once the change is applied; React state holds only WHICH rows have something
 * typed. A plain row is a visible value edited in place and stays an ordinary controlled field.
 */

import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { LoginEnvironment } from '../../contract/index.ts';
import { type EditRow, editRows, envChange, rowsChanged } from '../lib/environment-edit.ts';
import type { LoginChanges } from '../lib/login-changes.ts';
import { Button, ChangeApplyPanel, SecretInput, useSecretField } from '../ui.ts';

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

/** The two things the editor does to a masked row's field: read it on Save, empty it once applied. */
interface MaskedHandle {
  readonly read: () => string;
  readonly clear: () => void;
}

/** A row whose value is masked: only a plain row is shown (and edited) as text. */
const isMasked = (row: EditRow): boolean => row.kind !== 'plain';

interface MaskedValueProps {
  readonly rowKey: string;
  readonly label: string;
  readonly placeholder: string;
  /** Where the editor finds this row's field when Save is pressed. */
  readonly handles: MutableRefObject<Map<string, MaskedHandle>>;
  /** Told whether this row has anything typed (never what). */
  readonly onFilled: (rowKey: string, filled: boolean) => void;
  /** Told on every keystroke, so a refusal that was about the old text goes away. */
  readonly onEdit: () => void;
}

/** One masked, uncontrolled value input, registered with the editor by the row's key. */
function MaskedValue({ rowKey, label, placeholder, handles, onFilled, onEdit }: MaskedValueProps) {
  const field = useSecretField();
  const { read, clear, filled } = field;
  useEffect(() => {
    handles.current.set(rowKey, { read, clear });
    return () => {
      handles.current.delete(rowKey);
    };
  }, [handles, rowKey, read, clear]);
  useEffect(() => {
    onFilled(rowKey, filled);
  }, [onFilled, rowKey, filled]);
  // A row that leaves the screen (removed, or the editor closed) has nothing typed any more.
  useEffect(() => () => onFilled(rowKey, false), [onFilled, rowKey]);
  return (
    <SecretInput
      field={field}
      className="kt-input"
      aria-label={label}
      autoComplete="off"
      placeholder={placeholder}
      onTyped={onEdit}
    />
  );
}

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
  /** Each masked row's field, by the row's key: the only way the typed values are read. */
  const handles = useRef(new Map<string, MaskedHandle>());
  /** The keys of the masked rows that have something typed. Keys only, never a value. */
  const [filled, setFilled] = useState<ReadonlySet<string>>(new Set());
  const markFilled = useRef((rowKey: string, isFilled: boolean): void => {
    setFilled(current => {
      if (current.has(rowKey) === isFilled) return current;
      const next = new Set(current);
      if (isFilled) next.add(rowKey);
      else next.delete(rowKey);
      return next;
    });
  }).current;

  const patch = (index: number, change: Partial<EditRow>): void => {
    changes.clear();
    setRows(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  };

  const save = async (): Promise<void> => {
    // The typed values are read from their inputs now, for this one call: they are never kept in `rows`.
    const edit = envChange(
      loginId,
      rows.map(row =>
        isMasked(row) && !row.removed ? { ...row, value: handles.current.get(row.key)?.read() ?? '' } : row,
      ),
    );
    if (edit.kind === 'refused') {
      changes.refuse(edit.sentence);
      return;
    }
    const result = await changes.apply(edit.change);
    if (result.kind === 'applied') {
      for (const handle of handles.current.values()) handle.clear();
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
          ) : isMasked(row) ? (
            <MaskedValue
              rowKey={row.key}
              label={`${row.name === '' ? 'New variable' : row.name} value`}
              placeholder={row.kind === 'secret' || row.kind === 'hidden' ? '(kept)' : ''}
              handles={handles}
              onFilled={markFilled}
              onEdit={changes.clear}
            />
          ) : (
            <input
              className="kt-input"
              aria-label={`${row.name === '' ? 'New variable' : row.name} value`}
              autoComplete="off"
              spellCheck={false}
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
        disabled={!rowsChanged(start, rows) && filled.size === 0}
        onSubmit={() => void save()}
      >
        <Button type="button" data-env-cancel="" onClick={onDone}>
          Cancel
        </Button>
      </ChangeApplyPanel>
    </div>
  );
}
