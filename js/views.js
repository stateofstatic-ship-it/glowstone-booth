import { db, ui, $, esc, fmt, fmtDate, fmtTime, eventById, dayById, activeDay, daySales, cashLogged, dayTotal, zettleTxnsFor, pct } from './runtime.js';
import { PRICE_MULTIPLIERS, tagPrice } from './pricing.js';
import { VENUE_TYPES, todayStr } from './store.js';
import { updateCloseCalc, updateDayEditCalc } from './actions.js';
import {
  GLOWSTONE_PROCESS_SUMMARY,
  PLANNER_STATUSES,
  TASK_KINDS,
  monthCells,
  calendarEntries,
  entriesOnDate,
  fitScore
} from './planner.js';
import { SUGGESTED_EVENTS } from './event-suggestions.js';
import { syncResultParts } from './sync.js';

export function render() {
  const day = activeDay();
  if (ui.view === 'planner') $('#view').innerHTML = plannerView();
  else $('#view').innerHTML = day && !ui.forceHome ? dayView(day) : homeView();
  renderModal();
}

function homeView() {
  const day = activeDay();
  const today = todayStr();
  const plannerCount = calendarEntries(db)
    .filter(plannerEntryIsActive)
    .filter((entry) => entry.type === 'event'
      ? entry.endDate >= today && entry.date <= dateOffset(today, 7)
      : entry.date <= dateOffset(today, 7))
    .length;
  let html = `
    <div class="topbar">
      <h1>Glowstone Ops</h1>
      <div class="spacer"></div>
      <button class="btn small ghost" data-action="insights-open">Insights</button>
      <button class="btn small ghost" data-action="settings-open">⚙︎ Settings</button>
    </div>
    <div class="row2 home-tools">
      <button class="btn" data-action="price-open">Price Tool</button>
      <button class="btn" data-action="planner-open">Planner${plannerCount ? ` <span class="count-badge">${plannerCount}</span>` : ''}</button>
    </div>`;

  if (day) {
    const ev = eventById(day.eventId);
    html += `
      <div class="banner">Selling day in progress — ${esc(ev?.name)} · ${fmtDate(day.date)}</div>
      <button class="btn primary big" data-action="go-day">Resume selling day</button>`;
  } else {
    html += `<button class="btn primary big" data-action="start-day">Start selling day</button>`;
  }

  const evs = db.events
    .map((ev) => ({ ev, days: db.days.filter((d) => d.eventId === ev.id && !d.mappingOnly).sort((a, b) => b.date.localeCompare(a.date)) }))
    .filter((x) => x.days.length)
    .sort((a, b) => b.days[0].date.localeCompare(a.days[0].date));

  if (!evs.length) {
    html += `<p class="sub" style="margin-top:16px">No selling days yet. Tap the button above at your next event — log every cash sale with one tap, then close the day with your Zettle total.</p>`;
  } else {
    html += `<h2>History</h2>`;
    for (const { ev, days } of evs) {
      const closed = days.filter((d) => d.closedAt);
      const total = closed.reduce((t, d) => t + dayTotal(d), 0);
      const fees = (ev.boothFee || 0) + (ev.otherCosts || 0);
      const rows = days.map((d) => {
        if (!d.closedAt) return `<div class="day-row tappable" data-action="day-open" data-id="${d.id}" data-day-id="${d.id}"><span class="d">${fmtDate(d.date)}</span><span class="t">open — cash logged ${fmt(cashLogged(d))}</span></div>`;
        const perHr = d.hours ? fmt(dayTotal(d) / d.hours) + '/hr' : '';
        const ztx = zettleTxnsFor(d).length;
        return `<div class="day-row tappable" data-action="day-open" data-id="${d.id}" data-day-id="${d.id}"><span class="d">${fmtDate(d.date)}</span><span class="t">${fmt(dayTotal(d))}</span><span class="m">${d.hours ? d.hours + 'h ' + perHr : ''}${ztx ? ' · ' + ztx + ' card txns' : ''}</span></div>`;
      }).join('');
      html += `
        <div class="card">
          <strong>${esc(ev.name)}</strong> <span class="sub">· ${esc(ev.venueType || '')}</span>
          ${rows}
          <div class="sub" style="margin-top:8px">Total ${fmt(total)} − fees ${fmt(fees)} = <strong>${fmt(total - fees)}</strong></div>
        </div>`;
    }
  }
  return html;
}

function dayView(day) {
  const ev = eventById(day.eventId);
  const cash = cashLogged(day);
  const sales = daySales(day).slice().sort((a, b) => b.ts - a.ts);
  const stale = day.date !== todayStr()
    ? `<div class="banner">This day was started ${fmtDate(day.date)} — remember to end it.</div>` : '';

  const recent = sales.slice(0, 8).map((s) => `
    <div class="sale-row" data-action="void-sale" data-id="${s.id}">
      <span class="amt">${fmt(s.amount)}</span>
      <span class="badge ${s.payType}">${s.payType.toUpperCase()}</span>
      ${s.category ? `<span class="badge cat">${esc(s.category)}</span>` : ''}
      <span class="meta" style="text-align:right">${fmtTime(s.ts)}</span>
    </div>`).join('');

  return `
    <div class="topbar">
      <button class="btn small ghost" data-action="go-home">← Home</button>
      <div class="spacer"></div>
      <button class="btn small primary" data-action="close-open">End day</button>
    </div>
    ${stale}
    <div class="card stat-hero">
      <div class="lab">${esc(ev?.name)} · ${fmtDate(day.date)}</div>
      <div class="big">${fmt(cash)}</div>
      <div class="lab">cash logged · ${sales.filter((s) => s.payType === 'cash').length} sales</div>
      <div class="hint">Card sales live in Zettle — you'll enter the total at day end.</div>
    </div>
    <div class="chip-grid">
      ${db.settings.chips.map((c) => `<button class="chip" data-action="chip" data-amount="${c}">$${c}</button>`).join('')}
    </div>
    <div class="row2">
      <button class="btn" data-action="pad-open">$ Custom</button>
      <button class="btn" data-action="notable-open">★ Notable</button>
    </div>
    ${sales.length ? `<h2>Recent · tap to remove</h2><div class="card">${recent}</div>` : ''}
  `;
}

const PLANNER_STATUS_LABELS = {
  research: 'Research',
  shortlist: 'Shortlist',
  applying: 'Applying',
  applied: 'Applied',
  accepted: 'Accepted',
  booked: 'Booked',
  declined: 'Declined',
  skip: 'Pass',
  complete: 'Complete'
};

const TASK_KIND_LABELS = {
  application: 'Application',
  'event-prep': 'Event prep',
  'follow-up': 'Follow-up',
  general: 'General'
};

function dateOffset(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function safeHref(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? esc(url) : '';
}

function plannerDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function plannerMonthLabel(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function ratingOptions(selected) {
  return [1, 2, 3, 4, 5]
    .map((value) => `<option value="${value}" ${value === Number(selected || 3) ? 'selected' : ''}>${value} / 5</option>`)
    .join('');
}

function plannerEventById(id) {
  return db.plannerEvents.find((event) => event.id === id);
}

function plannerEntryIsActive(entry) {
  const event = entry.plannerEventId && plannerEventById(entry.plannerEventId);
  if (!event) return true;
  if (['declined', 'skip', 'complete'].includes(event.status)) return false;
  if (['applied', 'accepted', 'booked'].includes(event.status) && ['deadline', 'reminder'].includes(entry.type)) return false;
  return true;
}

function plannerTaskIsActive(task) {
  const event = task.plannerEventId && plannerEventById(task.plannerEventId);
  return !event || !['declined', 'skip', 'complete'].includes(event.status);
}

function plannerEntryLine(entry, today) {
  const overdue = entry.type !== 'event' && entry.date < today;
  const labels = {
    deadline: 'Application deadline',
    reminder: 'Research reminder',
    task: TASK_KIND_LABELS[entry.kind] || 'Task',
    event: entry.backendSchedule
      ? `${entry.rawStatus || entry.statusLabel || 'Scheduled'} in Events_Master`
      : 'Event'
  };
  const dateLabel = entry.type === 'event' && entry.endDate !== entry.date
    ? `${plannerDate(entry.date)} to ${plannerDate(entry.endDate)}`
    : plannerDate(entry.date);
  return `
    <div class="agenda-row ${overdue ? 'overdue' : ''}">
      <span class="entry-dot ${entry.type}"></span>
      <div>
        <strong>${esc(entry.title)}</strong>
        <span>${overdue ? 'Overdue, ' : ''}${dateLabel} · ${esc(labels[entry.type])}</span>
      </div>
    </div>`;
}

function plannerTaskRow(task, today) {
  const event = plannerEventById(task.plannerEventId);
  const title = String(task.title || 'Untitled task');
  const dueDate = typeof task.dueDate === 'string' ? task.dueDate : '';
  const overdue = !task.completedAt && dueDate && dueDate < today;
  const dueLabel = dueDate ? plannerDate(dueDate) : 'No due date';
  return `
    <div class="planner-task ${task.completedAt ? 'done' : ''} ${overdue ? 'overdue' : ''}">
      <button class="task-check" data-action="planner-task-toggle" data-id="${task.id}" aria-label="${task.completedAt ? 'Mark incomplete' : 'Mark complete'}">
        ${task.completedAt ? '✓' : ''}
      </button>
      <button class="task-body" data-action="planner-task-edit" data-id="${task.id}">
        <strong>${esc(title)}</strong>
        <span>${overdue ? 'Overdue, ' : ''}${dueLabel} · ${esc(TASK_KIND_LABELS[task.kind] || 'General')}${event ? ` · ${esc(event.name)}` : ''}</span>
      </button>
      <span class="priority-dot ${esc(task.priority || 'normal')}" role="img" aria-label="${esc(task.priority || 'normal')} priority"></span>
    </div>`;
}

function plannerCandidateCard(event) {
  const nextTask = db.plannerTasks
    .filter((task) => task.plannerEventId === event.id && !task.completedAt)
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')))[0];
  const sourceUrl = safeHref(event.sourceUrl);
  const checklistLabel = ['accepted', 'booked'].includes(event.status) ? 'Event prep tasks' : 'Application tasks';
  const dates = [
    event.applicationDeadline ? `Apply by ${plannerDate(event.applicationDeadline)}` : '',
    event.reminderDate ? `Next check ${plannerDate(event.reminderDate)}` : '',
    event.eventStart ? `Event ${plannerDate(event.eventStart)}${event.eventEnd && event.eventEnd !== event.eventStart ? ` to ${plannerDate(event.eventEnd)}` : ''}` : ''
  ].filter(Boolean);
  return `
    <article class="card planner-candidate">
      <div class="candidate-head">
        <div>
          <span class="status-pill ${esc(event.status || 'research')}">${esc(PLANNER_STATUS_LABELS[event.status] || 'Research')}</span>
          ${event.eligibilityRisk ? `<span class="risk-pill ${esc(event.eligibilityRisk)}">${esc(event.eligibilityRisk)} eligibility risk</span>` : ''}
        </div>
        <strong class="fit-score">${fitScore(event)}% venue fit</strong>
      </div>
      <h3>${esc(event.name)}</h3>
      <p class="candidate-location">${esc([event.city, event.state].filter(Boolean).join(', '))}</p>
      ${dates.length ? `<p class="candidate-dates">${dates.map(esc).join('<br>')}</p>` : ''}
      ${event.evidence ? `<p>${esc(event.evidence)}</p>` : ''}
      ${event.timingNote ? `<p class="sub">${esc(event.timingNote)}</p>` : ''}
      ${event.researchNotes ? `<p class="caution-note">${esc(event.researchNotes)}</p>` : ''}
      ${event.notes ? `<p class="sub">${esc(event.notes)}</p>` : ''}
      ${nextTask ? `<div class="next-task"><strong>Next:</strong> ${esc(nextTask.title)}, ${plannerDate(nextTask.dueDate)}</div>` : ''}
      ${event.deadlineVerifiedAt ? `<p class="verified">Source checked ${plannerDate(event.deadlineVerifiedAt)}</p>` : ''}
      <div class="planner-card-actions">
        <button class="btn small" data-action="planner-event-edit" data-id="${event.id}">Edit</button>
        <button class="btn small primary" data-action="planner-checklist" data-id="${event.id}">${checklistLabel}</button>
        ${sourceUrl ? `<a class="btn small ghost" href="${sourceUrl}" target="_blank" rel="noopener">Official source</a>` : ''}
      </div>
    </article>`;
}

function plannerSuggestionCard(event) {
  const tracked = db.plannerEvents.some((item) => item.sourceSuggestionId === event.suggestionId);
  const sourceUrl = safeHref(event.sourceUrl);
  return `
    <article class="card suggestion-card">
      <div class="candidate-head">
        <span class="priority-label ${esc(event.priority || 'medium')}">${esc(event.priority || 'medium')} priority</span>
        <strong class="fit-score">${fitScore(event)}% venue fit</strong>
      </div>
      <h3>${esc(event.name)}</h3>
      <p class="candidate-location">${esc([event.city, event.state].filter(Boolean).join(', '))}</p>
      <p>${esc(event.evidence)}</p>
      <p class="sub">${esc(event.timingNote)}</p>
      ${event.notes ? `<p class="caution-note">${esc(event.notes)}</p>` : ''}
      <p class="verified">Official source checked ${plannerDate(event.deadlineVerifiedAt)}</p>
      <div class="planner-card-actions">
        <button class="btn small primary" data-action="planner-suggestion-add" data-id="${event.suggestionId}">${tracked ? 'Apply app research' : 'Add to pipeline'}</button>
        ${sourceUrl ? `<a class="btn small ghost" href="${sourceUrl}" target="_blank" rel="noopener">Official source</a>` : ''}
      </div>
    </article>`;
}

function localPlannerBenchmark() {
  const results = [];
  for (const event of db.events) {
    const byYear = new Map();
    for (const day of db.days.filter((item) => item.eventId === event.id && item.closedAt && !item.mappingOnly)) {
      const year = String(day.date || '').slice(0, 4);
      if (!year) continue;
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(day);
    }
    for (const [year, days] of byYear) {
      const total = days.reduce((sum, day) => sum + dayTotal(day), 0);
      results.push({
        name: event.name,
        year,
        days: days.length,
        total,
        perDay: total / days.length,
        latestDate: days.reduce((latest, day) => day.date > latest ? day.date : latest, '')
      });
    }
  }
  const bellevue = results
    .filter((result) => /bellevue/i.test(result.name))
    .sort((a, b) => b.latestDate.localeCompare(a.latestDate))[0];
  return bellevue || results.sort((a, b) => b.perDay - a.perDay)[0] || null;
}

function plannerView() {
  const today = todayStr();
  const month = ui.plannerMonth || today.slice(0, 7);
  const allEntries = calendarEntries(db).filter(plannerEntryIsActive);
  const monthEnd = dateOffset(today, 30);
  const allOverdueAlerts = allEntries
    .filter((entry) => entry.type !== 'event' && entry.date < today)
    .sort((a, b) => b.date.localeCompare(a.date));
  const allUpcomingAlerts = allEntries
    .filter((entry) => entry.type !== 'event'
      ? entry.date >= today && entry.date <= monthEnd
      : entry.endDate >= today && entry.date <= monthEnd)
    .sort((a, b) => a.date.localeCompare(b.date));
  const overdueAlerts = allOverdueAlerts.slice(0, 3);
  const upcomingAlerts = allUpcomingAlerts.slice(0, 6);
  const alerts = overdueAlerts.concat(upcomingAlerts);
  const alertOverflow = Math.max(0, allOverdueAlerts.length - overdueAlerts.length) +
    Math.max(0, allUpcomingAlerts.length - upcomingAlerts.length);
  const selectedEntries = entriesOnDate(db, ui.plannerDate).filter(plannerEntryIsActive);
  const cells = monthCells(month);
  const activeTasks = db.plannerTasks.filter(plannerTaskIsActive);
  const pendingTasks = activeTasks.filter((task) => !task.completedAt);
  const completedTasks = activeTasks.filter((task) => task.completedAt);
  const tasks = pendingTasks
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.title || '').localeCompare(String(b.title || '')))
    .concat(completedTasks.sort((a, b) => b.completedAt - a.completedAt).slice(0, ui.plannerFilter === 'tasks' ? completedTasks.length : 5));
  let candidates = db.plannerEvents.slice().sort((a, b) =>
    String(a.applicationDeadline || a.reminderDate || '9999').localeCompare(String(b.applicationDeadline || b.reminderDate || '9999')));
  if (ui.plannerFilter === 'applications') candidates = candidates.filter((event) => !['accepted', 'booked', 'declined', 'skip', 'complete'].includes(event.status));
  if (ui.plannerFilter === 'booked') candidates = candidates.filter((event) => ['accepted', 'booked'].includes(event.status));
  const showCandidates = ui.plannerFilter !== 'tasks';
  const showTasks = ['all', 'tasks'].includes(ui.plannerFilter);
  const showSuggestions = ['all', 'applications'].includes(ui.plannerFilter);
  const filterLabels = { all: 'All', applications: 'Apply', booked: 'Booked', tasks: 'Tasks' };
  const benchmark = localPlannerBenchmark();
  const benchmarkName = benchmark && String(benchmark.name).includes(benchmark.year)
    ? benchmark.name
    : benchmark ? `${benchmark.name} ${benchmark.year}` : '';
  const benchmarkMarkup = benchmark
    ? `<strong>${esc(benchmarkName)}: ${fmt(benchmark.total)} over ${benchmark.days} day${benchmark.days === 1 ? '' : 's'}</strong>
       <p>${fmt(benchmark.perDay)} gross per day from private local history. Use it to compare venues, not as a revenue forecast.</p>`
    : `<strong>No local benchmark yet</strong>
       <p>Close an event's selling days and the strongest local result will appear here automatically.</p>`;
  const sheetEntries = allEntries
    .filter((entry) => entry.backendSchedule)
    .sort((a, b) => a.date.localeCompare(b.date));
  const upcomingSheetEntries = sheetEntries.filter((entry) => entry.endDate >= today);
  const feedIssues = Array.isArray(db.plannerFeed?.issues) ? db.plannerFeed.issues : [];
  const feedStamp = Number(db.plannerFeed?.fetchedAt)
    ? new Date(db.plannerFeed.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const feedState = ui.plannerFeedLoading
    ? 'Refreshing the read-only Events_Master schedule...'
    : ui.plannerFeedError
      ? ui.plannerFeedError
      : feedStamp
        ? `Last refreshed ${feedStamp}.`
        : 'Open this planner online to load Events_Master for the first time.';
  const feedIssueMarkup = feedIssues.length
    ? `<details class="planner-feed-issues">
        <summary>${feedIssues.length} Events_Master row${feedIssues.length === 1 ? '' : 's'} need review</summary>
        <ul>${feedIssues.slice(0, 6).map((issue) => `<li>${issue.sourceRow ? `Row ${issue.sourceRow}: ` : ''}${esc(issue.name ? `${issue.name}: ${issue.reason}` : issue.reason)}</li>`).join('')}</ul>
        ${feedIssues.length > 6 ? `<p>Plus ${feedIssues.length - 6} more issue${feedIssues.length - 6 === 1 ? '' : 's'}.</p>` : ''}
      </details>`
    : '';

  return `
    <div class="topbar">
      <button class="btn small ghost" data-action="planner-close">← Booth</button>
      <h1>Event Planner</h1>
      <div class="spacer"></div>
      <button class="btn small ghost" data-action="planner-export">Export .ics</button>
    </div>
    <div class="planner-quick-actions">
      <button class="btn primary" data-action="planner-event-new">+ Event</button>
      <button class="btn" data-action="planner-task-new">+ Task</button>
    </div>
    <p class="export-note">In-app reminders appear whenever Glowstone Ops opens. The .ics file is a manual snapshot, usually imported through desktop Google Calendar, and later edits do not stay synced.</p>
    <p class="export-note">Application plans and tasks stay local to this browser. Scheduled dates are read-only from Events_Master and cached for offline viewing. Everything is included in the JSON backup. <button data-action="export-json">Back up now</button></p>
    <div class="card planner-benchmark">
      <span>Working benchmark</span>
      ${benchmarkMarkup}
    </div>
    <div class="banner planner-warning">
      <strong>Process and eligibility:</strong> ${esc(GLOWSTONE_PROCESS_SUMMARY)} Verify each show's rules and the exact category for the pieces submitted.
    </div>
    <div class="planner-filters">
      ${Object.entries(filterLabels).map(([value, label]) => `<button class="${ui.plannerFilter === value ? 'sel' : ''}" data-action="planner-filter" data-filter="${value}" aria-pressed="${ui.plannerFilter === value}">${label}</button>`).join('')}
    </div>
    <section class="planner-feed">
      <div class="section-head">
        <div><h2>Scheduled from Events_Master</h2><span>${sheetEntries.length} scheduled, ${upcomingSheetEntries.length} upcoming</span></div>
        <button class="btn small ghost" data-action="planner-feed-refresh" ${ui.plannerFeedLoading ? 'disabled' : ''}>${ui.plannerFeedLoading ? 'Refreshing...' : 'Refresh'}</button>
      </div>
      <p class="sub">Only Approved, Accepted, Confirmed, or Booked rows are treated as scheduled. Edit these dates and statuses in the Google Sheet.</p>
      <p class="planner-feed-state">${esc(feedState)}</p>
      <div class="card agenda-list">
        ${upcomingSheetEntries.length
          ? upcomingSheetEntries.map((entry) => plannerEntryLine(entry, today)).join('')
          : '<p class="empty-state">No upcoming scheduled Events_Master dates are saved on this device.</p>'}
      </div>
      ${feedIssueMarkup}
    </section>
    <section>
      <h2>Due and next 30 days</h2>
      <div class="card agenda-list">
        ${alerts.length ? alerts.map((entry) => plannerEntryLine(entry, today)).join('') : '<p class="empty-state">No deadlines, reminders, events, or tasks due in the next 30 days.</p>'}
        ${alertOverflow ? `<p class="overflow-note">Plus ${alertOverflow} more. Use the calendar and task list below for the full schedule.</p>` : ''}
      </div>
    </section>
    <section class="planner-calendar-section">
      <div class="calendar-head">
        <button class="btn small ghost" data-action="planner-month-prev" aria-label="Previous month">‹</button>
        <h2>${esc(plannerMonthLabel(month))}</h2>
        <button class="btn small ghost" data-action="planner-month-next" aria-label="Next month">›</button>
      </div>
      <div class="calendar-grid weekdays">
        ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day) => `<span>${day}</span>`).join('')}
      </div>
      <div class="calendar-grid">
        ${cells.map((cell) => {
          const dayEntries = allEntries.filter((entry) => entry.date <= cell.date && entry.endDate >= cell.date);
          const types = [...new Set(dayEntries.map((entry) => entry.type))].slice(0, 3);
          const ariaLabel = `${plannerDate(cell.date)}${dayEntries.length ? `, ${dayEntries.length} scheduled item${dayEntries.length === 1 ? '' : 's'}` : ''}`;
          return `<button class="calendar-day ${cell.inMonth ? '' : 'outside'} ${cell.date === ui.plannerDate ? 'selected' : ''} ${cell.date === today ? 'today' : ''}" data-action="planner-date" data-date="${cell.date}" aria-label="${esc(ariaLabel)}" aria-pressed="${cell.date === ui.plannerDate}" ${cell.date === today ? 'aria-current="date"' : ''}>
            <span>${cell.day}</span>
            <i>${types.map((type) => `<b class="${type}"></b>`).join('')}</i>
          </button>`;
        }).join('')}
      </div>
      <div class="calendar-legend"><span><i class="task"></i>Task</span><span><i class="deadline"></i>Deadline</span><span><i class="reminder"></i>Reminder</span><span><i class="event"></i>Event</span></div>
      <div class="card selected-agenda">
        <strong>${plannerDate(ui.plannerDate)}</strong>
        ${selectedEntries.length ? selectedEntries.map((entry) => plannerEntryLine(entry, today)).join('') : '<p class="empty-state">Nothing scheduled.</p>'}
      </div>
    </section>
    ${showTasks ? `
      <section>
        <div class="section-head"><h2>Tasks</h2><span>${pendingTasks.length} open</span></div>
        <div class="card task-list">
          ${tasks.length ? tasks.map((task) => plannerTaskRow(task, today)).join('') : '<p class="empty-state">No tasks yet.</p>'}
        </div>
      </section>` : ''}
    ${showCandidates ? `
      <section>
        <div class="section-head"><h2>Application pipeline</h2><span>${candidates.length} tracked</span></div>
        ${candidates.length ? candidates.map(plannerCandidateCard).join('') : '<div class="card"><p class="empty-state">No matching events in this view.</p></div>'}
      </section>` : ''}
    ${showSuggestions ? `
      <section>
        <h2>Research shortlist</h2>
        <p class="sub">These are curated prospects, not live feeds or promises of acceptance. Check the official source before spending money.</p>
        <p class="sub">Venue fit weights luxury audience, buyer fit, home decor fit, and juried-show format. Eligibility risk is shown separately.</p>
        ${SUGGESTED_EVENTS.map(plannerSuggestionCard).join('')}
      </section>` : ''}
  `;
}

// (todayStr imported directly from store.js above)

/* ---------- modal markup ---------- */

function padMarkup(action, value) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'];
  return `
    <div class="pad-display">${value ? '$' + value : '$0'}</div>
    <div class="pad">
      ${keys.map((k) => `<button data-action="${action}" data-k="${k}">${k === 'back' ? '⌫' : k}</button>`).join('')}
    </div>`;
}

function insightsMarkup() {
  const data = ui.insights;
  if (!db.settings.syncUrl || !db.settings.syncKey) {
    return `
      <h3>Insights</h3>
      <p class="sub">Set the Sync URL and key in Settings first. Insights come from the same Apps Script endpoint that updates the master sheet.</p>
      <button class="btn primary" style="width:100%" data-action="settings-open">Open Settings</button>`;
  }
  if (!data || data.loading) {
    return `
      <h3>Insights</h3>
      <div class="card"><strong>Loading sheet insights...</strong><p class="sub">Reading Dashboard, Event_Analysis, Historical_Sales, Daily_Sales, and Txn_Log.</p></div>`;
  }
  if (data.error) {
    return `
      <h3>Insights</h3>
      <div class="card"><strong>Could not load insights</strong><p class="sub">${esc(data.error)}</p></div>
      <button class="btn primary" style="width:100%" data-action="insights-refresh">Try again</button>`;
  }

  const m = data.metrics || {};
  const events = data.events || [];
  const yoy = data.yoy || [];
  const tax = data.tax || [];
  const history = data.history || {};
  const histTop = history.topEvents || [];
  const quality = data.dataQuality || [];
  const recs = data.recommendations || [];
  const best = events[0];
  const worst = events.slice().sort((a, b) => (a.netPerDay || 0) - (b.netPerDay || 0))[0];
  const up = yoy[0];
  const down = yoy.slice().sort((a, b) => (a.changePct || 0) - (b.changePct || 0))[0];
  const txn = data.txnStats;
  const eventRows = events.slice(0, 6).map((e) => `
    <div class="day-row">
      <span class="d">${esc(e.state || '') || 'OR'}</span>
      <span class="t">${esc(e.event)}</span>
      <span class="m">${fmt(e.netPerDay)}/net day</span>
    </div>`).join('');
  const recRows = recs.map((r) => `<div class="insight-note"><strong>${esc(r.title)}</strong><span>${esc(r.detail)}</span></div>`).join('');
  const taxTotal = tax.reduce((s, x) => s + (x.tax || 0), 0);

  return `
    <h3>Insights</h3>
    <div class="sub" style="margin-bottom:10px">Sheet refresh: ${data.generatedAt ? new Date(data.generatedAt).toLocaleString() : 'just now'}</div>
    <div class="kpi-grid">
      <div class="kpi"><span>Net revenue</span><strong>${fmt(m.netRevenue)}</strong></div>
      <div class="kpi"><span>Net after costs</span><strong>${fmt(m.netAfterCosts)}</strong></div>
      <div class="kpi"><span>Selling days</span><strong>${Number(m.sellingDays || 0)}</strong></div>
      <div class="kpi"><span>Revenue / hour</span><strong>${fmt(m.revenuePerHour)}</strong></div>
    </div>
    ${history.rows ? `<div class="card">
      <strong>Historical baseline: ${esc((history.years || []).join(', '))}</strong>
      <p class="sub">${history.eventRows || history.rows} event rows, ${fmt(history.totalRevenue)} recorded income. Top historical comp: ${histTop[0] ? `${esc(histTop[0].event)} at ${fmt(histTop[0].perDay)}/day` : 'none yet'}.</p>
    </div>` : ''}
    ${best ? `<div class="card"><strong>Best event so far: ${esc(best.event)}</strong><p class="sub">${fmt(best.netPerDay)}/day net of tax, ${fmt(best.netAfterCosts)} after event costs.</p></div>` : ''}
    ${worst && worst !== best ? `<div class="card"><strong>Lowest performer: ${esc(worst.event)}</strong><p class="sub">${fmt(worst.netPerDay)}/day net of tax. Check booth fee, venue fit, and product mix before rebooking.</p></div>` : ''}
    <h2>Event Ranking</h2>
    <div class="card">${eventRows || '<p class="sub">No event rows yet.</p>'}</div>
    <h2>Movement</h2>
    <div class="card">
      ${up ? `<div class="day-row"><span class="d">Best</span><span class="t">${esc(up.event)}</span><span class="m">${pct(up.changePct)} YoY</span></div>` : ''}
      ${down ? `<div class="day-row"><span class="d">Watch</span><span class="t">${esc(down.event)}</span><span class="m">${pct(down.changePct)} YoY</span></div>` : ''}
      <div class="day-row"><span class="d">Tax</span><span class="t">WA normalization</span><span class="m">${fmt(taxTotal)} est.</span></div>
    </div>
    ${txn ? `<h2>Latest Detail</h2><div class="card">
      <strong>${esc(txn.event)} · ${esc(txn.date)}</strong>
      <p class="sub">${txn.cardTransactions} card txns, ${txn.cashTaps} cash taps. Median card basket ${fmt(txn.medianCardNet)}; ${pct(txn.cardOver100Pct)} of card baskets were $100+.</p>
    </div>` : ''}
    ${recRows ? `<h2>BI Notes</h2><div class="card">${recRows}</div>` : ''}
    ${quality.length ? `<h2>Data Checks</h2><div class="card">${quality.slice(0, 5).map((q) => `<p class="sub">• ${esc(q)}</p>`).join('')}</div>` : ''}
    <button class="btn primary" style="width:100%" data-action="insights-refresh">Refresh insights</button>`;
}

/* ---------- weight-based pricing markup ---------- */

function selectedMaterial() {
  return ui.price?.materials?.find((m) => m.id === ui.price.selectedId) || null;
}

function sourceLabel(source) {
  return source.replace('Uruguay 2025 Le Stage', 'Uruguay 2025 — Le Stage');
}

function priceSourceOptions() {
  const sources = [...new Set(ui.price?.materials?.map((m) => m.sourceTrip).filter(Boolean))];
  const rank = (source) => source.startsWith('Uruguay') ? 0 : source.startsWith('Tucson') ? 1 : source.startsWith('China') ? 2 : 3;
  return sources.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true })).map((source) =>
    `<option value="${esc(source)}" ${ui.price.source === source ? 'selected' : ''}>${esc(sourceLabel(source))}</option>`
  ).join('');
}

export function priceMatchesMarkup() {
  const p = ui.price;
  const query = (p?.search || '').trim().toLowerCase();
  if (!p?.materials?.length) return '<p class="sub">No material costs are available yet.</p>';
  const scoped = p.source ? p.materials.filter((m) => m.sourceTrip === p.source) : p.materials;
  const matches = (query
    ? scoped.filter((m) => [m.material, m.quality, m.vendor, m.sourceTrip].join(' ').toLowerCase().includes(query))
    : scoped).slice(0, 12);
  if (!matches.length) return '<p class="sub">No matching material. Try a shorter word.</p>';
  const scope = p.source ? sourceLabel(p.source) : 'current inventory';
  const hint = query
    ? `${matches.length} matching material${matches.length === 1 ? '' : 's'} in ${scope}`
    : `Browse ${matches.length} material${matches.length === 1 ? '' : 's'} from ${scope}, or type to narrow the list.`;
  return `<p class="sub">${hint}</p>${matches.map((m) => `
    <button class="material-match ${m.id === p.selectedId ? 'sel' : ''}" data-action="price-material" data-id="${esc(m.id)}">
      <span>${esc(m.material)}${m.quality ? ` · ${esc(m.quality)}` : ''}</span>
      <small>${fmt(m.unitCost)}/kg · ${esc(m.sourceTrip)} · ${esc(m.costBasis || 'recorded cost')}</small>
    </button>`).join('')}`;
}

function priceSelectionMarkup() {
  const m = selectedMaterial();
  if (!m) return '<div class="price-selected empty">Choose the closest material/quality from the search results.</div>';
  return `<div class="price-selected">
    <strong>${esc(m.material)}${m.quality ? ` · ${esc(m.quality)}` : ''}</strong>
    <span>${fmt(m.unitCost)}/kg · ${esc(m.costBasis || 'recorded cost')} · ${esc(m.sourceTrip)}</span>
  </div>`;
}

export function priceResultMarkup() {
  const p = ui.price;
  const m = selectedMaterial();
  const weight = Number(p?.weight) || 0;
  const multiplier = Number(p?.multiplier) || 0;
  if (!m || !(weight > 0) || !(multiplier > 0)) return '<p class="sub">Select a material and enter the piece weight to see a price.</p>';
  const cost = m.unitCost * weight;
  const raw = cost * multiplier;
  const tag = tagPrice(raw);
  const ending = raw < 200 ? 'Nearest 3/7 tag price' : 'Rounded whole-dollar price';
  return `<div class="price-result-card">
    <span>${ending}</span>
    <strong>${fmt(tag)}</strong>
    <p>${weight.toFixed(3)} kg × ${fmt(m.unitCost)}/kg = ${fmt(cost)} cost · ${multiplier}x = ${fmt(raw)}</p>
    <button class="btn small primary" data-action="price-copy" data-price="${tag}">Copy ${fmt(tag)}</button>
  </div>`;
}

function priceToolMarkup() {
  const p = ui.price;
  if (!p || p.loading) return `
    <h3>Price Tool</h3>
    <div class="card"><strong>Loading material costs...</strong><p class="sub">Refreshing the standardized purchase catalog from Google Sheets.</p></div>`;
  if (p.error && !p.materials?.length) return `
    <h3>Price Tool</h3>
    <div class="card"><strong>Could not load material costs</strong><p class="sub">${esc(p.error)}</p></div>
    <button class="btn primary" style="width:100%" data-action="price-refresh">Try again</button>`;
  const stamp = db.priceCatalog?.fetchedAt ? new Date(db.priceCatalog.fetchedAt).toLocaleString() : '';
  return `
    <h3>Price Tool</h3>
    <p class="sub">Material cost × weight × chosen markup. Prices under $200 land on the closest ending in 3 or 7.</p>
    ${p.error ? `<div class="banner">Using saved material costs. Refresh failed: ${esc(p.error)}</div>` : ''}
    <label>Purchase source</label>
    <select id="price-source">
      <option value="">All current inventory</option>
      ${priceSourceOptions()}
    </select>
    <label>Search within source</label>
    <input id="price-search" type="search" autocomplete="off" placeholder="Type amethyst, ammonite, labradorite..." value="${esc(p.search || '')}">
    <div class="material-results" id="price-matches">${priceMatchesMarkup()}</div>
    <div id="price-selection">${priceSelectionMarkup()}</div>
    <label>Piece weight (KG)</label>
    <input id="price-weight" type="number" inputmode="decimal" min="0" step="0.001" placeholder="0.250" value="${esc(p.weight || '')}">
    <h2>Markup</h2>
    <div class="multiplier-grid">
      ${PRICE_MULTIPLIERS.map((x) => `<button class="multiplier ${p.multiplier === x ? 'sel' : ''}" data-action="price-multiplier" data-multiplier="${x}">${x}x</button>`).join('')}
    </div>
    <div id="price-result">${priceResultMarkup()}</div>
    <button class="btn" style="width:100%;margin-top:12px" data-action="price-refresh">Refresh material costs</button>
    ${stamp ? `<p class="sub" style="text-align:center">Saved on this phone: ${stamp}</p>` : ''}`;
}

export function renderPriceToolLive() {
  const matches = document.getElementById('price-matches');
  const selection = document.getElementById('price-selection');
  const result = document.getElementById('price-result');
  if (matches) matches.innerHTML = priceMatchesMarkup();
  if (selection) selection.innerHTML = priceSelectionMarkup();
  if (result) result.innerHTML = priceResultMarkup();
  document.querySelectorAll('[data-action="price-multiplier"]').forEach((el) => {
    el.classList.toggle('sel', Number(el.dataset.multiplier) === ui.price?.multiplier);
  });
}

/* ---------- render modal ---------- */

export function renderModal() {
  const root = $('#modal-root');
  if (!ui.modal) { root.innerHTML = ''; return; }
  let sheet = '';

  if (ui.modal === 'plannerEvent') {
    const event = plannerEventById(ui.plannerEventId) || {};
    sheet = `
      <h3>${event.id ? 'Edit event plan' : 'Add event or opportunity'}</h3>
      ${event.researchNotes ? `<div class="banner"><strong>Research caution:</strong> ${esc(event.researchNotes)}</div>` : ''}
      <form id="form-planner-event">
        <label for="planner-event-name">Event name</label>
        <input id="planner-event-name" name="eventName" required autocomplete="off" value="${esc(event.name || '')}" placeholder="Lake Oswego Festival of the Arts">
        <div class="row2">
          <div>
            <label for="planner-event-city">City</label>
            <input id="planner-event-city" name="city" autocomplete="off" value="${esc(event.city || '')}">
          </div>
          <div>
            <label for="planner-event-state">State</label>
            <input id="planner-event-state" name="state" autocomplete="off" maxlength="2" value="${esc(event.state || '')}" placeholder="OR">
          </div>
        </div>
        <label for="planner-event-venue">Venue type</label>
        <select id="planner-event-venue" name="venueType">${VENUE_TYPES.map((value) => `<option ${value === (event.venueType || 'Art Fair') ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select>
        <div class="row2">
          <div>
            <label for="planner-event-start">Event starts</label>
            <input id="planner-event-start" name="eventStart" type="date" value="${esc(event.eventStart || '')}">
          </div>
          <div>
            <label for="planner-event-end">Event ends</label>
            <input id="planner-event-end" name="eventEnd" type="date" value="${esc(event.eventEnd || '')}">
          </div>
        </div>
        <label for="planner-event-deadline">Application deadline</label>
        <input id="planner-event-deadline" name="applicationDeadline" type="date" value="${esc(event.applicationDeadline || '')}">
        <label for="planner-event-reminder">Reminder or next research date</label>
        <input id="planner-event-reminder" name="reminderDate" type="date" value="${esc(event.reminderDate || '')}">
        <label for="planner-event-status">Pipeline status</label>
        <select id="planner-event-status" name="status">${PLANNER_STATUSES.map((value) => `<option value="${value}" ${value === (event.status || 'research') ? 'selected' : ''}>${esc(PLANNER_STATUS_LABELS[value])}</option>`).join('')}</select>
        <div class="row2">
          <div>
            <label for="planner-event-luxury">Luxury fit</label>
            <select id="planner-event-luxury" name="luxuryFit">${ratingOptions(event.luxuryFit)}</select>
          </div>
          <div>
            <label for="planner-event-audience">Audience fit</label>
            <select id="planner-event-audience" name="audienceFit">${ratingOptions(event.audienceFit)}</select>
          </div>
        </div>
        <div class="row2">
          <div>
            <label for="planner-event-decor">Home decor fit</label>
            <select id="planner-event-decor" name="homeDecorFit">${ratingOptions(event.homeDecorFit)}</select>
          </div>
          <div>
            <label for="planner-event-juried">Juried format fit</label>
            <select id="planner-event-juried" name="juriedArtFit">${ratingOptions(event.juriedArtFit)}</select>
          </div>
        </div>
        <label for="planner-event-risk">Eligibility risk</label>
        <select id="planner-event-risk" name="eligibilityRisk">${['unknown', 'low', 'medium', 'high'].map((value) => `<option value="${value}" ${value === (event.eligibilityRisk || 'unknown') ? 'selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select>
        <label for="planner-event-source">Official source URL</label>
        <input id="planner-event-source" name="sourceUrl" type="url" inputmode="url" value="${esc(event.sourceUrl || '')}" placeholder="https://...">
        <label for="planner-event-evidence">Why it may fit</label>
        <textarea id="planner-event-evidence" name="evidence" rows="3" placeholder="Audience, venue quality, home decor fit">${esc(event.evidence || '')}</textarea>
        <label for="planner-event-notes">Notes and costs to verify</label>
        <textarea id="planner-event-notes" name="notes" rows="3" placeholder="Booth fee, travel, lodging, commission, eligibility">${esc(event.notes || '')}</textarea>
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save event</button>
        </div>
      </form>
      ${event.id ? `<button class="btn danger modal-delete" data-action="planner-event-delete" data-id="${event.id}">Delete event plan</button>` : ''}`;
  }

  if (ui.modal === 'plannerTask') {
    const task = db.plannerTasks.find((item) => item.id === ui.plannerTaskId) || {};
    const linkedEventId = task.plannerEventId || ui.plannerEventId || '';
    const defaultDueDate = ui.plannerDate >= todayStr() ? ui.plannerDate : todayStr();
    sheet = `
      <h3>${task.id ? 'Edit task' : 'Add task'}</h3>
      <form id="form-planner-task">
        <label for="planner-task-title">Task</label>
        <input id="planner-task-title" name="taskTitle" required autocomplete="off" value="${esc(task.title || '')}" placeholder="Prepare booth photos">
        <label for="planner-task-event">Related event</label>
        <select id="planner-task-event" name="plannerEventId">
          <option value="">General task</option>
          ${db.plannerEvents.map((event) => `<option value="${event.id}" ${event.id === linkedEventId ? 'selected' : ''}>${esc(event.name)}</option>`).join('')}
        </select>
        <div class="row2">
          <div>
            <label for="planner-task-kind">Task type</label>
            <select id="planner-task-kind" name="kind">${TASK_KINDS.map((value) => `<option value="${value}" ${value === (task.kind || 'general') ? 'selected' : ''}>${esc(TASK_KIND_LABELS[value])}</option>`).join('')}</select>
          </div>
          <div>
            <label for="planner-task-priority">Priority</label>
            <select id="planner-task-priority" name="priority">${['high', 'normal', 'low'].map((value) => `<option value="${value}" ${value === (task.priority || 'normal') ? 'selected' : ''}>${value[0].toUpperCase() + value.slice(1)}</option>`).join('')}</select>
          </div>
        </div>
        <label for="planner-task-due">Due date</label>
        <input id="planner-task-due" name="dueDate" type="date" required value="${esc(task.dueDate || defaultDueDate)}">
        <label for="planner-task-notes">Notes</label>
        <textarea id="planner-task-notes" name="notes" rows="3">${esc(task.notes || '')}</textarea>
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save task</button>
        </div>
      </form>
      ${task.id ? `<button class="btn danger modal-delete" data-action="planner-task-delete" data-id="${task.id}">Delete task</button>` : ''}`;
  }

  if (ui.modal === 'pad') {
    const v = parseFloat(ui.pad.value) || 0;
    sheet = `
      <h3>Cash sale</h3>
      ${padMarkup('pad-key', ui.pad.value)}
      <div class="actions">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="pad-save">Log cash ${fmt(v)}</button>
      </div>`;
  }

  if (ui.modal === 'notable') {
    const n = ui.notable;
    sheet = `
      <h3>Notable piece</h3>
      <div class="cat-grid">
        ${db.settings.categories.map((c) => `<button class="cat ${n.cat === c ? 'sel' : ''}" data-action="notable-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
      </div>
      ${padMarkup('notable-key', n.value)}
      <div class="seg">
        <button class="${n.pay === 'card' ? 'sel' : ''}" data-action="notable-pay" data-pay="card">Card (in Zettle)</button>
        <button class="${n.pay === 'cash' ? 'sel' : ''}" data-action="notable-pay" data-pay="cash">Cash</button>
      </div>
      <div class="actions">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="notable-save">Save notable</button>
      </div>`;
  }

  if (ui.modal === 'pickEvent') {
    const recent = db.events.filter((event) => !event.historicalOnly).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)).slice(0, 8);
    sheet = `
      <h3>Which event?</h3>
      ${recent.map((e) => `<button class="btn big" style="margin-bottom:10px" data-action="pick-event" data-id="${e.id}">${esc(e.name)}</button>`).join('')}
      <button class="btn primary big" data-action="new-event">+ New event</button>`;
  }

  if (ui.modal === 'newEvent') {
    sheet = `
      <h3>New event</h3>
      <form id="form-event">
        <label>Event name</label>
        <input name="evname" required autocomplete="off" placeholder="Sandy Mountain Festival">
        <label>Venue type</label>
        <select name="venueType">${VENUE_TYPES.map((v) => `<option>${v}</option>`).join('')}</select>
        <label>Booth fee ($)</label>
        <input name="boothFee" type="number" inputmode="decimal" step="0.01" placeholder="0">
        <label>Other costs — travel, lodging, app fees ($)</label>
        <input name="otherCosts" type="number" inputmode="decimal" step="0.01" placeholder="0">
        <label>Sales tax % added at checkout (0 in Oregon)</label>
        <input name="taxRate" type="number" inputmode="decimal" step="0.01" placeholder="Seattle ≈ 10.35">
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Start selling day</button>
        </div>
      </form>`;
  }

  if (ui.modal === 'close') {
    const day = activeDay();
    sheet = `
      <h3>End day — ${esc(eventById(day.eventId)?.name)}</h3>
      <form id="form-close">
        <label>Hours (incl. drive + setup/teardown)</label>
        <input name="hours" type="number" inputmode="decimal" step="0.5" min="0" placeholder="12">
        <label>Card total from Zettle ($)</label>
        <input name="cardTotal" type="number" inputmode="decimal" step="0.01" placeholder="0">
        <label>Cash drawer count at close ($)</label>
        <input name="drawerCash" type="number" inputmode="decimal" step="1" placeholder="leave blank to use logged cash">
        <label>Starting float ($)</label>
        <input name="floatCash" type="number" inputmode="decimal" step="1" value="${db.settings.defaultFloat}">
        <label>Notes (weather, booth spot, crowd…)</label>
        <input name="notes" autocomplete="off" placeholder="optional">
        <div class="calc-line" id="close-calc"></div>
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Not yet</button>
          <button type="submit" class="btn primary">Close day</button>
        </div>
      </form>`;
  }
  if (ui.modal === 'dayEdit') {
    const day = dayById(ui.dayEditId);
    if (!day) { ui.modal = null; root.innerHTML = ''; return; }
    const ev = eventById(day.eventId);
    const logged = cashLogged(day);
    const ztx = zettleTxnsFor(day);
    const total = day.closedAt ? dayTotal(day) : (day.cardTotal || 0) + logged;
    const syncNote = day.synced
      ? '<p class="sub">This day has already synced. Saving changes will queue a sheet update on the next sync.</p>' : '';
    const zettleNote = ztx.length
      ? `<p class="sub">${ztx.length} imported Zettle transaction(s): ${fmt(ztx.reduce((s, t) => s + t.gross, 0))}${day.cardTax ? ` · tax ${fmt(day.cardTax)}` : ''}. The date is locked to the POS report.</p>` : '<p class="sub">No Zettle transactions imported yet.</p>';
    sheet = `
      <h3>Edit day — ${esc(ev?.name || 'Selling day')}</h3>
      <div class="card">
        <div class="day-row"><span class="d">Cash</span><span class="t">${fmt(logged)} logged</span><span class="m">${daySales(day).filter((s) => s.payType === 'cash').length} taps</span></div>
        <div class="day-row"><span class="d">Card</span><span class="t">${fmt(day.cardTotal || 0)}</span><span class="m">${ztx.length} txns</span></div>
        <div class="day-row"><span class="d">Total</span><span class="t">${fmt(total)}</span><span class="m">${day.hours ? fmt(total / day.hours) + '/hr' : ''}</span></div>
      </div>
      ${zettleNote}
      ${syncNote}
      <form id="form-day-edit">
        <label>Event</label>
        <select name="eventId">${db.events.filter((e) => !e.historicalOnly || e.id === day.eventId).map((e) => `<option value="${e.id}" ${e.id === day.eventId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>
        <label>Date</label>
        <input name="date" type="date" value="${esc(day.date)}" ${ztx.length ? 'disabled' : ''}>
        <label>Hours (incl. drive + setup/teardown)</label>
        <input name="hours" type="number" inputmode="decimal" step="0.5" min="0" value="${day.hours ?? ''}">
        <label>Card total from Zettle ($)</label>
        <input name="cardTotal" type="number" inputmode="decimal" step="0.01" value="${day.cardTotal ?? ''}">
        <label>Cash drawer count at close ($)</label>
        <input name="drawerCash" type="number" inputmode="decimal" step="1" value="${day.drawerCash ?? ''}" placeholder="leave blank to use logged cash">
        <label>Starting float ($)</label>
        <input name="floatCash" type="number" inputmode="decimal" step="1" value="${day.floatCash ?? db.settings.defaultFloat}">
        <label>Notes</label>
        <textarea name="notes" rows="3" placeholder="weather, booth spot, crowd...">${esc(day.notes || '')}</textarea>
        <div class="calc-line" id="day-edit-calc"></div>
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save changes</button>
        </div>
      </form>
      <h2>Zettle</h2>
      <button class="btn primary" style="width:100%;margin-bottom:10px" data-action="zettle-pick-day">Import Zettle report into this day</button>
      <input type="file" id="zettle-day-file" accept=".xlsx,.xls" hidden>
      <button class="btn danger" style="width:100%" data-action="day-delete">Delete day</button>`;
  }

  if (ui.modal === 'settings') {
    const s = db.settings;
    sheet = `
      <h3>Settings</h3>
      <form id="form-settings">
        <label>Quick-tap amounts (comma separated)</label>
        <input name="chips" value="${s.chips.join(', ')}">
        <label>Categories (one per line)</label>
        <textarea name="categories" rows="8">${s.categories.map(esc).join('\n')}</textarea>
        <label>Default cash float ($)</label>
        <input name="floatCash" type="number" inputmode="decimal" value="${s.defaultFloat}">
        <label style="display:flex;align-items:center;gap:10px;margin-top:14px">
          <input name="dark" type="checkbox" style="width:24px;height:24px" ${s.dark ? 'checked' : ''}> Dark mode
        </label>
        <label>Sync URL (Apps Script web app)</label>
        <input name="syncUrl" value="${esc(s.syncUrl)}" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec">
        <label>Sync key</label>
        <input name="syncKey" value="${esc(s.syncKey)}" autocomplete="off" placeholder="gsk_…">
        <div class="actions">
          <button type="button" class="btn" data-action="modal-cancel">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
      <h2>Data</h2>
      ${db.syncReviewRequired ? '<p class="banner">A POS import is waiting for review. Automatic Sheet sync is paused until this batch is previewed and confirmed.</p>' : ''}
      <button class="btn primary" style="width:100%;margin-bottom:10px" data-action="sync-now">Review &amp; sync to Google Sheets</button>
      ${db.lastSync ? `<p class="sub" style="text-align:center;margin-top:0">Last sync: ${new Date(db.lastSync.at).toLocaleString()} — ${esc(db.lastSync.summary)}</p>` : ''}
      <div class="row2" style="margin-bottom:10px">
        <button class="btn" data-action="export-sales">Sales CSV</button>
        <button class="btn" data-action="export-days">Days CSV</button>
      </div>
      <div class="row2" style="margin-bottom:10px">
        <button class="btn" data-action="export-json">Backup (JSON)</button>
        <button class="btn" data-action="backup-pick">Restore backup</button>
      </div>
      <button class="btn primary" style="width:100%" data-action="zettle-pick">Import Zettle report (.xlsx)</button>
      <input type="file" id="zettle-file" accept=".xlsx,.xls" hidden>
      <input type="file" id="backup-file" accept=".json,application/json" hidden>
      <p class="sub" style="text-align:center">Glowstone Ops v0.6.1</p>`;
  }

  if (ui.modal === 'insights') sheet = insightsMarkup();
  if (ui.modal === 'priceTool') sheet = priceToolMarkup();

  if (ui.modal === 'syncPreview') {
    const preview = ui.syncPreview;
    if (!preview) { ui.modal = null; root.innerHTML = ''; return; }
    const parts = syncResultParts(preview.out);
    sheet = `
      <h3>Review Google Sheets sync</h3>
      <p class="banner">Preview complete. No Sheet rows or local sync flags have changed yet.</p>
      <div class="card">
        ${parts.map((part) => `<div class="day-row"><span class="d">${esc(part)}</span></div>`).join('')}
      </div>
      <p class="sub">Reviewed local batch: ${preview.batch.days.length} day(s), ${preview.batch.sales.length} app sale(s), ${preview.batch.ztx.length} POS receipt(s), and ${preview.batch.tombstones.length} deletion request(s).</p>
      <p class="sub">Google Sheets could change between preview and confirmation. The live sync rechecks your local batch and stops if it changed.</p>
      <div class="actions">
        <button class="btn" data-action="sync-cancel">Cancel</button>
        <button class="btn primary" data-action="sync-confirm">Confirm live sync</button>
      </div>`;
  }

  if (ui.modal === 'zimport') {
    const z = ui.zimport;
    const lines = z.matches.map((m) => {
      const selected = (value) => m.choice === value ? ' selected' : '';
      const existingOptions = m.candidates.map((candidate) => {
        const event = eventById(candidate.eventId);
        const mapping = candidate.mappingOnly ? ' · historical receipt mapping' : ` · saved card ${fmt(candidate.cardTotal)}`;
        return `<option value="day:${esc(candidate.dayId)}"${selected(`day:${candidate.dayId}`)}>${esc(event?.name || 'Unknown event')}${mapping}</option>`;
      }).join('');
      const catalogOptions = (m.suggestions || []).map((suggestion) => {
        const delta = suggestion.expectedCard === ''
          ? ''
          : ` · recorded card ${fmt(suggestion.expectedCard)} · POS Δ ${fmt(m.gross - suggestion.expectedCard)}`;
        const review = suggestion.requiresExplicit ? ' · explicit review required' : '';
        const sourceRow = suggestion.sourceRow === '' ? '' : ` row ${suggestion.sourceRow}`;
        const source = [suggestion.source, suggestion.sourceSheet].filter(Boolean).join(' / ');
        const stale = suggestion.stale ? ' · cached' : '';
        return `<option value="catalog:${esc(suggestion.id)}"${selected(`catalog:${suggestion.id}`)}>Sheet: ${esc(suggestion.event)} · ${esc(suggestion.channel)}${delta}${review}${stale} · ${esc(source)}${esc(sourceRow)}</option>`;
      }).join('');
      const catalogDetails = (m.suggestions || [])
        .filter((suggestion) => suggestion.correctionBasis)
        .map((suggestion) =>
          `<p class="sub" style="margin:6px 0 0"><strong>${esc(suggestion.event)}:</strong> ${esc(suggestion.correctionBasis)}${suggestion.expectedCardSource ? ` Card basis: ${esc(suggestion.expectedCardSource)}.` : ''}</p>`
        ).join('');
      const newDayOptions = db.events.filter((event) => !event.historicalOnly).map((event) =>
        `<option value="event:${esc(event.id)}"${selected(`event:${event.id}`)}>Create day under ${esc(event.name)}</option>`
      ).join('');
      const target = z.targetDayId ? dayById(z.targetDayId) : null;
      const destination = target
        ? `<input type="hidden" data-zimport-date="${esc(m.date)}" value="day:${esc(target.id)}">
           <p class="sub" style="margin:8px 0 0">Destination: ${esc(eventById(target.eventId)?.name || 'this day')} · saved card ${fmt(target.cardTotal || 0)}</p>`
        : `<label for="zimport-destination-${esc(m.date)}">Destination</label>
           <select class="import-destination" id="zimport-destination-${esc(m.date)}" data-zimport-date="${esc(m.date)}">
             <option value="">Choose a day or explicitly skip…</option>
             ${existingOptions ? `<optgroup label="Existing days on this date">${existingOptions}</optgroup>` : ''}
             ${catalogOptions ? `<optgroup label="Protected Sheet suggestions">${catalogOptions}</optgroup>` : ''}
             ${newDayOptions ? `<optgroup label="Create a new closed day">${newDayOptions}</optgroup>` : ''}
             <option value="skip"${selected('skip')}>Skip this date intentionally</option>
           </select>`;
      const ambiguity = m.catalogConflict
        ? '<p class="banner" style="margin:8px 0 0">The local day and protected Sheet suggestion disagree. Choose deliberately; the app will not decide for you.</p>'
        : m.candidates.length > 1
        ? '<p class="sub" style="margin:6px 0 0">Multiple selling days share this date. Choose the correct event.</p>'
        : (m.suggestions || []).length > 1 && !m.candidates.length
          ? '<p class="sub" style="margin:6px 0 0">Multiple protected Sheet records share this date. Choose the matching channel and event.</p>'
          : '';
      const mappingCandidates = m.candidates.filter((candidate) => candidate.mappingOnly);
      const remapControl = !target
        && m.catalogConflict
        && m.candidates.length === 1
        && mappingCandidates.length === 1
        && (m.suggestions || []).length
        ? `<label style="display:flex;align-items:flex-start;gap:10px;margin-top:10px;font-weight:600">
             <input type="checkbox" data-zimport-remap="${esc(m.date)}" style="width:22px;height:22px;flex:0 0 auto" ${m.remapCatalog ? 'checked' : ''}>
             <span>If I choose a different protected Sheet suggestion, correct all ${m.count} existing historical receipts from ${esc(mappingCandidates[0].eventName || 'the old mapping')}. I understand Txn_Log event labels will be updated after a separate sync review.</span>
           </label>`
        : '';
      return `<div class="card" style="margin-bottom:10px">
        <div class="day-row"><span class="d">${fmtDate(m.date)}</span><span class="t">${m.count} receipts · ${fmt(m.gross)}</span><span class="m">${fmt(m.net)} + ${fmt(m.tax)} tax</span></div>
        ${destination}
        ${ambiguity}
        ${catalogDetails}
        ${remapControl}
        <label style="display:flex;align-items:flex-start;gap:10px;margin-top:10px;font-weight:500">
          <input type="checkbox" data-zimport-replace="${esc(m.date)}" style="width:22px;height:22px;flex:0 0 auto" ${m.replaceCard ? 'checked' : ''}>
          <span>If an existing day is selected, replace its saved card total with ${fmt(m.gross)}. Leave unchecked to preserve recorded revenue.</span>
        </label>
      </div>`;
    }).join('');
    const target = z.targetDayId ? dayById(z.targetDayId) : null;
    sheet = `
      <h3>${target ? `Import to ${esc(eventById(target.eventId)?.name || 'this day')}` : 'Import Zettle report'}</h3>
      ${z.error ? `<p class="banner" role="alert">${esc(z.error)}</p>` : ''}
      ${z.catalogNote ? `<p class="sub">${esc(z.catalogNote)}</p>` : ''}
      <p class="sub">Review every report date. The app no longer assigns all unmatched dates to one event, and saved card totals stay unchanged unless you select replacement for that date.</p>
      ${lines}
      <label style="display:flex;align-items:flex-start;gap:10px;margin:12px 0;font-weight:600">
        <input id="zimport-tender-confirm" type="checkbox" style="width:22px;height:22px;flex:0 0 auto" ${z.tenderConfirmed ? 'checked' : ''}>
        <span>I confirmed this POS export contains electronic payments only. Imported receipts will be labeled as card transactions; cash remains sourced from Glowstone Ops.</span>
      </label>
      <div class="actions">
        <button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="zimport-apply">Apply reviewed import (${z.txns.length} receipts)</button>
      </div>`;
  }

  root.innerHTML = `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-label="Glowstone dialog">${sheet}</div></div>`;
  if (ui.modal === 'plannerEvent' || ui.modal === 'plannerTask') {
    root.querySelector('input, select, textarea, button')?.focus();
  }
  if (ui.modal === 'close') updateCloseCalc();
  if (ui.modal === 'dayEdit') updateDayEditCalc();
}
