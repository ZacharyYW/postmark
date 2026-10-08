/* A small in-memory stand-in for the chrome.* APIs the extension uses. */
type Listener<A extends unknown[]> = (...a: A) => void;

class FakeEvent<A extends unknown[]> {
  listeners: Listener<A>[] = [];
  addListener(l: Listener<A>) {
    this.listeners.push(l);
  }
  removeListener(l: Listener<A>) {
    this.listeners = this.listeners.filter((x) => x !== l);
  }
  emit(...a: A) {
    for (const l of this.listeners) l(...a);
  }
}

function area() {
  let data: Record<string, unknown> = {};
  return {
    async get(keys?: string | string[] | null) {
      if (keys === undefined || keys === null) return structuredClone(data);
      const ks = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(items: Record<string, unknown>) {
      data = { ...data, ...structuredClone(items) };
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear() {
      data = {};
    },
    _dump: () => data,
  };
}

export interface FakeChrome {
  storage: { local: ReturnType<typeof area>; session: ReturnType<typeof area> };
  alarms: {
    _alarms: Map<string, { name: string; periodInMinutes?: number; scheduledTime: number }>;
    create(
      name: string,
      info: { periodInMinutes?: number; delayInMinutes?: number; when?: number },
    ): Promise<void>;
    get(name: string): Promise<{ name: string; periodInMinutes?: number } | undefined>;
    getAll(): Promise<{ name: string }[]>;
    clear(name: string): Promise<boolean>;
    onAlarm: FakeEvent<[{ name: string }]>;
  };
  notifications: {
    _shown: { id: string; opts: { title: string; message: string } }[];
    create(id: string, opts: { title: string; message: string }): Promise<string>;
    clear(id: string): Promise<boolean>;
    onClicked: FakeEvent<[string]>;
  };
  tabs: {
    _created: string[];
    _sent: { tabId: number; msg: unknown }[];
    create(o: { url: string }): Promise<void>;
    query(q: unknown): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, msg: unknown): Promise<void>;
    onRemoved: FakeEvent<[number]>;
    _active: number | undefined;
  };
  runtime: {
    id: string;
    getURL(p: string): string;
    sendMessage(msg: unknown): Promise<unknown>;
    onMessage: FakeEvent<[unknown, unknown, (r: unknown) => void]>;
    openOptionsPage(): Promise<void>;
    onInstalled: FakeEvent<[unknown]>;
    onStartup: FakeEvent<[]>;
  };
  permissions: { request(o: unknown): Promise<boolean>; contains(o: unknown): Promise<boolean> };
}

export function createFakeChrome(): FakeChrome {
  const alarms = new Map<
    string,
    { name: string; periodInMinutes?: number; scheduledTime: number }
  >();
  const fake: FakeChrome = {
    storage: { local: area(), session: area() },
    alarms: {
      _alarms: alarms,
      async create(name, info) {
        alarms.set(name, {
          name,
          ...(info.periodInMinutes !== undefined && { periodInMinutes: info.periodInMinutes }),
          scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000,
        });
      },
      async get(name) {
        return alarms.get(name);
      },
      async getAll() {
        return [...alarms.values()];
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: new FakeEvent(),
    },
    notifications: {
      _shown: [],
      async create(id, opts) {
        fake.notifications._shown.push({ id, opts });
        return id;
      },
      async clear() {
        return true;
      },
      onClicked: new FakeEvent(),
    },
    tabs: {
      _created: [],
      _sent: [],
      _active: undefined,
      async create(o) {
        fake.tabs._created.push(o.url);
      },
      async query() {
        return fake.tabs._active === undefined ? [] : [{ id: fake.tabs._active }];
      },
      async sendMessage(tabId, msg) {
        fake.tabs._sent.push({ tabId, msg });
      },
      onRemoved: new FakeEvent(),
    },
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (p) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
      async sendMessage() {
        return undefined;
      },
      onMessage: new FakeEvent(),
      async openOptionsPage() {},
      onInstalled: new FakeEvent(),
      onStartup: new FakeEvent(),
    },
    permissions: {
      async request() {
        return true;
      },
      async contains() {
        return true;
      },
    },
  };
  return fake;
}

export function installFakeChrome(): FakeChrome {
  const fake = createFakeChrome();
  (globalThis as unknown as { chrome: FakeChrome }).chrome = fake;
  return fake;
}
