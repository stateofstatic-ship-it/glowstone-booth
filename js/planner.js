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

const DAY_MS = 86400000;
const ENTRY_ORDER = { deadline: 0, reminder: 1, task: 2, event: 3 };

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
  const statusByEventId = new Map(events.map((event) => [String(event.id || ''), event.status || 'research']));
  const eventById = new Map(events.map((event) => [String(event.id || ''), event]));

  events.forEach((event, index) => {
    const sourceId = String(event.id || `event-${index}`);
    const name = eventName(event);
    const status = event.status || 'research';
    if (['declined', 'skip', 'complete'].includes(status)) return;
    const rawStart = validDate(event.eventStart) ? event.eventStart : '';
    const rawEnd = validDate(event.eventEnd) ? event.eventEnd : '';
    if (rawStart || rawEnd) {
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
      item('eligibility', 'Verify artist-made eligibility, fees, and product category', reminder || addDays(anchor, -120), 'application', 'high'),
      item('photos', 'Prepare luxury-focused product, booth photos, and artist statement', addDays(anchor, -60), 'application'),
      item('submit', 'Submit application', addDays(anchor, -14), 'application', 'high'),
      item('receipt', 'Confirm application receipt', anchor, 'application')
    ];
  }
  return [
    item('eligibility', 'Check official application dates, fees, and artist-made eligibility', anchor, 'application', 'high'),
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
