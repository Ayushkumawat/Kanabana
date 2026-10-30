import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { addDays, isISODate, isoDate, parseISODate, startOfWeek, todayISO, weekdayMon1 } from './dates.js';
import {
  aggregate,
  closeDb,
  connectDb,
  count,
  databaseName,
  deleteMany,
  deleteOne,
  ensureIndexes,
  ensureRecurring,
  exists,
  findMany,
  findOne,
  hydrateRules,
  hydrateTasks,
  id,
  insertIgnore,
  insertOne,
  loadTask,
  logActivity,
  notify,
  now,
  ping,
  prepareWeek,
  repairData,
  updateMany,
  updateOne,
  usersByIds,
  withTx,
} from './db.js';
import { seedIfEmpty } from './seed.js';
import { lanAddresses, publishOfficeName } from './office.js';
import { loadEnv } from './store.js';
import { registerSections } from './sections.js';
import { announcementPending } from './announcements.js';
import { finishGoogleAuth, googleAuthUrl, googleReady } from './google.js';
import { storageConfigured, storageLabel } from './storage.js';
import { checkMail, sendAssignmentEmail } from './mail.js';
import { startReminders } from './reminders.js';

loadEnv();
const PORT = process.env.PORT || 4050;
const SECRET = process.env.JWT_SECRET || 'kanabana-dev-secret';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);
const STATUSES = new Set(['upcoming', 'in_progress', 'review', 'done']);
const STATUS_LABEL = {
  upcoming: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  next();
});
app.use(cors({ origin: true }));
app.use(express.json({ limit: '20mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function bad(res, status, error) {
  res.status(status).json({ error });
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readText(value, max, label, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) return { error: `Enter ${label}` };
  if (text.length > max) return { error: `Keep ${label} under ${max} characters` };
  return { value: text };
}

function readEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
    return { error: 'Enter a valid email' };
  }
  return { value: email };
}

function readPassword(value) {
  const password = String(value ?? '');
  if (password.length < 8) return { error: 'Use at least 8 characters for the password' };
  if (password.length > 100) return { error: 'That password is too long' };
  return { value: password };
}

function uniqueList(value) {
  return [...new Set(Array.isArray(value) ? value.filter(Boolean) : [])];
}

function byName(left, right) {
  return String(left.name).localeCompare(String(right.name));
}

async function shapeUsers(rows) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [links, departments, departures] = await Promise.all([
    findMany('user_departments', { user_id: { $in: ids } }),
    findMany('departments', {}),
    findMany('departure_requests', { user_id: { $in: ids }, status: 'open' }),
  ]);
  const leads = await usersByIds(departures.map((item) => item.lead_id));
  const deptById = new Map(departments.map((department) => [department.id, department]));
  return rows.map((row) => {
    const personDepartments = links
      .filter((link) => link.user_id === row.id)
      .map((link) => deptById.get(link.department_id))
      .filter(Boolean)
      .sort(byName)
      .map((department) => ({ id: department.id, name: department.name }));
    const leadOf = departments
      .filter((department) => department.lead_id === row.id)
      .sort(byName)
      .map((department) => ({ id: department.id, name: department.name }));
    const departureLeads = [...new Set(
      departures
        .filter((item) => item.user_id === row.id)
        .map((item) => leads.get(item.lead_id)?.name)
        .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right));
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      active: Boolean(row.active),
      isAdmin: row.role === 'admin',
      isManager: Boolean(row.manager),
      isLead: leadOf.length > 0,
      isHr: personDepartments.some((item) => isHrDepartment(item.name)),
      birthday: row.birthday || null,
      workAnniversary: row.work_anniversary || null,
      leadOf,
      departments: personDepartments,
      departmentIds: personDepartments.map((item) => item.id),
      leadDepartmentIds: leadOf.map((item) => item.id),
      departureLeads,
      createdAt: row.created_at,
    };
  });
}

async function shapeUser(row) {
  const [shaped] = await shapeUsers([row]);
  return shaped;
}

async function userContext(userId) {
  const row = await findOne('users', { _id: userId });
  if (!row || !row.active) return null;
  return shapeUser(row);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return bad(res, 401, 'Sign in required');
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return bad(res, 401, 'Sign in required');
  }
  userContext(payload.sub).then((auth) => {
    if (!auth) return bad(res, 401, 'Sign in required');
    req.auth = auth;
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  if (!req.auth.isAdmin) return bad(res, 403, 'Only an admin can do that');
  next();
}

async function activeUser(userId) {
  if (!userId) return null;
  const user = await findOne('users', { _id: userId });
  if (!user || !user.active) return null;
  return user;
}

function isProjectMember(projectId, userId) {
  return exists('project_members', { project_id: projectId, user_id: userId });
}

const NOT_ON_PROJECT = 'You’re not part of this project. Ask the team lead to add you.';

function seesConfidential(auth) {
  return Boolean(auth.isAdmin || auth.isManager);
}

async function managerIdSet() {
  const rows = await findMany('users', { manager: 1 });
  return new Set(rows.map((row) => row.id));
}

async function isPrivateAssignee(userId) {
  if (!userId) return false;
  const row = await findOne('users', { _id: userId });
  return Boolean(row?.manager);
}

async function omitPrivateTasks(auth, tasks) {
  if (seesConfidential(auth) || !tasks.length) return tasks;
  const hidden = await managerIdSet();
  if (!hidden.size) return tasks;
  return tasks.filter((task) => !hidden.has(task.assignee_id));
}

async function canViewProject(auth, projectId) {
  if (auth.isAdmin || auth.isManager || await isProjectMember(projectId, auth.id)) return true;
  const project = await findOne('projects', { _id: projectId });
  if (project?.created_by === auth.id) return true;
  const projectDepartments = await findMany('project_departments', { project_id: projectId });
  return projectDepartments.some((link) => auth.leadDepartmentIds.includes(link.department_id));
}

async function userInDepartments(userId, departmentIds) {
  if (!departmentIds.length) return false;
  return exists('user_departments', { user_id: userId, department_id: { $in: departmentIds } });
}

async function assigneeInLeadDepts(auth, assigneeId) {
  if (!auth.leadDepartmentIds.length) return false;
  return exists('user_departments', { user_id: assigneeId, department_id: { $in: auth.leadDepartmentIds } });
}

async function projectDepartmentIds(projectId) {
  const links = await findMany('project_departments', { project_id: projectId });
  return links.map((item) => item.department_id);
}

function managesProject(auth, row) {
  return Boolean(row && (auth.isAdmin || row.created_by === auth.id));
}

async function canDeleteProject(auth, row) {
  if (!row) return false;
  if (auth.isAdmin || row.created_by === auth.id) return true;
  const ids = await projectDepartmentIds(row.id);
  return ids.some((departmentId) => auth.leadDepartmentIds.includes(departmentId));
}

async function canAssignOnProject(auth, project) {
  if (!project) return false;
  if (auth.isAdmin || auth.isManager || project.created_by === auth.id) return true;
  const ids = await projectDepartmentIds(project.id);
  return ids.some((departmentId) => auth.leadDepartmentIds.includes(departmentId));
}

async function canGovernTask(auth, task) {
  if (!task) return false;
  if (!seesConfidential(auth) && task.assignee_id !== auth.id && await isPrivateAssignee(task.assignee_id)) return false;
  if (auth.isAdmin) return true;
  if (auth.isLead && task.creator_id === auth.id) return true;
  return assigneeInLeadDepts(auth, task.assignee_id);
}

async function leadIdsFor(userId) {
  const links = await findMany('user_departments', { user_id: userId });
  if (!links.length) return [];
  const departments = await findMany('departments', {
    _id: { $in: links.map((link) => link.department_id) },
    lead_id: { $ne: null },
  });
  return [...new Set(departments.map((department) => department.lead_id))];
}

async function requestRecipients(task) {
  if (await isPrivateAssignee(task.assignee_id)) {
    const managers = await findMany('users', { manager: 1, active: 1 });
    const admins = await findMany('users', { role: 'admin', active: 1 });
    const ids = new Set([...managers, ...admins].map((user) => user.id));
    ids.delete(task.assignee_id);
    return [...ids];
  }
  const ids = new Set(await leadIdsFor(task.assignee_id));
  if (await exists('departments', { lead_id: task.creator_id })) ids.add(task.creator_id);
  ids.delete(task.assignee_id);
  if (!ids.size) {
    for (const admin of await findMany('users', { role: 'admin', active: 1 })) ids.add(admin.id);
  }
  return [...ids];
}

async function openRequest(task, kind, auth, note) {
  const existing = await findOne('task_requests', { task_id: task.id, kind, status: 'open' });
  if (existing) return existing.id;
  const requestId = id('req');
  await insertOne('task_requests', {
    id: requestId,
    task_id: task.id,
    kind,
    requester_id: auth.id,
    note: note || '',
    response_note: '',
    status: 'open',
    task_title: task.title,
    assignee_id: task.assignee_id,
    creator_id: task.creator_id,
    project_id: task.project_id || null,
    created_at: now(),
    resolved_at: null,
  });
  return requestId;
}

async function canHandleRequest(auth, row) {
  const assigneeId = row.assignee_id || row.assigneeId;
  if (await isPrivateAssignee(assigneeId)) return seesConfidential(auth);
  if (auth.isAdmin || auth.isManager) return true;
  const creatorId = row.creator_id || row.creatorId;
  if (await assigneeInLeadDepts(auth, assigneeId)) return true;
  return Boolean(auth.isLead && creatorId === auth.id);
}

function requestVerb(kind) {
  if (kind === 'remove') return 'delete';
  if (kind === 'edit') return 'edit';
  return 'complete';
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

async function presentProjects(rows, auth, withHistory = false) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [deptLinks, memberLinks, departments, tasks, history, timelines] = await Promise.all([
    findMany('project_departments', { project_id: { $in: ids } }),
    findMany('project_members', { project_id: { $in: ids } }),
    findMany('departments', {}),
    findMany('tasks', { project_id: { $in: ids } }),
    withHistory ? findMany('timeline_changes', { project_id: { $in: ids } }, { sort: { created_at: -1 } }) : [],
    findMany('project_timelines', { project_id: { $in: ids } }),
  ]);
  const deptMap = new Map(departments.map((department) => [department.id, department]));
  const userIds = new Set(rows.map((row) => row.created_by));
  for (const link of memberLinks) userIds.add(link.user_id);
  for (const item of history) userIds.add(item.actor_id);
  const users = await usersByIds([...userIds]);
  const privateAssignees = seesConfidential(auth) ? new Set() : await managerIdSet();
  const linksByProject = groupBy(deptLinks, 'project_id');
  const membersByProject = groupBy(memberLinks, 'project_id');
  const tasksByProject = groupBy(tasks, 'project_id');
  const historyByProject = groupBy(history, 'project_id');
  const timelinesByProject = groupBy(timelines, 'project_id');
  return rows.map((row) => {
    const projectDepartments = (linksByProject.get(row.id) || [])
      .map((link) => deptMap.get(link.department_id))
      .filter(Boolean)
      .sort(byName)
      .map((department) => ({ id: department.id, name: department.name }));
    const members = (membersByProject.get(row.id) || [])
      .map((link) => users.get(link.user_id))
      .filter(Boolean)
      .sort(byName)
      .map((member) => ({ id: member.id, name: member.name, active: Boolean(member.active) }));
    const projectTasks = (tasksByProject.get(row.id) || []).filter((task) => !privateAssignees.has(task.assignee_id));
    const onTeam = projectDepartments.some((item) => auth.leadDepartmentIds.includes(item.id));
    const wide = auth.isAdmin || auth.isManager;
    const savedTimelines = timelinesByProject.get(row.id) || [];
    const teamTimelines = projectDepartments.map((department) => {
      const saved = savedTimelines.find((item) => item.department_id === department.id);
      const canEdit = auth.isAdmin || auth.leadDepartmentIds.includes(department.id);
      if (!saved) {
        return {
          departmentId: department.id,
          departmentName: department.name,
          startDate: row.start_date,
          endDate: row.end_date,
          status: 'set',
          reason: '',
          canEdit,
          pending: false,
        };
      }
      return {
        departmentId: department.id,
        departmentName: department.name,
        startDate: saved.start_date,
        endDate: saved.end_date,
        status: saved.status,
        reason: saved.reason || '',
        canEdit,
        pending: saved.status !== 'set',
      };
    });
    const project = {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
      createdAt: row.created_at,
      departments: projectDepartments,
      timelines: teamTimelines,
      members,
      taskCount: projectTasks.length,
      doneCount: projectTasks.filter((task) => task.status === 'done').length,
      createdBy: row.created_by,
      createdByName: users.get(row.created_by)?.name || '',
      canManage: auth.isAdmin || row.created_by === auth.id,
      canDelete: auth.isAdmin || row.created_by === auth.id || onTeam,
      canAssign: wide || row.created_by === auth.id || onTeam,
      canEditTimeline: auth.isAdmin || onTeam,
      canOpen: wide || row.created_by === auth.id || onTeam || members.some((member) => member.id === auth.id),
      canAddTask: wide || row.created_by === auth.id || onTeam || members.some((member) => member.id === auth.id),
    };
    if (!withHistory) return project;
    const items = (historyByProject.get(row.id) || []).map((item) => ({
      id: item.id,
      reason: item.reason,
      before: JSON.parse(item.before_json),
      after: JSON.parse(item.after_json),
      createdAt: item.created_at,
      departmentName: item.department_name || '',
      actorName: String(item.actor_name || '').trim() || users.get(item.actor_id)?.name || '',
    }));
    return { ...project, history: items };
  });
}

async function presentProject(row, auth, withHistory = false) {
  const [project] = await presentProjects([row], auth, withHistory);
  return project;
}

function mapTask(row, weekEnd, weekStart = null) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    projectId: row.project_id,
    projectName: row.project_name || null,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    assigneeDepartmentIds: row.assignee_departments ? row.assignee_departments.split(',') : [],
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    kind: row.kind,
    cadence: row.cadence || null,
    recurringRuleId: row.recurring_rule_id,
    parentTaskId: row.parent_task_id,
    parentTitle: row.parent_title || null,
    parentStatus: row.parent_status || null,
    parentAssigneeName: row.parent_assignee_name || null,
    handoffTaskId: row.handoff_task_id,
    handoffTitle: row.handoff_title || null,
    handoffDueDate: row.handoff_due_date || null,
    handoffStatus: row.handoff_status || null,
    handoffAssigneeId: row.handoff_assignee_id || null,
    handoffAssigneeName: row.handoff_assignee_name || null,
    spillover: Boolean(weekEnd && row.due_date > weekEnd && !row.from_next),
    fromNextWeek: Boolean(row.from_next),
    fromPreviousWeek: Boolean(weekStart && row.due_date < weekStart && row.status !== 'done'),
    waitingOn: row.waiting_on || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
  };
}

async function canSeeTask(auth, task) {
  if (!task) return false;
  if (task.assignee_id !== auth.id && !seesConfidential(auth) && await isPrivateAssignee(task.assignee_id)) return false;
  if (auth.isAdmin || auth.isManager || task.assignee_id === auth.id || task.creator_id === auth.id) return true;
  if (await assigneeInLeadDepts(auth, task.assignee_id)) return true;
  if (task.project_id) {
    const project = await findOne('projects', { _id: task.project_id });
    if (await canAssignOnProject(auth, project)) return true;
  }
  return exists('task_dependencies', { task_id: task.id, depends_on_id: auth.id, status: 'open' });
}

async function taskChain(taskId) {
  const upward = [];
  const seenUp = new Set();
  let cursor = await loadTask(taskId);
  let guard = 0;
  while (cursor?.parent_task_id && guard < 8) {
    const parent = await loadTask(cursor.parent_task_id);
    if (!parent || seenUp.has(parent.id)) break;
    seenUp.add(parent.id);
    upward.push(parent);
    cursor = parent;
    guard += 1;
  }
  upward.reverse();
  const downward = [];
  const seenDown = new Set();
  cursor = await loadTask(taskId);
  guard = 0;
  while (cursor?.handoff_task_id && guard < 8) {
    const child = await loadTask(cursor.handoff_task_id);
    if (!child || seenDown.has(child.id)) break;
    seenDown.add(child.id);
    downward.push(child);
    cursor = child;
    guard += 1;
  }
  const rows = [...upward, await loadTask(taskId), ...downward].filter(Boolean);
  const unique = [];
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) continue;
    ids.add(row.id);
    unique.push(mapTask(row, '9999-99-99'));
  }
  return unique;
}

async function insertTaskRow(fields) {
  const taskId = fields.id || id('task');
  const stamp = now();
  await insertOne('tasks', {
    id: taskId,
    title: fields.title,
    description: fields.description || '',
    project_id: fields.projectId || null,
    stage_id: null,
    creator_id: fields.creatorId,
    assignee_id: fields.assigneeId,
    status: fields.status,
    priority: fields.priority,
    due_date: fields.dueDate,
    kind: fields.kind,
    recurring_rule_id: fields.recurringRuleId || null,
    parent_task_id: fields.parentTaskId || null,
    handoff_task_id: fields.handoffTaskId || null,
    created_at: stamp,
    updated_at: stamp,
    completed_at: null,
  });
  return taskId;
}

async function createHandoff(parentId, auth, handoff) {
  const parent = await findOne('tasks', { _id: parentId });
  if (!parent) throw httpError(404, 'Task not found');
  if (parent.handoff_task_id) {
    throw httpError(400, 'This task already names the next person. Only an admin can change that.');
  }
  const title = readText(handoff?.title, 140, 'the next piece of work', true);
  if (title.error) throw httpError(400, title.error);
  const description = readText(handoff?.description, 4000, 'the handoff details');
  if (description.error) throw httpError(400, description.error);
  if (!isISODate(handoff?.dueDate)) throw httpError(400, 'Choose a due date for the next person');
  if (handoff.dueDate < parent.due_date) {
    throw httpError(400, 'The next due date should be on or after this task’s due date');
  }
  const next = await activeUser(handoff.assigneeId);
  if (!next) throw httpError(400, 'Choose an active person for the next step');
  if (next.id === parent.assignee_id) throw httpError(400, 'Hand the work to someone else');
  if (parent.project_id && !await isProjectMember(parent.project_id, next.id)) {
    throw httpError(400, 'The next person needs to be on this project');
  }
  const childId = await insertTaskRow({
    title: title.value,
    description: description.value,
    projectId: parent.project_id,
    creatorId: auth.id,
    assigneeId: next.id,
    status: 'upcoming',
    priority: parent.priority,
    dueDate: handoff.dueDate,
    kind: parent.project_id ? 'project' : 'personal',
    parentTaskId: parent.id,
  });
  await updateOne('tasks', { _id: parent.id }, { handoff_task_id: childId, updated_at: now() });
  if (next.id !== auth.id) {
    await notify(next.id, `${auth.name} handed you “${title.value}” after “${parent.title}”.`, childId, parent.project_id);
  }
  await logActivity(auth.id, `${auth.name} handed “${title.value}” to ${next.name}.`, childId, parent.project_id);
  return childId;
}

async function writeStatus(taskId, status, previousCompletedAt) {
  const stamp = now();
  const completedAt = status === 'done' ? (previousCompletedAt || stamp) : null;
  await updateOne('tasks', { _id: taskId }, { status, completed_at: completedAt, updated_at: stamp });
}

async function noteStatus(task, status, auth) {
  await logActivity(auth.id, `${auth.name} moved “${task.title}” to ${STATUS_LABEL[status]}.`, task.id, task.project_id);
  if (task.status === 'review' && status !== 'review') {
    const accepted = status === 'done';
    await updateMany('task_requests', { task_id: task.id, kind: 'review', status: 'open' }, {
      status: accepted ? 'accepted' : 'declined',
      resolved_at: now(),
      ...(accepted ? { response_note: 'Marked done.' } : {}),
    });
  }
  if (status === 'review' && auth.id === task.assignee_id && !await canGovernTask(auth, task)) {
    await openRequest(task, 'review', auth, '');
    for (const userId of await requestRecipients(task)) {
      await notify(userId, `${auth.name} asked you to review “${task.title}”.`, task.id, task.project_id, 'requests');
    }
  }
  if (status !== 'done' || !task.handoff_task_id) return;
  const child = await findOne('tasks', { _id: task.handoff_task_id });
  if (child && child.assignee_id !== auth.id) {
    await notify(child.assignee_id, `${auth.name} finished “${task.title}”. “${child.title}” is ready for you.`, child.id, task.project_id);
  }
}

async function rawTask(taskId) {
  return findOne('tasks', { _id: taskId });
}

async function canTouchRule(auth, rule) {
  if (rule.assignee_id !== auth.id && !seesConfidential(auth) && await isPrivateAssignee(rule.assignee_id)) return false;
  if (auth.isAdmin || auth.isManager || rule.created_by === auth.id || rule.assignee_id === auth.id) return true;
  return assigneeInLeadDepts(auth, rule.assignee_id);
}

function mapRule(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    cadence: row.cadence,
    weekday: row.weekday,
    priority: row.priority,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    createdBy: row.created_by,
    creatorName: row.creator_name,
    projectId: row.project_id,
    projectName: row.project_name || null,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

async function notifyProject(projectId, auth, message) {
  const recipients = new Set((await findMany('project_members', { project_id: projectId })).map((row) => row.user_id));
  const links = await findMany('project_departments', { project_id: projectId });
  if (links.length) {
    const departments = await findMany('departments', { _id: { $in: links.map((link) => link.department_id) } });
    for (const department of departments) if (department.lead_id) recipients.add(department.lead_id);
  }
  for (const userId of recipients) {
    if (userId !== auth.id) await notify(userId, message, null, projectId);
  }
}

async function deleteTask(taskId) {
  await updateMany('tasks', { handoff_task_id: taskId }, { handoff_task_id: null, updated_at: now() });
  await updateMany('tasks', { parent_task_id: taskId }, { parent_task_id: null });
  await deleteMany('comments', { task_id: taskId });
  const stamp = now();
  await updateMany('task_requests', { task_id: taskId, status: 'open', kind: 'remove' }, {
    status: 'accepted',
    response_note: 'The task was deleted.',
    resolved_at: stamp,
  });
  await updateMany('task_requests', { task_id: taskId, status: 'open', kind: { $ne: 'remove' } }, {
    status: 'declined',
    response_note: 'This task was deleted.',
    resolved_at: stamp,
  });
  await deleteMany('departure_items', { task_id: taskId });
  await deleteMany('task_dependencies', { task_id: taskId });
  await updateMany('knowledge_items', { task_id: taskId }, { task_id: null });
  await deleteOne('tasks', { _id: taskId });
}

async function removeProject(projectId) {
  const tasks = await findMany('tasks', { project_id: projectId });
  const taskIds = tasks.map((task) => task.id);
  if (taskIds.length) {
    await updateMany('tasks', { handoff_task_id: { $in: taskIds } }, { handoff_task_id: null, updated_at: now() });
    for (const taskId of taskIds) await deleteTask(taskId);
  }
  const rules = await findMany('recurring_rules', { project_id: projectId });
  for (const rule of rules) {
    await updateMany('tasks', { recurring_rule_id: rule.id }, { recurring_rule_id: null });
    await deleteMany('departure_items', { rule_id: rule.id });
    await deleteOne('recurring_rules', { _id: rule.id });
  }
  await deleteMany('project_departments', { project_id: projectId });
  await deleteMany('project_members', { project_id: projectId });
  await deleteMany('project_stages', { project_id: projectId });
  await deleteMany('timeline_changes', { project_id: projectId });
  await deleteMany('project_timelines', { project_id: projectId });
  await deleteMany('knowledge_items', { project_id: projectId });
  await deleteOne('projects', { _id: projectId });
}

app.get('/api/health', wrap(async (_req, res) => {
  try {
    await ping();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = readEmail(req.body.email || '');
  const password = String(req.body.password || '');
  if (email.error) return bad(res, 401, 'Email or password is incorrect');
  const user = await findOne('users', { email: email.value });
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return bad(res, 401, 'Email or password is incorrect');
  }
  if (!user.active) return bad(res, 403, 'This account is deactivated. Ask an admin to turn it back on.');
  const token = jwt.sign({ sub: user.id }, SECRET, { expiresIn: '7d' });
  res.json({ token, user: await userContext(user.id) });
}));

app.get('/api/me', requireAuth, wrap(async (req, res) => {
  res.json({ user: req.auth });
}));

app.patch('/api/me', requireAuth, wrap(async (req, res) => {
  const name = readText(req.body.name, 80, 'your name', true);
  if (name.error) return bad(res, 400, name.error);
  const email = readEmail(req.body.email);
  if (email.error) return bad(res, 400, email.error);
  if (!isISODate(req.body.birthday)) return bad(res, 400, 'Choose a date of birth');
  if (!isISODate(req.body.workAnniversary)) return bad(res, 400, 'Choose a date of joining');
  const today = todayISO();
  if (req.body.birthday > today) return bad(res, 400, 'Date of birth can’t be in the future');
  if (req.body.workAnniversary > today) return bad(res, 400, 'Date of joining can’t be in the future');
  if (await exists('users', { email: email.value, _id: { $ne: req.auth.id } })) {
    return bad(res, 400, 'That email is already in use');
  }
  await updateOne('users', { _id: req.auth.id }, {
    name: name.value,
    email: email.value,
    birthday: req.body.birthday,
    work_anniversary: req.body.workAnniversary,
  });
  await logActivity(req.auth.id, `${name.value} updated their profile.`);
  res.json({ user: await userContext(req.auth.id) });
}));

app.post('/api/google/connect', requireAuth, requireAdmin, wrap(async (_req, res) => {
  try {
    res.json({ url: googleAuthUrl() });
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
}));

app.get('/api/google/callback', wrap(async (req, res) => {
  try {
    await finishGoogleAuth(String(req.query.code || ''), String(req.query.state || ''));
  } catch (error) {
    const message = String(error.message || 'Google Calendar could not be connected.')
      .replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));
    res.status(400).type('html').send(`<!doctype html><p>${message}</p><p><a href="/meetings">Back to meetings</a></p>`);
    return;
  }
  res.redirect('/meetings');
}));

app.post('/api/me/password', requireAuth, wrap(async (req, res) => {
  const next = readPassword(req.body.nextPassword);
  if (next.error) return bad(res, 400, next.error);
  const user = await findOne('users', { _id: req.auth.id });
  if (!bcrypt.compareSync(String(req.body.currentPassword || ''), user.password_hash)) {
    return bad(res, 400, 'Current password is incorrect');
  }
  await updateOne('users', { _id: req.auth.id }, { password_hash: bcrypt.hashSync(next.value, 10) });
  await logActivity(req.auth.id, `${req.auth.name} changed their password.`);
  res.json({ ok: true });
}));

app.get('/api/users', requireAuth, wrap(async (_req, res) => {
  const rows = await findMany('users', {});
  rows.sort(byName);
  res.json({ users: await shapeUsers(rows) });
}));

app.post('/api/users', requireAuth, requireAdmin, wrap(async (req, res) => {
  const name = readText(req.body.name, 80, 'the person’s name', true);
  if (name.error) return bad(res, 400, name.error);
  const email = readEmail(req.body.email);
  if (email.error) return bad(res, 400, email.error);
  const password = readPassword(req.body.password);
  if (password.error) return bad(res, 400, password.error);
  const manager = req.body.manager === true;
  let departmentIds = uniqueList(req.body.departmentIds);
  if (manager) departmentIds = (await findMany('departments', {})).map((department) => department.id);
  const leadDepartmentId = req.body.leadDepartmentId || null;
  if (!departmentIds.length) return bad(res, 400, 'Choose at least one department');
  const found = await findMany('departments', { _id: { $in: departmentIds } });
  if (found.length !== departmentIds.length) return bad(res, 400, 'Choose a real department');
  if (leadDepartmentId && !departmentIds.includes(leadDepartmentId)) {
    return bad(res, 400, 'A team lead has to belong to that department');
  }
  if (await exists('users', { email: email.value })) return bad(res, 400, 'That email is already in use');
  if (!isISODate(req.body.birthday)) return bad(res, 400, 'Choose a birthday');
  if (!isISODate(req.body.workAnniversary)) return bad(res, 400, 'Choose a work anniversary');
  const userId = id('usr');
  try {
    await withTx(async () => {
      await insertOne('users', {
        id: userId,
        name: name.value,
        email: email.value,
        password_hash: bcrypt.hashSync(password.value, 10),
        role: 'member',
        active: 1,
        manager: manager ? 1 : 0,
        birthday: req.body.birthday,
        work_anniversary: req.body.workAnniversary,
        created_at: now(),
      });
      for (const departmentId of departmentIds) {
        await insertOne('user_departments', { _id: `${userId}:${departmentId}`, user_id: userId, department_id: departmentId });
      }
      if (leadDepartmentId) await updateOne('departments', { _id: leadDepartmentId }, { lead_id: userId });
      await logActivity(req.auth.id, `${req.auth.name} added ${name.value} to the office.`);
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return bad(res, 400, 'That email is already in use');
    throw error;
  }
  res.status(201).json({ user: await userContext(userId) });
}));

app.patch('/api/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const current = await findOne('users', { _id: req.params.id });
  if (!current) return bad(res, 404, 'Person not found');
  const name = readText(req.body.name, 80, 'the person’s name', true);
  if (name.error) return bad(res, 400, name.error);
  const email = readEmail(req.body.email);
  if (email.error) return bad(res, 400, email.error);
  const manager = req.body.manager === undefined ? Boolean(current.manager) : req.body.manager === true;
  let departmentIds = uniqueList(req.body.departmentIds);
  if (manager) departmentIds = (await findMany('departments', {})).map((department) => department.id);
  const active = req.body.active !== false;
  if (!departmentIds.length) return bad(res, 400, 'Each person needs at least one department');
  const found = await findMany('departments', { _id: { $in: departmentIds } });
  if (found.length !== departmentIds.length) return bad(res, 400, 'Choose a real department');
  if (await exists('users', { email: email.value, _id: { $ne: current.id } })) {
    return bad(res, 400, 'That email is already in use');
  }
  const leading = (await findMany('departments', { lead_id: current.id })).sort(byName);
  for (const department of leading) {
    if (!departmentIds.includes(department.id)) {
      return bad(res, 400, `${current.name} still leads ${department.name}. Choose a new lead before removing them.`);
    }
  }
  if (!active) {
    if (current.id === req.auth.id) return bad(res, 400, 'You can’t deactivate your own account');
    if (leading.length) return bad(res, 400, `Choose a new lead for ${leading.map((item) => item.name).join(', ')} first`);
    if (current.role === 'admin') {
      const others = await count('users', { role: 'admin', active: 1, _id: { $ne: current.id } });
      if (!others) return bad(res, 400, 'Keep at least one active admin');
    }
  }
  const birthday = isISODate(req.body.birthday) ? req.body.birthday : (current.birthday || null);
  const workAnniversary = isISODate(req.body.workAnniversary) ? req.body.workAnniversary : (current.work_anniversary || null);
  await withTx(async () => {
    await updateOne('users', { _id: current.id }, {
      name: name.value,
      email: email.value,
      active: active ? 1 : 0,
      manager: manager ? 1 : 0,
      birthday,
      work_anniversary: workAnniversary,
    });
    await deleteMany('user_departments', { user_id: current.id });
    for (const departmentId of departmentIds) {
      await insertOne('user_departments', { _id: `${current.id}:${departmentId}`, user_id: current.id, department_id: departmentId });
    }
    await logActivity(req.auth.id, `${req.auth.name} updated ${name.value}.`);
  });
  const row = await findOne('users', { _id: current.id });
  res.json({ user: await shapeUser(row) });
}));

app.post('/api/users/:id/password', requireAuth, requireAdmin, wrap(async (req, res) => {
  const person = await findOne('users', { _id: req.params.id });
  if (!person) return bad(res, 404, 'Person not found');
  const password = readPassword(req.body.password);
  if (password.error) return bad(res, 400, password.error);
  await updateOne('users', { _id: person.id }, { password_hash: bcrypt.hashSync(password.value, 10) });
  await logActivity(req.auth.id, `${req.auth.name} reset the password for ${person.name}.`);
  res.json({ ok: true });
}));

function nameList(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

async function personDepartments(userId) {
  const links = await findMany('user_departments', { user_id: userId });
  if (!links.length) return [];
  const departments = await findMany('departments', { _id: { $in: links.map((link) => link.department_id) } });
  const leads = await usersByIds(departments.map((department) => department.lead_id));
  return departments.map((department) => {
    const lead = department.lead_id ? leads.get(department.lead_id) : null;
    return {
      id: department.id,
      name: department.name,
      leadId: department.lead_id || null,
      leadName: lead?.name || null,
      leadActive: lead ? lead.active : null,
    };
  }).sort(byName);
}

function owningDepartmentIds(projectId, departmentIds, projectDepartmentSet) {
  if (!projectId) return departmentIds.slice();
  const overlap = departmentIds.filter((departmentId) => projectDepartmentSet.has(departmentId));
  return overlap.length ? overlap : departmentIds.slice();
}

async function teammates(departmentIds, exceptId) {
  if (!departmentIds.length) return [];
  const links = await findMany('user_departments', { department_id: { $in: departmentIds } });
  const ids = [...new Set(links.map((link) => link.user_id))].filter((userId) => userId !== exceptId);
  if (!ids.length) return [];
  const users = await findMany('users', { _id: { $in: ids }, active: 1 });
  return users.map((user) => ({ id: user.id, name: user.name })).sort(byName);
}

async function departureBuckets(personId) {
  const departments = await personDepartments(personId);
  const departmentIds = departments.map((item) => item.id);
  const projectIds = new Set();
  const tasks = (await findMany('tasks', {
    assignee_id: personId,
    status: { $ne: 'done' },
    recurring_rule_id: null,
  })).sort((left, right) => left.due_date.localeCompare(right.due_date) || left.title.localeCompare(right.title));
  const rules = (await findMany('recurring_rules', { assignee_id: personId })).sort((left, right) => left.title.localeCompare(right.title));
  for (const item of [...tasks, ...rules]) if (item.project_id) projectIds.add(item.project_id);
  const projectLinks = projectIds.size
    ? await findMany('project_departments', { project_id: { $in: [...projectIds] } })
    : [];
  const departmentsByProject = groupBy(projectLinks, 'project_id');
  const projectNames = new Map((projectIds.size ? await findMany('projects', { _id: { $in: [...projectIds] } }) : []).map((project) => [project.id, project.name]));
  const buckets = new Map();
  for (const department of departments) {
    if (!department.leadId || department.leadId === personId) continue;
    if (!buckets.has(department.leadId)) {
      buckets.set(department.leadId, {
        leadId: department.leadId,
        leadName: department.leadName,
        departmentIds: [],
        departmentNames: [],
        tasks: [],
        rules: [],
      });
    }
    const bucket = buckets.get(department.leadId);
    bucket.departmentIds.push(department.id);
    bucket.departmentNames.push(department.name);
  }
  function place(item, key) {
    const owned = new Set((departmentsByProject.get(item.project_id) || []).map((link) => link.department_id));
    const owners = owningDepartmentIds(item.project_id, departmentIds, owned);
    const leadIds = [...new Set(owners.map((departmentId) => departments.find((department) => department.id === departmentId)?.leadId).filter((leadId) => leadId && leadId !== personId))];
    for (const leadId of leadIds) {
      const bucket = buckets.get(leadId);
      if (!bucket || bucket[key].some((row) => row.id === item.id)) continue;
      const scoped = owners.filter((departmentId) => bucket.departmentIds.includes(departmentId));
      bucket[key].push({
        id: item.id,
        title: item.title,
        status: item.status,
        project_id: item.project_id,
        project_name: item.project_id ? (projectNames.get(item.project_id) || null) : null,
        departmentIds: scoped.length ? scoped : bucket.departmentIds,
      });
    }
  }
  for (const task of tasks) place(task, 'tasks');
  for (const rule of rules) place(rule, 'rules');
  return { departments, buckets: [...buckets.values()] };
}

async function eraseUser(person, requestedById) {
  const created = await count('projects', { created_by: person.id });
  if (created) throw httpError(400, `${person.name} created projects that are still here, so this account can’t be deleted.`);
  const leading = (await findMany('departments', { lead_id: person.id })).sort(byName);
  if (leading.length) {
    throw httpError(400, `${person.name} still leads ${leading.map((item) => item.name).join(', ')}. Choose a new lead first.`);
  }
  const openTasks = await count('tasks', { assignee_id: person.id, status: { $ne: 'done' } });
  const rules = await count('recurring_rules', { assignee_id: person.id });
  if (openTasks || rules) throw httpError(400, `${person.name} still has tasks to move.`);
  await withTx(async () => {
    const stamp = now();
    await updateMany('tasks', { assignee_id: person.id, status: 'done' }, { assignee_id: requestedById, updated_at: stamp });
    await updateMany('tasks', { creator_id: person.id }, { creator_id: requestedById });
    await updateMany('recurring_rules', { created_by: person.id }, { created_by: requestedById });
    await updateMany('comments', { author_id: person.id, $or: [{ author_name: null }, { author_name: '' }] }, { author_name: person.name });
    await updateMany('comments', { author_id: person.id }, { author_id: requestedById });
    await updateMany('timeline_changes', { actor_id: person.id, $or: [{ actor_name: null }, { actor_name: '' }] }, { actor_name: person.name });
    await updateMany('timeline_changes', { actor_id: person.id }, { actor_id: requestedById });
    await updateMany('task_requests', { requester_id: person.id }, { requester_id: requestedById });
    await updateMany('office_chores', { requester_id: person.id }, { requester_id: requestedById });
    await deleteMany('attendance', { user_id: person.id });
    await deleteMany('notifications', { user_id: person.id });
    await deleteMany('activity', { actor_id: person.id });
    await deleteMany('project_members', { user_id: person.id });
    const requests = await findMany('departure_requests', { user_id: person.id });
    if (requests.length) await deleteMany('departure_items', { request_id: { $in: requests.map((item) => item.id) } });
    await deleteMany('departure_requests', { user_id: person.id });
    await deleteMany('departure_holds', { user_id: person.id });
    await deleteMany('task_dependencies', { $or: [{ requester_id: person.id }, { depends_on_id: person.id }] });
    await updateMany('tenders', { created_by: person.id }, { created_by: requestedById });
    await updateMany('hiring_positions', { created_by: person.id }, { created_by: requestedById });
    await updateMany('hiring_resumes', { uploaded_by: person.id }, { uploaded_by: requestedById });
    await updateMany('hiring_resumes', { reviewer_id: person.id }, { reviewer_id: null });
    await updateMany('hiring_resumes', { user_id: person.id }, { user_id: null });
    await updateMany('knowledge_items', { user_id: person.id }, { user_id: null });
    await updateMany('knowledge_items', { author_id: person.id }, { author_id: null });
    await updateMany('reports', { author_id: person.id }, { author_id: requestedById });
    await deleteMany('personal_notes', { user_id: person.id });
    await deleteMany('notepad_days', { user_id: person.id });
    await deleteMany('user_departments', { user_id: person.id });
    await deleteOne('users', { _id: person.id });
    const keeper = await findOne('users', { _id: requestedById });
    if (keeper) await logActivity(keeper.id, `${keeper.name} removed ${person.name} from the office.`);
  });
}

async function openDependencyBlock(taskId) {
  const deps = await findMany('task_dependencies', { task_id: taskId, status: 'open' });
  if (!deps.length) return null;
  const users = await usersByIds(deps.map((dep) => dep.depends_on_id));
  const names = deps.map((dep) => users.get(dep.depends_on_id)?.name).filter(Boolean).sort((left, right) => left.localeCompare(right));
  if (!names.length) return null;
  return `This task is waiting on ${nameList(names)}.`;
}

function hasKtDocument(userId) {
  return exists('knowledge_items', { kind: 'kt', user_id: userId, file_stored: { $nin: [null, ''] } });
}

async function rememberDeparture(person, admin) {
  await insertIgnore('departure_holds', {
    _id: person.id,
    user_id: person.id,
    requested_by: admin.id,
    created_at: now(),
  });
  if (!await hasKtDocument(person.id)) {
    await notify(person.id, `${admin.name} asked to remove your account. Upload your KT document in Knowledge before it can be removed.`, null, null, 'knowledge');
  }
}

async function maybeFinishDeparture(personId, actor) {
  const open = await count('departure_requests', { user_id: personId, status: 'open' });
  if (open) return { removed: false, message: 'Tasks moved. Waiting on the other team lead.' };
  const person = await findOne('users', { _id: personId });
  if (!person) return { removed: true, message: 'This person is already gone.' };
  const hold = await findOne('departure_holds', { user_id: personId });
  let request = hold;
  if (!request) {
    const closed = await findMany('departure_requests', { user_id: personId, status: { $ne: 'open' } });
    closed.sort((left, right) => left.created_at.localeCompare(right.created_at));
    request = closed[0] || null;
  }
  if (!request) return { removed: false, message: 'KT document saved' };
  if (!await hasKtDocument(personId)) {
    return { removed: false, message: `${person.name} still needs to upload a KT document.` };
  }
  await eraseUser(person, request.requested_by || actor.id);
  return { removed: true, message: `${person.name} was removed.` };
}

async function assertTeammate(assigneeId, departmentIds, exceptId) {
  const assignee = await activeUser(assigneeId);
  if (!assignee || assignee.id === exceptId) throw httpError(400, 'Choose someone else on the team');
  const allowed = await teammates(String(departmentIds || '').split(',').filter(Boolean), exceptId);
  if (!allowed.some((person) => person.id === assignee.id)) throw httpError(400, 'Choose someone on that team');
  return assignee;
}

async function moveDepartureTask(task, assignee, person, actor) {
  if (task.assignee_id === assignee.id) return;
  if (task.project_id) {
    await insertIgnore('project_members', {
      _id: `${task.project_id}:${assignee.id}`,
      project_id: task.project_id,
      user_id: assignee.id,
    });
  }
  await updateOne('tasks', { _id: task.id }, { assignee_id: assignee.id, updated_at: now() });
  await notify(assignee.id, `${actor.name} assigned “${task.title}” to you.`, task.id, task.project_id, 'board');
  await sendAssignmentEmail(assignee, actor, task);
  await logActivity(actor.id, `${actor.name} moved “${task.title}” from ${person.name} to ${assignee.name}.`, task.id, task.project_id);
}

async function startDeparture(person, admin) {
  const openTasks = await count('tasks', { assignee_id: person.id, status: { $ne: 'done' }, recurring_rule_id: null });
  const rules = await count('recurring_rules', { assignee_id: person.id });
  if (!openTasks && !rules) {
    if (!await hasKtDocument(person.id)) {
      await rememberDeparture(person, admin);
      return { ok: true, pending: true, message: `Waiting on ${person.name} to upload a KT document. The account is removed once that file is in.` };
    }
    await eraseUser(person, admin.id);
    return { ok: true, pending: false };
  }
  const { departments, buckets } = await departureBuckets(person.id);
  if (!departments.length) throw httpError(400, `Add ${person.name} to a department with a team lead before removing them.`);
  const missing = departments.filter((department) => !department.leadId);
  if (missing.length) {
    throw httpError(400, `${nameList(missing.map((department) => department.name))} needs a team lead before ${person.name} can be removed.`);
  }
  const inactive = departments.filter((department) => department.leadId && !department.leadActive);
  if (inactive.length) {
    throw httpError(400, `The lead for ${nameList(inactive.map((department) => department.name))} is not active.`);
  }
  const active = buckets.filter((bucket) => bucket.tasks.length || bucket.rules.length);
  if (!active.length) throw httpError(400, `No team lead can take ${person.name}’s tasks.`);
  for (const bucket of active) {
    for (const item of [...bucket.tasks, ...bucket.rules]) {
      if (!(await teammates(item.departmentIds, person.id)).length) {
        const names = item.departmentIds.map((departmentId) => departments.find((department) => department.id === departmentId)?.name).filter(Boolean);
        throw httpError(400, `No one else on ${nameList(names)} can take ${person.name}’s tasks.`);
      }
    }
  }
  for (const bucket of active) {
    const requestId = id('dpr');
    await insertOne('departure_requests', {
      id: requestId,
      user_id: person.id,
      lead_id: bucket.leadId,
      requested_by: admin.id,
      status: 'open',
      created_at: now(),
    });
    for (const task of bucket.tasks) {
      await insertOne('departure_items', {
        id: id('dpi'),
        request_id: requestId,
        task_id: task.id,
        rule_id: null,
        department_ids: task.departmentIds.join(','),
        done: 0,
      });
    }
    for (const rule of bucket.rules) {
      await insertOne('departure_items', {
        id: id('dpi'),
        request_id: requestId,
        task_id: null,
        rule_id: rule.id,
        department_ids: rule.departmentIds.join(','),
        done: 0,
      });
    }
    await notify(bucket.leadId, `${admin.name} wants ${person.name} removed. Move their tasks to someone on your team.`, null, null, 'requests');
  }
  const names = nameList(active.map((bucket) => bucket.leadName));
  await rememberDeparture(person, admin);
  await logActivity(admin.id, `${admin.name} asked ${names} to move ${person.name}’s tasks before removing them.`);
  const kt = await hasKtDocument(person.id) ? '' : ` ${person.name} also has to upload a KT document.`;
  return {
    ok: true,
    pending: true,
    message: `Waiting on ${names} to move ${person.name}’s tasks.${kt} The account is removed once that is done.`,
  };
}

app.delete('/api/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const person = await findOne('users', { _id: req.params.id });
  if (!person) return bad(res, 404, 'Person not found');
  if (person.id === req.auth.id) return bad(res, 400, 'You can’t delete your own account');
  if (person.role === 'admin') {
    const others = await count('users', { role: 'admin', active: 1, _id: { $ne: person.id } });
    if (!others) return bad(res, 400, 'Keep at least one active admin');
  }
  const leading = (await findMany('departments', { lead_id: person.id })).sort(byName);
  if (leading.length) {
    return bad(res, 400, `${person.name} still leads ${leading.map((item) => item.name).join(', ')}. Choose a new lead first.`);
  }
  const created = await count('projects', { created_by: person.id });
  if (created) return bad(res, 400, `${person.name} created projects that are still here, so this account can’t be deleted.`);
  const waitingRows = await findMany('departure_requests', { user_id: person.id, status: 'open' });
  const waitingUsers = await usersByIds(waitingRows.map((row) => row.lead_id));
  const waiting = [...new Set(waitingRows.map((row) => waitingUsers.get(row.lead_id)?.name).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  if (waiting.length) {
    return bad(res, 400, `Waiting on ${nameList(waiting)} to move ${person.name}’s tasks.`);
  }
  try {
    const result = await withTx(() => startDeparture(person, req.auth));
    res.json(result);
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
}));

app.get('/api/departments', requireAuth, wrap(async (req, res) => {
  const departments = (await findMany('departments', {})).sort(byName);
  const leads = await usersByIds(departments.map((department) => department.lead_id));
  const links = await findMany('user_departments', {});
  const members = await usersByIds(links.map((link) => link.user_id));
  const showPrivate = seesConfidential(req.auth);
  res.json({
    departments: departments.map((department) => ({
      id: department.id,
      name: department.name,
      leadId: department.lead_id || null,
      createdAt: department.created_at,
      leadName: department.lead_id ? (leads.get(department.lead_id)?.name || null) : null,
      members: links
        .filter((link) => link.department_id === department.id)
        .map((link) => members.get(link.user_id))
        .filter((member) => member && (showPrivate || !member.manager))
        .sort(byName)
        .map((member) => ({ id: member.id, name: member.name, active: Boolean(member.active) })),
    })),
  });
}));

app.post('/api/departments', requireAuth, requireAdmin, wrap(async (req, res) => {
  const name = readText(req.body.name, 80, 'a department name', true);
  if (name.error) return bad(res, 400, name.error);
  const lead = await activeUser(req.body.leadId);
  if (!lead) return bad(res, 400, 'Choose an active team lead');
  const departmentId = id('dep');
  try {
    await withTx(async () => {
      await insertOne('departments', { id: departmentId, name: name.value, lead_id: lead.id, created_at: now() });
      await insertIgnore('user_departments', { _id: `${lead.id}:${departmentId}`, user_id: lead.id, department_id: departmentId });
      for (const manager of await findMany('users', { manager: 1 })) {
        await insertIgnore('user_departments', { _id: `${manager.id}:${departmentId}`, user_id: manager.id, department_id: departmentId });
      }
      await logActivity(req.auth.id, `${req.auth.name} added the ${name.value} department with ${lead.name} as lead.`);
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return bad(res, 400, 'That department name is already in use');
    throw error;
  }
  res.status(201).json({ id: departmentId });
}));

app.patch('/api/departments/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const department = await findOne('departments', { _id: req.params.id });
  if (!department) return bad(res, 404, 'Department not found');
  const name = readText(req.body.name ?? department.name, 80, 'a department name', true);
  if (name.error) return bad(res, 400, name.error);
  const leadId = req.body.leadId === undefined ? department.lead_id : req.body.leadId;
  const lead = await activeUser(leadId);
  if (!lead) return bad(res, 400, 'Choose an active team lead');
  try {
    await withTx(async () => {
      await updateOne('departments', { _id: department.id }, { name: name.value, lead_id: lead.id });
      await insertIgnore('user_departments', { _id: `${lead.id}:${department.id}`, user_id: lead.id, department_id: department.id });
      await logActivity(req.auth.id, `${req.auth.name} updated the ${name.value} department.`);
    });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return bad(res, 400, 'That department name is already in use');
    throw error;
  }
  res.json({ ok: true });
}));

app.delete('/api/departments/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const department = await findOne('departments', { _id: req.params.id });
  if (!department) return bad(res, 404, 'Department not found');
  const projectLinks = await findMany('project_departments', { department_id: department.id });
  const projects = projectLinks.length
    ? (await findMany('projects', { _id: { $in: projectLinks.map((link) => link.project_id) } })).sort(byName)
    : [];
  if (projects.length) {
    return bad(res, 400, `${department.name} is still on ${projects.map((item) => item.name).join(', ')}. Remove it from those projects first.`);
  }
  if (await count('hiring_positions', { department_id: department.id })) {
    return bad(res, 400, `${department.name} still has hiring positions. Close those first.`);
  }
  const links = await findMany('user_departments', { department_id: department.id });
  const userIds = links.map((link) => link.user_id);
  const allLinks = userIds.length ? await findMany('user_departments', { user_id: { $in: userIds } }) : [];
  const counts = new Map();
  for (const link of allLinks) counts.set(link.user_id, (counts.get(link.user_id) || 0) + 1);
  const onlyIds = userIds.filter((userId) => counts.get(userId) === 1);
  const people = await usersByIds(onlyIds);
  const onlyHere = onlyIds.map((userId) => people.get(userId)).filter(Boolean).sort(byName);
  if (onlyHere.length) {
    const names = onlyHere.map((item) => item.name).join(', ');
    const verb = onlyHere.length === 1 ? 'belongs' : 'belong';
    return bad(res, 400, `${names} ${verb} only to ${department.name}. Move them to another department first.`);
  }
  await withTx(async () => {
    await deleteMany('user_departments', { department_id: department.id });
    await deleteOne('departments', { _id: department.id });
    await logActivity(req.auth.id, `${req.auth.name} removed the ${department.name} department.`);
  });
  res.json({ ok: true });
}));

app.get('/api/projects', requireAuth, wrap(async (req, res) => {
  const rows = await findMany('projects', {});
  rows.sort((left, right) => left.start_date.localeCompare(right.start_date) || left.name.localeCompare(right.name));
  res.json({ projects: await presentProjects(rows, req.auth) });
}));

app.post('/api/projects', requireAuth, wrap(async (req, res) => {
  if (!req.auth.isAdmin && !req.auth.isLead && !req.auth.isManager) return bad(res, 403, 'Only an admin, a manager, or a team lead can create a project');
  const name = readText(req.body.name, 120, 'a project name', true);
  if (name.error) return bad(res, 400, name.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  const { startDate, endDate } = req.body;
  if (!isISODate(startDate) || !isISODate(endDate) || endDate < startDate) {
    return bad(res, 400, 'Check the project start and end dates');
  }
  const departmentIds = uniqueList(req.body.departmentIds);
  const memberIds = uniqueList(req.body.memberIds);
  if (!departmentIds.length) return bad(res, 400, 'Choose at least one department');
  if (!memberIds.length) return bad(res, 400, 'Add at least one person');
  const foundDepartments = await findMany('departments', { _id: { $in: departmentIds } });
  if (foundDepartments.length !== departmentIds.length) return bad(res, 400, 'Choose a real department');
  for (const memberId of memberIds) {
    const member = await activeUser(memberId);
    if (!member) return bad(res, 400, 'Add active people only');
    if (!await userInDepartments(memberId, departmentIds)) {
      return bad(res, 400, `${member.name} is not in the selected departments`);
    }
  }
  const projectId = id('prj');
  await withTx(async () => {
    await insertOne('projects', {
      id: projectId,
      name: name.value,
      description: description.value,
      status: 'active',
      start_date: startDate,
      end_date: endDate,
      created_by: req.auth.id,
      created_at: now(),
    });
    for (const departmentId of departmentIds) {
      await insertOne('project_departments', { _id: `${projectId}:${departmentId}`, project_id: projectId, department_id: departmentId });
    }
    for (const memberId of memberIds) {
      await insertOne('project_members', { _id: `${projectId}:${memberId}`, project_id: projectId, user_id: memberId });
    }
    for (const department of foundDepartments) {
      await insertOne('project_timelines', {
        id: id('ptl'),
        project_id: projectId,
        department_id: department.id,
        start_date: null,
        end_date: null,
        status: 'open',
        reason: '',
        set_by: null,
        set_at: null,
        created_at: now(),
      });
    }
    await logActivity(req.auth.id, `${req.auth.name} created the project “${name.value}”.`, null, projectId);
  });
  for (const department of foundDepartments) {
    const message = department.lead_id
      ? `Set the ${department.name} timeline for “${name.value}”. It stays in Requests until you do.`
      : `${department.name} is on “${name.value}” and has no team lead. Set that timeline.`;
    const recipients = department.lead_id
      ? [department.lead_id]
      : (await findMany('users', { role: 'admin', active: 1 })).map((user) => user.id);
    for (const userId of recipients) await notify(userId, message, null, projectId, 'requests');
  }
  const row = await findOne('projects', { _id: projectId });
  res.status(201).json({ project: await presentProject(row, req.auth, true) });
}));

app.get('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const row = await findOne('projects', { _id: req.params.id });
  if (!row) return bad(res, 404, 'Project not found');
  if (!await canViewProject(req.auth, row.id)) return bad(res, 403, NOT_ON_PROJECT);
  res.json({ project: await presentProject(row, req.auth, true) });
}));

app.patch('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const row = await findOne('projects', { _id: req.params.id });
  if (!row) return bad(res, 404, 'Project not found');
  if (!managesProject(req.auth, row)) return bad(res, 403, 'Only an admin or the person who created this project can change it');
  const name = readText(req.body.name, 120, 'a project name', true);
  if (name.error) return bad(res, 400, name.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  const status = req.body.status || row.status;
  if (!new Set(['active', 'paused', 'done']).has(status)) return bad(res, 400, 'Choose a project status');
  await updateOne('projects', { _id: row.id }, { name: name.value, description: description.value, status });
  await logActivity(req.auth.id, `${req.auth.name} updated the project “${name.value}”.`, null, row.id);
  const fresh = await findOne('projects', { _id: row.id });
  res.json({ project: await presentProject(fresh, req.auth, true) });
}));

app.delete('/api/projects/:id', requireAuth, wrap(async (req, res) => {
  const row = await findOne('projects', { _id: req.params.id });
  if (!row) return bad(res, 404, 'Project not found');
  if (!await canDeleteProject(req.auth, row)) return bad(res, 403, 'Only an admin or a team lead on this project can delete it');
  await withTx(async () => {
    await removeProject(row.id);
    await logActivity(req.auth.id, `${req.auth.name} deleted the project “${row.name}” and its tasks.`);
  });
  res.json({ ok: true });
}));

app.patch('/api/projects/:id/timeline', requireAuth, wrap(async (req, res) => {
  const row = await findOne('projects', { _id: req.params.id });
  if (!row) return bad(res, 404, 'Project not found');
  if (!await canViewProject(req.auth, row.id)) return bad(res, 403, NOT_ON_PROJECT);
  const departmentId = String(req.body.departmentId || '');
  if (!await exists('project_departments', { project_id: row.id, department_id: departmentId })) {
    return bad(res, 400, 'That team is not on this project');
  }
  if (!req.auth.isAdmin && !req.auth.leadDepartmentIds.includes(departmentId)) {
    return bad(res, 403, 'The team lead for this department sets its timeline');
  }
  const department = await findOne('departments', { _id: departmentId });
  if (!department) return bad(res, 404, 'Department not found');
  const { startDate, endDate } = req.body;
  if (!isISODate(startDate) || !isISODate(endDate) || endDate < startDate) {
    return bad(res, 400, 'Check the start and end dates');
  }
  const existing = await findOne('project_timelines', { project_id: row.id, department_id: departmentId });
  const first = !existing || existing.status === 'open';
  let reason = String(req.body.reason || '').trim();
  if (!first && !req.auth.isAdmin && reason.length < 8) {
    return bad(res, 400, 'Write a short reason for the date change (at least 8 characters).');
  }
  if (!first && !reason) reason = 'Updated by admin';
  if (reason.length > 500) return bad(res, 400, 'Keep the reason under 500 characters');
  const before = { startDate: existing?.start_date || null, endDate: existing?.end_date || null };
  const after = { startDate, endDate };
  const savedReason = reason || 'Timeline set';
  await withTx(async () => {
    if (existing) {
      await updateOne('project_timelines', { _id: existing.id }, {
        start_date: startDate,
        end_date: endDate,
        status: 'set',
        reason: savedReason,
        set_by: req.auth.id,
        set_at: now(),
      });
    } else {
      await insertOne('project_timelines', {
        id: id('ptl'),
        project_id: row.id,
        department_id: departmentId,
        start_date: startDate,
        end_date: endDate,
        status: 'set',
        reason: savedReason,
        set_by: req.auth.id,
        set_at: now(),
        created_at: now(),
      });
    }
    await insertOne('timeline_changes', {
      id: id('tlc'),
      project_id: row.id,
      department_id: departmentId,
      department_name: department.name,
      actor_id: req.auth.id,
      actor_name: null,
      reason: savedReason,
      before_json: JSON.stringify(before),
      after_json: JSON.stringify(after),
      created_at: now(),
    });
    await logActivity(req.auth.id, `${req.auth.name} set the ${department.name} timeline for ${row.name}.`, null, row.id);
  });
  await notifyProject(row.id, req.auth, `${req.auth.name} set the ${department.name} timeline for ${row.name} (${startDate} to ${endDate}).`);
  const fresh = await findOne('projects', { _id: row.id });
  res.json({ project: await presentProject(fresh, req.auth, true) });
}));

app.post('/api/projects/:id/members', requireAuth, wrap(async (req, res) => {
  const row = await findOne('projects', { _id: req.params.id });
  if (!row) return bad(res, 404, 'Project not found');
  if (!await canAssignOnProject(req.auth, row)) return bad(res, 403, 'A team lead on this project can add people');
  const member = await activeUser(req.body.userId);
  if (!member) return bad(res, 400, 'Choose an active person');
  if (await isProjectMember(row.id, member.id)) return bad(res, 400, 'They are already on this project');
  const departmentIds = await projectDepartmentIds(row.id);
  if (!req.auth.isAdmin && !req.auth.isManager && !await userInDepartments(member.id, departmentIds)) {
    return bad(res, 400, `${member.name} is not in this project’s departments`);
  }
  await insertOne('project_members', { _id: `${row.id}:${member.id}`, project_id: row.id, user_id: member.id });
  await logActivity(req.auth.id, `${req.auth.name} added ${member.name} to ${row.name}.`, null, row.id);
  await notify(member.id, `${req.auth.name} added you to ${row.name}.`, null, row.id);
  res.json({ project: await presentProject(await findOne('projects', { _id: row.id }), req.auth, true) });
}));

app.delete('/api/projects/:id/members/:userId', requireAuth, wrap(async (req, res) => {
  const row = await findOne('projects', { _id: req.params.id });
  if (!row) return bad(res, 404, 'Project not found');
  if (!await canAssignOnProject(req.auth, row)) return bad(res, 403, 'A team lead on this project can remove people');
  const open = await count('tasks', { project_id: row.id, assignee_id: req.params.userId, status: { $ne: 'done' } });
  if (open) return bad(res, 400, 'They still have open work on this project');
  await deleteOne('project_members', { project_id: row.id, user_id: req.params.userId });
  await logActivity(req.auth.id, `${req.auth.name} removed a person from ${row.name}.`, null, row.id);
  res.json({ project: await presentProject(await findOne('projects', { _id: row.id }), req.auth, true) });
}));

function matchesWeek(task, weekStart, weekEnd, isCurrent) {
  if (task.due_date >= weekStart && task.due_date <= weekEnd) return true;
  const completed = String(task.completed_at || '').slice(0, 10);
  if (task.status === 'done' && completed.length === 10 && completed >= weekStart && completed <= weekEnd) return true;
  if (isCurrent && task.due_date > weekEnd && task.status !== 'done' && task.parent_task_id) return true;
  if (task.due_date && task.due_date < weekStart && ['upcoming', 'in_progress', 'review'].includes(task.status)) return true;
  return false;
}

function byDue(left, right) {
  return left.due_date.localeCompare(right.due_date) || left.title.localeCompare(right.title);
}

async function withChangeRequests(tasks) {
  if (!tasks.length) return tasks;
  const rows = await findMany('task_requests', {
    task_id: { $in: tasks.map((task) => task.id) },
    status: 'open',
    kind: { $in: ['edit', 'remove'] },
  });
  const byTask = groupBy(rows, 'task_id');
  return tasks.map((task) => ({
    ...task,
    changeRequests: [...new Set((byTask.get(task.id) || []).map((row) => row.kind))],
  }));
}

app.get('/api/tasks', requireAuth, wrap(async (req, res) => {
  const scope = ['team', 'project', 'person'].includes(req.query.scope) ? req.query.scope : 'mine';
  let weekStart = null;
  let weekEnd = null;
  let isCurrent = false;
  let filter = {};

  if (scope === 'project') {
    const projectId = req.query.projectId;
    if (!projectId) return bad(res, 400, 'Choose a project');
    if (!await canViewProject(req.auth, projectId)) return bad(res, 403, NOT_ON_PROJECT);
    filter = { project_id: projectId };
    weekEnd = '9999-99-99';
  } else {
    const requested = isISODate(req.query.week) ? req.query.week : isoDate(new Date());
    const monday = startOfWeek(requested);
    weekStart = isoDate(monday);
    weekEnd = isoDate(addDays(monday, 6));
    isCurrent = weekStart === isoDate(startOfWeek(new Date()));
    await ensureRecurring(weekStart, weekEnd);
    if (scope === 'mine' || scope === 'person') {
      const assigneeId = scope === 'person' ? req.query.userId : req.auth.id;
      if (scope === 'person') {
        if (!await exists('users', { _id: assigneeId })) return bad(res, 404, 'Person not found');
        if (assigneeId !== req.auth.id && !seesConfidential(req.auth) && await isPrivateAssignee(assigneeId)) {
          return bad(res, 403, 'That board is private');
        }
        if (assigneeId !== req.auth.id && !req.auth.isAdmin && !req.auth.isManager && !await assigneeInLeadDepts(req.auth, assigneeId)) {
          return bad(res, 403, 'You can open boards for people on a team you lead');
        }
      }
      filter = { assignee_id: assigneeId };
    } else {
      const departmentId = req.query.departmentId;
      if (!departmentId) return bad(res, 400, 'Choose a department');
      if (!await exists('departments', { _id: departmentId })) return bad(res, 404, 'Department not found');
      if (!req.auth.isAdmin && !req.auth.isManager && !req.auth.departmentIds.includes(departmentId)) {
        return bad(res, 403, 'You are not in that department');
      }
      const members = await findMany('user_departments', { department_id: departmentId });
      let assigneeIds = members.map((member) => member.user_id);
      const seesWholeTeam = req.auth.isAdmin || req.auth.isManager || req.auth.leadDepartmentIds.includes(departmentId);
      if (!seesWholeTeam) assigneeIds = assigneeIds.filter((userId) => userId === req.auth.id);
      filter = { assignee_id: { $in: assigneeIds } };
    }
    const candidates = await findMany('tasks', filter);
    let rows = candidates.filter((task) => matchesWeek(task, weekStart, weekEnd, isCurrent));
    if (isCurrent) {
      // Every later To do card stays on this week's To do column. Inclusion does not
      // depend on other cards, so moving one task cannot hide someone else's.
      const seen = new Set(rows.map((row) => row.id));
      const extra = candidates
        .filter((task) => !seen.has(task.id) && task.status === 'upcoming' && task.due_date > weekEnd)
        .map((task) => ({ ...task, from_next: 1 }));
      rows = rows.concat(extra);
    }
    rows.sort(byDue);
    rows = await omitPrivateTasks(req.auth, rows);
    const hydrated = await hydrateTasks(rows);
    return res.json({
      tasks: await withChangeRequests(hydrated.map((row) => mapTask(row, weekEnd, weekStart))),
      weekStart,
      weekEnd,
      isCurrent,
    });
  }

  const rows = await omitPrivateTasks(req.auth, (await findMany('tasks', filter)).sort(byDue));
  const hydrated = await hydrateTasks(rows);
  res.json({
    tasks: await withChangeRequests(hydrated.map((row) => mapTask(row, weekEnd, null))),
    weekStart,
    weekEnd: null,
    isCurrent,
  });
}));

async function createTeamTasks(req, res, { title, description, priority, projectId, departmentIds }) {
  if (departmentIds.some((departmentId) => !req.auth.leadDepartmentIds.includes(departmentId))) {
    return bad(res, 403, 'You can assign a whole team only for a department you lead');
  }
  const departments = await findMany('departments', { _id: { $in: departmentIds } });
  if (departments.length !== departmentIds.length) return bad(res, 400, 'Choose a team you lead');
  const project = projectId ? await findOne('projects', { _id: projectId }) : null;
  if (projectId) {
    if (!project) return bad(res, 404, 'Project not found');
    if (project.status === 'done') return bad(res, 400, 'This project is marked done');
    if (!await canAssignOnProject(req.auth, project)) return bad(res, 403, 'You can’t assign this project to the whole team');
  }
  const links = await findMany('user_departments', { department_id: { $in: departmentIds } });
  const ids = [...new Set([
    ...links.map((link) => link.user_id),
    ...departments.map((department) => department.lead_id).filter(Boolean),
  ])];
  const users = ids.length ? await findMany('users', { _id: { $in: ids }, active: 1 }) : [];
  const assignees = users.filter((user) => user.id === req.auth.id || !user.manager);
  if (!assignees.length) return bad(res, 400, 'That team has no one to assign');
  const created = [];
  for (const assignee of assignees) {
    const taskId = await withTx(async () => {
      const createdId = await insertTaskRow({
        title: title.value,
        description: description.value,
        projectId,
        creatorId: req.auth.id,
        assigneeId: assignee.id,
        status: 'upcoming',
        priority,
        dueDate: req.body.dueDate,
        kind: projectId ? 'project' : 'personal',
      });
      if (projectId && !await isProjectMember(projectId, assignee.id)) {
        await insertIgnore('project_members', {
          _id: `${projectId}:${assignee.id}`,
          project_id: projectId,
          user_id: assignee.id,
        });
      }
      if (assignee.id !== req.auth.id) {
        await notify(assignee.id, `${req.auth.name} assigned “${title.value}” to you.`, createdId, projectId, 'board');
      }
      return createdId;
    });
    created.push({ assignee, taskId });
  }
  const names = departments.map((department) => department.name).sort((left, right) => left.localeCompare(right)).join(', ');
  await logActivity(req.auth.id, `${req.auth.name} assigned “${title.value}” to everyone in ${names}.`, created[0]?.taskId || null, projectId);
  for (const item of created) {
    if (item.assignee.id === req.auth.id) continue;
    await sendAssignmentEmail(item.assignee, req.auth, {
      title: title.value,
      description: description.value,
      dueDate: req.body.dueDate,
    });
  }
  return res.status(201).json({ count: created.length });
}

async function createTasksForPeople(req, res, { title, description, priority, projectId, assigneeIds }) {
  const allowed = req.auth.isAdmin || req.auth.isManager || req.auth.isLead;
  if (!allowed) return bad(res, 403, 'You can add this task for yourself');
  const project = projectId ? await findOne('projects', { _id: projectId }) : null;
  if (projectId) {
    if (!project) return bad(res, 404, 'Project not found');
    if (project.status === 'done') return bad(res, 400, 'This project is marked done');
    const onProject = await isProjectMember(projectId, req.auth.id) || await canAssignOnProject(req.auth, project);
    if (!onProject) return bad(res, 403, 'Only people on the project can add their part');
  } else if (!req.auth.isAdmin && !req.auth.isLead && !req.auth.isManager) {
    return bad(res, 403, 'You can add this task for yourself');
  }
  const assignees = [];
  for (const assigneeId of assigneeIds) {
    const assignee = await activeUser(assigneeId);
    if (!assignee) return bad(res, 400, 'Choose an active person');
    if (assignee.manager && assignee.id !== req.auth.id && !req.auth.isAdmin && !req.auth.isManager) {
      return bad(res, 403, 'That board is private');
    }
    if (projectId && !await isProjectMember(projectId, assignee.id) && !req.auth.isAdmin && !req.auth.isManager) {
      return bad(res, 400, 'Add them to the project before assigning this task');
    }
    assignees.push(assignee);
  }
  const created = [];
  for (const assignee of assignees) {
    const taskId = await withTx(async () => {
      const createdId = await insertTaskRow({
        title: title.value,
        description: description.value,
        projectId,
        creatorId: req.auth.id,
        assigneeId: assignee.id,
        status: 'upcoming',
        priority,
        dueDate: req.body.dueDate,
        kind: projectId ? 'project' : 'personal',
      });
      if (projectId && !await isProjectMember(projectId, assignee.id)) {
        await insertIgnore('project_members', {
          _id: `${projectId}:${assignee.id}`,
          project_id: projectId,
          user_id: assignee.id,
        });
      }
      if (assignee.id !== req.auth.id) {
        await notify(assignee.id, `${req.auth.name} assigned “${title.value}” to you.`, createdId, projectId, 'board');
      }
      return createdId;
    });
    created.push({ assignee, taskId });
  }
  const names = assignees.map((person) => person.name).sort((left, right) => left.localeCompare(right)).join(', ');
  await logActivity(req.auth.id, `${req.auth.name} assigned “${title.value}” to ${names}.`, created[0]?.taskId || null, projectId);
  for (const item of created) {
    if (item.assignee.id === req.auth.id) continue;
    await sendAssignmentEmail(item.assignee, req.auth, {
      title: title.value,
      description: description.value,
      dueDate: req.body.dueDate,
    });
  }
  return res.status(201).json({ count: created.length });
}

app.post('/api/tasks', requireAuth, wrap(async (req, res) => {
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  if (!isISODate(req.body.dueDate)) return bad(res, 400, 'Choose a due date');
  const priority = PRIORITIES.has(req.body.priority) ? req.body.priority : 'medium';
  const projectId = req.body.projectId || null;
  const departmentIds = uniqueList(req.body.departmentIds);
  if (departmentIds.length) {
    return createTeamTasks(req, res, { title, description, priority, projectId, departmentIds });
  }
  const assigneeIds = uniqueList(req.body.assigneeIds);
  if (assigneeIds.length > 1) {
    return createTasksForPeople(req, res, { title, description, priority, projectId, assigneeIds });
  }
  const assigneeId = assigneeIds[0] || req.body.assigneeId || req.auth.id;
  const project = projectId ? await findOne('projects', { _id: projectId }) : null;
  const assigningSomeoneElse = assigneeId !== req.auth.id;
  if (assigningSomeoneElse) {
    const allowed = project ? await canAssignOnProject(req.auth, project) : (req.auth.isAdmin || req.auth.isLead || req.auth.isManager);
    if (!allowed) return bad(res, 403, 'You can add this task for yourself');
  }
  const assignee = await activeUser(assigneeId);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  if (projectId) {
    if (!project) return bad(res, 404, 'Project not found');
    if (project.status === 'done') return bad(res, 400, 'This project is marked done');
    const onProject = await isProjectMember(projectId, req.auth.id) || await canAssignOnProject(req.auth, project);
    if (!onProject) return bad(res, 403, 'Only people on the project can add their part');
    if (!await isProjectMember(projectId, assigneeId) && !req.auth.isAdmin && !req.auth.isManager) {
      return bad(res, 400, 'Add them to the project before assigning this task');
    }
  }
  try {
    const taskId = await withTx(async () => {
      const createdId = await insertTaskRow({
        title: title.value,
        description: description.value,
        projectId,
        creatorId: req.auth.id,
        assigneeId,
        status: 'upcoming',
        priority,
        dueDate: req.body.dueDate,
        kind: projectId ? 'project' : 'personal',
      });
      if (projectId && !await isProjectMember(projectId, assigneeId)) {
        await insertIgnore('project_members', { _id: `${projectId}:${assigneeId}`, project_id: projectId, user_id: assigneeId });
      }
      if (assigneeId !== req.auth.id) {
        await notify(assigneeId, `${req.auth.name} assigned “${title.value}” to you.`, createdId, projectId);
      }
      await logActivity(req.auth.id, `${req.auth.name} added “${title.value}”.`, createdId, projectId);
      if (req.body.handoff) await createHandoff(createdId, req.auth, req.body.handoff);
      return createdId;
    });
    if (assigneeId !== req.auth.id) {
      await sendAssignmentEmail(assignee, req.auth, {
        title: title.value,
        description: description.value,
        dueDate: req.body.dueDate,
      });
    }
    if (req.body.handoff?.assigneeId && req.body.handoff.assigneeId !== req.auth.id) {
      const next = await activeUser(req.body.handoff.assigneeId);
      if (next) {
        await sendAssignmentEmail(next, req.auth, {
          title: req.body.handoff.title,
          description: req.body.handoff.description || '',
          dueDate: req.body.handoff.dueDate,
        });
      }
    }
    res.status(201).json({ task: mapTask(await loadTask(taskId), '9999-99-99') });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
}));

app.get('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  const task = await loadTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!await canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  const commentRows = (await findMany('comments', { task_id: task.id })).sort((left, right) => left.created_at.localeCompare(right.created_at));
  const requestRows = (await findMany('task_requests', { task_id: task.id, status: 'open' })).sort((left, right) => left.created_at.localeCompare(right.created_at));
  const followupRows = (await findMany('tasks', { parent_task_id: task.id })).sort(byDue);
  const users = await usersByIds([
    ...commentRows.map((comment) => comment.author_id),
    ...requestRows.map((request) => request.requester_id),
    ...followupRows.map((item) => item.assignee_id),
  ]);
  const comments = commentRows.map((comment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: comment.created_at,
    authorId: comment.author_id,
    authorName: String(comment.author_name || '').trim() || users.get(comment.author_id)?.name || '',
  }));
  const requests = requestRows.map((request) => ({
    id: request.id,
    kind: request.kind,
    note: request.note,
    status: request.status,
    createdAt: request.created_at,
    requesterId: request.requester_id,
    requesterName: users.get(request.requester_id)?.name || '',
  }));
  const followups = followupRows.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    dueDate: item.due_date,
    assigneeId: item.assignee_id,
    assigneeName: users.get(item.assignee_id)?.name || '',
  }));
  res.json({ task: mapTask(task, '9999-99-99'), comments, chain: await taskChain(task.id), requests, followups });
}));

app.post('/api/tasks/:id/comments', requireAuth, wrap(async (req, res) => {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!await canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  const body = readText(req.body.body, 2000, 'a comment', true);
  if (body.error) return bad(res, 400, body.error);
  await insertOne('comments', {
    id: id('cmt'),
    task_id: task.id,
    author_id: req.auth.id,
    author_name: null,
    body: body.value,
    created_at: now(),
  });
  await logActivity(req.auth.id, `${req.auth.name} commented on “${task.title}”.`, task.id, task.project_id);
  for (const userId of new Set([task.assignee_id, task.creator_id])) {
    if (userId !== req.auth.id) await notify(userId, `${req.auth.name} commented on “${task.title}”.`, task.id, task.project_id);
  }
  res.status(201).json({ ok: true });
}));

app.get('/api/trends', requireAuth, wrap(async (req, res) => {
  const userId = req.query.userId || req.auth.id;
  if (!await exists('users', { _id: userId, active: 1 })) return bad(res, 404, 'Person not found');
  if (userId !== req.auth.id && !seesConfidential(req.auth) && await isPrivateAssignee(userId)) {
    return bad(res, 403, 'That board is private');
  }
  if (userId !== req.auth.id && !req.auth.isAdmin && !req.auth.isManager && !await assigneeInLeadDepts(req.auth, userId)) {
    return bad(res, 403, 'You can see trends for people on a team you lead');
  }
  const current = startOfWeek(new Date());
  const weekly = [];
  for (let i = 7; i >= 0; i -= 1) {
    const monday = addDays(current, -7 * i);
    weekly.push({ start: isoDate(monday), end: isoDate(addDays(monday, 6)), completed: 0 });
  }
  const today = new Date();
  const monthly = [];
  for (let i = 5; i >= 0; i -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
    monthly.push({
      month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      completed: 0,
    });
  }
  const rows = await findMany('tasks', { assignee_id: userId, status: 'done', completed_at: { $ne: null } });
  for (const row of rows) {
    const stamped = new Date(row.completed_at);
    if (Number.isNaN(stamped.getTime())) continue;
    const day = isoDate(stamped);
    const week = weekly.find((item) => day >= item.start && day <= item.end);
    if (week) week.completed += 1;
    const monthKey = `${stamped.getFullYear()}-${String(stamped.getMonth() + 1).padStart(2, '0')}`;
    const month = monthly.find((item) => item.month === monthKey);
    if (month) month.completed += 1;
  }
  res.json({
    weekly: weekly.map(({ start, completed }) => ({ start, completed })),
    monthly,
  });
}));

app.post('/api/tasks/:id/followup', requireAuth, wrap(async (req, res) => {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!await canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  if (!await canGovernTask(req.auth, task)) return bad(res, 403, 'Only a team lead can assign a follow-up');
  if (task.status !== 'review') return bad(res, 400, 'Assign a follow-up from a task that is in Review');
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  if (!isISODate(req.body.dueDate)) return bad(res, 400, 'Choose a due date');
  const assignee = await activeUser(req.body.assigneeId || task.assignee_id);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  if (task.project_id && !await isProjectMember(task.project_id, assignee.id)) {
    return bad(res, 400, 'Add them to the project before assigning this follow-up');
  }
  try {
    const childId = await withTx(async () => {
      const createdId = await insertTaskRow({
        title: title.value,
        description: description.value,
        projectId: task.project_id,
        creatorId: req.auth.id,
        assigneeId: assignee.id,
        status: 'upcoming',
        priority: task.priority,
        dueDate: req.body.dueDate,
        kind: task.project_id ? 'project' : 'personal',
        parentTaskId: task.id,
      });
      if (!task.handoff_task_id) {
        await updateOne('tasks', { _id: task.id }, { handoff_task_id: createdId, updated_at: now() });
      }
      if (assignee.id !== req.auth.id) {
        await notify(assignee.id, `${req.auth.name} added “${title.value}” to your To do, following “${task.title}”.`, createdId, task.project_id);
      }
      await logActivity(req.auth.id, `${req.auth.name} assigned follow-up “${title.value}” to ${assignee.name}.`, createdId, task.project_id);
      return createdId;
    });
    await sendAssignmentEmail(assignee, req.auth, {
      title: title.value,
      description: description.value,
      dueDate: req.body.dueDate,
    });
    res.status(201).json({ task: mapTask(await loadTask(childId), '9999-99-99') });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
}));

app.post('/api/tasks/:id/handoff', requireAuth, wrap(async (req, res) => {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!await canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  if (!req.auth.isAdmin && req.auth.id !== task.assignee_id) {
    return bad(res, 403, 'Only the person doing this task can name who takes it next');
  }
  try {
    const childId = await withTx(() => createHandoff(task.id, req.auth, req.body));
    if (req.body.assigneeId && req.body.assigneeId !== req.auth.id) {
      const next = await activeUser(req.body.assigneeId);
      if (next) {
        await sendAssignmentEmail(next, req.auth, {
          title: req.body.title,
          description: req.body.description || '',
          dueDate: req.body.dueDate,
        });
      }
    }
    res.status(201).json({ task: mapTask(await loadTask(childId), '9999-99-99') });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
}));

app.patch('/api/tasks/:id/status', requireAuth, wrap(async (req, res) => {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!STATUSES.has(req.body.status)) return bad(res, 400, 'Choose a status');
  if (!await canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  const next = req.body.status;
  if (next !== task.status) {
    const governs = await canGovernTask(req.auth, task);
    const ownStep = req.auth.id === task.assignee_id && (
      (task.status === 'upcoming' && next === 'in_progress')
      || (task.status === 'in_progress' && (next === 'upcoming' || next === 'review'))
    );
    if (!governs && !ownStep) {
      if (next === 'done') return bad(res, 403, 'Your team lead marks this done after review');
      return bad(res, 403, 'Move this between To do and In progress, then send it to Review for your team lead');
    }
    if (next === 'done') {
      const waiting = await openDependencyBlock(task.id);
      if (waiting) return bad(res, 400, waiting);
    }
    await writeStatus(task.id, next, task.completed_at);
    await noteStatus(task, next, req.auth);
  }
  res.json({ task: mapTask(await loadTask(task.id), '9999-99-99') });
}));

app.patch('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!await canGovernTask(req.auth, task)) return bad(res, 403, 'Only an admin or the team lead can edit this task');
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  if (!isISODate(req.body.dueDate)) return bad(res, 400, 'Choose a due date');
  if (!PRIORITIES.has(req.body.priority)) return bad(res, 400, 'Choose a priority');
  if (!STATUSES.has(req.body.status)) return bad(res, 400, 'Choose a status');
  const assignee = await activeUser(req.body.assigneeId);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  if (task.project_id && !await isProjectMember(task.project_id, assignee.id)) {
    return bad(res, 400, 'The assignee needs to be on this project');
  }
  if (req.body.status === 'done' && task.status !== 'done') {
    const waiting = await openDependencyBlock(task.id);
    if (waiting) return bad(res, 400, waiting);
  }
  const completedAt = req.body.status === 'done' ? (task.status === 'done' && task.completed_at ? task.completed_at : now()) : null;
  await updateOne('tasks', { _id: task.id }, {
    title: title.value,
    description: description.value,
    assignee_id: assignee.id,
    due_date: req.body.dueDate,
    priority: req.body.priority,
    stage_id: null,
    status: req.body.status,
    completed_at: completedAt,
    updated_at: now(),
  });
  if (assignee.id !== task.assignee_id) {
    await notify(assignee.id, `${req.auth.name} assigned “${title.value}” to you.`, task.id, task.project_id);
    await sendAssignmentEmail(assignee, req.auth, {
      title: title.value,
      description: description.value,
      dueDate: req.body.dueDate,
    });
  }
  await logActivity(req.auth.id, `${req.auth.name} edited “${title.value}”.`, task.id, task.project_id);
  if (req.body.status !== task.status) await noteStatus({ ...task, title: title.value }, req.body.status, req.auth);
  res.json({ task: mapTask(await loadTask(task.id), '9999-99-99') });
}));

async function raiseChange(req, res, kind) {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (req.auth.id !== task.assignee_id) return bad(res, 403, 'Ask from the person this task is assigned to');
  if (await canGovernTask(req.auth, task)) {
    return bad(res, 400, kind === 'edit' ? 'You can edit this task directly' : 'You can delete this task directly');
  }
  const note = readText(req.body.note, 500, 'a note for your team lead', true);
  if (note.error) return bad(res, 400, note.error);
  if (note.value.length < 8) return bad(res, 400, 'Write a short note for your team lead (at least 8 characters)');
  if (await exists('task_requests', { task_id: task.id, kind, status: 'open' })) {
    return bad(res, 400, kind === 'edit'
      ? 'You already asked your team lead for edits'
      : 'You already asked your team lead to delete this');
  }
  await openRequest(task, kind, req.auth, note.value);
  const asked = kind === 'edit' ? `asked for edits on “${task.title}”` : `asked to delete “${task.title}”`;
  for (const userId of await requestRecipients(task)) {
    await notify(userId, `${req.auth.name} ${asked}. ${note.value}`, task.id, task.project_id, 'requests');
  }
  await logActivity(req.auth.id, `${req.auth.name} ${asked}.`, task.id, task.project_id);
  return res.status(201).json({ ok: true });
}

app.post('/api/tasks/:id/change', requireAuth, wrap(async (req, res) => {
  const kind = req.body.kind === 'edit' || req.body.kind === 'remove' ? req.body.kind : '';
  if (!kind) return bad(res, 400, 'Say whether this is an edit or a deletion');
  return raiseChange(req, res, kind);
}));

app.post('/api/tasks/:id/removal', requireAuth, wrap(async (req, res) => raiseChange(req, res, 'remove')));

app.delete('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  const task = await rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!await canGovernTask(req.auth, task)) return bad(res, 403, 'Ask your team lead to remove this, and include a note');
  await deleteTask(task.id);
  await logActivity(req.auth.id, `${req.auth.name} deleted “${task.title}”.`, null, task.project_id);
  res.json({ ok: true });
}));

async function visibleTaskRequests(auth) {
  const stored = (await findMany('task_requests', {})).sort((left, right) => right.created_at.localeCompare(left.created_at));
  if (!stored.length) return [];
  const taskIds = [...new Set(stored.map((request) => request.task_id).filter(Boolean))];
  const tasks = taskIds.length ? await findMany('tasks', { _id: { $in: taskIds } }) : [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const users = await usersByIds([
    ...stored.map((request) => request.requester_id),
    ...stored.map((request) => request.assignee_id),
    ...tasks.map((task) => task.assignee_id),
  ]);
  const requests = [];
  for (const request of stored) {
    const task = taskMap.get(request.task_id) || null;
    const row = {
      assignee_id: task?.assignee_id || request.assignee_id,
      creator_id: task?.creator_id || request.creator_id,
    };
    const mine = request.requester_id === auth.id;
    const handle = await canHandleRequest(auth, row);
    if (!mine && !handle) continue;
    requests.push({
      id: request.id,
      kind: request.kind,
      note: request.note || '',
      responseNote: request.response_note || '',
      status: request.status || 'open',
      createdAt: request.created_at,
      resolvedAt: request.resolved_at || null,
      requesterId: request.requester_id,
      requesterName: users.get(request.requester_id)?.name || '',
      taskId: request.task_id,
      taskTitle: task?.title || request.task_title || 'Task',
      taskStatus: task?.status || null,
      assigneeName: users.get(row.assignee_id)?.name || '',
      taskMissing: !task,
      canAnswer: request.status === 'open' && handle && !mine && Boolean(task),
    });
  }
  return requests;
}

async function visibleTimelineRequests(auth) {
  if (!auth.isAdmin && !auth.isManager && !auth.leadDepartmentIds.length) return [];
  const stored = await findMany('project_timelines', auth.isAdmin || auth.isManager ? {} : { department_id: { $in: auth.leadDepartmentIds } });
  if (!stored.length) return [];
  const projects = await findMany('projects', { _id: { $in: [...new Set(stored.map((row) => row.project_id))] } });
  const departments = await findMany('departments', { _id: { $in: [...new Set(stored.map((row) => row.department_id))] } });
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const departmentMap = new Map(departments.map((department) => [department.id, department]));
  return stored.flatMap((row) => {
    const project = projectMap.get(row.project_id);
    const department = departmentMap.get(row.department_id);
    if (!project || !department) return [];
    const open = row.status === 'open';
    return [{
      id: row.id,
      kind: 'timeline',
      note: open ? '' : (row.reason || ''),
      responseNote: '',
      status: open ? 'open' : 'set',
      createdAt: row.created_at,
      resolvedAt: row.set_at || null,
      projectId: project.id,
      projectName: project.name,
      departmentId: department.id,
      departmentName: department.name,
      startDate: row.start_date,
      endDate: row.end_date,
      canAnswer: open && (auth.isAdmin || auth.leadDepartmentIds.includes(department.id)),
    }];
  });
}

app.get('/api/requests', requireAuth, wrap(async (req, res) => {
  const [tasks, timelines] = await Promise.all([
    visibleTaskRequests(req.auth),
    visibleTimelineRequests(req.auth),
  ]);
  const requests = [...tasks, ...timelines].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  res.json({ requests });
}));

app.post('/api/requests/:id/decline', requireAuth, wrap(async (req, res) => {
  const request = await findOne('task_requests', { _id: req.params.id });
  const task = request ? await findOne('tasks', { _id: request.task_id }) : null;
  if (!request || !task || request.status !== 'open') return bad(res, 404, 'Request not found');
  const row = { ...request, assignee_id: task.assignee_id, creator_id: task.creator_id, title: task.title, project_id: task.project_id };
  if (!await canHandleRequest(req.auth, row)) return bad(res, 403, 'Only the team lead can answer this');
  const note = readText(req.body.note, 500, 'a note');
  if (note.error) return bad(res, 400, note.error);
  await updateOne('task_requests', { _id: row.id }, { status: 'declined', response_note: note.value, resolved_at: now() });
  const sentBack = request.kind === 'review' && task.status === 'review';
  if (sentBack) await writeStatus(task.id, 'upcoming', task.completed_at);
  const label = requestVerb(row.kind);
  const base = note.value
    ? `${req.auth.name} declined the request to ${label} “${row.title}”. Note: ${note.value}`
    : `${req.auth.name} declined the request to ${label} “${row.title}”.`;
  const message = sentBack ? `${base} It’s back on your To do.` : base;
  await notify(row.requester_id, message, row.task_id, row.project_id, sentBack ? 'board' : 'requests');
  await logActivity(req.auth.id, message, row.task_id, row.project_id);
  res.json({ ok: true });
}));

app.post('/api/requests/:id/accept', requireAuth, wrap(async (req, res) => {
  const request = await findOne('task_requests', { _id: req.params.id });
  const task = request ? await findOne('tasks', { _id: request.task_id }) : null;
  if (!request || request.status !== 'open') return bad(res, 404, 'Request not found');
  if (request.kind !== 'edit') return bad(res, 400, 'Open the task to finish this request');
  if (!task) return bad(res, 404, 'That task is already gone');
  const row = { ...request, assignee_id: task.assignee_id, creator_id: task.creator_id };
  if (!await canHandleRequest(req.auth, row)) return bad(res, 403, 'Only the team lead can answer this');
  const note = readText(req.body.note, 500, 'a note');
  if (note.error) return bad(res, 400, note.error);
  await updateOne('task_requests', { _id: request.id }, {
    status: 'accepted',
    response_note: note.value || 'Edits done.',
    resolved_at: now(),
  });
  const message = note.value
    ? `${req.auth.name} accepted the edit request on “${task.title}”. Note: ${note.value}`
    : `${req.auth.name} accepted the edit request on “${task.title}”.`;
  await notify(request.requester_id, message, task.id, task.project_id, 'requests');
  await logActivity(req.auth.id, message, task.id, task.project_id);
  res.json({ ok: true });
}));

async function departureCard(request) {
  const links = await findMany('user_departments', { user_id: request.user_id });
  const departmentIds = links.map((link) => link.department_id);
  const departments = departmentIds.length
    ? await findMany('departments', { _id: { $in: departmentIds }, lead_id: request.lead_id })
    : [];
  const names = departments.map((department) => department.name).sort((left, right) => left.localeCompare(right));
  const items = await findMany('departure_items', { request_id: request.id, done: 0 });
  const tasks = items.some((item) => item.task_id)
    ? await findMany('tasks', { _id: { $in: items.map((item) => item.task_id).filter(Boolean) } })
    : [];
  const rules = items.some((item) => item.rule_id)
    ? await findMany('recurring_rules', { _id: { $in: items.map((item) => item.rule_id).filter(Boolean) } })
    : [];
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const ruleMap = new Map(rules.map((rule) => [rule.id, rule]));
  const projectIds = [...new Set([...tasks, ...rules].map((item) => item.project_id).filter(Boolean))];
  const projects = projectIds.length ? await findMany('projects', { _id: { $in: projectIds } }) : [];
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const rows = items.map((item) => {
    const task = item.task_id ? taskMap.get(item.task_id) : null;
    const rule = item.rule_id ? ruleMap.get(item.rule_id) : null;
    return {
      ...item,
      task_title: task?.title || null,
      task_status: task?.status || null,
      task_project: task?.project_id ? (projectMap.get(task.project_id)?.name || null) : null,
      rule_title: rule?.title || null,
      rule_project: rule?.project_id ? (projectMap.get(rule.project_id)?.name || null) : null,
      label: task?.title || rule?.title || '',
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
  const taskCards = [];
  const ruleCards = [];
  for (const item of rows) {
    const people = await teammates(String(item.department_ids || '').split(',').filter(Boolean), request.user_id);
    if (item.task_id) {
      taskCards.push({ id: item.task_id, title: item.task_title, status: item.task_status, projectName: item.task_project, people });
    }
    if (item.rule_id) {
      ruleCards.push({ id: item.rule_id, title: item.rule_title, projectName: item.rule_project, people });
    }
  }
  return {
    id: request.id,
    userId: request.user_id,
    userName: request.user_name,
    departments: names,
    tasks: taskCards,
    rules: ruleCards,
  };
}

app.get('/api/departures', requireAuth, wrap(async (req, res) => {
  const rows = (await findMany('departure_requests', { lead_id: req.auth.id, status: 'open' }))
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  const users = await usersByIds(rows.map((row) => row.user_id));
  const departures = [];
  for (const row of rows) {
    const user = users.get(row.user_id);
    if (!user) continue;
    departures.push(await departureCard({ ...row, user_name: user.name }));
  }
  res.json({ departures });
}));

app.post('/api/departures/:id/move', requireAuth, wrap(async (req, res) => {
  const request = await findOne('departure_requests', { _id: req.params.id });
  const person = request ? await findOne('users', { _id: request.user_id }) : null;
  if (!request || !person || request.status !== 'open') return bad(res, 404, 'Request not found');
  if (request.lead_id !== req.auth.id) return bad(res, 403, 'Only that team lead can move these tasks');
  const chosenTasks = Array.isArray(req.body.tasks) ? req.body.tasks : [];
  const chosenRules = Array.isArray(req.body.rules) ? req.body.rules : [];
  try {
    const result = await withTx(async () => {
      const items = await findMany('departure_items', { request_id: request.id, done: 0 });
      for (const item of items) {
        if (item.task_id) {
          const chosen = chosenTasks.find((entry) => entry.id === item.task_id);
          if (!chosen) throw httpError(400, 'Choose someone on your team for each task');
          const assignee = await assertTeammate(chosen.assigneeId, item.department_ids, person.id);
          const task = await findOne('tasks', { _id: item.task_id });
          if (task) await moveDepartureTask(task, assignee, person, req.auth);
        }
        if (item.rule_id) {
          const chosen = chosenRules.find((entry) => entry.id === item.rule_id);
          if (!chosen) throw httpError(400, 'Choose someone on your team for each repeating task');
          const assignee = await assertTeammate(chosen.assigneeId, item.department_ids, person.id);
          const rule = await findOne('recurring_rules', { _id: item.rule_id });
          if (rule) {
            const changed = rule.assignee_id !== assignee.id;
            await updateOne('recurring_rules', { _id: rule.id }, { assignee_id: assignee.id });
            await updateMany('tasks', { recurring_rule_id: rule.id, status: { $ne: 'done' } }, { assignee_id: assignee.id, updated_at: now() });
            if (rule.project_id) {
              await insertIgnore('project_members', {
                _id: `${rule.project_id}:${assignee.id}`,
                project_id: rule.project_id,
                user_id: assignee.id,
              });
            }
            if (changed) {
              await notify(assignee.id, `${req.auth.name} set the repeating task “${rule.title}” for you.`, null, rule.project_id, 'repeating');
              await logActivity(req.auth.id, `${req.auth.name} moved the repeating task “${rule.title}” from ${person.name} to ${assignee.name}.`, null, rule.project_id);
            }
          }
        }
        await updateOne('departure_items', { _id: item.id }, { done: 1 });
      }
      await updateOne('departure_requests', { _id: request.id }, { status: 'done' });
      return maybeFinishDeparture(person.id, req.auth);
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
}));

app.get('/api/recurring', requireAuth, wrap(async (req, res) => {
  const rules = await hydrateRules(await findMany('recurring_rules', {}));
  const allowed = [];
  for (const rule of rules) if (await canTouchRule(req.auth, rule)) allowed.push(rule);
  allowed.sort((left, right) => right.active - left.active || left.assignee_name.localeCompare(right.assignee_name) || left.title.localeCompare(right.title));
  res.json({ rules: allowed.map(mapRule) });
}));

app.post('/api/recurring', requireAuth, wrap(async (req, res) => {
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  const cadence = req.body.cadence;
  if (cadence !== 'daily' && cadence !== 'weekly') return bad(res, 400, 'Choose daily or weekly');
  let weekday = null;
  if (cadence === 'weekly') {
    weekday = Number(req.body.weekday);
    if (![1, 2, 3, 4, 5, 6].includes(weekday)) return bad(res, 400, 'Choose a day, Monday through Saturday');
  }
  const priority = PRIORITIES.has(req.body.priority) ? req.body.priority : 'medium';
  const assigneeId = req.body.assigneeId || req.auth.id;
  if (!req.auth.isAdmin && !req.auth.isManager && assigneeId !== req.auth.id && !await assigneeInLeadDepts(req.auth, assigneeId)) {
    return bad(res, 403, 'You can add repeating tasks for yourself. Team leads can add them for their department.');
  }
  const assignee = await activeUser(assigneeId);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  const projectId = req.body.projectId || null;
  if (projectId) {
    const project = await findOne('projects', { _id: projectId });
    if (!project) return bad(res, 400, 'That project does not exist');
    if (project.status === 'done') return bad(res, 400, 'That project is marked done');
    if (!await isProjectMember(projectId, assigneeId)) {
      if (req.auth.isAdmin || req.auth.isManager) {
        await insertIgnore('project_members', { _id: `${projectId}:${assigneeId}`, project_id: projectId, user_id: assigneeId });
      } else {
        return bad(res, 400, 'That person is not on the project');
      }
    }
  }
  const ruleId = id('rule');
  await insertOne('recurring_rules', {
    id: ruleId,
    title: title.value,
    description: description.value,
    cadence,
    weekday,
    priority,
    assignee_id: assigneeId,
    created_by: req.auth.id,
    project_id: projectId,
    active: 1,
    created_at: now(),
  });
  await logActivity(req.auth.id, `${req.auth.name} set “${title.value}” to repeat.`, null, projectId);
  if (assigneeId !== req.auth.id) {
    await notify(assigneeId, `${req.auth.name} set a repeating task for you: “${title.value}”.`, null, projectId, 'repeating');
    await sendAssignmentEmail(assignee, req.auth, {
      title: title.value,
      description: description.value,
      dueDate: 'each time it repeats',
    });
  }
  await prepareWeek();
  const [rule] = await hydrateRules([await findOne('recurring_rules', { _id: ruleId })]);
  res.status(201).json({ rule: mapRule(rule) });
}));

app.patch('/api/recurring/:id', requireAuth, wrap(async (req, res) => {
  const rule = await findOne('recurring_rules', { _id: req.params.id });
  if (!rule) return bad(res, 404, 'Repeating task not found');
  if (!await canTouchRule(req.auth, rule)) return bad(res, 403, 'You can’t change this repeating task');
  const title = readText(req.body.title ?? rule.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description ?? rule.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  const cadence = req.body.cadence ?? rule.cadence;
  if (cadence !== 'daily' && cadence !== 'weekly') return bad(res, 400, 'Choose daily or weekly');
  let weekday = cadence === 'weekly' ? Number(req.body.weekday ?? rule.weekday) : null;
  if (cadence === 'weekly' && ![1, 2, 3, 4, 5, 6].includes(weekday)) {
    return bad(res, 400, 'Choose a day, Monday through Saturday');
  }
  const priority = PRIORITIES.has(req.body.priority) ? req.body.priority : rule.priority;
  const assigneeId = req.body.assigneeId ?? rule.assignee_id;
  if (assigneeId !== rule.assignee_id && !req.auth.isAdmin && !await assigneeInLeadDepts(req.auth, assigneeId)) {
    return bad(res, 403, 'Only an admin or team lead can change who this repeats for');
  }
  if (!await activeUser(assigneeId)) return bad(res, 400, 'Choose an active person');
  const projectId = req.body.projectId === undefined ? rule.project_id : (req.body.projectId || null);
  if (projectId && !await isProjectMember(projectId, assigneeId)) return bad(res, 400, 'That person is not on the project');
  const active = req.body.active === undefined ? rule.active : (req.body.active ? 1 : 0);
  await updateOne('recurring_rules', { _id: rule.id }, {
    title: title.value,
    description: description.value,
    cadence,
    weekday,
    priority,
    assignee_id: assigneeId,
    project_id: projectId,
    active,
  });
  if (assigneeId !== rule.assignee_id && assigneeId !== req.auth.id) {
    const next = await activeUser(assigneeId);
    if (next) {
      await notify(next.id, `${req.auth.name} set the repeating task “${title.value}” for you.`, null, projectId, 'repeating');
      await sendAssignmentEmail(next, req.auth, {
        title: title.value,
        description: description.value,
        dueDate: 'each time it repeats',
      });
    }
  }
  await prepareWeek();
  const [fresh] = await hydrateRules([await findOne('recurring_rules', { _id: rule.id })]);
  res.json({ rule: mapRule(fresh) });
}));

app.delete('/api/recurring/:id', requireAuth, wrap(async (req, res) => {
  const rule = await findOne('recurring_rules', { _id: req.params.id });
  if (!rule) return bad(res, 404, 'Repeating task not found');
  if (!await canTouchRule(req.auth, rule)) return bad(res, 403, 'You can’t change this repeating task');
  await updateMany('tasks', { recurring_rule_id: rule.id }, { recurring_rule_id: null });
  await deleteMany('departure_items', { rule_id: rule.id });
  await deleteOne('recurring_rules', { _id: rule.id });
  await logActivity(req.auth.id, `${req.auth.name} stopped the repeat “${rule.title}”. Future weeks will not add it.`);
  res.json({ ok: true });
}));

function isHrDepartment(name) {
  const value = String(name || '').trim().toLowerCase();
  return value === 'hr' || value === 'human resource and admin';
}

async function hrUserIds() {
  const departments = (await findMany('departments', {})).filter((department) => isHrDepartment(department.name));
  if (!departments.length) return [];
  const departmentIds = departments.map((department) => department.id);
  const links = await findMany('user_departments', { department_id: { $in: departmentIds } });
  const ids = new Set(links.map((link) => link.user_id));
  for (const department of departments) if (department.lead_id) ids.add(department.lead_id);
  if (!ids.size) return [];
  const users = await findMany('users', { _id: { $in: [...ids] }, active: 1 });
  return users.map((user) => user.id);
}

function isHr(auth) {
  return auth.departments.some((item) => isHrDepartment(item.name));
}

function monthBounds(month) {
  const [year, index] = month.split('-').map(Number);
  const start = new Date(year, index - 1, 1);
  const end = new Date(year, index, 0);
  return { start: isoDate(start), end: isoDate(end) };
}

function mapAttendance(row) {
  if (!row) return null;
  return { day: row.day, checkIn: row.check_in, checkOut: row.check_out };
}

app.get('/api/attendance/today', requireAuth, wrap(async (req, res) => {
  const row = await findOne('attendance', { user_id: req.auth.id, day: todayISO() });
  res.json({ record: mapAttendance(row) });
}));

app.post('/api/attendance/check-in', requireAuth, wrap(async (req, res) => {
  const day = todayISO();
  if (weekdayMon1(day) === 7) return bad(res, 400, 'Sunday is off');
  const existing = await findOne('attendance', { user_id: req.auth.id, day });
  if (existing?.check_in) return bad(res, 400, 'You already checked in today');
  const stamp = now();
  if (existing) {
    await updateOne('attendance', { _id: existing.id }, { check_in: stamp });
  } else {
    await insertOne('attendance', { id: id('att'), user_id: req.auth.id, day, check_in: stamp, check_out: null });
  }
  res.status(201).json({ record: mapAttendance(await findOne('attendance', { user_id: req.auth.id, day })) });
}));

app.post('/api/attendance/check-out', requireAuth, wrap(async (req, res) => {
  const day = todayISO();
  if (weekdayMon1(day) === 7) return bad(res, 400, 'Sunday is off');
  const existing = await findOne('attendance', { user_id: req.auth.id, day });
  if (!existing?.check_in) return bad(res, 400, 'Check in before you check out');
  if (existing.check_out) return bad(res, 400, 'You already checked out today');
  await updateOne('attendance', { _id: existing.id }, { check_out: now() });
  res.json({ record: mapAttendance(await findOne('attendance', { user_id: req.auth.id, day })) });
}));

app.get('/api/attendance', requireAuth, wrap(async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return bad(res, 400, 'Choose a month');
  const userId = req.query.userId || req.auth.id;
  if (!await exists('users', { _id: userId })) return bad(res, 404, 'Person not found');
  if (userId !== req.auth.id && !seesConfidential(req.auth) && await isPrivateAssignee(userId)) {
    return bad(res, 403, 'That attendance is private');
  }
  if (userId !== req.auth.id && !req.auth.isAdmin && !req.auth.isManager && !await assigneeInLeadDepts(req.auth, userId)) {
    return bad(res, 403, 'You can open attendance for people on a team you lead');
  }
  const { start, end } = monthBounds(month);
  const records = (await findMany('attendance', { user_id: userId, day: { $gte: start, $lte: end } }))
    .sort((left, right) => left.day.localeCompare(right.day))
    .map(mapAttendance);
  const dates = await findOne('users', { _id: userId });
  res.json({ month, userId, records, birthday: dates?.birthday || null, workAnniversary: dates?.work_anniversary || null });
}));

app.get('/api/chores', requireAuth, wrap(async (req, res) => {
  const rows = (await findMany('office_chores', {})).sort((left, right) => right.created_at.localeCompare(left.created_at));
  const users = await usersByIds(rows.map((row) => row.requester_id));
  const chores = rows.flatMap((row) => {
    const requester = users.get(row.requester_id);
    if (!requester) return [];
    return [{
      id: row.id,
      category: row.category,
      title: row.title,
      details: row.details,
      status: row.status,
      createdAt: row.created_at,
      requesterId: row.requester_id,
      requesterName: requester.name,
    }];
  });
  res.json({ chores, canMove: isHr(req.auth) });
}));

app.post('/api/chores', requireAuth, wrap(async (req, res) => {
  const category = req.body.category === 'purchasing' ? 'purchasing' : req.body.category === 'maintenance' ? 'maintenance' : '';
  if (!category) return bad(res, 400, 'Choose maintenance or purchasing');
  const title = readText(req.body.title, 140, 'what is needed', true);
  if (title.error) return bad(res, 400, title.error);
  const details = readText(req.body.details, 2000, 'the details');
  if (details.error) return bad(res, 400, details.error);
  const choreId = id('chr');
  await insertOne('office_chores', {
    id: choreId,
    category,
    title: title.value,
    details: details.value,
    requester_id: req.auth.id,
    status: 'open',
    created_at: now(),
  });
  const label = category === 'purchasing' ? 'Purchasing' : 'Maintenance';
  for (const userId of await hrUserIds()) {
    if (userId !== req.auth.id) {
      await notify(userId, `${req.auth.name} raised a ${label.toLowerCase()} request: “${title.value}”.`, null, null, 'chores');
    }
  }
  await logActivity(req.auth.id, `${req.auth.name} raised “${title.value}” for ${label.toLowerCase()}.`);
  res.status(201).json({ ok: true });
}));

app.post('/api/chores/:id/status', requireAuth, wrap(async (req, res) => {
  if (!isHr(req.auth)) return bad(res, 403, 'Human Resource and Admin moves these requests');
  const next = req.body.status;
  if (!['open', 'in_progress', 'done'].includes(next)) return bad(res, 400, 'Choose open, in progress, or done');
  const chore = await findOne('office_chores', { _id: req.params.id });
  if (!chore) return bad(res, 404, 'Request not found');
  if (chore.status !== next) {
    await updateOne('office_chores', { _id: chore.id }, { status: next });
    if (chore.requester_id !== req.auth.id) {
      const label = next === 'done' ? 'done' : next === 'in_progress' ? 'in progress' : 'open';
      await notify(chore.requester_id, `${req.auth.name} moved “${chore.title}” to ${label}.`, null, null, 'chores');
    }
  }
  res.json({ ok: true });
}));

app.get('/api/notifications', requireAuth, wrap(async (req, res) => {
  const notifications = (await findMany('notifications', { user_id: req.auth.id }, { sort: { created_at: -1 }, limit: 40 }))
    .map((item) => ({
      id: item.id,
      message: item.message,
      taskId: item.task_id,
      projectId: item.project_id,
      area: item.area,
      read: Boolean(item.read),
      createdAt: item.created_at,
    }));
  const unreadCount = await count('notifications', { user_id: req.auth.id, read: 0 });
  const grouped = await aggregate('notifications', [
    { $match: { user_id: req.auth.id, area_seen: 0, area: { $ne: null } } },
    { $group: { _id: '$area', n: { $sum: 1 } } },
    { $project: { _id: 0, area: '$_id', n: 1 } },
  ]);
  const areas = {};
  for (const row of grouped) areas[row.area] = row.n;
  const announcementPendingCount = await announcementPending(req.auth);
  res.json({ notifications, unreadCount, areas, announcementPending: announcementPendingCount });
}));

app.post('/api/notifications/seen', requireAuth, wrap(async (req, res) => {
  const area = String(req.body.area || '');
  if (!/^[a-z]+$/.test(area)) return bad(res, 400, 'Choose a section');
  await updateMany('notifications', { user_id: req.auth.id, area }, { area_seen: 1 });
  res.json({ ok: true });
}));

app.post('/api/notifications/read', requireAuth, wrap(async (req, res) => {
  if (req.body.all) {
    await updateMany('notifications', { user_id: req.auth.id }, { read: 1 });
  } else if (Array.isArray(req.body.ids) && req.body.ids.length) {
    const ids = req.body.ids.slice(0, 100);
    await updateMany('notifications', { user_id: req.auth.id, _id: { $in: ids } }, { read: 1 });
  }
  res.json({ ok: true });
}));

app.get('/api/activity', requireAuth, wrap(async (req, res) => {
  let events;
  if (req.auth.isAdmin || req.auth.isLead) {
    events = await findMany('activity', {}, { sort: { created_at: -1 }, limit: 200 });
  } else {
    const [memberships, tasks] = await Promise.all([
      findMany('project_members', { user_id: req.auth.id }),
      findMany('tasks', { $or: [{ assignee_id: req.auth.id }, { creator_id: req.auth.id }] }),
    ]);
    events = await findMany('activity', {
      $or: [
        { actor_id: req.auth.id },
        { task_id: { $in: tasks.map((task) => task.id) } },
        { project_id: { $in: memberships.map((link) => link.project_id) } },
      ],
    }, { sort: { created_at: -1 }, limit: 200 });
  }
  const actors = await usersByIds(events.map((event) => event.actor_id));
  res.json({
    events: events.flatMap((event) => {
      const actor = actors.get(event.actor_id);
      if (!actor) return [];
      return [{
        id: event.id,
        message: event.message,
        taskId: event.task_id,
        projectId: event.project_id,
        createdAt: event.created_at,
        actorName: actor.name,
      }];
    }),
  });
}));

registerSections(app, {
  requireAuth,
  requireAdmin,
  bad,
  httpError,
  readText,
  activeUser,
  isHr,
  hrUserIds,
  nameList,
  rawTask,
  maybeFinishDeparture,
  isISODate,
  uniqueList,
  wrap,
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const distDir = path.resolve(__dirname, '../client/dist');
const indexHtml = path.join(distDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(indexHtml);
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  if (error?.code === 11000 || String(error?.message || '').includes('UNIQUE')) {
    return res.status(400).json({ error: 'That value is already in use' });
  }
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({ error: 'That file is too large. Keep it under 8 MB.' });
  }
  res.status(500).json({ error: 'Something went wrong' });
});

async function bootstrapAdmin() {
  if (await count('users')) return;
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  const name = process.env.BOOTSTRAP_ADMIN_NAME || 'Admin';
  if (!email || password.length < 8) {
    console.error('BOOTSTRAP_ADMIN_EMAIL and a password of at least 8 characters are required to create the first admin.');
    return;
  }
  await insertOne('users', {
    id: id('usr'),
    name,
    email,
    password_hash: bcrypt.hashSync(password, 10),
    role: 'admin',
    active: 1,
    birthday: null,
    work_anniversary: null,
    created_at: now(),
  });
  console.log(`Created the first admin ${email}.`);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('Set MONGODB_URI. The Atlas, Compass, and Docker steps are in DEPLOY.md.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'kanabana-dev-secret')) {
    console.error('Set JWT_SECRET to a long random string before starting in production.');
    process.exit(1);
  }
  let connected = false;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await connectDb();
      connected = true;
      break;
    } catch (error) {
      console.error(`Waiting for MongoDB (${attempt}/30): ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * attempt, 10_000)));
    }
  }
  if (!connected) process.exit(1);
  await ensureIndexes();
  await repairData();
  if (process.env.SEED_DEMO === '1') await seedIfEmpty();
  else if (process.env.BOOTSTRAP_ADMIN_EMAIL) await bootstrapAdmin();
  await prepareWeek();
  await checkMail();
  console.log(await googleReady() ? 'Google Calendar is connected' : 'Google Calendar is not connected');
  console.log(storageConfigured()
    ? `File storage is ready (${storageLabel()})`
    : 'File storage is not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
  startReminders();
  const officeAddresses = lanAddresses();
  if (officeAddresses[0]) publishOfficeName(officeAddresses[0]);
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Kanabana API listening on ${PORT}`);
    console.log(`MongoDB database “${databaseName()}”`);
    if (!officeAddresses.length) return;
    console.log('On this Wi-Fi, open http://kanabana.local:5173');
    console.log(`Office API is http://${officeAddresses[0]}:${PORT}`);
  });
  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown(); });
  process.on('SIGINT', () => { shutdown(); });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
