const KEY = 'glowstone_db_v1';

// Tag prices end in 3s and 7s below $200 — owner A/B tested vs 4s/9s and 5s/0s: 34% higher conversion.
export const DEFAULT_CHIPS = [17, 23, 27, 33, 37, 43, 47, 53, 67];
const LEGACY_CHIPS = JSON.stringify([20, 30, 40, 50, 60, 80, 100, 150]);

export const DEFAULT_CATEGORIES = [
  'Amethyst Cut Base',
  'Amethyst Cluster/Cavity',
  'Agate/Slice',
  'Labradorite',
  'Fluorite',
  'Quartz (Clear/Smoky)',
  'Petrified Wood',
  'Septarian',
  'Celestite',
  'Orthoceras',
  'Ammonite/Goniatite',
  'Meg/Shark Teeth',
  'Geode',
  'Other Mineral',
  'Other Fossil',
  'Premium/XL'
];

export const VENUE_TYPES = [
  'Art Fair', 'Craft Fair', 'Farmers Market', 'Food/Wine Fest',
  'Holiday Market', 'Street Fair', 'Sportsman Show', 'Other'
];

function defaults() {
  return {
    version: 2,
    activeDayId: null,
    events: [],
    days: [],
    sales: [],
    zettle: {},
    tombstones: [],
    syncReviewRequired: false,
    plannerEvents: [],
    plannerTasks: [],
    plannerFeed: { version: null, generatedAt: null, sourceSheet: 'Events_Master', events: [], issues: [], fetchedAt: null },
    importCatalog: { version: null, generatedAt: null, dates: [], fetchedAt: null },
    priceCatalog: { materials: [], fetchedAt: null },
    settings: {
      chips: DEFAULT_CHIPS.slice(),
      categories: DEFAULT_CATEGORIES.slice(),
      defaultFloat: 200,
      dark: false,
      syncUrl: '',
      syncKey: ''
    }
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const db = JSON.parse(raw);
    // shallow-merge settings so new defaults appear for old installs
    const base = defaults();
    db.settings = Object.assign(base.settings, db.settings || {});
    for (const k of ['events', 'days', 'sales', 'tombstones', 'plannerEvents', 'plannerTasks']) if (!Array.isArray(db[k])) db[k] = [];
    db.plannerEvents = db.plannerEvents.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    db.plannerTasks = db.plannerTasks.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
    if (typeof db.plannerFeed !== 'object' || db.plannerFeed === null ||
      !Array.isArray(db.plannerFeed.events) || !Array.isArray(db.plannerFeed.issues)) {
      db.plannerFeed = base.plannerFeed;
    } else {
      db.plannerFeed = Object.assign(base.plannerFeed, db.plannerFeed);
    }
    if (typeof db.zettle !== 'object' || db.zettle === null) db.zettle = {};
    db.syncReviewRequired = db.syncReviewRequired === true
      || Object.values(db.zettle).some((item) => item && item.synced !== true);
    if (typeof db.importCatalog !== 'object' || db.importCatalog === null || !Array.isArray(db.importCatalog.dates)) db.importCatalog = base.importCatalog;
    else db.importCatalog = Object.assign(base.importCatalog, db.importCatalog);
    if (typeof db.priceCatalog !== 'object' || db.priceCatalog === null || !Array.isArray(db.priceCatalog.materials)) db.priceCatalog = base.priceCatalog;
    if (JSON.stringify(db.settings.chips) === LEGACY_CHIPS) db.settings.chips = DEFAULT_CHIPS.slice();
    db.version = 2;
    return db;
  } catch {
    return defaults();
  }
}

export function save(db) {
  localStorage.setItem(KEY, JSON.stringify(db));
}

// Replace the entire database (backup restore). Caller should reload after.
export function replaceDb(next) {
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
