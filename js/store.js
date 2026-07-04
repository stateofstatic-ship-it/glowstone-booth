const KEY = 'glowstone_db_v1';

export const DEFAULT_CHIPS = [20, 30, 40, 50, 60, 80, 100, 150];

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
    version: 1,
    activeDayId: null,
    events: [],
    days: [],
    sales: [],
    settings: {
      chips: DEFAULT_CHIPS.slice(),
      categories: DEFAULT_CATEGORIES.slice(),
      defaultFloat: 200,
      dark: false
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
    for (const k of ['events', 'days', 'sales']) if (!Array.isArray(db[k])) db[k] = [];
    return db;
  } catch {
    return defaults();
  }
}

export function save(db) {
  localStorage.setItem(KEY, JSON.stringify(db));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
