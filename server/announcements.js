import { findMany } from './db.js';

export function mustAck(row, user) {
  if (!row || !user) return false;
  if (row.audience === 'everyone') return true;
  if (row.audience === 'teams') {
    const wanted = new Set(row.department_ids || []);
    return (user.departmentIds || []).some((departmentId) => wanted.has(departmentId));
  }
  if (row.audience === 'people') return (row.user_ids || []).includes(user.id);
  return false;
}

export async function announcementPending(user) {
  const [rows, acks] = await Promise.all([
    findMany('announcements', {}),
    findMany('announcement_acks', { user_id: user.id }),
  ]);
  const acked = new Set(acks.map((ack) => ack.announcement_id));
  return rows.filter((row) => mustAck(row, user) && !acked.has(row.id)).length;
}

export async function audienceUsers(row) {
  const people = await findMany('users', { active: 1 });
  if (row.audience === 'everyone') return people;
  if (row.audience === 'teams') {
    const links = await findMany('user_departments', { department_id: { $in: row.department_ids || [] } });
    const ids = new Set(links.map((link) => link.user_id));
    return people.filter((person) => ids.has(person.id));
  }
  const ids = new Set(row.user_ids || []);
  return people.filter((person) => ids.has(person.id));
}
