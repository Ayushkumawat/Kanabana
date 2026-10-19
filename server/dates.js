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

export function isISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = parseISODate(value);
  return !Number.isNaN(date.getTime()) && isoDate(date) === value;
}

export function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

export function startOfWeek(input) {
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

export function weekdayMon1(value) {
  const day = parseISODate(value).getDay();
  return day === 0 ? 7 : day;
}

export function eachDate(startISO, endISO) {
  const dates = [];
  let cursor = parseISODate(startISO);
  const end = parseISODate(endISO);
  while (cursor <= end) {
    dates.push(isoDate(cursor));
    cursor = addDays(cursor, 1);
  }
  return dates;
}
