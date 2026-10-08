import { useState } from 'preact/hooks';
import { absoluteTime, relativeTime, type TrackingEvent } from '@postmark/shared';
import { attribution, buildActivity } from '../activity';

export interface ActivityTimelineProps {
  events: TrackingEvent[];
  recipients: string[];
  /** Maps logical class names to real ones (CSS modules in the popup, plain in the Gmail strip). */
  cls?: (name: string) => string;
}

/** Complete per-email history: every open and click with time and source. */
export function ActivityTimeline({ events, recipients, cls = (n) => n }: ActivityTimelineProps) {
  const [showIgnored, setShowIgnored] = useState(false);
  const items = buildActivity(events);
  const ignoredCount = items.filter((i) => i.ignored).length;
  const visible = showIgnored ? items : items.filter((i) => !i.ignored);

  return (
    <div class={cls('activity')}>
      <p class={cls('attrib')}>{attribution(recipients)}</p>
      {visible.length === 0 ? (
        <p class={cls('emptyActivity')}>
          {items.length === 0 ? 'No activity yet.' : 'No counted opens or clicks yet.'}
        </p>
      ) : (
        <ol class={cls('timeline')} aria-label="Activity history, newest first">
          {visible.map((i) => (
            <li class={`${cls('tlItem')} ${i.ignored ? cls('tlIgnored') : ''}`} key={i.id}>
              <span class={`${cls('tlDot')} ${cls(i.tone)}`} aria-hidden="true" />
              <span class={cls('tlText')} title={i.detail}>
                {i.text}
              </span>
              <time class={cls('tlTime')} dateTime={i.at} title={relativeTime(i.at)}>
                {absoluteTime(i.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {ignoredCount > 0 && (
        <button type="button" class={cls('linkBtn')} onClick={() => setShowIgnored(!showIgnored)}>
          {showIgnored ? 'Hide' : 'Show'} {ignoredCount} ignored event
          {ignoredCount === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
