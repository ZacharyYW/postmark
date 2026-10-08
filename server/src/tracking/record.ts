import { TIMING, type EventType, type UaClass } from '@postmark/shared';
import type { MessageRow, Repo } from '../db/repo';
import { hashIp, verifyShort } from '../lib/crypto';
import { classifyClick, classifyOpen } from './classify';
import { ipInCidrs, type parseCidrList } from './cidr';

export interface TrackingContext {
  repo: Repo;
  /** Per-install secrets, loaded lazily from the DB (memoised). */
  secrets: () => Promise<{ ipSalt: string; signSecret: string }>;
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

async function recordEvent(
  ctx: TrackingContext,
  message: MessageRow,
  type: EventType,
  linkId: string | null,
  req: RequestInfo,
  resourceId: string,
): Promise<RecordOutcome> {
  const { ipSalt, signSecret } = await ctx.secrets();
  const input = {
    ua: req.ua,
    msSinceSent: req.now - message.sent_at,
    ipInMppRange: ipInCidrs(req.ip, ctx.mppCidrs),
    senderSigValid: verifyShort(
      signSecret,
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
    (await ctx.repo.hasSelfViewNear(
      message.id,
      message.sender_account,
      req.now,
      TIMING.SELF_VIEW_WINDOW_MS,
    ))
  ) {
    uaClass = 'sender';
  }

  const ipHash = hashIp(req.ip, ipSalt);
  // Dedupe is a heuristic; two truly simultaneous hits may both land, which is harmless.
  if (
    await ctx.repo.hasRecentDuplicate({
      message_id: message.id,
      link_id: linkId,
      type,
      ip_hash: ipHash,
      ua_class: uaClass,
      after: req.now - TIMING.DEDUPE_WINDOW_MS,
    })
  ) {
    return { recorded: false, reason: 'duplicate', uaClass };
  }
  const eventId = await ctx.repo.insertEvent({
    message_id: message.id,
    link_id: linkId,
    type,
    occurred_at: req.now,
    ip_hash: ipHash,
    ua_class: uaClass,
    is_first: 0,
  });
  return { recorded: true, eventId, uaClass };
}

export async function recordOpen(
  ctx: TrackingContext,
  pixelId: string,
  req: RequestInfo,
): Promise<RecordOutcome> {
  const message = await ctx.repo.getMessageByPixel(pixelId);
  if (!message || message.tracking_enabled !== 1) return { recorded: false, reason: 'unknown' };
  return recordEvent(ctx, message, 'open', null, req, pixelId);
}

export async function recordClick(
  ctx: TrackingContext,
  linkId: string,
  req: RequestInfo,
): Promise<{ outcome: RecordOutcome; url: string | null }> {
  const found = await ctx.repo.getLinkWithMessage(linkId);
  if (!found) return { outcome: { recorded: false, reason: 'unknown' }, url: null };
  return {
    outcome: await recordEvent(ctx, found.message, 'click', linkId, req, linkId),
    url: found.link.original_url,
  };
}

/**
 * Self-view beacon. Ignored unless `account` is the message's sender account (another of the
 * user's accounts viewing it is a genuine recipient). Reclassifies nearby Gmail-proxy opens,
 * including ones that arrived before the beacon.
 */
export async function recordSelfView(
  ctx: TrackingContext,
  message: MessageRow,
  account: string,
  now: number,
): Promise<{ accepted: boolean; reclassified: number }> {
  if (account !== message.sender_account) return { accepted: false, reclassified: 0 };
  const reclassified = await ctx.repo.recordSelfView(
    message.id,
    account,
    now,
    TIMING.SELF_VIEW_WINDOW_MS,
  );
  return { accepted: true, reclassified };
}
