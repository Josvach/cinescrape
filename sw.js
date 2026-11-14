/**
 * Service worker: a live film-admissions notification, and nothing else.
 *
 * There is no push server — the whole project is a static page fed by a cron
 * job — so the notification is driven from the client. For a watched film it
 * keeps one notification in the tray that always shows the current count and
 * updates it in place, quietly, so the phone does not buzz every few minutes;
 * it only rings on a real jump. While the app is open the page triggers a check
 * after every data refresh; when it is closed, a periodic background sync does
 * it where the platform allows one — an installed PWA on Android. "Always" is
 * therefore best-effort: a locked iPhone will not be woken, and even on Android
 * the browser decides how often the sync runs, so between checks the number is
 * as fresh as the last refresh, not the last second.
 *
 * The watch list and each film's last-seen count live in IndexedDB, which the
 * page and this worker both read.
 */

const DB = "cinescrape-alerts";
const STORE = "watch";
/** A jump this big in today's admissions is worth a buzz, not just a silent update. */
const BUZZ_THRESHOLD = 100;
/** No more than one buzz per film in this window, however fast it sells. */
const BUZZ_QUIET_MS = 10 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

async function allWatched() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putWatched(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(entry);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

const cz = (n) => (n || 0).toLocaleString("cs-CZ");

/**
 * Refresh the notification for every watched film.
 *
 * Today's admissions is the live pulse — it climbs through the day as
 * screenings are read — so that is the headline; the run total rides along in
 * the body. The notification is re-shown on every check so it survives being
 * dismissed and always carries the latest number, silent unless the film has
 * jumped enough since the last time it rang.
 */
async function checkAndNotify() {
  const watched = await allWatched();
  if (watched.length === 0) return;

  const res = await fetch(`data/live.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return;
  const live = await res.json();
  const now = Date.now();

  for (const w of watched) {
    const film = live.films.find((f) => f.id === w.id);
    if (!film) continue;
    const today = film.today?.admissions ?? 0;
    const total = (film.official?.admissions ?? 0) + (film.official?.sinceAdmissions ?? 0);

    const firstTime = w.buzzAt == null;
    const sinceBuzz = today - (firstTime ? today : w.buzzAdmissions ?? today);
    // Ring on the very first show so the user sees it took, then only on a real
    // jump and never more than once per quiet window.
    const ring = firstTime || (sinceBuzz >= BUZZ_THRESHOLD && now - w.buzzAt >= BUZZ_QUIET_MS);

    await self.registration.showNotification(`🎬 ${film.title}`, {
      body: `Dnes ${cz(today)} diváků${total > 0 ? ` · celkem ${cz(total)}` : ""}`,
      tag: `film-${film.id}`,
      renotify: ring,
      silent: !ring,
      // Keep it pinned in the tray as a live readout rather than a transient toast.
      requireInteraction: true,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { id: film.id },
    });

    await putWatched({
      ...w,
      title: film.title,
      lastAdmissions: today,
      buzzAdmissions: ring ? today : w.buzzAdmissions ?? today,
      buzzAt: ring ? now : w.buzzAt ?? 0,
    });
  }
}

async function clearFilm(id) {
  for (const n of await self.registration.getNotifications({ tag: `film-${id}` })) n.close();
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("periodicsync", (e) => {
  if (e.tag === "films") e.waitUntil(checkAndNotify());
});

// The page asks for a check after each refresh, so foreground and background
// share one path. It can also ask to clear a film that was just unwatched.
self.addEventListener("message", (e) => {
  if (e.data === "check") e.waitUntil(checkAndNotify());
  else if (e.data && e.data.clear != null) e.waitUntil(clearFilm(e.data.clear));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data?.id;
  const url = id ? `./#film-${id}-today` : "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          c.navigate?.(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
