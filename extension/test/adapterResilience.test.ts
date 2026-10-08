import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposeHandle, MessageViewHandle, ThreadRowHandle } from '../src/gmail/adapter';

type Handler = (...a: unknown[]) => void;
class Emitter {
  handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  emit(ev: string, ...a: unknown[]) {
    (this.handlers.get(ev) ?? []).forEach((fn) => fn(...a));
  }
}

const sdkState: { sdk: unknown } = { sdk: null };
vi.mock('@inboxsdk/core', () => ({ load: vi.fn(async () => sdkState.sdk) }));

const { loadInboxSdkAdapter } = await import('../src/gmail/inboxsdkAdapter');

function brokenSdk() {
  return {
    User: {
      getEmailAddress: () => {
        throw new Error('gmail changed');
      },
    },
    Compose: {
      registerComposeViewHandler: () => {
        throw new Error('compose hook broke');
      },
    },
    Lists: {
      registerThreadRowViewHandler: () => {
        throw new Error('list hook broke');
      },
    },
    Conversations: {
      registerMessageViewHandler: () => {
        throw new Error('thread hook broke');
      },
    },
    ButterBar: {
      showMessage: () => {
        throw new Error('no butter');
      },
      showError: () => {
        throw new Error('no butter');
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('InboxSDK adapter fails soft', () => {
  it('every hook failing to attach is logged, never thrown', async () => {
    sdkState.sdk = brokenSdk();
    const adapter = await loadInboxSdkAdapter('sdk_test');
    expect(adapter.getUserEmail()).toBeNull();
    expect(() => adapter.onCompose(() => {})).not.toThrow();
    expect(() => adapter.onThreadRow(() => {})).not.toThrow();
    expect(() => adapter.onMessageView(() => {})).not.toThrow();
    expect(() => adapter.toast('hi')).not.toThrow();
  });

  it('compose: broken getters degrade to null/empty, modifier registers after draftSaved', async () => {
    const view = Object.assign(new Emitter(), {
      getComposeID: () => 'cid',
      getFromContact: () => {
        throw new Error('x');
      },
      getFromContactChoices: () => {
        throw new Error('x');
      },
      getSubject: () => {
        throw new Error('x');
      },
      getToRecipients: () => {
        throw new Error('x');
      },
      getCcRecipients: () => [],
      getBccRecipients: () => [],
      isReply: () => false,
      addButton: () => {
        throw new Error('toolbar moved');
      },
      registerRequestModifier: vi.fn(),
      getHTMLContent: () => '<div>body</div>',
      setBodyHTML: vi.fn(),
      send: vi.fn(),
    });
    let attempts = 0;
    view.registerRequestModifier.mockImplementation(() => {
      attempts++;
      if (attempts === 1) throw new Error('keyId should be set here'); // no draft id yet
    });
    let handler: ((v: unknown) => void) | null = null;
    sdkState.sdk = {
      ...brokenSdk(),
      Compose: { registerComposeViewHandler: (fn: (v: unknown) => void) => (handler = fn) },
    };
    const adapter = await loadInboxSdkAdapter('sdk_test');
    let compose: ComposeHandle | null = null;
    adapter.onCompose((c) => (compose = c));
    handler!(view);
    const c = compose!;
    expect(c.getFromAddress()).toBeNull();
    expect(c.getFromChoices()).toEqual([]);
    expect(c.getSubject()).toBe('');
    expect(c.getRecipients()).toEqual([]);
    const btn = c.addToggleButton({ initialOn: true, onClick: () => {} });
    expect(() => btn.setOn(false)).not.toThrow();
    c.registerBodyModifier(async ({ body }) => ({ body: `${body}<img>` }));
    expect(attempts).toBe(1);
    view.emit('draftSaved');
    expect(attempts).toBe(2);
    view.emit('draftSaved');
    expect(attempts).toBe(2); // registered once only
  });

  it('compose: presending fallback (no draft id) cancels, rewrites in place and re-sends once', async () => {
    const view = Object.assign(new Emitter(), {
      getComposeID: () => 'cid2',
      getFromContact: () => ({ emailAddress: 'me@x.com' }),
      getFromContactChoices: () => [],
      getSubject: () => 's',
      getToRecipients: () => [],
      getCcRecipients: () => [],
      getBccRecipients: () => [],
      isReply: () => false,
      addButton: () => {},
      registerRequestModifier: () => {
        throw new Error('keyId should be set here');
      },
      getHTMLContent: () => '<div>body</div>',
      setBodyHTML: vi.fn(),
      send: vi.fn(),
    });
    let handler: ((v: unknown) => void) | null = null;
    sdkState.sdk = {
      ...brokenSdk(),
      Compose: { registerComposeViewHandler: (fn: (v: unknown) => void) => (handler = fn) },
    };
    const adapter = await loadInboxSdkAdapter('sdk_test');
    adapter.onCompose((c) =>
      c.registerBodyModifier(async ({ body }) => ({ body: `${body}<img data-postmark="1">` })),
    );
    handler!(view);
    const cancel = vi.fn();
    view.emit('presending', { cancel });
    expect(cancel).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.setBodyHTML).toHaveBeenCalledWith('<div>body</div><img data-postmark="1">');
    expect(view.send).toHaveBeenCalledOnce();
  });

  it('rows and message views degrade safely', async () => {
    let rowHandler: ((v: unknown) => void) | null = null;
    let mvHandler: ((v: unknown) => void) | null = null;
    sdkState.sdk = {
      ...brokenSdk(),
      Lists: { registerThreadRowViewHandler: (fn: (v: unknown) => void) => (rowHandler = fn) },
      Conversations: { registerMessageViewHandler: (fn: (v: unknown) => void) => (mvHandler = fn) },
    };
    const adapter = await loadInboxSdkAdapter('sdk_test');
    const rows: ThreadRowHandle[] = [];
    const mvs: MessageViewHandle[] = [];
    adapter.onThreadRow((r) => rows.push(r));
    adapter.onMessageView((m) => mvs.push(m));
    rowHandler!(
      Object.assign(new Emitter(), {
        getThreadIDIfStableAsync: () => Promise.reject(new Error('unstable')),
        addAttachmentIcon: () => {
          throw new Error('column gone');
        },
        getVisibleMessageCount: () => {
          throw new Error('x');
        },
        getContacts: () => {
          throw new Error('x');
        },
      }),
    );
    mvHandler!(
      Object.assign(new Emitter(), {
        getMessageIDAsync: () => Promise.reject(new Error('x')),
        getThreadView: () => {
          throw new Error('x');
        },
        getSender: () => {
          throw new Error('x');
        },
        getBodyElement: () => {
          throw new Error('x');
        },
        isLoaded: () => {
          throw new Error('x');
        },
      }),
    );
    const [row] = rows;
    const [mv] = mvs;
    expect(await row!.getThreadId()).toBeNull();
    expect(() =>
      row!.setMarks({ status: { iconUrl: 'x', tooltip: 'y' }, clicks: null }),
    ).not.toThrow();
    expect(row!.getVisibleMessageCount()).toBe(0);
    expect(row!.getContactEmails()).toEqual([]);
    expect(await mv!.getMessageId()).toBeNull();
    expect(await mv!.getThreadId()).toBeNull();
    expect(mv!.getSenderEmail()).toBeNull();
    expect(mv!.getLaterSenders()).toEqual([]);
    expect(mv!.mountAboveBody(document.createElement('div'))).toBe(false);
    expect(mv!.isLoaded()).toBe(false);
  });
});
