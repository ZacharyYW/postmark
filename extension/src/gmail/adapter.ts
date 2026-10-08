/**
 * Gmail integration surface. Everything Postmark needs from Gmail goes through this interface;
 * `inboxsdkAdapter.ts` is the only implementation and the only file that imports InboxSDK, so it
 * can be swapped for raw DOM observation later. Tests use fakes.
 */

export type BodyModifier = (p: { body: string; isPlainText: boolean }) => Promise<{ body: string }>;

export interface ToggleButton {
  setOn(on: boolean): void;
}

export interface ComposeHandle {
  readonly id: string;
  /** The From address actually selected (handles "Send as" aliases). */
  getFromAddress(): string | null;
  /** All From addresses offered in this compose (the account's aliases). */
  getFromChoices(): string[];
  getSubject(): string;
  /** To + Cc + Bcc email addresses. */
  getRecipients(): string[];
  isReply(): boolean;
  addToggleButton(opts: { initialOn: boolean; onClick: () => void }): ToggleButton;
  /**
   * Register a function that may rewrite the outgoing body at send time. Implementations must
   * fall back to sending the original body if the modifier throws or rejects.
   */
  registerBodyModifier(fn: BodyModifier): void;
  onSent(cb: (ids: { threadId: string | null; messageId: string | null }) => void): void;
  onFromChanged(cb: () => void): void;
  onDestroy(cb: () => void): void;
}

export interface MarkIcon {
  iconUrl: string;
  tooltip: string;
}

export interface ThreadRowHandle {
  getThreadId(): Promise<string | null>;
  /** Replace this row's Postmark marks in place (null = none). */
  setMarks(marks: { status: MarkIcon | null; clicks: MarkIcon | null }): void;
  getVisibleMessageCount(): number;
  getContactEmails(): string[];
  onDestroy(cb: () => void): void;
}

export interface MessageViewHandle {
  getMessageId(): Promise<string | null>;
  getThreadId(): Promise<string | null>;
  getSenderEmail(): string | null;
  /** Senders of every message in the thread, in order (for reply detection). */
  getThreadSenders(): string[];
  /** Insert `el` right above the message body. Returns false if the hook point is unavailable. */
  mountAboveBody(el: HTMLElement): boolean;
  isLoaded(): boolean;
  onLoad(cb: () => void): void;
  onDestroy(cb: () => void): void;
}

export interface GmailAdapter {
  getUserEmail(): string | null;
  onCompose(handler: (c: ComposeHandle) => void): void;
  onThreadRow(handler: (r: ThreadRowHandle) => void): void;
  onMessageView(handler: (m: MessageViewHandle) => void): void;
  toast(text: string, kind?: 'info' | 'error'): void;
}
