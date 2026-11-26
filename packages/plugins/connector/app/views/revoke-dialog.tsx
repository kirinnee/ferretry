/** The confirm step for a revoke: what stops is said in the same breath as the button that does it. */
import { Trash2 } from 'lucide-react';
import { Button, Dialog } from '@ferretry/app/ui';
import type { ConnectorGrantView } from '../../contract/index.ts';
import { revokeConsequence } from '../lib/words.ts';

export function RevokeDialog({
  grant,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly grant: ConnectorGrantView;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Revoke ${grant.clientName}?`}
      width="28rem"
      footer={
        <>
          <Button type="button" onClick={onCancel} className="min-h-[44px]">
            Keep it
          </Button>
          <Button
            type="button"
            variant="danger"
            busy={busy}
            busyLabel="Revoking…"
            data-connector-revoke-confirm=""
            icon={<Trash2 size={14} aria-hidden="true" />}
            onClick={onConfirm}
            className="min-h-[44px]"
          >
            Revoke
          </Button>
        </>
      }
    >
      <p className="m-0 text-ui leading-base text-muted" data-connector-revoke-dialog={grant.id}>
        {revokeConsequence(grant)}
      </p>
    </Dialog>
  );
}
