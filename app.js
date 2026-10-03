// smoke, the web version: pack buttons, counting and a log, running in the browser.
// Nothing is sent anywhere: the log and the settings live in this browser's own database (IndexedDB) on this phone.

export const ZONE = "Europe/Zagreb"; // entry times are shown in this zone, whatever the phone is set to
export const MAX_COUNT = 5;          // at most this many sticks in one entry
export const WINDOW_MS = 5000;       // taps within this window count up the same entry

/** The packs on the strip until the user chooses others in the settings. */
export const DEFAULT_SELECTED = ["LEVIA_SUMMER_PEARL", "TEREA_BRONZE", "TEREA_TURQUOISE_BLACK"];

/** The settings list shows these groups, in this order, each sorted by name. */
export const LINES = ["Terea", "Levia"];
// The countries whose packs the settings offer, and the one a pack without a country belongs to.
export const COUNTRIES = ["HR", "PL"];
export const DEFAULT_COUNTRY = "PL";

/** Opens a database at whatever version it has; a new one gets its single store. Never asks for an upgrade. */
function openDatabase(name, store, keyPath) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath });
    };
    request.onsuccess = () => {
      // Should anything ever ask for a newer version, let go rather than hold it back.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * The browser's own storage (IndexedDB): the log in the database "smoke", one record per entry keyed by its
 * id, and the settings in the database "smoke-settings", one record per key. Both survive closing the page,
 * the browser and the phone; only clearing the site's data removes them.
 *
 * Two databases, each opened at the version it has, because adding a store to an existing database is an
 * upgrade, and the browser holds an upgrade back for as long as any other page has that database open
 * (2026-10-03: the settings store was added to "smoke" that way, and with an older tab or the installed copy
 * still open the page stayed black forever). Nothing here ever asks for an upgrade of a database that exists.
 */
export class BrowserDatabase {
  constructor(name = "smoke") {
    this.entries = openDatabase(name, "entries", "id");
    this.settings = openDatabase(`${name}-settings`, "settings", "key");
  }

  async run(opened, name, mode, work) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode);
      const request = work(transaction.objectStore(name));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  }

  all() { return this.run(this.entries, "entries", "readonly", (store) => store.getAll()); }
  put(entry) { return this.run(this.entries, "entries", "readwrite", (store) => store.put(entry)); }
  delete(id) { return this.run(this.entries, "entries", "readwrite", (store) => store.delete(id)); }

  async setting(key) {
    const record = await this.run(this.settings, "settings", "readonly", (store) => store.get(key));
    if (record) return record.value;
    // A selection made on 2026-10-03, while the settings were a store inside the log's database.
    const old = await this.entries;
    if (!old.objectStoreNames.contains("settings")) return undefined;
    return (await this.run(this.entries, "settings", "readonly", (store) => store.get(key)))?.value;
  }

  saveSetting(key, value) { return this.run(this.settings, "settings", "readwrite", (store) => store.put({ key, value })); }
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

  /** Reads the stored entries; call once. Entries added while the read was under way are kept. */
  async load() {
    const stored = await this.database.all();
    const known = new Set(stored.map((e) => e.id));
    this.entries = [...stored, ...this.entries.filter((e) => !known.has(e.id))].sort((a, b) => b.time - a.time);
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
 * Which packs are on the strip, in the order they were chosen, and which country's list the settings open
 * on: kept in the settings database under the keys "selected" and "country". Packs of any country can be
 * on the strip together.
 */
export class Selection {
  constructor(database) {
    this.database = database;
    this.ids = [...DEFAULT_SELECTED];
    this.country = DEFAULT_COUNTRY;
    this.saved = Promise.resolve();
  }

  async load() {
    try {
      const stored = await this.database.setting("selected");
      if (Array.isArray(stored)) this.ids = stored;
      const country = await this.database.setting("country");
      if (COUNTRIES.includes(country)) this.country = country;
    } catch (error) {
      // The settings cannot be read: the default packs.
      this.failed = error;
    }
    return this;
  }

  has(id) { return this.ids.includes(id); }

  /**
   * Puts a pack on the strip or takes it off. `same` are the other packs of the same stick (the other
   * countries' packaging of it): choosing one takes those off, so a stick is on the strip once, in the
   * packaging chosen last.
   */
  set(id, selected, same = []) {
    const rest = this.ids.filter((x) => x !== id && !(selected && same.includes(x)));
    this.ids = selected ? [...rest, id] : rest;
    this.save("selected", this.ids);
  }

  setCountry(country) {
    this.country = country;
    this.save("country", country);
  }

  save(key, value) {
    this.saved = this.saved.then(() => this.database.saveSetting(key, value)).catch((error) => { this.failed = error; });
  }
}

const byLabel = (a, b) => a.label.localeCompare(b.label, "en");

/** The stick a pack holds: the same stick sold in two countries is two packs (label, picture) of one stick. */
export const stickOf = (product) => product.stick ?? product.id;

/** The other packs of the same stick as the given one. */
export function sameStick(products, id) {
  const product = products.find((p) => p.id === id);
  return product ? products.filter((p) => p.id !== id && stickOf(p) === stickOf(product)).map((p) => p.id) : [];
}

/** The selected packs as they stand on the strip: one per stick (the one chosen last), sorted by name. */
export function strip(products, selection) {
  const chosen = new Map();
  for (const id of selection.ids) {
    const product = products.find((p) => p.id === id);
    if (product) chosen.set(stickOf(product), product);
  }
  return [...chosen.values()].sort(byLabel);
}

/** One country's packs for the settings list: one group per line, in the order of LINES, each sorted by name. */
export function groups(products, country) {
  const there = products.filter((p) => !country || (p.country ?? DEFAULT_COUNTRY) === country);
  return LINES
    .map((line) => ({ line, products: there.filter((p) => p.line === line).sort(byLabel) }))
    .filter((group) => group.products.length);
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
  const result = [];
  for (const entry of entries) {
    const day = dayOf(entry.time);
    let group = result[result.length - 1];
    if (!group || group.day !== day) result.push((group = { day, sticks: 0, entries: [] }));
    group.sticks += entry.count;
    group.entries.push(entry);
  }
  return result;
}

// ---- the page (not run under the tests, which have no document) ----

async function start() {
  // Ask the browser never to evict the database when storage runs low.
  navigator.storage?.persist?.();
  // The page is drawn and works before the database answers: a slow or stuck database must never leave an
  // empty screen. What it holds is drawn when it arrives.
  const database = new BrowserDatabase("smoke");
  const log = new Log(database);
  const selection = new Selection(database);
  const products = await fetch("products.json").then((response) => response.json());
  // An entry of a product that is no longer in the list still shows, under its id.
  // The log holds sticks, not packs: the same stick from either country's pack is the same entry.
  const label = (id) => products.find((p) => stickOf(p) === id)?.label ?? id;
  const several = (product) => new Set(products.filter((p) => stickOf(p) === stickOf(product)).map((p) => p.country)).size > 1;
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const buttons = document.getElementById("buttons");
  const left = document.getElementById("left");
  const right = document.getElementById("right");
  const pendingBar = document.getElementById("pending");
  const list = document.getElementById("log");
  const settings = document.getElementById("settings");

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

  // The strip: the selected packs, three to a screen; more than fit are reached by sliding or the arrows.
  const arrows = () => {
    const most = buttons.scrollWidth - buttons.clientWidth;
    left.hidden = buttons.scrollLeft <= 1;
    right.hidden = buttons.scrollLeft >= most - 1;
  };
  const renderStrip = () => {
    buttons.replaceChildren(
      // The button is the picture of the pack, no caption; the name is there for screen readers.
      ...strip(products, selection).map((product) =>
        el("button", { className: "tap", ariaLabel: product.label, onclick: () => taps.tap(stickOf(product)) },
          el("img", { src: product.image, alt: "", draggable: false }),
          // Sold in both countries: a small mark says whose pack this is.
          ...(several(product) ? [el("span", { className: "flag", textContent: product.country })] : []))),
    );
    arrows();
  };
  const step = () => (buttons.firstElementChild?.getBoundingClientRect().width ?? buttons.clientWidth / 3) + 8;
  left.onclick = () => buttons.scrollBy({ left: -step(), behavior: "smooth" });
  right.onclick = () => buttons.scrollBy({ left: step(), behavior: "smooth" });
  buttons.addEventListener("scroll", arrows, { passive: true });
  window.addEventListener("resize", arrows);

  // Dragging with a mouse slides the strip like a finger does; a drag is not a tap.
  let drag = null;
  buttons.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") drag = { x: event.clientX, from: buttons.scrollLeft, moved: false };
  });
  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > 5) drag.moved = true;
    if (drag.moved) buttons.scrollLeft = drag.from - dx;
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    // The click the browser sends right after a drag is swallowed; the guard is gone a moment later, so that
    // a drag which ends without a click cannot eat the next real tap.
    const swallow = (event) => { event.stopPropagation(); event.preventDefault(); };
    buttons.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => buttons.removeEventListener("click", swallow, { capture: true }), 0);
  });

  // Settings: a tab per country, its packs grouped by line and sorted by name; ticked ones are on the strip.
  const renderSettings = () => {
    document.getElementById("countries").replaceChildren(
      ...COUNTRIES.map((country) =>
        el("button", { className: "country", textContent: country, ariaPressed: String(country === selection.country),
          onclick: () => { selection.setCountry(country); renderSettings(); } })),
    );
    document.getElementById("products").replaceChildren(
      ...groups(products, selection.country).flatMap((group) => [
        el("h3", { textContent: group.line }),
        ...group.products.map((product) => {
          const box = el("input", { type: "checkbox", checked: selection.has(product.id) });
          box.onchange = () => { selection.set(product.id, box.checked, sameStick(products, product.id)); renderStrip(); };
          return el("label", { className: "product" }, box, el("img", { src: product.image, alt: "", loading: "lazy" }), el("span", { textContent: product.label }));
        }),
      ]),
    );
  };
  document.getElementById("gear").onclick = () => { renderSettings(); settings.showModal(); };
  document.getElementById("done").onclick = () => settings.close();

  // Leaving the page logs the entry being tapped, so nothing is lost with the tab.
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") taps.store(); });
  window.addEventListener("pagehide", () => taps.store());
  renderStrip();
  render();
  selection.load().then(renderStrip);
  const waiting = setTimeout(() => {
    if (!log.entries.length) list.textContent = "The log is not answering. Close every other smoke tab or window, then reopen this one.";
  }, 4000);
  log.load().then(() => { clearTimeout(waiting); render(); });

  // Work offline once loaded.
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
}

// Whatever goes wrong while starting is said on the page, never left as an empty screen.
if (typeof document !== "undefined") {
  start().catch((error) => {
    document.getElementById("log").textContent = `smoke could not start: ${error?.message ?? error}`;
  });
}
