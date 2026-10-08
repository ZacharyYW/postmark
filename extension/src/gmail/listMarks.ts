import type { MessageSummary, PushMap } from '@postmark/shared';
import type { BusClient } from '../bus/client';
import type { GmailAdapter, ThreadRowHandle } from './adapter';
import { marksFor, type IconUrl } from './marks';
import { logOnce } from './safe';

export interface ListMarksDeps {
  adapter: Pick<GmailAdapter, 'onThreadRow'>;
  bus: BusClient;
  iconUrl: IconUrl;
  onUpdate: (fn: (p: PushMap['DATA_UPDATED']) => void) => () => void;
  batchDelayMs?: number;
}

/**
 * Sent-list marks. Rows register as they render; thread ids are batched into one GET_MARKS call
 * (the SW filters by this tab's account). Marks update in place when the SW pushes DATA_UPDATED.
 */
export function startListMarks(deps: ListMarksDeps) {
  const rowsByThread = new Map<string, Set<ThreadRowHandle>>();
  const marks = new Map<string, MessageSummary[]>();
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const render = (threadId: string) => {
    const rows = rowsByThread.get(threadId);
    if (!rows) return;
    const m = marksFor(marks.get(threadId) ?? [], deps.iconUrl);
    for (const r of rows) r.setMarks(m);
  };

  const flush = async () => {
    timer = null;
    const ids = [...pending];
    pending = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const r = await deps.bus.send('GET_MARKS', { threadIds: chunk });
      if (!r.ok) {
        if (r.error.code !== 'NOT_AUTHENTICATED')
          logOnce(`list marks: ${r.error.code}`, r.error.message);
        continue;
      }
      for (const id of chunk) {
        const ms = r.data.marks[id] ?? [];
        if (ms.length > 0 || marks.has(id)) {
          marks.set(id, ms);
          render(id);
        }
      }
    }
  };

  const request = (threadIds: string[]) => {
    for (const id of threadIds) pending.add(id);
    if (!timer) timer = setTimeout(() => void flush(), deps.batchDelayMs ?? 150);
  };

  deps.adapter.onThreadRow((row) => {
    void row.getThreadId().then((threadId) => {
      if (!threadId) return;
      let set = rowsByThread.get(threadId);
      if (!set) rowsByThread.set(threadId, (set = new Set()));
      set.add(row);
      row.onDestroy(() => {
        set.delete(row);
        if (set.size === 0) rowsByThread.delete(threadId);
      });
      if (marks.has(threadId)) render(threadId);
      else request([threadId]);
    });
  });

  const off = deps.onUpdate((p) => {
    const visible = p.threadIds.filter((t) => rowsByThread.has(t));
    if (visible.length > 0) request(visible);
  });

  return {
    /** For tests: force pending requests through now. */
    flush,
    stop: off,
    _state: { rowsByThread, marks },
  };
}
