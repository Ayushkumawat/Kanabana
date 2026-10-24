import { addDays, eachDate, isoDate, startOfWeek, weekdayMon1 } from './dates.js';
import {
  findMany,
  findOne,
  id,
  insertIgnore,
  insertOne,
  now,
  updateMany,
  updateOne,
} from './store.js';

export {
  aggregate,
  closeDb,
  connectDb,
  count,
  databaseName,
  deleteMany,
  deleteOne,
  ensureIndexes,
  exists,
  findMany,
  findOne,
  id,
  insertIgnore,
  insertOne,
  now,
  ping,
  replaceOne,
  updateMany,
  updateOne,
  withTx,
} from './store.js';

export async function usersByIds(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await findMany('users', { _id: { $in: unique } });
  return new Map(rows.map((row) => [row.id, row]));
}

export async function logActivity(actorId, message, taskId = null, projectId = null) {
  await insertOne('activity', {
    id: id('act'),
    actor_id: actorId,
    message,
    task_id: taskId,
    project_id: projectId,
    created_at: now(),
  });
}

export async function notify(userId, message, taskId = null, projectId = null, area = null) {
  if (!userId) return;
  const user = await findOne('users', { _id: userId });
  if (!user?.active) return;
  const section = area || (taskId ? 'board' : projectId ? 'projects' : null);
  await insertOne('notifications', {
    id: id('ntf'),
    user_id: userId,
    message,
    task_id: taskId,
    project_id: projectId,
    read: 0,
    area: section,
    area_seen: 0,
    created_at: now(),
  });
}

export async function ensureRecurring(weekStart, weekEnd) {
  const currentStart = isoDate(startOfWeek(new Date()));
  if (weekEnd < currentStart) return;
  const rules = await findMany('recurring_rules', { active: 1 });
  const stamp = now();
  for (const date of eachDate(weekStart, weekEnd)) {
    if (date < currentStart) continue;
    const weekday = weekdayMon1(date);
    for (const rule of rules) {
      if (rule.cadence === 'daily' && weekday === 7) continue;
      if (rule.cadence === 'weekly' && weekday !== rule.weekday) continue;
      await insertIgnore('tasks', {
        id: id('task'),
        title: rule.title,
        description: rule.description || '',
        project_id: rule.project_id || null,
        stage_id: null,
        creator_id: rule.assignee_id,
        assignee_id: rule.assignee_id,
        status: 'upcoming',
        priority: rule.priority,
        due_date: date,
        kind: 'recurring',
        recurring_rule_id: rule.id,
        parent_task_id: null,
        handoff_task_id: null,
        created_at: stamp,
        updated_at: stamp,
        completed_at: null,
      }, { recurring_rule_id: rule.id, due_date: date });
    }
  }
}

export async function repairData() {
  const unfinished = await findMany('tasks', {
    status: 'done',
    $or: [{ completed_at: null }, { completed_at: '' }],
  });
  for (const task of unfinished) {
    await updateOne('tasks', { _id: task.id }, { completed_at: task.updated_at });
  }
  const notes = await findMany('notifications', { area: null });
  for (const note of notes) {
    const area = note.task_id ? 'board' : note.project_id ? 'projects' : null;
    if (area) await updateOne('notifications', { _id: note.id }, { area });
  }
  await updateMany('notifications', { read: 1, area_seen: { $ne: 1 } }, { area_seen: 1 });
}

export async function prepareWeek() {
  const monday = startOfWeek(new Date());
  await ensureRecurring(isoDate(monday), isoDate(addDays(monday, 13)));
}

export async function hydrateTasks(tasks) {
  if (!tasks.length) return [];
  const relatedIds = new Set();
  for (const task of tasks) {
    if (task.parent_task_id) relatedIds.add(task.parent_task_id);
    if (task.handoff_task_id) relatedIds.add(task.handoff_task_id);
  }
  const have = new Set(tasks.map((task) => task.id));
  const missing = [...relatedIds].filter((taskId) => !have.has(taskId));
  const extra = missing.length ? await findMany('tasks', { _id: { $in: missing } }) : [];
  const taskMap = new Map([...tasks, ...extra].map((task) => [task.id, task]));
  const userIds = new Set();
  const projectIds = new Set();
  const ruleIds = new Set();
  for (const task of taskMap.values()) {
    userIds.add(task.creator_id);
    userIds.add(task.assignee_id);
    if (task.project_id) projectIds.add(task.project_id);
    if (task.recurring_rule_id) ruleIds.add(task.recurring_rule_id);
  }
  const taskIds = tasks.map((task) => task.id);
  const assigneeIds = [...new Set(tasks.map((task) => task.assignee_id))];
  const [users, projects, rules, links, deps] = await Promise.all([
    userIds.size ? findMany('users', { _id: { $in: [...userIds] } }) : [],
    projectIds.size ? findMany('projects', { _id: { $in: [...projectIds] } }) : [],
    ruleIds.size ? findMany('recurring_rules', { _id: { $in: [...ruleIds] } }) : [],
    assigneeIds.length ? findMany('user_departments', { user_id: { $in: assigneeIds } }) : [],
    taskIds.length ? findMany('task_dependencies', { task_id: { $in: taskIds }, status: 'open' }) : [],
  ]);
  const userMap = new Map(users.map((user) => [user.id, user]));
  const depUserIds = [...new Set(deps.map((dep) => dep.depends_on_id))].filter((userId) => !userMap.has(userId));
  if (depUserIds.length) {
    for (const user of await findMany('users', { _id: { $in: depUserIds } })) userMap.set(user.id, user);
  }
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));
  const deptByUser = new Map();
  for (const link of links) {
    if (!deptByUser.has(link.user_id)) deptByUser.set(link.user_id, []);
    deptByUser.get(link.user_id).push(link.department_id);
  }
  const depsByTask = new Map();
  for (const dep of deps) {
    if (!depsByTask.has(dep.task_id)) depsByTask.set(dep.task_id, []);
    depsByTask.get(dep.task_id).push(dep);
  }
  return tasks.map((task) => {
    const parent = task.parent_task_id ? taskMap.get(task.parent_task_id) : null;
    const child = task.handoff_task_id ? taskMap.get(task.handoff_task_id) : null;
    const departments = (deptByUser.get(task.assignee_id) || []).slice().sort();
    const names = (depsByTask.get(task.id) || [])
      .map((dep) => userMap.get(dep.depends_on_id)?.name)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
    return {
      ...task,
      creator_name: userMap.get(task.creator_id)?.name || '',
      assignee_name: userMap.get(task.assignee_id)?.name || '',
      project_name: task.project_id ? (projectMap.get(task.project_id)?.name || null) : null,
      parent_title: parent?.title || null,
      parent_status: parent?.status || null,
      parent_assignee_name: parent ? (userMap.get(parent.assignee_id)?.name || null) : null,
      handoff_title: child?.title || null,
      handoff_due_date: child?.due_date || null,
      handoff_status: child?.status || null,
      handoff_assignee_id: child?.assignee_id || null,
      handoff_assignee_name: child ? (userMap.get(child.assignee_id)?.name || null) : null,
      cadence: task.recurring_rule_id ? (ruleMap.get(task.recurring_rule_id)?.cadence || null) : null,
      assignee_departments: departments.length ? departments.join(',') : null,
      waiting_on: names.length ? names.join(', ') : null,
    };
  });
}

export async function loadTask(taskId) {
  const task = await findOne('tasks', { _id: taskId });
  if (!task) return null;
  const [hydrated] = await hydrateTasks([task]);
  return hydrated;
}

export async function hydrateRules(rules) {
  if (!rules.length) return [];
  const userIds = new Set();
  const projectIds = new Set();
  for (const rule of rules) {
    userIds.add(rule.assignee_id);
    userIds.add(rule.created_by);
    if (rule.project_id) projectIds.add(rule.project_id);
  }
  const [users, projects] = await Promise.all([
    findMany('users', { _id: { $in: [...userIds] } }),
    projectIds.size ? findMany('projects', { _id: { $in: [...projectIds] } }) : [],
  ]);
  const userMap = new Map(users.map((user) => [user.id, user]));
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  return rules.map((rule) => ({
    ...rule,
    assignee_name: userMap.get(rule.assignee_id)?.name || '',
    creator_name: userMap.get(rule.created_by)?.name || '',
    project_name: rule.project_id ? (projectMap.get(rule.project_id)?.name || null) : null,
  }));
}
