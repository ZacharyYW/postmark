import { TIMING, type EventType, type UaClass } from '@postmark/shared';
import type { MessageRow, Repo } from '../db/repo';
import { hashIp, verifyShort } from '../lib/crypto';
import { classifyClick, classifyOpen } from './classify';
import { ipInCidrs, type parseCidrList } from './cidr';

export interface TrackingContext {
  repo: Repo;
  ipSalt: string;
  signSecret: string;
  mppCidrs: ReturnType<typeof parseCidrList>;
}

export interface RequestInfo {
  ip: string;
  ua: string | null | undefined;
  sig: string | undefined;
  now: number;
}

export type RecordOutcome =
  | { recorded: true; eventId: number; uaClass: UaClass }
  | { recorded: false; reason: 'unknown' | 'duplicate'; uaClass?: UaClass };

/** Value signed for the `?s=` sender parameter: binds the signature to one resource id. */
export const senderSigValue = (resourceId: string, account: string) => `${resourceId}|${account}`;

function recordEvent(
  ctx: TrackingContext,
  message: MessageRow,
  type: EventType,
  linkId: string | null,
  req: RequestInfo,
  resourceId: string,
): RecordOutcome {
  const input = {
    ua: req.ua,
    msSinceSent: req.now - message.sent_at,
    ipInMppRange: ipInCidrs(req.ip, ctx.mppCidrs),
    senderSigValid: verifyShort(
      ctx.signSecret,
      senderSigValue(resourceId, message.sender_account),
      req.sig,
    ),
  };
  let uaClass = type === 'open' ? classifyOpen(input) : classifyClick(input);

  // Self-view beacon: the sender's own Gmail tab told us it was showing this message.
  // Only views from the *sending* account count; other accounts of the same user are recipients.
  if (
    type === 'open' &&
    uaClass === 'gmail_proxy' &&
    ctx.repo.hasSelfViewNear(
      message.id,
      message.sender_account,
      req.now,
      TIMING.SELF_VIEW_WINDOW_MS,
    )
  ) {
    uaClass = 'sender';
  }

  const ipHash = hashIp(req.ip, ctx.ipSalt);
  return ctx.repo.tx(() => {
    if (
      ctx.repo.hasRecentDuplicate({
        message_id: message.id,
        link_id: linkId,
        type,
        ip_hash: ipHash,
        ua_class: uaClass,
        after: req.now - TIMING.DEDUPE_WINDOW_MS,
      })
    ) {
      return { recorded: false, reason: 'duplicate', uaClass } as const;
    }
    const eventId = ctx.repo.insertEvent({
      message_id: message.id,
      link_id: linkId,
      type,
      occurred_at: req.now,
      ip_hash: ipHash,
      ua_class: uaClass,
      is_first: 0,
    });
    ctx.repo.recomputeFirst(message.id, type, linkId);
    return { recorded: true, eventId, uaClass } as const;
  });
}

export function recordOpen(ctx: TrackingContext, pixelId: string, req: RequestInfo): RecordOutcome {
  const message = ctx.repo.getMessageByPixel(pixelId);
  if (!message || message.tracking_enabled !== 1) return { recorded: false, reason: 'unknown' };
  return recordEvent(ctx, message, 'open', null, req, pixelId);
}

export function recordClick(
  ctx: TrackingContext,
  linkId: string,
  req: RequestInfo,
): { outcome: RecordOutcome; url: string | null } {
  const found = ctx.repo.getLinkWithMessage(linkId);
  if (!found) return { outcome: { recorded: false, reason: 'unknown' }, url: null };
  return {
    outcome: recordEvent(ctx, found.message, 'click', linkId, req, linkId),
    url: found.link.original_url,
  };
}

/**
 * Self-view beacon. Ignored unless `account` is the message's sender account (another of the
 * user's accounts viewing it is a genuine recipient). Reclassifies nearby Gmail-proxy opens,
 * including ones that arrived before the beacon.
 */
export function recordSelfView(
  ctx: TrackingContext,
  message: MessageRow,
  account: string,
  now: number,
): { accepted: boolean; reclassified: number } {
  if (account !== message.sender_account) return { accepted: false, reclassified: 0 };
  return ctx.repo.tx(() => {
    ctx.repo.insertSelfView(message.id, account, now);
    const reclassified = ctx.repo.reclassifyProxyOpensAsSender(
      message.id,
      now,
      TIMING.SELF_VIEW_WINDOW_MS,
    );
    if (reclassified > 0) ctx.repo.recomputeFirst(message.id, 'open', null);
    return { accepted: true, reclassified };
  });
}
