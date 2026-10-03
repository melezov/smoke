// smoke, the web version: the same three buttons, counting and log as the Android app, running in the browser.
// Nothing is sent anywhere: the log lives in this browser's own database (IndexedDB) on this phone.

export const ZONE = "Europe/Zagreb"; // entry times are shown in this zone, whatever the phone is set to
export const MAX_COUNT = 5;          // at most this many sticks in one entry
export const WINDOW_MS = 5000;       // taps within this window count up the same entry

export const PRODUCTS = [
  { id: "LEVIA_SUMMER_PEARL", label: "Levia Summer Pearl", color: "#F2823A" },
  { id: "TEREA_BRONZE", label: "Terea Bronze", color: "#A9713A" },
  { id: "TEREA_TURQUOISE_BLACK", label: "Terea Turquoise Black Edition", color: "#1FA7B5" },
];

/**
 * Where the log is kept: the browser's own database (IndexedDB), one record per entry, keyed by its id.
 * It survives closing the page, the browser and the phone; only clearing the site's data removes it.
 */
export class BrowserDatabase {
  constructor(name = "smoke") {
    this.opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async run(mode, work) {
    const db = await this.opened;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("entries", mode);
      const request = work(transaction.objectStore("entries"));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }

  all() { return this.run("readonly", (store) => store.getAll()); }
  put(entry) { return this.run("readwrite", (store) => store.put(entry)); }
  delete(id) { return this.run("readwrite", (store) => store.delete(id)); }
}

/**
 * The log: entries { id, product, count, time (epoch ms, whole seconds) }, newest first. The list in memory
 * is what the page shows; every change is written to the database, and `saved` settles when all are in.
 */
export class Log {
  constructor(database) {
    this.database = database;
    this.entries = [];
    this.saved = Promise.resolve();
  }

  /** Reads the stored entries; call once before use. */
  async load() {
    this.entries = (await this.database.all()).sort((a, b) => b.time - a.time);
    return this;
  }

  add(product, count, time) {
    const entry = {
      id: `${time}-${Math.random().toString(36).slice(2, 10)}`,
      product,
      count: Math.min(Math.max(count, 1), MAX_COUNT),
      time: Math.floor(time / 1000) * 1000,
    };
    this.entries = [...this.entries, entry].sort((a, b) => b.time - a.time);
    this.write(() => this.database.put(entry));
    return entry;
  }

  remove(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.write(() => this.database.delete(id));
  }

  write(change) {
    this.saved = this.saved.then(change).catch((error) => { this.failed = error; });
  }
}

/**
 * Tap logic, the same as the Android app's: a tap starts an entry with one stick, further taps on the same
 * button within the window raise the count (up to MAX_COUNT) and restart the window; when it passes the
 * entry is logged with the time of the first tap. Another button logs the open entry at once.
 */
export class Taps {
  // The timer functions are wrapped: called as methods of this object, the browser's own setTimeout and
  // clearTimeout throw "Illegal invocation" (they insist on the window as their `this`).
  constructor(log, { now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), onChange = () => {} } = {}) {
    Object.assign(this, { log, now, setTimer, clearTimer, onChange });
    this.pending = null;
    this.timer = null;
  }

  tap(product) {
    if (this.pending && this.pending.product === product) {
      this.pending = { ...this.pending, count: Math.min(this.pending.count + 1, MAX_COUNT) };
    } else {
      this.store();
      this.pending = { product, count: 1, firstTap: this.now() };
    }
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.store(), WINDOW_MS);
    this.onChange();
  }

  /** Drops the open entry: nothing is logged. */
  undo() {
    this.clearTimer(this.timer);
    this.pending = null;
    this.onChange();
  }

  /** Logs the open entry now (window passed, page hidden, or another button tapped). */
  store() {
    this.clearTimer(this.timer);
    if (!this.pending) return;
    const { product, count, firstTap } = this.pending;
    this.pending = null;
    this.log.add(product, count, firstTap);
    this.onChange();
  }
}

const DAY = new Intl.DateTimeFormat("sv-SE", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const TIME = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export const dayOf = (time) => DAY.format(new Date(time));   // 2026-10-03
export const timeOf = (time) => TIME.format(new Date(time)); // 16:37:46

/** The entries grouped by day, newest day first: [{ day, sticks, entries }]. */
export function days(entries) {
  const groups = [];
  for (const entry of entries) {
    const day = dayOf(entry.time);
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) groups.push((group = { day, sticks: 0, entries: [] }));
    group.sticks += entry.count;
    group.entries.push(entry);
  }
  return groups;
}

// ---- the page (not run under the tests, which have no document) ----

const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2,16h15v3L2,19zM20.5,16L22,16v3h-1.5zM18,16h1.5v3L18,19zM18.85,7.73c0.62,-0.61 1,-1.45 1,-2.38C19.85,3.5 18.35,2 16.5,2v1.5c1.02,0 1.85,0.83 1.85,1.85S17.52,7.2 16.5,7.2v1.5c2.24,0 4,1.83 4,4.07L20.5,15L22,15v-2.24c0,-2.22 -1.28,-4.14 -3.15,-5.03zM16.03,10.2L14.5,10.2c-1.02,0 -1.85,-0.98 -1.85,-2s0.83,-1.75 1.85,-1.75v-1.5c-1.85,0 -3.35,1.5 -3.35,3.35s1.5,3.35 3.35,3.35h1.53c1.05,0 1.97,0.74 1.97,2.05L18,15h1.5v-1.64c0,-1.81 -1.6,-3.16 -3.47,-3.16z"/></svg>';

async function start() {
  // Ask the browser never to evict the database when storage runs low.
  navigator.storage?.persist?.();
  const log = await new Log(new BrowserDatabase()).load();
  const label = (id) => PRODUCTS.find((p) => p.id === id)?.label ?? id;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const buttons = document.getElementById("buttons");
  const pendingBar = document.getElementById("pending");
  const list = document.getElementById("log");

  const render = () => {
    pendingBar.hidden = !taps.pending;
    if (taps.pending) {
      pendingBar.replaceChildren(
        el("span", { className: "what", textContent: `${label(taps.pending.product)} ${taps.pending.count}` }),
        el("button", { className: "text", textContent: "Undo", onclick: () => taps.undo() }),
      );
    }
    list.replaceChildren(
      ...days(log.entries).flatMap((group) => [
        el("h2", { textContent: `${group.day} · ${group.sticks}` }),
        ...group.entries.map((entry) =>
          el("div", { className: "row" },
            el("span", { className: "time", textContent: timeOf(entry.time) }),
            el("span", { className: "name", textContent: `${label(entry.product)} ${entry.count}` }),
            el("button", { className: "text x", textContent: "✕", ariaLabel: "Remove", onclick: () => { log.remove(entry.id); render(); } }),
          )),
      ]),
    );
  };

  const taps = new Taps(log, { onChange: render });
  for (const product of PRODUCTS) {
    const button = el("button", { className: "tap", onclick: () => taps.tap(product.id) });
    button.innerHTML = ICON;
    button.firstChild.style.color = product.color;
    button.append(el("span", { textContent: product.label }));
    buttons.append(button);
  }
  // Leaving the page logs the entry being tapped, so nothing is lost with the tab.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") taps.store(); });
  window.addEventListener("pagehide", () => taps.store());
  render();

  // Work offline once loaded.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
}

if (typeof document !== "undefined") start();
