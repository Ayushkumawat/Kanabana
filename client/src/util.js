export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseISODate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function startOfWeek(input = new Date()) {
  const date = typeof input === 'string' ? parseISODate(input) : new Date(input);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  return date;
}

export function todayISO() {
  return isoDate(new Date());
}

export function currentMonday() {
  return isoDate(startOfWeek(new Date()));
}

export function shiftWeek(mondayISO, days) {
  return isoDate(addDays(parseISODate(mondayISO), days));
}

export function weekLabel(mondayISO) {
  const start = parseISODate(mondayISO);
  const end = addDays(start, 6);
  const short = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString(undefined, short)} – ${end.toLocaleDateString(undefined, { ...short, year: 'numeric' })}`;
}

export function formatDay(value) {
  if (!value) return '';
  return parseISODate(value).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatWhen(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatClock(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function clockMinutes(value) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

export const CHECKIN_CUTOFF = 10 * 60;
export const CHECKOUT_CUTOFF = 18 * 60 + 30;
export const FULL_DAY_MINUTES = 8 * 60 + 30;

export function workedMinutes(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  return Math.max(0, Math.round((new Date(checkOut) - new Date(checkIn)) / 60000));
}

export function formatElapsed(start, end) {
  const total = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatHours(minutes) {
  if (minutes == null) return '—';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}:${String(mins).padStart(2, '0')}`;
}

export function currentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month, amount) {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(year, index - 1 + amount, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(month) {
  const [year, index] = month.split('-').map(Number);
  return new Date(year, index - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function daysInMonth(month) {
  const [year, index] = month.split('-').map(Number);
  const count = new Date(year, index, 0).getDate();
  return Array.from({ length: count }, (_, offset) => `${month}-${String(offset + 1).padStart(2, '0')}`);
}

export const COLUMNS = [
  { id: 'upcoming', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

export const PRIORITIES = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'urgent', label: 'Urgent' },
];

export function priorityLabel(id) {
  return PRIORITIES.find((item) => item.id === id)?.label || id;
}

export function statusLabel(id) {
  return COLUMNS.find((item) => item.id === id)?.label || id;
}

export function isSunday(value) {
  const date = typeof value === 'string' ? parseISODate(value) : value;
  return date.getDay() === 0;
}

export function weekdayLabel(value) {
  return ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][value] || '';
}

export function canGovernTask(user, task) {
  if (!user || !task) return false;
  if (user.isAdmin) return true;
  if (user.isLead && task.creatorId === user.id) return true;
  return (user.leadDepartmentIds || []).some((id) => (task.assigneeDepartmentIds || []).includes(id));
}

export function allowedMoves(user, task) {
  if (!user || !task) return [];
  if (canGovernTask(user, task)) return COLUMNS.map((column) => column.id).filter((id) => id !== task.status);
  if (user.id !== task.assigneeId) return [];
  if (task.status === 'upcoming') return ['in_progress'];
  if (task.status === 'in_progress') return ['upcoming', 'review'];
  return [];
}

export function canMoveTask(user, task, status) {
  const moves = allowedMoves(user, task);
  if (!status) return moves.length > 0;
  return moves.includes(status);
}

export function isOverdue(task) {
  return task.status !== 'done' && task.dueDate < todayISO();
}

export function clashInfo(tasks) {
  const open = tasks.filter((task) => task.status !== 'done' && !task.spillover);
  const byDay = new Map();
  for (const task of open) {
    if (!byDay.has(task.dueDate)) byDay.set(task.dueDate, []);
    byDay.get(task.dueDate).push(task);
  }
  const sameDay = [...byDay.entries()]
    .filter(([, group]) => group.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dueDate, group]) => ({ dueDate, tasks: group }));
  const parallel = open.filter((task) => task.status === 'in_progress');
  const ids = new Set(sameDay.flatMap((group) => group.tasks.map((task) => task.id)));
  if (parallel.length > 1) parallel.forEach((task) => ids.add(task.id));
  return { sameDay, parallel: parallel.length > 1 ? parallel : [], ids };
}

export function roleLabel(user) {
  if (user.isAdmin) return 'Admin';
  if (user.isManager) return 'Manager';
  if (user.isLead) return 'Team lead';
  return 'Member';
}
