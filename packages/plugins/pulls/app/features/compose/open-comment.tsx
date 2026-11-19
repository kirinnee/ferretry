import { Button } from '@ferretry/app/ui';
import { useMaybeCompose } from './context.tsx';

/** The end of the conversation: one button that opens the comment box at the foot of the page. */
export function OpenComment() {
  const compose = useMaybeCompose();
  if (compose === undefined) return null;
  return (
    <div>
      <Button data-compose-open="" onClick={compose.openComment} size="sm" type="button" variant="primary">
        Write a comment
      </Button>
    </div>
  );
}
