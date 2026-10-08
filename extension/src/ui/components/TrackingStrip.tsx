import { useEffect, useState } from 'preact/hooks';
import {
  absoluteTime,
  relativeTime,
  type MessageSummary,
  type ReminderCondition,
  type TrackingEvent,
} from '@postmark/shared';
import { ActivityTimeline } from './ActivityTimeline';
import { shortUrl, statusView } from '../format';
import { RemindPopover } from './RemindPopover';

export interface TrackingStripProps {
  message: MessageSummary;
  collapsed: boolean;
  onToggle: (collapsed: boolean) => void;
  onRemind: (remindAt: Date, condition: ReminderCondition) => Promise<void>;
  /** Loads the full activity history (lazily, when the user opens it). */
  loadActivity?: () => Promise<TrackingEvent[]>;
  /** Bumped when new tracking data arrives, so an open history refreshes itself. */
  version?: number;
}

function When({ iso }: { iso: string | null }) {
  if (!iso) return <span>—</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

/** Compact per-message "Tracking" strip injected (in Shadow DOM) under a tracked outgoing message. */
export function TrackingStrip({
  message: m,
  collapsed,
  onToggle,
  onRemind,
  loadActivity,
  version = 0,
}: TrackingStripProps) {
  const [open, setOpen] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<TrackingEvent[] | 'loading' | 'error'>('loading');

  useEffect(() => {
    if (!showActivity || !loadActivity) return;
    let live = true;
    loadActivity().then(
      (ev) => live && setActivity(ev),
      () => live && setActivity('error'),
    );
    return () => {
      live = false;
    };
  }, [showActivity, loadActivity, version]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const s = statusView(m);
  const bodyId = `pm-body-${m.id}`;

  return (
    <section class="strip" aria-label="Postmark tracking">
      <div class="head">
        <button
          type="button"
          class="toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => onToggle(!collapsed)}
        >
          <span class={`chev ${collapsed ? '' : 'open'}`} aria-hidden="true">
            ▶
          </span>
          Tracking
        </button>
        <span class={`badge ${s.tone}`} title={s.detail}>
          {s.label}
        </span>
        {m.opens.last && (
          <span class="summary">
            · last open <When iso={m.opens.last} />
          </span>
        )}
        <span class="spacer" />
        <button
          type="button"
          class="btn"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setConfirm(null);
            setOpen(!open);
          }}
        >
          Remind me
        </button>
      </div>
      {confirm && (
        <div class="ok-msg" role="status">
          {confirm}
        </div>
      )}
      {open && (
        <RemindPopover
          onClose={() => setOpen(false)}
          onSubmit={async (at, cond) => {
            await onRemind(at, cond);
            setOpen(false);
            setConfirm(`Reminder set for ${at.toLocaleDateString()}.`);
          }}
        />
      )}
      {!collapsed && (
        <div class="body" id={bodyId}>
          <div class="row">
            <span class="label">Opens</span>
            <span>
              {m.opens.total === 0 ? (
                'None detected yet'
              ) : (
                <>
                  {m.opens.total} (first <When iso={m.opens.first} />, last{' '}
                  <When iso={m.opens.last} />)
                </>
              )}
            </span>
          </div>
          {m.opens.autoLoaded > 0 && (
            <div class="note">
              Possibly auto-loaded{' '}
              {m.opens.autoLoaded === 1 ? 'once' : `${m.opens.autoLoaded} times`} (e.g. Apple Mail
              Privacy Protection). Not counted as opens.
            </div>
          )}
          <div class="row">
            <span class="label">Link clicks</span>
            {m.links.length === 0 ? (
              <span>No tracked links</span>
            ) : (
              <ul class="links">
                {m.links.map((l) => (
                  <li key={l.id}>
                    <span class="url" title={l.originalUrl}>
                      {shortUrl(l.originalUrl)}
                    </span>
                    <span>
                      {l.clicks} {l.clicks === 1 ? 'click' : 'clicks'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {loadActivity && (
            <div class="row">
              <span class="label">History</span>
              <div>
                <button
                  type="button"
                  class="linkBtn"
                  aria-expanded={showActivity}
                  onClick={() => setShowActivity(!showActivity)}
                >
                  {showActivity ? 'Hide full activity' : 'Show full activity'}
                </button>
                {showActivity &&
                  (activity === 'loading' ? (
                    <p class="fine" role="status">
                      Loading…
                    </p>
                  ) : activity === 'error' ? (
                    <p class="error" role="alert">
                      Couldn’t load activity.
                    </p>
                  ) : (
                    <ActivityTimeline events={activity} recipients={m.recipients} />
                  ))}
              </div>
            </div>
          )}
          <div class="fine">
            Open tracking is an estimate: image blocking hides opens, and privacy proxies can create
            false ones.
          </div>
        </div>
      )}
    </section>
  );
}
