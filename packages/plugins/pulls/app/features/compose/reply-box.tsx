import { Button } from '@ferretry/app/ui';
import { useState } from 'react';
import type { ReviewThread } from '../../../contract/index.ts';
import { Composer } from './composer.tsx';
import { useMaybeCompose } from './context.tsx';

/** A reply under one review thread: a **Reply** button that opens a composer of its own, one draft per thread. */
export function ReplyBox({ thread }: { readonly thread: ReviewThread }) {
  const compose = useMaybeCompose();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (compose === undefined) return null;
  if (!open)
    return (
      <div className="px-sm pb-xs">
        <Button data-reply-open={thread.id} onClick={() => setOpen(true)} size="sm" type="button">
          Reply
        </Button>
      </div>
    );
  return (
    <div className="px-sm pb-xs" data-reply-box={thread.id}>
      <Composer
        autoFocus
        closeLabel={text.trim() === '' ? 'Close' : 'Discard'}
        onChange={setText}
        onClose={() => {
          setText('');
          setOpen(false);
        }}
        payload={{ kind: 'reply', threadId: thread.id }}
        title={`Reply on ${thread.path}`}
        value={text}
      />
    </div>
  );
}
