import { addDays, isoDate, parseISODate, todayISO } from './dates.js';
import { findMany, findOne, notify, updateOne, usersByIds } from './db.js';
import { sendOverdueEmail } from './mail.js';

async function leadsFor(userId) {
  const links = await findMany('user_departments', { user_id: userId });
  if (!links.length) return [];
  const departments = await findMany('departments', { _id: { $in: links.map((link) => link.department_id) } });
  const leads = await usersByIds(departments.map((department) => department.lead_id));
  const seen = new Set();
  const people = [];
  for (const lead of leads.values()) {
    if (!lead?.active || seen.has(lead.id)) continue;
    seen.add(lead.id);
    people.push(lead);
  }
  return people;
}

export async function scanOverdue() {
  const today = todayISO();
  const oldest = isoDate(addDays(parseISODate(today), -7));
  const open = await findMany('tasks', { status: { $ne: 'done' }, due_date: { $gte: oldest, $lt: today } });
  const due = open.filter((task) => task.due_date && task.overdue_notified_for !== task.due_date);
  if (!due.length) return;
  const users = await usersByIds(due.flatMap((task) => [task.assignee_id, task.creator_id]));
  for (const task of due) {
    const assignee = users.get(task.assignee_id);
    if (!assignee?.active) {
      await updateOne('tasks', { _id: task.id }, { overdue_notified_for: task.due_date });
      continue;
    }
    await sendOverdueEmail(assignee, task);
    const told = new Set();
    await notify(
      assignee.id,
      `“${task.title}” is past its deadline (${task.due_date}).`,
      task.id,
      task.project_id,
      'board',
    );
    told.add(assignee.id);
    let leads = await leadsFor(assignee.id);
    if (!leads.length && task.creator_id && task.creator_id !== assignee.id) {
      const creator = users.get(task.creator_id) || await findOne('users', { _id: task.creator_id });
      if (creator?.active) leads = [creator];
    }
    for (const lead of leads) {
      if (told.has(lead.id)) continue;
      await notify(
        lead.id,
        `${assignee.name} is past the deadline for “${task.title}” (${task.due_date}).`,
        task.id,
        task.project_id,
        'board',
      );
      told.add(lead.id);
    }
    await updateOne('tasks', { _id: task.id }, { overdue_notified_for: task.due_date });
  }
}

export function startReminders() {
  const run = () => {
    scanOverdue().catch((error) => console.error(`Overdue check failed: ${error.message}`));
  };
  setTimeout(run, 15_000);
  const timer = setInterval(run, 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}
