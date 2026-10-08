import * as InboxSDK from '@inboxsdk/core';
import type {
  BodyModifier,
  ComposeHandle,
  GmailAdapter,
  MarkIcon,
  MessageViewHandle,
  ThreadRowHandle,
} from './adapter';
import { extensionAlive, LiveValue, logOnce, safe } from './safe';

// The only file that imports InboxSDK. Everything here goes through public InboxSDK APIs; no
// Gmail class names are hard-coded (see docs/GMAIL_INTEGRATION.md).

type SDK = InboxSDK.InboxSDK;
type ComposeView = InboxSDK.ComposeView;
type ThreadRowView = InboxSDK.ThreadRowView;
type MessageView = InboxSDK.MessageView;

export async function loadInboxSdkAdapter(appId: string): Promise<GmailAdapter> {
  // Opt out of everything InboxSDK lets us; the rest is blocked by telemetryGuard.ts.
  const sdk = await InboxSDK.load(2, appId, {
    appName: 'Postmark',
    eventTracking: false,
    globalErrorLogging: false,
  } as never);
  return new InboxSdkAdapter(sdk);
}

let composeSeq = 0;

class InboxSdkCompose implements ComposeHandle {
  readonly id: string;
  private modifier: BodyModifier | null = null;
  private registered = false;
  private resending = false;

  constructor(private readonly view: ComposeView) {
    // One InboxSdkCompose per compose window, so a local id is stable for its lifetime
    // (InboxSDK's getComposeID is deprecated).
    this.id = `c${Date.now().toString(36)}${(composeSeq++).toString(36)}`;
  }

  getFromAddress(): string | null {
    try {
      return this.view.getFromContact()?.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  getFromChoices(): string[] {
    try {
      return this.view.getFromContactChoices().map((c) => c.emailAddress);
    } catch {
      return [];
    }
  }

  getSubject(): string {
    try {
      return this.view.getSubject() ?? '';
    } catch {
      return '';
    }
  }

  getRecipients(): string[] {
    try {
      return [
        ...this.view.getToRecipients(),
        ...this.view.getCcRecipients(),
        ...this.view.getBccRecipients(),
      ].map((c) => c.emailAddress);
    } catch {
      return [];
    }
  }

  isReply(): boolean {
    try {
      return this.view.isReply();
    } catch {
      return false;
    }
  }

  addToggleButton(opts: { initialOn: boolean; onClick: () => void }) {
    const descriptor = new LiveValue(toggleDescriptor(opts.initialOn, opts.onClick));
    try {
      this.view.addButton(descriptor as never);
    } catch (err) {
      logOnce('compose toolbar button unavailable', err);
    }
    return { setOn: (on: boolean) => descriptor.set(toggleDescriptor(on, opts.onClick)) };
  }

  registerBodyModifier(fn: BodyModifier): void {
    this.modifier = fn;
    this.tryRegister();
    // The request modifier needs a draft id, which Gmail assigns on first autosave.
    this.view.on('draftSaved', () => this.tryRegister());
    this.view.on('bodyChanged', () => this.tryRegister());
    this.view.on('presending', (e) => this.onPresending(e));
  }

  private tryRegister(): void {
    if (this.registered || !this.modifier) return;
    const fn = this.modifier;
    try {
      // InboxSDK awaits our promise and sends the original body if it rejects (fail-soft).
      this.view.registerRequestModifier(async (params) =>
        fn({ body: params.body, isPlainText: Boolean(params.isPlainText) }),
      );
      this.registered = true;
    } catch {
      // No draft id yet; will retry on draftSaved / bodyChanged / presending.
    }
  }

  /**
   * Fallback when the request modifier couldn't be registered before Send (very fast sends):
   * cancel, rewrite the compose body in place, and send again.
   */
  private onPresending(e: { cancel(): void }): void {
    this.tryRegister();
    if (this.registered || this.resending || !this.modifier) return;
    const fn = this.modifier;
    e.cancel();
    this.resending = true;
    const original = this.view.getHTMLContent();
    void fn({ body: original, isPlainText: false })
      .catch(() => ({ body: original }))
      .then(({ body }) => {
        if (body !== original) this.view.setBodyHTML(body);
        this.view.send();
      })
      .catch((err: unknown) => logOnce('fallback resend failed', err))
      .finally(() => {
        this.resending = false;
      });
  }

  onSent(cb: (ids: { threadId: string | null; messageId: string | null }) => void): void {
    this.view.on('sent', (data) => {
      void Promise.all([
        data.getThreadID().catch(() => null),
        data.getMessageID().catch(() => null),
      ]).then(([threadId, messageId]) => cb({ threadId, messageId }));
    });
  }

  onFromChanged(cb: () => void): void {
    this.view.on('fromContactChanged', safe('fromContactChanged handler', cb));
  }

  onDestroy(cb: () => void): void {
    this.view.on('destroy', safe('compose destroy handler', cb));
  }
}

function toggleDescriptor(on: boolean, onClick: () => void) {
  return {
    title: on ? 'Tracking on' : 'Tracking off',
    tooltip: on
      ? 'Postmark tracking is ON for this email. Click to turn off.'
      : 'Postmark tracking is OFF for this email. Click to turn on.',
    iconUrl: extensionAlive()
      ? chrome.runtime.getURL(on ? 'icons/eye-on.svg' : 'icons/eye-off.svg')
      : '',
    type: 'MODIFIER' as const,
    orderHint: 10,
    onClick,
  };
}

class InboxSdkRow implements ThreadRowHandle {
  private readonly status = new LiveValue<MarkIcon | null>(null);
  private readonly clicks = new LiveValue<MarkIcon | null>(null);
  private attached = false;

  constructor(private readonly row: ThreadRowView) {}

  getThreadId(): Promise<string | null> {
    return this.row.getThreadIDIfStableAsync().catch(() => null);
  }

  setMarks(marks: { status: MarkIcon | null; clicks: MarkIcon | null }): void {
    if (!this.attached) {
      this.attached = true;
      try {
        this.row.addAttachmentIcon(this.status);
        this.row.addAttachmentIcon(this.clicks);
      } catch (err) {
        logOnce('thread row icon unavailable', err);
      }
    }
    this.status.set(marks.status);
    this.clicks.set(marks.clicks);
  }

  getVisibleMessageCount(): number {
    try {
      return this.row.getVisibleMessageCount();
    } catch {
      return 0;
    }
  }

  getContactEmails(): string[] {
    try {
      return this.row.getContacts().map((c) => c.emailAddress);
    } catch {
      return [];
    }
  }

  onDestroy(cb: () => void): void {
    this.row.on('destroy', safe('row destroy handler', cb));
  }
}

class InboxSdkMessage implements MessageViewHandle {
  constructor(private readonly mv: MessageView) {}

  getMessageId(): Promise<string | null> {
    return this.mv.getMessageIDAsync().catch(() => null);
  }

  getThreadId(): Promise<string | null> {
    try {
      return this.mv
        .getThreadView()
        .getThreadIDAsync()
        .catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  getSenderEmail(): string | null {
    try {
      return this.mv.getSender()?.emailAddress ?? null;
    } catch {
      return null;
    }
  }

  getLaterSenders(): string[] {
    try {
      const all = this.mv.getThreadView().getMessageViewsAll();
      const idx = all.indexOf(this.mv);
      if (idx < 0) return [];
      return all
        .slice(idx + 1)
        .map((m) => {
          try {
            return m.getSender().emailAddress;
          } catch {
            return '';
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  mountAboveBody(el: HTMLElement): boolean {
    try {
      const body = this.mv.getBodyElement();
      if (!body?.parentElement) return false;
      body.parentElement.insertBefore(el, body);
      return true;
    } catch {
      return false;
    }
  }

  isLoaded(): boolean {
    try {
      return this.mv.isLoaded();
    } catch {
      return false;
    }
  }

  onLoad(cb: () => void): void {
    this.mv.on('load', safe('message load handler', cb));
  }

  onDestroy(cb: () => void): void {
    this.mv.on('destroy', safe('message destroy handler', cb));
  }
}

class InboxSdkAdapter implements GmailAdapter {
  constructor(private readonly sdk: SDK) {}

  getUserEmail(): string | null {
    try {
      return this.sdk.User.getEmailAddress();
    } catch (err) {
      logOnce('User.getEmailAddress failed', err);
      return null;
    }
  }

  onCompose(handler: (c: ComposeHandle) => void): void {
    try {
      this.sdk.Compose.registerComposeViewHandler(
        safe('compose handler', (view: ComposeView) => {
          if (extensionAlive()) handler(new InboxSdkCompose(view));
        }),
      );
    } catch (err) {
      logOnce('compose hook failed to attach', err);
    }
  }

  onThreadRow(handler: (r: ThreadRowHandle) => void): void {
    try {
      this.sdk.Lists.registerThreadRowViewHandler(
        safe('thread row handler', (row: ThreadRowView) => {
          if (extensionAlive()) handler(new InboxSdkRow(row));
        }),
      );
    } catch (err) {
      logOnce('list hook failed to attach', err);
    }
  }

  onMessageView(handler: (m: MessageViewHandle) => void): void {
    try {
      this.sdk.Conversations.registerMessageViewHandler(
        safe('message view handler', (mv: MessageView) => {
          if (extensionAlive()) handler(new InboxSdkMessage(mv));
        }),
      );
    } catch (err) {
      logOnce('thread hook failed to attach', err);
    }
  }

  toast(text: string, kind: 'info' | 'error' = 'info'): void {
    try {
      if (kind === 'error') this.sdk.ButterBar.showError({ text, time: 5000 });
      else this.sdk.ButterBar.showMessage({ text, time: 5000 });
    } catch (err) {
      logOnce('toast unavailable', err);
    }
  }
}
