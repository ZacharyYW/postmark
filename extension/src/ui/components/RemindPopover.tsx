import { useEffect, useRef, useState } from 'preact/hooks';
import { DAY_MS, type ReminderCondition } from '@postmark/shared';

export interface RemindPopoverProps {
  onSubmit: (remindAt: Date, condition: ReminderCondition) => Promise<void>;
  onClose: () => void;
  now?: () => number;
  /** CSS class map (shadow-DOM strip uses plain class names). */
  cls?: (name: string) => string;
}

const PRESETS = [1, 3, 7] as const;

export function RemindPopover({
  onSubmit,
  onClose,
  now = Date.now,
  cls = (n) => n,
}: RemindPopoverProps) {
  const [days, setDays] = useState<number | 'custom'>(3);
  const [custom, setCustom] = useState('');
  const [condition, setCondition] = useState<ReminderCondition>('no_reply');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const el = ref.current;
    el?.addEventListener('keydown', onKey);
    return () => el?.removeEventListener('keydown', onKey);
  }, [onClose]);

  const minDate = new Date(now() + DAY_MS).toISOString().slice(0, 10);

  const submit = async () => {
    setError(null);
    let at: Date;
    if (days === 'custom') {
      if (!custom) return setError('Pick a date');
      at = new Date(`${custom}T09:00:00`);
      if (Number.isNaN(at.getTime()) || at.getTime() <= now())
        return setError('Pick a future date');
    } else {
      at = new Date(now() + days * DAY_MS);
    }
    setBusy(true);
    try {
      await onSubmit(at, condition);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create reminder');
      setBusy(false);
    }
  };

  return (
    <div class={cls('popover')} role="dialog" aria-label="Remind me to follow up" ref={ref}>
      <fieldset>
        <legend>Remind me in</legend>
        <div class={cls('chips')}>
          {PRESETS.map((d) => (
            <button
              type="button"
              class={cls('chip')}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              key={d}
            >
              {d === 1 ? '1 day' : `${d} days`}
            </button>
          ))}
          <button
            type="button"
            class={cls('chip')}
            aria-pressed={days === 'custom'}
            onClick={() => setDays('custom')}
          >
            Custom
          </button>
        </div>
        {days === 'custom' && (
          <label>
            <span class={cls('sr')}>Reminder date</span>
            <input
              type="date"
              min={minDate}
              value={custom}
              aria-label="Reminder date"
              onInput={(e) => setCustom((e.target as HTMLInputElement).value)}
            />
          </label>
        )}
      </fieldset>
      <fieldset>
        <legend>Only if</legend>
        <label>
          <input
            type="radio"
            name="pm-cond"
            checked={condition === 'no_reply'}
            onChange={() => setCondition('no_reply')}
          />{' '}
          No reply detected
        </label>
        <label>
          <input
            type="radio"
            name="pm-cond"
            checked={condition === 'no_open'}
            onChange={() => setCondition('no_open')}
          />{' '}
          Not opened
        </label>
        <label>
          <input
            type="radio"
            name="pm-cond"
            checked={condition === 'always'}
            onChange={() => setCondition('always')}
          />{' '}
          Always remind me
        </label>
      </fieldset>
      {error && (
        <div class={cls('error')} role="alert">
          {error}
        </div>
      )}
      <div class={cls('actions')}>
        <button type="button" class={cls('btn')} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          class={`${cls('btn')} ${cls('primary')}`}
          onClick={submit}
          disabled={busy}
        >
          {busy ? 'Saving…' : 'Set reminder'}
        </button>
      </div>
    </div>
  );
}
