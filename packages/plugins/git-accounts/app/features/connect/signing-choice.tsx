import type { GitKeyFormat } from '../../../contract/index.ts';

export function SigningChoice({
  value,
  onChange,
  name,
  disabled = false,
}: {
  readonly value: GitKeyFormat;
  readonly onChange: (value: GitKeyFormat) => void;
  readonly name: string;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0" disabled={disabled}>
      <legend className="mb-2 text-cell font-semibold text-fg">Commit signing</legend>
      {(['ssh', 'gpg'] as const).map(format => (
        <label
          key={format}
          className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-control border border-border px-3 text-cell text-fg"
        >
          <input type="radio" name={name} value={format} checked={value === format} onChange={() => onChange(format)} />
          {format === 'ssh' ? 'SSH' : 'GPG'}
        </label>
      ))}
    </fieldset>
  );
}
