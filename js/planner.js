export const PLANNER_STATUSES = [
  'research',
  'shortlist',
  'applying',
  'applied',
  'accepted',
  'booked',
  'declined',
  'skip',
  'complete'
];

export const TASK_KINDS = ['application', 'event-prep', 'follow-up', 'general'];

export const GLOWSTONE_PROCESS_SUMMARY = "Much of Glowstone's work starts as raw mineral material. The artist performs grinding, coring, polishing, shaping, mounting, wiring/lighting, and final finishing.";

const DAY_MS = 86400000;
const ENTRY_ORDER = { deadline: 0, reminder: 1, task: 2, event: 3 };
const PLANNER_FEED_VERSION = 1;
const FEED_STATUS_MAP = {
  approved: 'booked',
  accepted: 'booked',
  confirmed: 'booked',
  booked: 'booked',
  applied: 'applied',
  submitted: 'applied',
  shortlist: 'shortlist',
  shortlisted: 'shortlist',
  waitlist: 'shortlist',
  waitlisted: 'shortlist',
  inquired: 'research',
  inquiry: 'research',
  research: 'research',
  completed: 'complete',
  complete: 'complete',
  rejected: 'declined',
  declined: 'declined',
  denied: 'declined'
};

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayNumber(value) {
  if (!validDate(value)) return null;
  return Math.floor(new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MS);
}

function dateFromDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function addDays(value, amount) {
  const day = dayNumber(value);
  return day === null ? '' : dateFromDay(day + amount);
}

function eventName(event) {
  return String(event.name || event.title || 'Untitled event').trim() || 'Untitled event';
}

function limitedText(value, maxLength) {
  return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function normalizedEventName(value) {
  const normalized = limitedText(value, 200)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+20\d{2}$/, '');
  if ([
    'bam',
    'bam arts fair',
    'bellevue arts fair',
    'bellevue festival of the arts'
  ].includes(normalized)) return 'bam arts fair';
  return normalized;
}

function eventFingerprint(name, startDate) {
  const normalized = normalizedEventName(name);
  return normalized && validDate(startDate) ? `${normalized}|${startDate}` : '';
}

function feedStatus(value) {
  return FEED_STATUS_MAP[limitedText(value, 40).toLowerCase()] || '';
}

function normalizeFeedEvent(value, index, strict = false) {
  const fail = (message) => {
    if (strict) throw new TypeError(`Invalid Events_Master event at index ${index}: ${message}`);
    return null;
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('event must be an object');
  const name = limitedText(value.name || value.eventName, 200);
  const eventStart = limitedText(value.startDate || value.eventStart, 10);
  const eventEnd = limitedText(value.endDate || value.eventEnd || eventStart, 10);
  const status = feedStatus(value.status || value.rawStatus);
  if (!name) return fail('name is required');
  if (!validDate(eventStart) || !validDate(eventEnd) || eventEnd < eventStart) return fail('date range is invalid');
  if (!status) return fail('status is unsupported');
  const sourceRow = Number(value.sourceRow);
  if (!Number.isInteger(sourceRow) || sourceRow < 1) return fail('source row is invalid');
  const id = limitedText(value.id, 240);
  if (!id) return fail('id is required');
  const applicationDeadline = limitedText(value.applicationDeadline, 10);
  if (applicationDeadline && !validDate(applicationDeadline)) return fail('application deadline is invalid');
  return {
    id,
    sourceRow,
    name,
    canonicalEvent: limitedText(value.canonicalEvent || name, 200),
    eventType: limitedText(value.eventType || value.venueType, 100),
    eventStart,
    eventEnd,
    status,
    statusLabel: limitedText(value.rawStatus || value.statusLabel || status, 80),
    rawStatus: limitedText(value.rawStatus || value.status, 80),
    applicationDeadline,
    state: limitedText(value.state, 40),
    notes: limitedText(value.notes, 2000),
    readOnly: true,
    sourceSheet: 'Events_Master'
  };
}

function normalizeFeedIssue(value) {
  if (typeof value === 'string') return { sourceRow: null, name: '', reason: limitedText(value, 500) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sourceRow = Number(value.sourceRow);
  const reason = limitedText(value.reason || value.issue || value.message, 500);
  if (!reason) return null;
  return {
    sourceRow: Number.isInteger(sourceRow) && sourceRow > 0 ? sourceRow : null,
    name: limitedText(value.name || value.eventName, 200),
    reason
  };
}

export function validatePlannerFeedResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) {
    throw new TypeError('Events_Master response was rejected');
  }
  if (Number(value.plannerFeedVersion) !== PLANNER_FEED_VERSION) {
    throw new TypeError('Events_Master feed version is unsupported');
  }
  if (value.sourceSheet !== 'Events_Master') {
    throw new TypeError('Events_Master feed source is invalid');
  }
  const generatedAt = limitedText(value.generatedAt, 40);
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError('Events_Master feed timestamp is invalid');
  }
  if (!Array.isArray(value.events)) {
    throw new TypeError('Events_Master feed events are missing');
  }
  const seen = new Set();
  const events = value.events.map((event, index) => normalizeFeedEvent(event, index, true))
    .filter((event) => {
      const key = `${event.id}|${eventFingerprint(event.canonicalEvent || event.name, event.eventStart)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const issues = Array.isArray(value.issues)
    ? value.issues.map(normalizeFeedIssue).filter(Boolean)
    : [];
  return {
    version: PLANNER_FEED_VERSION,
    generatedAt,
    sourceSheet: 'Events_Master',
    events,
    issues
  };
}

export function scheduledPlannerEvents(db) {
  const values = Array.isArray(db?.plannerFeed?.events) ? db.plannerFeed.events : [];
  const seen = new Set();
  return values
    .map((event, index) => normalizeFeedEvent(event, index))
    .filter((event) => event && event.status === 'booked')
    .filter((event) => {
      const key = eventFingerprint(event.canonicalEvent || event.name, event.eventStart);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function compareEntries(a, b) {
  return a.date.localeCompare(b.date) ||
    (ENTRY_ORDER[a.type] ?? 9) - (ENTRY_ORDER[b.type] ?? 9) ||
    a.title.localeCompare(b.title);
}

export function monthCells(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || '')) || !validDate(`${month}-01`)) {
    throw new TypeError('month must be YYYY-MM');
  }
  const firstDay = dayNumber(`${month}-01`);
  const weekday = new Date(firstDay * DAY_MS).getUTCDay();
  const gridStart = firstDay - weekday;
  return Array.from({ length: 42 }, (_, index) => {
    const date = dateFromDay(gridStart + index);
    return {
      date,
      day: Number(date.slice(8, 10)),
      inMonth: date.slice(0, 7) === month
    };
  });
}

export function calendarEntries(db) {
  const entries = [];
  const events = Array.isArray(db?.plannerEvents)
    ? db.plannerEvents.filter((event) => event && typeof event === 'object' && !Array.isArray(event))
    : [];
  const tasks = Array.isArray(db?.plannerTasks)
    ? db.plannerTasks.filter((task) => task && typeof task === 'object' && !Array.isArray(task))
    : [];
  const scheduledEvents = scheduledPlannerEvents(db);
  const scheduledFingerprints = new Set(scheduledEvents.map((event) =>
    eventFingerprint(event.canonicalEvent || event.name, event.eventStart)));
  const scheduledIds = new Set(scheduledEvents.map((event) => event.id));
  const statusByEventId = new Map(events.map((event) => [String(event.id || ''), event.status || 'research']));
  const eventById = new Map(events.map((event) => [String(event.id || ''), event]));

  events.forEach((event, index) => {
    const sourceId = String(event.id || `event-${index}`);
    const name = eventName(event);
    const rawStart = validDate(event.eventStart) ? event.eventStart : '';
    const linkedSchedule = scheduledIds.has(String(event.eventsMasterId || '')) ||
      scheduledFingerprints.has(eventFingerprint(name, rawStart));
    const status = linkedSchedule ? 'booked' : event.status || 'research';
    if (['declined', 'skip', 'complete'].includes(status)) return;
    const rawEnd = validDate(event.eventEnd) ? event.eventEnd : '';
    if ((rawStart || rawEnd) && !linkedSchedule) {
      const date = rawStart || rawEnd;
      const endDate = rawEnd && rawEnd >= date ? rawEnd : date;
      entries.push({
        id: `event:${sourceId}`,
        sourceId,
        plannerEventId: sourceId,
        type: 'event',
        title: name,
        date,
        endDate,
        status,
        city: event.city || '',
        state: event.state || '',
        notes: event.notes || '',
        sourceUrl: event.sourceUrl || ''
      });
    }
    if (!['applied', 'accepted', 'booked'].includes(status) && validDate(event.applicationDeadline)) {
      entries.push({
        id: `deadline:${sourceId}`,
        sourceId,
        plannerEventId: sourceId,
        type: 'deadline',
        title: `Application deadline: ${name}`,
        date: event.applicationDeadline,
        endDate: event.applicationDeadline,
        status,
        notes: event.notes || '',
        sourceUrl: event.applicationUrl || event.sourceUrl || ''
      });
    }
    if (!['applied', 'accepted', 'booked'].includes(status) && validDate(event.reminderDate)) {
      entries.push({
        id: `reminder:${sourceId}`,
        sourceId,
        plannerEventId: sourceId,
        type: 'reminder',
        title: `Reminder: ${name}`,
        date: event.reminderDate,
        endDate: event.reminderDate,
        status,
        notes: event.notes || '',
        sourceUrl: event.applicationUrl || event.sourceUrl || ''
      });
    }
  });

  scheduledEvents.forEach((event) => {
    entries.push({
      id: `events-master:${event.id}`,
      sourceId: event.id,
      plannerEventId: null,
      type: 'event',
      title: event.name,
      date: event.eventStart,
      endDate: event.eventEnd,
      status: event.status,
      city: '',
      state: event.state,
      notes: event.notes,
      sourceUrl: '',
      backendSchedule: true,
      sourceSheet: 'Events_Master',
      rawStatus: event.rawStatus,
      statusLabel: event.statusLabel,
      sourceRow: event.sourceRow
    });
  });

  tasks.forEach((task, index) => {
    if (task.completedAt || !validDate(task.dueDate)) return;
    if (task.plannerEventId && ['declined', 'skip', 'complete'].includes(statusByEventId.get(String(task.plannerEventId)))) return;
    const sourceId = String(task.id || `task-${index}`);
    const linkedEvent = task.plannerEventId ? eventById.get(String(task.plannerEventId)) : null;
    const taskTitle = String(task.title || 'Untitled task').trim() || 'Untitled task';
    const reminderDays = Array.isArray(task.reminderDays)
      ? [...new Set(task.reminderDays.map(Number).filter((days) => Number.isInteger(days) && days >= 0))].sort((a, b) => b - a)
      : [1];
    entries.push({
      id: `task:${sourceId}`,
      sourceId,
      plannerEventId: task.plannerEventId || null,
      type: 'task',
      title: linkedEvent ? `${taskTitle}: ${eventName(linkedEvent)}` : taskTitle,
      date: task.dueDate,
      endDate: task.dueDate,
      kind: TASK_KINDS.includes(task.kind) ? task.kind : 'general',
      priority: task.priority || 'normal',
      reminderDays: reminderDays.length ? reminderDays : [1],
      notes: task.notes || ''
    });
  });

  return entries.sort(compareEntries);
}

export function entriesOnDate(db, date) {
  if (!validDate(date)) return [];
  return calendarEntries(db).filter((entry) => entry.date <= date && entry.endDate >= date);
}

export function upcomingItems(db, today, days = 30) {
  const start = dayNumber(today);
  if (start === null) return [];
  const span = Math.max(0, Math.floor(Number(days) || 0));
  const end = dateFromDay(start + span);
  return calendarEntries(db).filter((entry) => {
    if (entry.type === 'event') return entry.date <= end && entry.endDate >= today;
    return entry.date >= today && entry.date <= end;
  });
}

export function fitScore(event) {
  if (!event || typeof event !== 'object') return 0;
  const rating = (value) => Math.min(5, Math.max(0, Number(value) || 0));
  // Luxury and home-decor fit carry most weight because the brand is moving toward premium decor venues.
  const weighted = rating(event.luxuryFit) * 0.35 +
    rating(event.audienceFit) * 0.25 +
    rating(event.homeDecorFit) * 0.25 +
    rating(event.juriedArtFit) * 0.15;
  return Math.round(weighted / 5 * 100);
}

export function checklistTemplates(event, today) {
  if (!event || typeof event !== 'object' || !validDate(today)) return [];
  const booked = ['accepted', 'booked'].includes(event.status);
  if (booked && !validDate(event.eventStart)) return [];
  const deadline = validDate(event.applicationDeadline) ? event.applicationDeadline : '';
  const reminder = validDate(event.reminderDate) ? event.reminderDate : '';
  const anchor = booked ? event.eventStart : deadline || reminder || today;
  const item = (templateKey, title, dueDate, kind, priority = 'normal') => ({
    templateKey, title, dueDate, kind, priority
  });
  if (booked) {
    const end = validDate(event.eventEnd) && event.eventEnd >= event.eventStart ? event.eventEnd : event.eventStart;
    return [
      item('contract', 'Confirm booth fee, contract, insurance, and permits', addDays(anchor, -90), 'event-prep'),
      item('travel', 'Book lodging and confirm travel or freight plan', addDays(anchor, -60), 'event-prep'),
      item('inventory', 'Set inventory and pricing batch plan', addDays(anchor, -30), 'event-prep'),
      item('packing', 'Pack booth, products, signage, and payment gear', addDays(anchor, -2), 'event-prep'),
      item('review', 'Record net sales, costs, and rebook decision', addDays(end, 2), 'follow-up')
    ];
  }
  if (event.status === 'applied') {
    return [item('receipt', 'Confirm application receipt', today, 'application')];
  }
  if (deadline) {
    return [
      item('eligibility', 'Prepare process evidence and confirm artist-made category', reminder || addDays(anchor, -120), 'application', 'high'),
      item('photos', 'Prepare luxury-focused product, booth photos, and artist statement', addDays(anchor, -60), 'application'),
      item('submit', 'Submit application', addDays(anchor, -14), 'application', 'high'),
      item('receipt', 'Confirm application receipt', anchor, 'application')
    ];
  }
  return [
    item('eligibility', 'Check application dates, fees, category, and process-documentation rules', anchor, 'application', 'high'),
    item('decision', 'Decide whether to apply or pass', addDays(anchor, 7), 'application')
  ];
}

function icsEscape(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function icsDate(value) {
  return value.replaceAll('-', '');
}

function safeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function alarmLines(entry) {
  let triggers;
  if (entry.type === 'reminder') triggers = ['PT0M'];
  else if (entry.type === 'deadline') triggers = ['-P30D', '-P7D', '-P1D'];
  else if (entry.type === 'event') triggers = ['-P7D', '-P1D'];
  else triggers = (entry.reminderDays || [1]).map((days) => days === 0 ? 'PT0M' : `-P${days}D`);
  return triggers.flatMap((trigger) => [
    'BEGIN:VALARM',
    `TRIGGER:${trigger}`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(entry.title)}`,
    'END:VALARM'
  ]);
}

function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = '';
  for (const char of line) {
    const limit = parts.length ? 74 : 75;
    if (current && encoder.encode(current + char).length > limit) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(db) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Glowstone Ops//Planner//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Glowstone Ops'
  ];

  calendarEntries(db).forEach((entry) => {
    const location = entry.type === 'event'
      ? [entry.city, entry.state].filter(Boolean).join(', ')
      : '';
    const description = [entry.notes, entry.type === 'deadline' ? 'Application deadline' : '']
      .filter(Boolean)
      .join('\n');
    const url = safeUrl(entry.sourceUrl);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(entry.id)}@glowstone-ops`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(entry.date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(entry.endDate, 1))}`,
      `SUMMARY:${icsEscape(entry.title)}`,
      `CATEGORIES:${entry.type.toUpperCase()}`
    );
    if (location) lines.push(`LOCATION:${icsEscape(location)}`);
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    if (url) lines.push(`URL:${url}`);
    lines.push(...alarmLines(entry), 'END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}
