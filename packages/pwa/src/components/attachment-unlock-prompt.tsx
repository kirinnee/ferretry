import { AlertTriangle, LoaderCircle, LockKeyhole } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { attachmentUnlockFailure, type AttachmentUnlockFailure } from '../lib/attachment-unlock.ts';
import { BottomSheet } from '../shell/bottom-sheet.tsx';
import { Button } from '../shell/primitives.tsx';

export interface AttachmentUnlockPromptProps {
  /** Rendered in the heading, so the reader knows which document wants a password. */
  readonly filename: string;
  readonly open: boolean;
  /** Resolves after the daemon created an in-memory decrypted copy. */
  readonly onUnlock: (password: string) => Promise<void>;
  readonly onCancel: () => void;
}

/**
 * Password prompt for an encrypted PDF attachment.
 *
 * The password is never persisted in browser state or storage. A wrong
 * password remains editable, while failures no password can fix clearly end
 * the flow instead of offering an ineffective retry.
 */
export function AttachmentUnlockPrompt({ filename, open, onUnlock, onCancel }: AttachmentUnlockPromptProps) {
  const titleId = useId();
  const fieldId = useId();
  const helpId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AttachmentUnlockFailure | null>(null);

  useEffect(() => {
    if (open) return;
    // A document password must never survive closing this sheet.
    setPassword('');
    setSubmitting(false);
    setFailure(null);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting || password.length === 0) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await onUnlock(password);
      setPassword('');
    } catch (error) {
      const nextFailure = attachmentUnlockFailure(error);
      setFailure(nextFailure);
      if (nextFailure.retryable) {
        // Replacing an incorrect password is one edit, not a manual clear.
        inputRef.current?.focus();
        inputRef.current?.select();
      } else setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet
      ariaLabel="Unlock encrypted PDF"
      closeLabel="Close password prompt"
      id="attachment-unlock"
      labelledBy={titleId}
      onClose={submitting ? () => undefined : onCancel}
      open={open}
      panelClassName="bg-surface"
      zIndexClass="z-50"
    >
      <div className="shrink-0 border-b border-border-soft px-panel pb-row-y">
        <div className="flex items-center gap-sm">
          <LockKeyhole aria-hidden="true" className="text-accent" size={15} />
          <h1 className="m-0 font-display text-title font-semibold tracking-display text-fg" id={titleId}>
            Unlock encrypted PDF
          </h1>
        </div>
        <p className="mt-1 break-words text-ui leading-base text-muted">
          <span className="mono">{filename}</span> needs a password.
        </p>
      </div>

      <form className="min-h-0 flex-1 overflow-y-auto scroll-thin px-panel pb-4" noValidate onSubmit={submit}>
        <div className="mx-auto grid w-full max-w-2xl gap-4 py-3">
          <label className="grid gap-1.5 text-ui text-fg" htmlFor={fieldId}>
            <span className="font-semibold">Document password</span>
            <input
              aria-describedby={helpId}
              aria-invalid={failure?.retryable ? true : undefined}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              className="kt-input !min-h-[44px] w-full"
              disabled={submitting}
              id={fieldId}
              onChange={event => {
                setPassword(event.target.value);
                setFailure(null);
              }}
              ref={inputRef}
              spellCheck={false}
              type="password"
              value={password}
            />
            <span className="text-meta leading-base text-muted" id={helpId}>
              Ferretry decrypts the PDF in memory for the agent. The decrypted file is never written to disk, the
              password is never stored, and the attached original stays encrypted.
            </span>
          </label>

          {failure ? (
            <div
              className="flex items-start gap-sm rounded-control border border-err p-3 text-ui text-err"
              role="alert"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
              <span>{failure.message}</span>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-sm sm:flex-row sm:justify-end">
            <Button className="min-h-[44px]" disabled={submitting} onClick={onCancel} type="button">
              Cancel
            </Button>
            <Button
              className="min-h-[44px]"
              disabled={submitting || password.length === 0}
              type="submit"
              variant="primary"
            >
              {submitting ? (
                <span className="inline-flex items-center gap-sm">
                  <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={15} />
                  Decrypting…
                </span>
              ) : failure?.retryable ? (
                'Try again'
              ) : (
                'Unlock'
              )}
            </Button>
          </div>
        </div>
      </form>
    </BottomSheet>
  );
}
