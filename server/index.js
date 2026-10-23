import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { addDays, isISODate, isoDate, parseISODate, startOfWeek, todayISO, weekdayMon1 } from './dates.js';
import { db, ensureRecurring, id, logActivity, notify, now } from './db.js';
import { lanAddresses, publishOfficeName } from './office.js';
import { registerSections } from './sections.js';

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
app.use(express.json({ limit: '15mb' }));

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

function shapeUser(row) {
  const departments = db.prepare(`
    SELECT d.id, d.name
    FROM departments d
    JOIN user_departments ud ON ud.department_id = d.id
    WHERE ud.user_id = ?
    ORDER BY d.name
  `).all(row.id);
  const leadOf = db.prepare('SELECT id, name FROM departments WHERE lead_id = ? ORDER BY name').all(row.id);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: Boolean(row.active),
    isAdmin: row.role === 'admin',
    isLead: leadOf.length > 0,
    isHr: row.role === 'admin' || departments.some((item) => item.name.toLowerCase() === 'hr'),
    birthday: row.birthday || null,
    workAnniversary: row.work_anniversary || null,
    leadOf,
    departments,
    departmentIds: departments.map((item) => item.id),
    leadDepartmentIds: leadOf.map((item) => item.id),
    departureLeads: db.prepare(`
      SELECT DISTINCT u.name
      FROM departure_requests d
      JOIN users u ON u.id = d.lead_id
      WHERE d.user_id = ? AND d.status = 'open'
      ORDER BY u.name
    `).all(row.id).map((item) => item.name),
    createdAt: row.created_at,
  };
}

function userContext(userId) {
  const row = db.prepare('SELECT id, name, email, role, active, birthday, work_anniversary, created_at FROM users WHERE id = ?').get(userId);
  if (!row || !row.active) return null;
  return shapeUser(row);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return bad(res, 401, 'Sign in required');
  try {
    const payload = jwt.verify(token, SECRET);
    const auth = userContext(payload.sub);
    if (!auth) return bad(res, 401, 'Sign in required');
    req.auth = auth;
    next();
  } catch {
    return bad(res, 401, 'Sign in required');
  }
}

function requireAdmin(req, res, next) {
  if (!req.auth.isAdmin) return bad(res, 403, 'Only an admin can do that');
  else next();
}

function activeUser(userId) {
  if (!userId) return null;
  const user = db.prepare('SELECT id, name, active FROM users WHERE id = ?').get(userId);
  if (!user || !user.active) return null;
  return user;
}

function isProjectMember(projectId, userId) {
  return Boolean(db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId));
}

function canViewProject(auth, projectId) {
  if (auth.isAdmin || isProjectMember(projectId, auth.id)) return true;
  return Boolean(db.prepare(`
    SELECT 1 FROM project_departments pd
    JOIN user_departments ud ON ud.department_id = pd.department_id
    WHERE pd.project_id = ? AND ud.user_id = ?
  `).get(projectId, auth.id));
}

function userInDepartments(userId, departmentIds) {
  const marks = departmentIds.map(() => '?').join(',');
  return Boolean(db.prepare(
    `SELECT 1 FROM user_departments WHERE user_id = ? AND department_id IN (${marks})`,
  ).get(userId, ...departmentIds));
}

function assigneeInLeadDepts(auth, assigneeId) {
  if (!auth.leadDepartmentIds.length) return false;
  const marks = auth.leadDepartmentIds.map(() => '?').join(',');
  return Boolean(db.prepare(
    `SELECT 1 FROM user_departments WHERE user_id = ? AND department_id IN (${marks})`,
  ).get(assigneeId, ...auth.leadDepartmentIds));
}

function projectDepartmentIds(projectId) {
  return db.prepare('SELECT department_id FROM project_departments WHERE project_id = ?').all(projectId).map((item) => item.department_id);
}

function managesProject(auth, row) {
  return Boolean(row && (auth.isAdmin || row.created_by === auth.id));
}

function canDeleteProject(auth, row) {
  if (!row) return false;
  if (auth.isAdmin || row.created_by === auth.id) return true;
  return projectDepartmentIds(row.id).some((departmentId) => auth.leadDepartmentIds.includes(departmentId));
}

function canAssignOnProject(auth, project) {
  if (!project) return false;
  if (auth.isAdmin || project.created_by === auth.id) return true;
  return projectDepartmentIds(project.id).some((departmentId) => auth.leadDepartmentIds.includes(departmentId));
}

function canGovernTask(auth, task) {
  if (!task) return false;
  if (auth.isAdmin) return true;
  if (auth.isLead && task.creator_id === auth.id) return true;
  return assigneeInLeadDepts(auth, task.assignee_id);
}

function leadIdsFor(userId) {
  return db.prepare(`
    SELECT DISTINCT d.lead_id AS id
    FROM departments d
    JOIN user_departments ud ON ud.department_id = d.id
    WHERE ud.user_id = ? AND d.lead_id IS NOT NULL
  `).all(userId).map((item) => item.id);
}

function requestRecipients(task) {
  const ids = new Set(leadIdsFor(task.assignee_id));
  if (db.prepare('SELECT 1 FROM departments WHERE lead_id = ?').get(task.creator_id)) ids.add(task.creator_id);
  ids.delete(task.assignee_id);
  if (!ids.size) {
    for (const admin of db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1`).all()) ids.add(admin.id);
  }
  return [...ids];
}

function openRequest(task, kind, auth, note) {
  const existing = db.prepare(`SELECT id FROM task_requests WHERE task_id = ? AND kind = ? AND status = 'open'`).get(task.id, kind);
  if (existing) return existing.id;
  const requestId = id('req');
  db.prepare(`
    INSERT INTO task_requests (id, task_id, kind, requester_id, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(requestId, task.id, kind, auth.id, note || '', now());
  return requestId;
}

function canHandleRequest(auth, row) {
  if (auth.isAdmin) return true;
  const assigneeId = row.assignee_id || row.assigneeId;
  const creatorId = row.creator_id || row.creatorId;
  if (assigneeInLeadDepts(auth, assigneeId)) return true;
  return Boolean(auth.isLead && creatorId === auth.id);
}

function timelineSnapshot(projectId) {
  const project = db.prepare('SELECT start_date, end_date FROM projects WHERE id = ?').get(projectId);
  return { startDate: project.start_date, endDate: project.end_date };
}

function presentProject(row, auth, withHistory = false) {
  const departments = db.prepare(`
    SELECT d.id, d.name FROM departments d
    JOIN project_departments pd ON pd.department_id = d.id
    WHERE pd.project_id = ? ORDER BY d.name
  `).all(row.id);
  const members = db.prepare(`
    SELECT u.id, u.name, u.active FROM users u
    JOIN project_members pm ON pm.user_id = u.id
    WHERE pm.project_id = ? ORDER BY u.name
  `).all(row.id).map((member) => ({ ...member, active: Boolean(member.active) }));
  const counts = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
    FROM tasks WHERE project_id = ?
  `).get(row.id);
  const project = {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    departments,
    members,
    taskCount: counts.total || 0,
    doneCount: counts.done || 0,
    createdBy: row.created_by,
    createdByName: db.prepare('SELECT name FROM users WHERE id = ?').get(row.created_by)?.name || '',
    canManage: auth.isAdmin || row.created_by === auth.id,
    canDelete: auth.isAdmin || row.created_by === auth.id || departments.some((item) => auth.leadDepartmentIds.includes(item.id)),
    canAssign: auth.isAdmin || row.created_by === auth.id || departments.some((item) => auth.leadDepartmentIds.includes(item.id)),
    canEditTimeline: auth.isAdmin || departments.some((item) => auth.leadDepartmentIds.includes(item.id)),
    canAddTask: auth.isAdmin || row.created_by === auth.id || departments.some((item) => auth.leadDepartmentIds.includes(item.id)) || members.some((member) => member.id === auth.id),
  };
  if (!withHistory) return project;
  const history = db.prepare(`
    SELECT tc.id, tc.reason, tc.before_json, tc.after_json, tc.created_at, COALESCE(NULLIF(tc.actor_name, ''), u.name) AS actor_name
    FROM timeline_changes tc
    JOIN users u ON u.id = tc.actor_id
    WHERE tc.project_id = ?
    ORDER BY tc.created_at DESC
  `).all(row.id).map((item) => ({
    id: item.id,
    reason: item.reason,
    before: JSON.parse(item.before_json),
    after: JSON.parse(item.after_json),
    createdAt: item.created_at,
    actorName: item.actor_name,
  }));
  return { ...project, history };
}

const TASK_SQL = `
SELECT
  t.id, t.title, t.description, t.project_id, t.creator_id, t.assignee_id,
  t.status, t.priority, t.due_date, t.kind, t.recurring_rule_id, t.parent_task_id,
  t.handoff_task_id, t.created_at, t.updated_at, t.completed_at,
  cu.name AS creator_name,
  au.name AS assignee_name,
  p.name AS project_name,
  parent.title AS parent_title,
  parent.status AS parent_status,
  pau.name AS parent_assignee_name,
  child.title AS handoff_title,
  child.due_date AS handoff_due_date,
  child.status AS handoff_status,
  child.assignee_id AS handoff_assignee_id,
  cau.name AS handoff_assignee_name,
  rr.cadence AS cadence,
  (SELECT group_concat(ud.department_id) FROM user_departments ud WHERE ud.user_id = t.assignee_id) AS assignee_departments,
  (SELECT group_concat(u.name, ', ') FROM task_dependencies d JOIN users u ON u.id = d.depends_on_id WHERE d.task_id = t.id AND d.status = 'open') AS waiting_on
FROM tasks t
JOIN users cu ON cu.id = t.creator_id
JOIN users au ON au.id = t.assignee_id
LEFT JOIN projects p ON p.id = t.project_id
LEFT JOIN tasks parent ON parent.id = t.parent_task_id
LEFT JOIN users pau ON pau.id = parent.assignee_id
LEFT JOIN tasks child ON child.id = t.handoff_task_id
LEFT JOIN users cau ON cau.id = child.assignee_id
LEFT JOIN recurring_rules rr ON rr.id = t.recurring_rule_id
`;

function loadTask(taskId) {
  return db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(taskId);
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

function canSeeTask(auth, task) {
  if (!task) return false;
  if (auth.isAdmin || task.assignee_id === auth.id || task.creator_id === auth.id) return true;
  if (assigneeInLeadDepts(auth, task.assignee_id)) return true;
  if (task.project_id) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id);
    if (canAssignOnProject(auth, project)) return true;
  }
  return Boolean(db.prepare(`
    SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ? AND status = 'open'
  `).get(task.id, auth.id));
}

function taskChain(taskId) {
  const upward = [];
  const seenUp = new Set();
  let cursor = loadTask(taskId);
  let guard = 0;
  while (cursor?.parent_task_id && guard < 8) {
    const parent = loadTask(cursor.parent_task_id);
    if (!parent || seenUp.has(parent.id)) break;
    seenUp.add(parent.id);
    upward.push(parent);
    cursor = parent;
    guard += 1;
  }
  upward.reverse();
  const downward = [];
  const seenDown = new Set();
  cursor = loadTask(taskId);
  guard = 0;
  while (cursor?.handoff_task_id && guard < 8) {
    const child = loadTask(cursor.handoff_task_id);
    if (!child || seenDown.has(child.id)) break;
    seenDown.add(child.id);
    downward.push(child);
    cursor = child;
    guard += 1;
  }
  const rows = [...upward, loadTask(taskId), ...downward].filter(Boolean);
  const unique = [];
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) continue;
    ids.add(row.id);
    unique.push(mapTask(row, '9999-99-99'));
  }
  return unique;
}

function insertTaskRow(fields) {
  const taskId = fields.id || id('task');
  const stamp = now();
  db.prepare(`
    INSERT INTO tasks (
      id, title, description, project_id, stage_id, creator_id, assignee_id,
      status, priority, due_date, kind, recurring_rule_id, parent_task_id, handoff_task_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    fields.title,
    fields.description || '',
    fields.projectId || null,
    null,
    fields.creatorId,
    fields.assigneeId,
    fields.status,
    fields.priority,
    fields.dueDate,
    fields.kind,
    fields.recurringRuleId || null,
    fields.parentTaskId || null,
    fields.handoffTaskId || null,
    stamp,
    stamp,
  );
  return taskId;
}

function createHandoff(parentId, auth, handoff) {
  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentId);
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
  const next = activeUser(handoff.assigneeId);
  if (!next) throw httpError(400, 'Choose an active person for the next step');
  if (next.id === parent.assignee_id) throw httpError(400, 'Hand the work to someone else');
  if (parent.project_id && !isProjectMember(parent.project_id, next.id)) {
    throw httpError(400, 'The next person needs to be on this project');
  }
  const childId = insertTaskRow({
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
  db.prepare('UPDATE tasks SET handoff_task_id = ?, updated_at = ? WHERE id = ?').run(childId, now(), parent.id);
  if (next.id !== auth.id) {
    notify(next.id, `${auth.name} handed you “${title.value}” after “${parent.title}”.`, childId, parent.project_id);
  }
  logActivity(auth.id, `${auth.name} handed “${title.value}” to ${next.name}.`, childId, parent.project_id);
  return childId;
}

function writeStatus(taskId, status, previousCompletedAt) {
  const stamp = now();
  const completedAt = status === 'done' ? (previousCompletedAt || stamp) : null;
  db.prepare('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(status, completedAt, stamp, taskId);
}

function noteStatus(task, status, auth) {
  logActivity(auth.id, `${auth.name} moved “${task.title}” to ${STATUS_LABEL[status]}.`, task.id, task.project_id);
  if (task.status === 'review' && status !== 'review') {
    db.prepare(`UPDATE task_requests SET status = ? WHERE task_id = ? AND kind = 'review' AND status = 'open'`).run(status === 'done' ? 'accepted' : 'declined', task.id);
  }
  if (status === 'review' && auth.id === task.assignee_id && !canGovernTask(auth, task)) {
    openRequest(task, 'review', auth, '');
    for (const userId of requestRecipients(task)) {
      notify(userId, `${auth.name} asked you to review “${task.title}”.`, task.id, task.project_id, 'requests');
    }
  }
  if (status !== 'done' || !task.handoff_task_id) return;
  const child = db.prepare('SELECT id, title, assignee_id FROM tasks WHERE id = ?').get(task.handoff_task_id);
  if (child && child.assignee_id !== auth.id) {
    notify(child.assignee_id, `${auth.name} finished “${task.title}”. “${child.title}” is ready for you.`, child.id, task.project_id);
  }
}

function rawTask(taskId) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
}

function canTouchRule(auth, rule) {
  if (auth.isAdmin || rule.created_by === auth.id || rule.assignee_id === auth.id) return true;
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

function refreshRecurring() {
  const monday = startOfWeek(new Date());
  ensureRecurring(isoDate(monday), isoDate(addDays(monday, 13)));
}

function notifyProject(projectId, auth, message) {
  const recipients = new Set(
    db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(projectId).map((row) => row.user_id),
  );
  const leads = db.prepare(`
    SELECT d.lead_id FROM departments d
    JOIN project_departments pd ON pd.department_id = d.id
    WHERE pd.project_id = ?
  `).all(projectId);
  for (const lead of leads) if (lead.lead_id) recipients.add(lead.lead_id);
  for (const userId of recipients) {
    if (userId !== auth.id) notify(userId, message, null, projectId);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const email = readEmail(req.body.email || '');
  const password = String(req.body.password || '');
  if (email.error) return bad(res, 401, 'Email or password is incorrect');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.value);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return bad(res, 401, 'Email or password is incorrect');
  }
  if (!user.active) return bad(res, 403, 'This account is deactivated. Ask an admin to turn it back on.');
  const token = jwt.sign({ sub: user.id }, SECRET, { expiresIn: '7d' });
  res.json({ token, user: userContext(user.id) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.auth });
});

app.post('/api/me/password', requireAuth, (req, res) => {
  const next = readPassword(req.body.nextPassword);
  if (next.error) return bad(res, 400, next.error);
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.auth.id);
  if (!bcrypt.compareSync(String(req.body.currentPassword || ''), user.password_hash)) {
    return bad(res, 400, 'Current password is incorrect');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next.value, 10), req.auth.id);
  logActivity(req.auth.id, `${req.auth.name} changed their password.`);
  res.json({ ok: true });
});

app.get('/api/users', requireAuth, (_req, res) => {
  const users = db.prepare('SELECT id, name, email, role, active, birthday, work_anniversary, created_at FROM users ORDER BY name').all().map(shapeUser);
  res.json({ users });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const name = readText(req.body.name, 80, 'the person’s name', true);
  if (name.error) return bad(res, 400, name.error);
  const email = readEmail(req.body.email);
  if (email.error) return bad(res, 400, email.error);
  const password = readPassword(req.body.password);
  if (password.error) return bad(res, 400, password.error);
  const departmentIds = uniqueList(req.body.departmentIds);
  const leadDepartmentId = req.body.leadDepartmentId || null;
  if (!departmentIds.length) return bad(res, 400, 'Choose at least one department');
  const marks = departmentIds.map(() => '?').join(',');
  const found = db.prepare(`SELECT id FROM departments WHERE id IN (${marks})`).all(...departmentIds);
  if (found.length !== departmentIds.length) return bad(res, 400, 'Choose a real department');
  if (leadDepartmentId && !departmentIds.includes(leadDepartmentId)) {
    return bad(res, 400, 'A team lead has to belong to that department');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.value)) {
    return bad(res, 400, 'That email is already in use');
  }
  if (!isISODate(req.body.birthday)) return bad(res, 400, 'Choose a birthday');
  if (!isISODate(req.body.workAnniversary)) return bad(res, 400, 'Choose a work anniversary');
  const userId = id('usr');
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, active, birthday, work_anniversary, created_at)
        VALUES (?, ?, ?, ?, 'member', 1, ?, ?, ?)
      `).run(userId, name.value, email.value, bcrypt.hashSync(password.value, 10), req.body.birthday, req.body.workAnniversary, now());
      const link = db.prepare('INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)');
      for (const departmentId of departmentIds) link.run(userId, departmentId);
      if (leadDepartmentId) db.prepare('UPDATE departments SET lead_id = ? WHERE id = ?').run(userId, leadDepartmentId);
      logActivity(req.auth.id, `${req.auth.name} added ${name.value} to the office.`);
    })();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return bad(res, 400, 'That email is already in use');
    throw error;
  }
  res.status(201).json({ user: userContext(userId) });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!current) return bad(res, 404, 'Person not found');
  const name = readText(req.body.name, 80, 'the person’s name', true);
  if (name.error) return bad(res, 400, name.error);
  const email = readEmail(req.body.email);
  if (email.error) return bad(res, 400, email.error);
  const departmentIds = uniqueList(req.body.departmentIds);
  const active = req.body.active !== false;
  if (!departmentIds.length) return bad(res, 400, 'Each person needs at least one department');
  const marks = departmentIds.map(() => '?').join(',');
  const found = db.prepare(`SELECT id FROM departments WHERE id IN (${marks})`).all(...departmentIds);
  if (found.length !== departmentIds.length) return bad(res, 400, 'Choose a real department');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email.value, current.id)) {
    return bad(res, 400, 'That email is already in use');
  }
  const leading = db.prepare('SELECT id, name FROM departments WHERE lead_id = ?').all(current.id);
  for (const department of leading) {
    if (!departmentIds.includes(department.id)) {
      return bad(res, 400, `${current.name} still leads ${department.name}. Choose a new lead before removing them.`);
    }
  }
  if (!active) {
    if (current.id === req.auth.id) return bad(res, 400, 'You can’t deactivate your own account');
    if (leading.length) return bad(res, 400, `Choose a new lead for ${leading.map((item) => item.name).join(', ')} first`);
    if (current.role === 'admin') {
      const others = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(current.id).n;
      if (!others) return bad(res, 400, 'Keep at least one active admin');
    }
  }
  const birthday = isISODate(req.body.birthday) ? req.body.birthday : (current.birthday || null);
  const workAnniversary = isISODate(req.body.workAnniversary) ? req.body.workAnniversary : (current.work_anniversary || null);
  db.transaction(() => {
    db.prepare('UPDATE users SET name = ?, email = ?, active = ?, birthday = ?, work_anniversary = ? WHERE id = ?').run(name.value, email.value, active ? 1 : 0, birthday, workAnniversary, current.id);
    db.prepare('DELETE FROM user_departments WHERE user_id = ?').run(current.id);
    const link = db.prepare('INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)');
    for (const departmentId of departmentIds) link.run(current.id, departmentId);
    logActivity(req.auth.id, `${req.auth.name} updated ${name.value}.`);
  })();
  const row = db.prepare('SELECT id, name, email, role, active, birthday, work_anniversary, created_at FROM users WHERE id = ?').get(current.id);
  res.json({ user: shapeUser(row) });
});

app.post('/api/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const person = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.id);
  if (!person) return bad(res, 404, 'Person not found');
  const password = readPassword(req.body.password);
  if (password.error) return bad(res, 400, password.error);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password.value, 10), person.id);
  logActivity(req.auth.id, `${req.auth.name} reset the password for ${person.name}.`);
  res.json({ ok: true });
});

function nameList(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function personDepartments(userId) {
  return db.prepare(`
    SELECT d.id, d.name, d.lead_id AS leadId, u.name AS leadName, u.active AS leadActive
    FROM departments d
    JOIN user_departments ud ON ud.department_id = d.id
    LEFT JOIN users u ON u.id = d.lead_id
    WHERE ud.user_id = ?
    ORDER BY d.name
  `).all(userId);
}

function owningDepartmentIds(projectId, departmentIds) {
  if (!projectId) return departmentIds.slice();
  const overlap = departmentIds.filter((departmentId) => projectDepartmentIds(projectId).includes(departmentId));
  return overlap.length ? overlap : departmentIds.slice();
}

function teammates(departmentIds, exceptId) {
  if (!departmentIds.length) return [];
  const marks = departmentIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT DISTINCT u.id, u.name
    FROM users u
    JOIN user_departments ud ON ud.user_id = u.id
    WHERE ud.department_id IN (${marks}) AND u.active = 1 AND u.id != ?
    ORDER BY u.name
  `).all(...departmentIds, exceptId);
}

function departureBuckets(personId) {
  const departments = personDepartments(personId);
  const departmentIds = departments.map((item) => item.id);
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.project_id, p.name AS project_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = ? AND t.status != 'done' AND t.recurring_rule_id IS NULL
    ORDER BY t.due_date, t.title
  `).all(personId);
  const rules = db.prepare(`
    SELECT r.id, r.title, r.project_id, p.name AS project_name
    FROM recurring_rules r
    LEFT JOIN projects p ON p.id = r.project_id
    WHERE r.assignee_id = ?
    ORDER BY r.title
  `).all(personId);
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
    const owners = owningDepartmentIds(item.project_id, departmentIds);
    const leadIds = [...new Set(owners.map((id) => departments.find((department) => department.id === id)?.leadId).filter((id) => id && id !== personId))];
    for (const leadId of leadIds) {
      const bucket = buckets.get(leadId);
      if (!bucket || bucket[key].some((row) => row.id === item.id)) continue;
      const scoped = owners.filter((id) => bucket.departmentIds.includes(id));
      bucket[key].push({ ...item, departmentIds: scoped.length ? scoped : bucket.departmentIds });
    }
  }
  for (const task of tasks) place(task, 'tasks');
  for (const rule of rules) place(rule, 'rules');
  return { departments, buckets: [...buckets.values()] };
}

function eraseUser(person, requestedById, actor) {
  const created = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_by = ?').get(person.id).n;
  if (created) throw httpError(400, `${person.name} created projects that are still here, so this account can’t be deleted.`);
  const leading = db.prepare('SELECT name FROM departments WHERE lead_id = ? ORDER BY name').all(person.id);
  if (leading.length) {
    throw httpError(400, `${person.name} still leads ${leading.map((item) => item.name).join(', ')}. Choose a new lead first.`);
  }
  const openTasks = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status != 'done'`).get(person.id).n;
  const rules = db.prepare('SELECT COUNT(*) AS n FROM recurring_rules WHERE assignee_id = ?').get(person.id).n;
  if (openTasks || rules) throw httpError(400, `${person.name} still has tasks to move.`);
  db.transaction(() => {
  db.prepare(`UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE assignee_id = ? AND status = 'done'`).run(requestedById, now(), person.id);
  db.prepare('UPDATE tasks SET creator_id = ? WHERE creator_id = ?').run(requestedById, person.id);
  db.prepare('UPDATE recurring_rules SET created_by = ? WHERE created_by = ?').run(requestedById, person.id);
  db.prepare(`UPDATE comments SET author_name = ? WHERE author_id = ? AND (author_name IS NULL OR author_name = '')`).run(person.name, person.id);
  db.prepare('UPDATE comments SET author_id = ? WHERE author_id = ?').run(requestedById, person.id);
  db.prepare(`UPDATE timeline_changes SET actor_name = ? WHERE actor_id = ? AND (actor_name IS NULL OR actor_name = '')`).run(person.name, person.id);
  db.prepare('UPDATE timeline_changes SET actor_id = ? WHERE actor_id = ?').run(requestedById, person.id);
  db.prepare('UPDATE task_requests SET requester_id = ? WHERE requester_id = ?').run(requestedById, person.id);
  db.prepare('UPDATE office_chores SET requester_id = ? WHERE requester_id = ?').run(requestedById, person.id);
  db.prepare('DELETE FROM attendance WHERE user_id = ?').run(person.id);
  db.prepare('DELETE FROM notifications WHERE user_id = ?').run(person.id);
  db.prepare('DELETE FROM activity WHERE actor_id = ?').run(person.id);
  db.prepare('DELETE FROM project_members WHERE user_id = ?').run(person.id);
  db.prepare('DELETE FROM departure_items WHERE request_id IN (SELECT id FROM departure_requests WHERE user_id = ?)').run(person.id);
  db.prepare('DELETE FROM departure_requests WHERE user_id = ?').run(person.id);
  db.prepare('DELETE FROM departure_holds WHERE user_id = ?').run(person.id);
  db.prepare('DELETE FROM task_dependencies WHERE requester_id = ? OR depends_on_id = ?').run(person.id, person.id);
  db.prepare('UPDATE tenders SET created_by = ? WHERE created_by = ?').run(requestedById, person.id);
  db.prepare('UPDATE hiring_positions SET created_by = ? WHERE created_by = ?').run(requestedById, person.id);
  db.prepare('UPDATE hiring_resumes SET uploaded_by = ? WHERE uploaded_by = ?').run(requestedById, person.id);
  db.prepare('UPDATE hiring_resumes SET reviewer_id = NULL WHERE reviewer_id = ?').run(person.id);
  db.prepare('DELETE FROM user_departments WHERE user_id = ?').run(person.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(person.id);
  const keeper = db.prepare('SELECT id, name FROM users WHERE id = ?').get(requestedById);
  if (keeper) logActivity(keeper.id, `${keeper.name} removed ${person.name} from the office.`);
  })();
}



function openDependencyBlock(taskId) {
  const names = db.prepare(`
    SELECT u.name FROM task_dependencies d
    JOIN users u ON u.id = d.depends_on_id
    WHERE d.task_id = ? AND d.status = 'open'
    ORDER BY u.name
  `).all(taskId).map((row) => row.name);
  if (!names.length) return null;
  return `This task is waiting on ${nameList(names)}.`;
}

function hasKtDocument(userId) {
  return Boolean(db.prepare(`SELECT 1 FROM knowledge_items WHERE kind = 'kt' AND user_id = ? AND file_stored IS NOT NULL AND file_stored != ''`).get(userId));
}

function rememberDeparture(person, admin) {
  db.prepare('INSERT OR IGNORE INTO departure_holds (user_id, requested_by, created_at) VALUES (?, ?, ?)').run(person.id, admin.id, now());
  if (!hasKtDocument(person.id)) {
    notify(person.id, `${admin.name} asked to remove your account. Upload your KT document in Knowledge before it can be removed.`, null, null, 'knowledge');
  }
}

function maybeFinishDeparture(personId, actor) {
  const open = db.prepare(`SELECT COUNT(*) AS n FROM departure_requests WHERE user_id = ? AND status = 'open'`).get(personId).n;
  if (open) return { removed: false, message: 'Tasks moved. Waiting on the other team lead.' };
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(personId);
  if (!person) return { removed: true, message: 'This person is already gone.' };
  const request = db.prepare('SELECT requested_by FROM departure_holds WHERE user_id = ?').get(personId)
    || db.prepare(`SELECT requested_by FROM departure_requests WHERE user_id = ? AND status != 'open' ORDER BY created_at LIMIT 1`).get(personId);
  if (!request) return { removed: false, message: 'KT document saved' };
  if (!hasKtDocument(personId)) {
    return { removed: false, message: `${person.name} still needs to upload a KT document.` };
  }
  eraseUser(person, request.requested_by || actor.id, actor);
  return { removed: true, message: `${person.name} was removed.` };
}

function assertTeammate(assigneeId, departmentIds, exceptId) {
  const assignee = activeUser(assigneeId);
  if (!assignee || assignee.id === exceptId) throw httpError(400, 'Choose someone else on the team');
  const allowed = teammates(String(departmentIds || '').split(',').filter(Boolean), exceptId);
  if (!allowed.some((person) => person.id === assignee.id)) throw httpError(400, 'Choose someone on that team');
  return assignee;
}

function moveDepartureTask(task, assignee, person, actor) {
  if (task.assignee_id === assignee.id) return;
  if (task.project_id) {
    db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(task.project_id, assignee.id);
  }
  db.prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?').run(assignee.id, now(), task.id);
  notify(assignee.id, `${actor.name} assigned “${task.title}” to you.`, task.id, task.project_id, 'board');
  logActivity(actor.id, `${actor.name} moved “${task.title}” from ${person.name} to ${assignee.name}.`, task.id, task.project_id);
}

function startDeparture(person, admin) {
  const openTasks = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status != 'done' AND recurring_rule_id IS NULL`).get(person.id).n;
  const rules = db.prepare('SELECT COUNT(*) AS n FROM recurring_rules WHERE assignee_id = ?').get(person.id).n;
  if (!openTasks && !rules) {
    if (!hasKtDocument(person.id)) {
      rememberDeparture(person, admin);
      return { ok: true, pending: true, message: `Waiting on ${person.name} to upload a KT document. The account is removed once that file is in.` };
    }
    eraseUser(person, admin.id, admin);
    return { ok: true, pending: false };
  }
  const { departments, buckets } = departureBuckets(person.id);
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
      if (!teammates(item.departmentIds, person.id).length) {
        const names = item.departmentIds.map((id) => departments.find((department) => department.id === id)?.name).filter(Boolean);
        throw httpError(400, `No one else on ${nameList(names)} can take ${person.name}’s tasks.`);
      }
    }
  }
  for (const bucket of active) {
    const requestId = id('dpr');
    db.prepare(`
      INSERT INTO departure_requests (id, user_id, lead_id, requested_by, status, created_at)
      VALUES (?, ?, ?, ?, 'open', ?)
    `).run(requestId, person.id, bucket.leadId, admin.id, now());
    const insertItem = db.prepare(`
      INSERT INTO departure_items (id, request_id, task_id, rule_id, department_ids, done)
      VALUES (?, ?, ?, ?, ?, 0)
    `);
    for (const task of bucket.tasks) insertItem.run(id('dpi'), requestId, task.id, null, task.departmentIds.join(','));
    for (const rule of bucket.rules) insertItem.run(id('dpi'), requestId, null, rule.id, rule.departmentIds.join(','));
    notify(bucket.leadId, `${admin.name} wants ${person.name} removed. Move their tasks to someone on your team.`, null, null, 'requests');
  }
  const names = nameList(active.map((bucket) => bucket.leadName));
  rememberDeparture(person, admin);
  logActivity(admin.id, `${admin.name} asked ${names} to move ${person.name}’s tasks before removing them.`);
  const kt = hasKtDocument(person.id) ? '' : ` ${person.name} also has to upload a KT document.`;
  return {
    ok: true,
    pending: true,
    message: `Waiting on ${names} to move ${person.name}’s tasks.${kt} The account is removed once that is done.`,
  };
}

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!person) return bad(res, 404, 'Person not found');
  if (person.id === req.auth.id) return bad(res, 400, 'You can’t delete your own account');
  if (person.role === 'admin') {
    const others = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(person.id).n;
    if (!others) return bad(res, 400, 'Keep at least one active admin');
  }
  const leading = db.prepare('SELECT name FROM departments WHERE lead_id = ? ORDER BY name').all(person.id);
  if (leading.length) {
    return bad(res, 400, `${person.name} still leads ${leading.map((item) => item.name).join(', ')}. Choose a new lead first.`);
  }
  const created = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE created_by = ?').get(person.id).n;
  if (created) return bad(res, 400, `${person.name} created projects that are still here, so this account can’t be deleted.`);
  const waiting = db.prepare(`
    SELECT DISTINCT u.name
    FROM departure_requests d
    JOIN users u ON u.id = d.lead_id
    WHERE d.user_id = ? AND d.status = 'open'
    ORDER BY u.name
  `).all(person.id);
  if (waiting.length) {
    return bad(res, 400, `Waiting on ${nameList(waiting.map((item) => item.name))} to move ${person.name}’s tasks.`);
  }
  try {
    const result = db.transaction(() => startDeparture(person, req.auth))();
    res.json(result);
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
});

app.get('/api/departments', requireAuth, (_req, res) => {
  const departments = db.prepare('SELECT id, name, lead_id AS leadId, created_at AS createdAt FROM departments ORDER BY name').all().map((department) => ({
    ...department,
    leadName: department.leadId ? db.prepare('SELECT name FROM users WHERE id = ?').get(department.leadId)?.name || null : null,
    members: db.prepare(`
      SELECT u.id, u.name, u.active FROM users u
      JOIN user_departments ud ON ud.user_id = u.id
      WHERE ud.department_id = ?
      ORDER BY u.name
    `).all(department.id).map((member) => ({ ...member, active: Boolean(member.active) })),
  }));
  res.json({ departments });
});

app.post('/api/departments', requireAuth, requireAdmin, (req, res) => {
  const name = readText(req.body.name, 80, 'a department name', true);
  if (name.error) return bad(res, 400, name.error);
  const lead = activeUser(req.body.leadId);
  if (!lead) return bad(res, 400, 'Choose an active team lead');
  const departmentId = id('dep');
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO departments (id, name, lead_id, created_at) VALUES (?, ?, ?, ?)').run(departmentId, name.value, lead.id, now());
      db.prepare('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)').run(lead.id, departmentId);
      logActivity(req.auth.id, `${req.auth.name} added the ${name.value} department with ${lead.name} as lead.`);
    })();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return bad(res, 400, 'That department name is already in use');
    throw error;
  }
  res.status(201).json({ id: departmentId });
});

app.patch('/api/departments/:id', requireAuth, requireAdmin, (req, res) => {
  const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!department) return bad(res, 404, 'Department not found');
  const name = readText(req.body.name ?? department.name, 80, 'a department name', true);
  if (name.error) return bad(res, 400, name.error);
  const leadId = req.body.leadId === undefined ? department.lead_id : req.body.leadId;
  const lead = activeUser(leadId);
  if (!lead) return bad(res, 400, 'Choose an active team lead');
  try {
    db.transaction(() => {
      db.prepare('UPDATE departments SET name = ?, lead_id = ? WHERE id = ?').run(name.value, lead.id, department.id);
      db.prepare('INSERT OR IGNORE INTO user_departments (user_id, department_id) VALUES (?, ?)').run(lead.id, department.id);
      logActivity(req.auth.id, `${req.auth.name} updated the ${name.value} department.`);
    })();
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return bad(res, 400, 'That department name is already in use');
    throw error;
  }
  res.json({ ok: true });
});

app.delete('/api/departments/:id', requireAuth, requireAdmin, (req, res) => {
  const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
  if (!department) return bad(res, 404, 'Department not found');
  const projects = db.prepare(`
    SELECT p.name FROM projects p
    JOIN project_departments pd ON pd.project_id = p.id
    WHERE pd.department_id = ?
    ORDER BY p.name
  `).all(department.id);
  if (projects.length) {
    return bad(res, 400, `${department.name} is still on ${projects.map((item) => item.name).join(', ')}. Remove it from those projects first.`);
  }
  const onlyHere = db.prepare(`
    SELECT u.name FROM users u
    JOIN user_departments ud ON ud.user_id = u.id
    WHERE ud.department_id = ?
      AND (SELECT COUNT(*) FROM user_departments other WHERE other.user_id = u.id) = 1
    ORDER BY u.name
  `).all(department.id);
  if (onlyHere.length) {
    const names = onlyHere.map((item) => item.name).join(', ');
    const verb = onlyHere.length === 1 ? 'belongs' : 'belong';
    return bad(res, 400, `${names} ${verb} only to ${department.name}. Move them to another department first.`);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM user_departments WHERE department_id = ?').run(department.id);
    db.prepare('DELETE FROM departments WHERE id = ?').run(department.id);
    logActivity(req.auth.id, `${req.auth.name} removed the ${department.name} department.`);
  })();
  res.json({ ok: true });
});

app.get('/api/projects', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT p.*
    FROM projects p
    LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    LEFT JOIN project_departments pd ON pd.project_id = p.id
    LEFT JOIN user_departments ud ON ud.department_id = pd.department_id AND ud.user_id = ?
    WHERE ? = 1 OR pm.user_id IS NOT NULL OR ud.user_id IS NOT NULL
    ORDER BY p.start_date, p.name
  `).all(req.auth.id, req.auth.id, req.auth.isAdmin ? 1 : 0);
  res.json({ projects: rows.map((row) => presentProject(row, req.auth)) });
});

app.post('/api/projects', requireAuth, (req, res) => {
  if (!req.auth.isAdmin && !req.auth.isLead) return bad(res, 403, 'Only an admin or a team lead can create a project');
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
  const departmentMarks = departmentIds.map(() => '?').join(',');
  const foundDepartments = db.prepare(`SELECT id FROM departments WHERE id IN (${departmentMarks})`).all(...departmentIds);
  if (foundDepartments.length !== departmentIds.length) return bad(res, 400, 'Choose a real department');
  for (const memberId of memberIds) {
    const member = activeUser(memberId);
    if (!member) return bad(res, 400, 'Add active people only');
    if (!userInDepartments(memberId, departmentIds)) {
      return bad(res, 400, `${member.name} is not in the selected departments`);
    }
  }
  const projectId = id('prj');
  db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, name, description, status, start_date, end_date, created_by, created_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(projectId, name.value, description.value, startDate, endDate, req.auth.id, now());
    const addDepartment = db.prepare('INSERT INTO project_departments (project_id, department_id) VALUES (?, ?)');
    for (const departmentId of departmentIds) addDepartment.run(projectId, departmentId);
    const addMember = db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const memberId of memberIds) addMember.run(projectId, memberId);
    logActivity(req.auth.id, `${req.auth.name} created the project “${name.value}”.`, null, projectId);
  })();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  res.status(201).json({ project: presentProject(row, req.auth, true) });
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return bad(res, 404, 'Project not found');
  if (!canViewProject(req.auth, row.id)) return bad(res, 403, 'You can’t see this project');
  res.json({ project: presentProject(row, req.auth, true) });
});

app.patch('/api/projects/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return bad(res, 404, 'Project not found');
  if (!managesProject(req.auth, row)) return bad(res, 403, 'Only an admin or the person who created this project can change it');
  const name = readText(req.body.name, 120, 'a project name', true);
  if (name.error) return bad(res, 400, name.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  const status = req.body.status || row.status;
  if (!new Set(['active', 'paused', 'done']).has(status)) return bad(res, 400, 'Choose a project status');
  db.prepare('UPDATE projects SET name = ?, description = ?, status = ? WHERE id = ?').run(name.value, description.value, status, row.id);
  logActivity(req.auth.id, `${req.auth.name} updated the project “${name.value}”.`, null, row.id);
  const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id);
  res.json({ project: presentProject(fresh, req.auth, true) });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return bad(res, 404, 'Project not found');
  if (!canDeleteProject(req.auth, row)) return bad(res, 403, 'Only an admin or a team lead on this project can delete it');
  const taskIds = db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(row.id).map((item) => item.id);
  db.transaction(() => {
    if (taskIds.length) {
      const marks = taskIds.map(() => '?').join(',');
      db.prepare(`UPDATE tasks SET handoff_task_id = NULL, updated_at = ? WHERE handoff_task_id IN (${marks})`).run(now(), ...taskIds);
      db.prepare(`DELETE FROM tasks WHERE id IN (${marks})`).run(...taskIds);
    }
    db.prepare('DELETE FROM recurring_rules WHERE project_id = ?').run(row.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
    logActivity(req.auth.id, `${req.auth.name} deleted the project “${row.name}” and its tasks.`);
  })();
  res.json({ ok: true });
});

app.patch('/api/projects/:id/timeline', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return bad(res, 404, 'Project not found');
  if (!canViewProject(req.auth, row.id)) return bad(res, 403, 'You can’t see this project');
  const leads = presentProject(row, req.auth).canEditTimeline;
  if (!leads) return bad(res, 403, 'Only an admin or this project’s team lead can move the timeline');
  let reason = String(req.body.reason || '').trim();
  if (!req.auth.isAdmin && reason.length < 8) {
    return bad(res, 400, 'Write a short reason for the date change (at least 8 characters).');
  }
  if (!reason) reason = 'Updated by admin';
  if (reason.length > 500) return bad(res, 400, 'Keep the reason under 500 characters');
  const { startDate, endDate } = req.body;
  if (!isISODate(startDate) || !isISODate(endDate) || endDate < startDate) {
    return bad(res, 400, 'Check the project start and end dates');
  }
  const before = timelineSnapshot(row.id);
  db.transaction(() => {
    db.prepare('UPDATE projects SET start_date = ?, end_date = ? WHERE id = ?').run(startDate, endDate, row.id);
    const after = timelineSnapshot(row.id);
    db.prepare(`
      INSERT INTO timeline_changes (id, project_id, actor_id, reason, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id('tlc'), row.id, req.auth.id, reason, JSON.stringify(before), JSON.stringify(after), now());
    logActivity(req.auth.id, `${req.auth.name} changed the timeline for ${row.name}. ${reason}`, null, row.id);
  })();
  notifyProject(row.id, req.auth, `${req.auth.name} changed the timeline for ${row.name}. ${reason}`);
  const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id);
  res.json({ project: presentProject(fresh, req.auth, true) });
});

app.post('/api/projects/:id/members', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return bad(res, 404, 'Project not found');
  if (!canAssignOnProject(req.auth, row)) return bad(res, 403, 'A team lead on this project can add people');
  const member = activeUser(req.body.userId);
  if (!member) return bad(res, 400, 'Choose an active person');
  if (isProjectMember(row.id, member.id)) return bad(res, 400, 'They are already on this project');
  const departmentIds = db.prepare('SELECT department_id FROM project_departments WHERE project_id = ?').all(row.id).map((item) => item.department_id);
  if (!userInDepartments(member.id, departmentIds)) {
    return bad(res, 400, `${member.name} is not in this project’s departments`);
  }
  db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(row.id, member.id);
  logActivity(req.auth.id, `${req.auth.name} added ${member.name} to ${row.name}.`, null, row.id);
  notify(member.id, `${req.auth.name} added you to ${row.name}.`, null, row.id);
  res.json({ project: presentProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id), req.auth, true) });
});

app.delete('/api/projects/:id/members/:userId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return bad(res, 404, 'Project not found');
  if (!canAssignOnProject(req.auth, row)) return bad(res, 403, 'A team lead on this project can remove people');
  const open = db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE project_id = ? AND assignee_id = ? AND status != 'done'
  `).get(row.id, req.params.userId).n;
  if (open) return bad(res, 400, 'They still have open work on this project');
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(row.id, req.params.userId);
  logActivity(req.auth.id, `${req.auth.name} removed a person from ${row.name}.`, null, row.id);
  res.json({ project: presentProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id), req.auth, true) });
});

app.get('/api/tasks', requireAuth, (req, res) => {
  const scope = ['team', 'project', 'person'].includes(req.query.scope) ? req.query.scope : 'mine';
  const where = [];
  const params = [];
  let weekStart = null;
  let weekEnd = null;
  let isCurrent = false;
  let previousWeekStart = null;

  if (scope === 'project') {
    const projectId = req.query.projectId;
    if (!projectId) return bad(res, 400, 'Choose a project');
    if (!canViewProject(req.auth, projectId)) return bad(res, 403, 'You can’t see this project');
    where.push('t.project_id = ?');
    params.push(projectId);
    weekEnd = '9999-99-99';
  } else {
    const requested = isISODate(req.query.week) ? req.query.week : isoDate(new Date());
    const monday = startOfWeek(requested);
    weekStart = isoDate(monday);
    weekEnd = isoDate(addDays(monday, 6));
    isCurrent = weekStart === isoDate(startOfWeek(new Date()));
    const includePrevious = isCurrent && (scope === 'mine' || scope === 'person');
    if (includePrevious) previousWeekStart = weekStart;
    const prevStart = isoDate(addDays(monday, -7));
    ensureRecurring(weekStart, weekEnd);
    if (scope === 'mine' || scope === 'person') {
      const assigneeId = scope === 'person' ? req.query.userId : req.auth.id;
      if (scope === 'person') {
        if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(assigneeId)) return bad(res, 404, 'Person not found');
        if (!req.auth.isAdmin && !assigneeInLeadDepts(req.auth, assigneeId)) {
          return bad(res, 403, 'You can open boards for people on a team you lead');
        }
      }
      where.push('t.assignee_id = ?');
      params.push(assigneeId);
    } else {
      const departmentId = req.query.departmentId;
      if (!departmentId) return bad(res, 400, 'Choose a department');
      if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) return bad(res, 404, 'Department not found');
      if (!req.auth.isAdmin && !req.auth.departmentIds.includes(departmentId)) {
        return bad(res, 403, 'You are not in that department');
      }
      where.push('t.assignee_id IN (SELECT user_id FROM user_departments WHERE department_id = ?)');
      params.push(departmentId);
      const seesWholeTeam = req.auth.isAdmin || req.auth.leadDepartmentIds.includes(departmentId);
      if (!seesWholeTeam) {
        where.push('t.assignee_id = ?');
        params.push(req.auth.id);
      }
    }
    where.push(`(
      (t.due_date >= ? AND t.due_date <= ?)
      OR (t.status = 'done' AND substr(t.completed_at, 1, 10) >= ? AND substr(t.completed_at, 1, 10) <= ?)
      OR (? = 1 AND t.due_date > ? AND t.status != 'done' AND t.parent_task_id IS NOT NULL)
      OR (? = 1 AND t.due_date >= ? AND t.due_date < ? AND t.status != 'done')
    )`);
    params.push(weekStart, weekEnd, weekStart, weekEnd, isCurrent ? 1 : 0, weekEnd, includePrevious ? 1 : 0, prevStart, weekStart);
  }

  let rows = db.prepare(`
    ${TASK_SQL}
    WHERE ${where.join(' AND ')}
    ORDER BY t.due_date, t.title
  `).all(...params);
  if (isCurrent && scope !== 'project') {
    const hasTodo = rows.some((row) => row.status === 'upcoming' && row.due_date >= weekStart && row.due_date <= weekEnd);
    if (!hasTodo) {
      const horizon = isoDate(addDays(parseISODate(weekEnd), 28));
      const scopeWhere = where.slice(0, -1);
      const scopeParams = params.slice(0, -9);
      const extra = db.prepare(`
        ${TASK_SQL}
        WHERE ${scopeWhere.join(' AND ')}
          AND t.status != 'done'
          AND t.due_date > ?
          AND t.due_date <= ?
        ORDER BY t.due_date, t.title
      `).all(...scopeParams, weekEnd, horizon);
      const seen = new Set(rows.map((row) => row.id));
      rows = rows.concat(extra.filter((row) => !seen.has(row.id)).map((row) => ({ ...row, from_next: 1 })));
    }
  }
  res.json({
    tasks: rows.map((row) => mapTask(row, weekEnd, previousWeekStart)),
    weekStart,
    weekEnd: scope === 'project' ? null : weekEnd,
    isCurrent,
  });
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  if (!isISODate(req.body.dueDate)) return bad(res, 400, 'Choose a due date');
  const priority = PRIORITIES.has(req.body.priority) ? req.body.priority : 'medium';
  const projectId = req.body.projectId || null;
  let assigneeId = req.body.assigneeId || req.auth.id;
  const project = projectId ? db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) : null;
  const assigningSomeoneElse = assigneeId !== req.auth.id;
  if (assigningSomeoneElse) {
    const allowed = project ? canAssignOnProject(req.auth, project) : (req.auth.isAdmin || req.auth.isLead);
    if (!allowed) return bad(res, 403, 'You can add this task for yourself');
  }
  const assignee = activeUser(assigneeId);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  if (projectId) {
    if (!project) return bad(res, 404, 'Project not found');
    if (project.status === 'done') return bad(res, 400, 'This project is marked done');
    const onProject = isProjectMember(projectId, req.auth.id) || canAssignOnProject(req.auth, project);
    if (!onProject) return bad(res, 403, 'Only people on the project can add their part');
    if (!isProjectMember(projectId, assigneeId)) return bad(res, 400, 'Add them to the project before assigning this task');
  }
  try {
    const taskId = db.transaction(() => {
      const createdId = insertTaskRow({
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
      if (assigneeId !== req.auth.id) {
        notify(assigneeId, `${req.auth.name} assigned “${title.value}” to you.`, createdId, projectId);
      }
      logActivity(req.auth.id, `${req.auth.name} added “${title.value}”.`, createdId, projectId);
      if (req.body.handoff) createHandoff(createdId, req.auth, req.body.handoff);
      return createdId;
    })();
    res.status(201).json({ task: mapTask(loadTask(taskId), '9999-99-99') });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at AS createdAt, c.author_id AS authorId, COALESCE(NULLIF(c.author_name, ''), u.name) AS authorName
    FROM comments c JOIN users u ON u.id = c.author_id
    WHERE c.task_id = ? ORDER BY c.created_at
  `).all(task.id);
  const requests = db.prepare(`
    SELECT r.id, r.kind, r.note, r.status, r.created_at AS createdAt, r.requester_id AS requesterId, u.name AS requesterName
    FROM task_requests r JOIN users u ON u.id = r.requester_id
    WHERE r.task_id = ? AND r.status = 'open'
    ORDER BY r.created_at
  `).all(task.id);
  const followups = db.prepare(`
    SELECT t.id, t.title, t.status, t.due_date AS dueDate, t.assignee_id AS assigneeId, u.name AS assigneeName
    FROM tasks t
    JOIN users u ON u.id = t.assignee_id
    WHERE t.parent_task_id = ?
    ORDER BY t.due_date, t.title
  `).all(task.id);
  res.json({ task: mapTask(task, '9999-99-99'), comments, chain: taskChain(task.id), requests, followups });
});

app.post('/api/tasks/:id/comments', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  const body = readText(req.body.body, 2000, 'a comment', true);
  if (body.error) return bad(res, 400, body.error);
  db.prepare('INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id('cmt'), task.id, req.auth.id, body.value, now());
  logActivity(req.auth.id, `${req.auth.name} commented on “${task.title}”.`, task.id, task.project_id);
  for (const userId of new Set([task.assignee_id, task.creator_id])) {
    if (userId !== req.auth.id) notify(userId, `${req.auth.name} commented on “${task.title}”.`, task.id, task.project_id);
  }
  res.status(201).json({ ok: true });
});

app.get('/api/trends', requireAuth, (req, res) => {
  const userId = req.query.userId || req.auth.id;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) return bad(res, 404, 'Person not found');
  if (userId !== req.auth.id && !req.auth.isAdmin && !assigneeInLeadDepts(req.auth, userId)) {
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
  const rows = db.prepare(`
    SELECT completed_at FROM tasks
    WHERE assignee_id = ? AND status = 'done' AND completed_at IS NOT NULL
  `).all(userId);
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
});

app.post('/api/tasks/:id/followup', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  if (!canGovernTask(req.auth, task)) return bad(res, 403, 'Only a team lead can assign a follow-up');
  if (task.status !== 'review') return bad(res, 400, 'Assign a follow-up from a task that is in Review');
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  if (!isISODate(req.body.dueDate)) return bad(res, 400, 'Choose a due date');
  const assignee = activeUser(req.body.assigneeId || task.assignee_id);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  if (task.project_id && !isProjectMember(task.project_id, assignee.id)) {
    return bad(res, 400, 'Add them to the project before assigning this follow-up');
  }
  try {
    const childId = db.transaction(() => {
      const createdId = insertTaskRow({
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
        db.prepare('UPDATE tasks SET handoff_task_id = ?, updated_at = ? WHERE id = ?').run(createdId, now(), task.id);
      }
      if (assignee.id !== req.auth.id) {
        notify(assignee.id, `${req.auth.name} added “${title.value}” to your To do, following “${task.title}”.`, createdId, task.project_id);
      }
      logActivity(req.auth.id, `${req.auth.name} assigned follow-up “${title.value}” to ${assignee.name}.`, createdId, task.project_id);
      return createdId;
    })();
    res.status(201).json({ task: mapTask(loadTask(childId), '9999-99-99') });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
});

app.post('/api/tasks/:id/handoff', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  if (!req.auth.isAdmin && req.auth.id !== task.assignee_id) {
    return bad(res, 403, 'Only the person doing this task can name who takes it next');
  }
  try {
    const childId = db.transaction(() => createHandoff(task.id, req.auth, req.body))();
    res.status(201).json({ task: mapTask(loadTask(childId), '9999-99-99') });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
});

app.patch('/api/tasks/:id/status', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!STATUSES.has(req.body.status)) return bad(res, 400, 'Choose a status');
  if (!canSeeTask(req.auth, task)) return bad(res, 403, 'You can’t see this task');
  const next = req.body.status;
  if (next !== task.status) {
    const governs = canGovernTask(req.auth, task);
    const ownStep = req.auth.id === task.assignee_id && (
      (task.status === 'upcoming' && next === 'in_progress')
      || (task.status === 'in_progress' && next === 'review')
    );
    if (!governs && !ownStep) {
      if (next === 'done') return bad(res, 403, 'Your team lead marks this done after review');
      return bad(res, 403, 'Move this from To do to In progress, then to Review for your team lead');
    }
    if (next === 'done') {
      const waiting = openDependencyBlock(task.id);
      if (waiting) return bad(res, 400, waiting);
    }
    writeStatus(task.id, next, task.completed_at);
    noteStatus(task, next, req.auth);
  }
  res.json({ task: mapTask(loadTask(task.id), '9999-99-99') });
});

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!canGovernTask(req.auth, task)) return bad(res, 403, 'Only an admin or the team lead can edit this task');
  const title = readText(req.body.title, 140, 'a title', true);
  if (title.error) return bad(res, 400, title.error);
  const description = readText(req.body.description, 4000, 'the description');
  if (description.error) return bad(res, 400, description.error);
  if (!isISODate(req.body.dueDate)) return bad(res, 400, 'Choose a due date');
  if (!PRIORITIES.has(req.body.priority)) return bad(res, 400, 'Choose a priority');
  if (!STATUSES.has(req.body.status)) return bad(res, 400, 'Choose a status');
  const assignee = activeUser(req.body.assigneeId);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  if (task.project_id && !isProjectMember(task.project_id, assignee.id)) {
    return bad(res, 400, 'The assignee needs to be on this project');
  }
  if (req.body.status === 'done' && task.status !== 'done') {
    const waiting = openDependencyBlock(task.id);
    if (waiting) return bad(res, 400, waiting);
  }
  const completedAt = req.body.status === 'done' ? (task.status === 'done' && task.completed_at ? task.completed_at : now()) : null;
  db.prepare(`
    UPDATE tasks
    SET title = ?, description = ?, assignee_id = ?, due_date = ?, priority = ?, stage_id = NULL, status = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(title.value, description.value, assignee.id, req.body.dueDate, req.body.priority, req.body.status, completedAt, now(), task.id);
  if (assignee.id !== task.assignee_id) {
    notify(assignee.id, `${req.auth.name} assigned “${title.value}” to you.`, task.id, task.project_id);
  }
  logActivity(req.auth.id, `${req.auth.name} edited “${title.value}”.`, task.id, task.project_id);
  if (req.body.status !== task.status) noteStatus({ ...task, title: title.value }, req.body.status, req.auth);
  res.json({ task: mapTask(loadTask(task.id), '9999-99-99') });
});

app.post('/api/tasks/:id/removal', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (req.auth.id !== task.assignee_id) return bad(res, 403, 'Ask from the person this task is assigned to');
  if (canGovernTask(req.auth, task)) return bad(res, 400, 'You can delete this task directly');
  const note = readText(req.body.note, 500, 'a note for your team lead', true);
  if (note.error) return bad(res, 400, note.error);
  if (note.value.length < 8) return bad(res, 400, 'Write a short note for your team lead (at least 8 characters)');
  if (db.prepare(`SELECT 1 FROM task_requests WHERE task_id = ? AND kind = 'remove' AND status = 'open'`).get(task.id)) {
    return bad(res, 400, 'You already asked your team lead to remove this');
  }
  openRequest(task, 'remove', req.auth, note.value);
  for (const userId of requestRecipients(task)) {
    notify(userId, `${req.auth.name} asked to remove “${task.title}”. ${note.value}`, task.id, task.project_id, 'requests');
  }
  logActivity(req.auth.id, `${req.auth.name} asked to remove “${task.title}”.`, task.id, task.project_id);
  res.status(201).json({ ok: true });
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const task = rawTask(req.params.id);
  if (!task) return bad(res, 404, 'Task not found');
  if (!canGovernTask(req.auth, task)) return bad(res, 403, 'Ask your team lead to remove this, and include a note');
  db.prepare('UPDATE tasks SET handoff_task_id = NULL, updated_at = ? WHERE handoff_task_id = ?').run(now(), task.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  logActivity(req.auth.id, `${req.auth.name} deleted “${task.title}”.`, null, task.project_id);
  res.json({ ok: true });
});

app.get('/api/requests', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.kind, r.note, r.status, r.created_at AS createdAt,
      r.requester_id AS requesterId, ru.name AS requesterName,
      t.id AS taskId, t.title AS taskTitle, t.status AS taskStatus,
      t.assignee_id AS assigneeId, t.creator_id AS creatorId, au.name AS assigneeName
    FROM task_requests r
    JOIN tasks t ON t.id = r.task_id
    JOIN users ru ON ru.id = r.requester_id
    JOIN users au ON au.id = t.assignee_id
    WHERE r.status = 'open'
    ORDER BY r.created_at DESC
  `).all();
  const requests = rows
    .filter((row) => req.auth.isAdmin || row.requesterId === req.auth.id || canHandleRequest(req.auth, row))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      note: row.note,
      createdAt: row.createdAt,
      requesterId: row.requesterId,
      requesterName: row.requesterName,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      taskStatus: row.taskStatus,
      assigneeName: row.assigneeName,
      canAnswer: req.auth.isAdmin || (canHandleRequest(req.auth, row) && row.requesterId !== req.auth.id),
    }));
  res.json({ requests });
});

app.post('/api/requests/:id/decline', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT r.*, t.assignee_id, t.creator_id, t.title, t.project_id
    FROM task_requests r JOIN tasks t ON t.id = r.task_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!row || row.status !== 'open') return bad(res, 404, 'Request not found');
  if (!canHandleRequest(req.auth, row)) return bad(res, 403, 'Only the team lead can answer this');
  const note = readText(req.body.note, 500, 'a note');
  if (note.error) return bad(res, 400, note.error);
  db.prepare(`UPDATE task_requests SET status = 'declined', response_note = ? WHERE id = ?`).run(note.value, row.id);
  const label = row.kind === 'remove' ? 'remove' : 'review';
  const message = note.value
    ? `${req.auth.name} declined the request to ${label} “${row.title}”. Note: ${note.value}`
    : `${req.auth.name} declined the request to ${label} “${row.title}”.`;
  notify(row.requester_id, message, row.task_id, row.project_id, 'requests');
  logActivity(req.auth.id, message, row.task_id, row.project_id);
  res.json({ ok: true });
});

function departureCard(request) {
  const departments = db.prepare(`
    SELECT d.name FROM departments d
    JOIN user_departments ud ON ud.department_id = d.id
    WHERE ud.user_id = ? AND d.lead_id = ?
    ORDER BY d.name
  `).all(request.user_id, request.lead_id).map((item) => item.name);
  const items = db.prepare(`
    SELECT i.id, i.task_id, i.rule_id, i.department_ids,
      t.title AS task_title, t.status AS task_status, tp.name AS task_project,
      r.title AS rule_title, rp.name AS rule_project
    FROM departure_items i
    LEFT JOIN tasks t ON t.id = i.task_id
    LEFT JOIN projects tp ON tp.id = t.project_id
    LEFT JOIN recurring_rules r ON r.id = i.rule_id
    LEFT JOIN projects rp ON rp.id = r.project_id
    WHERE i.request_id = ? AND i.done = 0
    ORDER BY COALESCE(t.title, r.title)
  `).all(request.id);
  const peopleFor = (departmentIds) => teammates(String(departmentIds || '').split(',').filter(Boolean), request.user_id);
  return {
    id: request.id,
    userId: request.user_id,
    userName: request.user_name,
    departments,
    tasks: items.filter((item) => item.task_id).map((item) => ({
      id: item.task_id,
      title: item.task_title,
      status: item.task_status,
      projectName: item.task_project,
      people: peopleFor(item.department_ids),
    })),
    rules: items.filter((item) => item.rule_id).map((item) => ({
      id: item.rule_id,
      title: item.rule_title,
      projectName: item.rule_project,
      people: peopleFor(item.department_ids),
    })),
  };
}

app.get('/api/departures', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, u.name AS user_name
    FROM departure_requests d
    JOIN users u ON u.id = d.user_id
    WHERE d.lead_id = ? AND d.status = 'open'
    ORDER BY d.created_at
  `).all(req.auth.id);
  const departures = rows.map((row) => departureCard(row));
  res.json({ departures });
});

app.post('/api/departures/:id/move', requireAuth, (req, res) => {
  const request = db.prepare(`
    SELECT d.*, u.name AS user_name
    FROM departure_requests d
    JOIN users u ON u.id = d.user_id
    WHERE d.id = ?
  `).get(req.params.id);
  if (!request || request.status !== 'open') return bad(res, 404, 'Request not found');
  if (request.lead_id !== req.auth.id) return bad(res, 403, 'Only that team lead can move these tasks');
  const person = db.prepare('SELECT * FROM users WHERE id = ?').get(request.user_id);
  if (!person) return bad(res, 404, 'Person not found');
  const chosenTasks = Array.isArray(req.body.tasks) ? req.body.tasks : [];
  const chosenRules = Array.isArray(req.body.rules) ? req.body.rules : [];
  try {
    const result = db.transaction(() => {
      const items = db.prepare(`
        SELECT * FROM departure_items WHERE request_id = ? AND done = 0
      `).all(request.id);
      for (const item of items) {
        if (item.task_id) {
          const chosen = chosenTasks.find((entry) => entry.id === item.task_id);
          if (!chosen) throw httpError(400, 'Choose someone on your team for each task');
          const assignee = assertTeammate(chosen.assigneeId, item.department_ids, person.id);
          const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(item.task_id);
          if (task) moveDepartureTask(task, assignee, person, req.auth);
        }
        if (item.rule_id) {
          const chosen = chosenRules.find((entry) => entry.id === item.rule_id);
          if (!chosen) throw httpError(400, 'Choose someone on your team for each repeating task');
          const assignee = assertTeammate(chosen.assigneeId, item.department_ids, person.id);
          const rule = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(item.rule_id);
          if (rule) {
            const changed = rule.assignee_id !== assignee.id;
            db.prepare('UPDATE recurring_rules SET assignee_id = ? WHERE id = ?').run(assignee.id, rule.id);
            db.prepare(`
              UPDATE tasks SET assignee_id = ?, updated_at = ?
              WHERE recurring_rule_id = ? AND status != 'done'
            `).run(assignee.id, now(), rule.id);
            if (rule.project_id) {
              db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').run(rule.project_id, assignee.id);
            }
            if (changed) {
              notify(assignee.id, `${req.auth.name} set the repeating task “${rule.title}” for you.`, null, rule.project_id, 'repeating');
              logActivity(req.auth.id, `${req.auth.name} moved the repeating task “${rule.title}” from ${person.name} to ${assignee.name}.`, null, rule.project_id);
            }
          }
        }
        db.prepare('UPDATE departure_items SET done = 1 WHERE id = ?').run(item.id);
      }
      db.prepare(`UPDATE departure_requests SET status = 'done' WHERE id = ?`).run(request.id);
      return maybeFinishDeparture(person.id, req.auth);
    })();
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) return bad(res, error.status, error.message);
    throw error;
  }
});

const RULE_SQL = `
SELECT r.id, r.title, r.description, r.cadence, r.weekday, r.priority, r.assignee_id, r.created_by,
  r.project_id, r.active, r.created_at,
  u.name AS assignee_name, c.name AS creator_name, p.name AS project_name
FROM recurring_rules r
JOIN users u ON u.id = r.assignee_id
JOIN users c ON c.id = r.created_by
LEFT JOIN projects p ON p.id = r.project_id
`;

app.get('/api/recurring', requireAuth, (req, res) => {
  const rules = db.prepare(`${RULE_SQL} ORDER BY r.active DESC, u.name, r.title`).all();
  res.json({ rules: rules.filter((rule) => canTouchRule(req.auth, rule)).map(mapRule) });
});

app.post('/api/recurring', requireAuth, (req, res) => {
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
  if (!req.auth.isAdmin && assigneeId !== req.auth.id && !assigneeInLeadDepts(req.auth, assigneeId)) {
    return bad(res, 403, 'You can add repeating tasks for yourself. Team leads can add them for their department.');
  }
  const assignee = activeUser(assigneeId);
  if (!assignee) return bad(res, 400, 'Choose an active person');
  const projectId = req.body.projectId || null;
  if (projectId) {
    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get(projectId);
    if (!project) return bad(res, 400, 'That project does not exist');
    if (project.status === 'done') return bad(res, 400, 'That project is marked done');
    if (!isProjectMember(projectId, assigneeId)) return bad(res, 400, 'That person is not on the project');
  }
  const ruleId = id('rule');
  db.prepare(`
    INSERT INTO recurring_rules (
      id, title, description, cadence, weekday, priority, assignee_id, created_by, project_id, active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(ruleId, title.value, description.value, cadence, weekday, priority, assigneeId, req.auth.id, projectId, now());
  logActivity(req.auth.id, `${req.auth.name} set “${title.value}” to repeat.`, null, projectId);
  if (assigneeId !== req.auth.id) notify(assigneeId, `${req.auth.name} set a repeating task for you: “${title.value}”.`, null, projectId, 'repeating');
  refreshRecurring();
  const rule = db.prepare(`${RULE_SQL} WHERE r.id = ?`).get(ruleId);
  res.status(201).json({ rule: mapRule(rule) });
});

app.patch('/api/recurring/:id', requireAuth, (req, res) => {
  const rule = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(req.params.id);
  if (!rule) return bad(res, 404, 'Repeating task not found');
  if (!canTouchRule(req.auth, rule)) return bad(res, 403, 'You can’t change this repeating task');
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
  let assigneeId = req.body.assigneeId ?? rule.assignee_id;
  if (assigneeId !== rule.assignee_id && !req.auth.isAdmin && !assigneeInLeadDepts(req.auth, assigneeId)) {
    return bad(res, 403, 'Only an admin or team lead can change who this repeats for');
  }
  if (!activeUser(assigneeId)) return bad(res, 400, 'Choose an active person');
  let projectId = req.body.projectId === undefined ? rule.project_id : (req.body.projectId || null);
  if (projectId && !isProjectMember(projectId, assigneeId)) return bad(res, 400, 'That person is not on the project');
  const active = req.body.active === undefined ? rule.active : (req.body.active ? 1 : 0);
  db.prepare(`
    UPDATE recurring_rules
    SET title = ?, description = ?, cadence = ?, weekday = ?, priority = ?, assignee_id = ?, project_id = ?, active = ?
    WHERE id = ?
  `).run(title.value, description.value, cadence, weekday, priority, assigneeId, projectId, active, rule.id);
  refreshRecurring();
  res.json({ rule: mapRule(db.prepare(`${RULE_SQL} WHERE r.id = ?`).get(rule.id)) });
});

app.delete('/api/recurring/:id', requireAuth, (req, res) => {
  const rule = db.prepare('SELECT * FROM recurring_rules WHERE id = ?').get(req.params.id);
  if (!rule) return bad(res, 404, 'Repeating task not found');
  if (!canTouchRule(req.auth, rule)) return bad(res, 403, 'You can’t change this repeating task');
  db.prepare('DELETE FROM recurring_rules WHERE id = ?').run(rule.id);
  logActivity(req.auth.id, `${req.auth.name} stopped the repeat “${rule.title}”. Future weeks will not add it.`);
  res.json({ ok: true });
});

function hrUserIds() {
  return db.prepare(`
    SELECT DISTINCT u.id AS id
    FROM users u
    JOIN user_departments ud ON ud.user_id = u.id
    JOIN departments d ON d.id = ud.department_id
    WHERE u.active = 1 AND lower(d.name) = 'hr'
    UNION
    SELECT u.id AS id
    FROM departments d
    JOIN users u ON u.id = d.lead_id
    WHERE u.active = 1 AND lower(d.name) = 'hr' AND d.lead_id IS NOT NULL
  `).all().map((row) => row.id);
}

function isHr(auth) {
  return auth.isAdmin || auth.departments.some((item) => item.name.toLowerCase() === 'hr');
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

app.get('/api/attendance/today', requireAuth, (req, res) => {
  const row = db.prepare('SELECT day, check_in, check_out FROM attendance WHERE user_id = ? AND day = ?').get(req.auth.id, todayISO());
  res.json({ record: mapAttendance(row) });
});

app.post('/api/attendance/check-in', requireAuth, (req, res) => {
  const day = todayISO();
  if (weekdayMon1(day) === 7) return bad(res, 400, 'Sunday is off');
  const existing = db.prepare('SELECT check_in FROM attendance WHERE user_id = ? AND day = ?').get(req.auth.id, day);
  if (existing?.check_in) return bad(res, 400, 'You already checked in today');
  const stamp = now();
  if (existing) {
    db.prepare('UPDATE attendance SET check_in = ? WHERE user_id = ? AND day = ?').run(stamp, req.auth.id, day);
  } else {
    db.prepare('INSERT INTO attendance (id, user_id, day, check_in, check_out) VALUES (?, ?, ?, ?, NULL)').run(id('att'), req.auth.id, day, stamp);
  }
  res.status(201).json({ record: mapAttendance(db.prepare('SELECT day, check_in, check_out FROM attendance WHERE user_id = ? AND day = ?').get(req.auth.id, day)) });
});

app.post('/api/attendance/check-out', requireAuth, (req, res) => {
  const day = todayISO();
  if (weekdayMon1(day) === 7) return bad(res, 400, 'Sunday is off');
  const existing = db.prepare('SELECT check_in, check_out FROM attendance WHERE user_id = ? AND day = ?').get(req.auth.id, day);
  if (!existing?.check_in) return bad(res, 400, 'Check in before you check out');
  if (existing.check_out) return bad(res, 400, 'You already checked out today');
  db.prepare('UPDATE attendance SET check_out = ? WHERE user_id = ? AND day = ?').run(now(), req.auth.id, day);
  res.json({ record: mapAttendance(db.prepare('SELECT day, check_in, check_out FROM attendance WHERE user_id = ? AND day = ?').get(req.auth.id, day)) });
});

app.get('/api/attendance', requireAuth, (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) return bad(res, 400, 'Choose a month');
  const userId = req.query.userId || req.auth.id;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return bad(res, 404, 'Person not found');
  if (userId !== req.auth.id && !req.auth.isAdmin && !assigneeInLeadDepts(req.auth, userId)) {
    return bad(res, 403, 'You can open attendance for people on a team you lead');
  }
  const { start, end } = monthBounds(month);
  const records = db.prepare(`
    SELECT day, check_in, check_out FROM attendance
    WHERE user_id = ? AND day >= ? AND day <= ?
    ORDER BY day
  `).all(userId, start, end).map(mapAttendance);
  const dates = db.prepare('SELECT birthday, work_anniversary AS workAnniversary FROM users WHERE id = ?').get(userId);
  res.json({ month, userId, records, birthday: dates?.birthday || null, workAnniversary: dates?.workAnniversary || null });
});

app.get('/api/chores', requireAuth, (req, res) => {
  const chores = db.prepare(`
    SELECT c.id, c.category, c.title, c.details, c.status, c.created_at AS createdAt,
      c.requester_id AS requesterId, u.name AS requesterName
    FROM office_chores c
    JOIN users u ON u.id = c.requester_id
    ORDER BY c.created_at DESC
  `).all();
  res.json({ chores, canClose: isHr(req.auth) });
});

app.post('/api/chores', requireAuth, (req, res) => {
  const category = req.body.category === 'purchasing' ? 'purchasing' : req.body.category === 'maintenance' ? 'maintenance' : '';
  if (!category) return bad(res, 400, 'Choose maintenance or purchasing');
  const title = readText(req.body.title, 140, 'what is needed', true);
  if (title.error) return bad(res, 400, title.error);
  const details = readText(req.body.details, 2000, 'the details');
  if (details.error) return bad(res, 400, details.error);
  const choreId = id('chr');
  db.prepare(`
    INSERT INTO office_chores (id, category, title, details, requester_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `).run(choreId, category, title.value, details.value, req.auth.id, now());
  const label = category === 'purchasing' ? 'Purchasing' : 'Maintenance';
  for (const userId of hrUserIds()) {
    if (userId !== req.auth.id) {
      notify(userId, `${req.auth.name} raised a ${label.toLowerCase()} request: “${title.value}”.`, null, null, 'chores');
    }
  }
  logActivity(req.auth.id, `${req.auth.name} raised “${title.value}” for ${label.toLowerCase()}.`);
  res.status(201).json({ ok: true });
});

app.post('/api/chores/:id/done', requireAuth, (req, res) => {
  if (!isHr(req.auth)) return bad(res, 403, 'HR marks office requests done');
  const chore = db.prepare('SELECT * FROM office_chores WHERE id = ?').get(req.params.id);
  if (!chore) return bad(res, 404, 'Request not found');
  if (chore.status !== 'done') {
    db.prepare(`UPDATE office_chores SET status = 'done' WHERE id = ?`).run(chore.id);
    if (chore.requester_id !== req.auth.id) {
      notify(chore.requester_id, `${req.auth.name} marked “${chore.title}” done.`, null, null, 'chores');
    }
  }
  res.json({ ok: true });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  const notifications = db.prepare(`
    SELECT id, message, task_id AS taskId, project_id AS projectId, area, read, created_at AS createdAt
    FROM notifications WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 40
  `).all(req.auth.id).map((item) => ({ ...item, read: Boolean(item.read) }));
  const unreadCount = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(req.auth.id).n;
  const areas = {};
  for (const row of db.prepare(`
    SELECT area, COUNT(*) AS n FROM notifications
    WHERE user_id = ? AND area_seen = 0 AND area IS NOT NULL
    GROUP BY area
  `).all(req.auth.id)) {
    areas[row.area] = row.n;
  }
  res.json({ notifications, unreadCount, areas });
});

app.post('/api/notifications/seen', requireAuth, (req, res) => {
  const area = String(req.body.area || '');
  if (!/^[a-z]+$/.test(area)) return bad(res, 400, 'Choose a section');
  db.prepare('UPDATE notifications SET area_seen = 1 WHERE user_id = ? AND area = ?').run(req.auth.id, area);
  res.json({ ok: true });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  if (req.body.all) {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.auth.id);
  } else if (Array.isArray(req.body.ids) && req.body.ids.length) {
    const ids = req.body.ids.slice(0, 100);
    const marks = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${marks})`).run(req.auth.id, ...ids);
  }
  res.json({ ok: true });
});

app.get('/api/activity', requireAuth, (req, res) => {
  const events = req.auth.isAdmin || req.auth.isLead
    ? db.prepare(`
        SELECT a.id, a.message, a.task_id AS taskId, a.project_id AS projectId, a.created_at AS createdAt, u.name AS actorName
        FROM activity a JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT DISTINCT a.id, a.message, a.task_id AS taskId, a.project_id AS projectId, a.created_at AS createdAt, u.name AS actorName
        FROM activity a
        JOIN users u ON u.id = a.actor_id
        LEFT JOIN tasks t ON t.id = a.task_id
        LEFT JOIN project_members pm ON pm.project_id = a.project_id AND pm.user_id = ?
        WHERE a.actor_id = ? OR t.assignee_id = ? OR t.creator_id = ? OR pm.user_id IS NOT NULL
        ORDER BY createdAt DESC LIMIT 200
      `).all(req.auth.id, req.auth.id, req.auth.id, req.auth.id);
  res.json({ events });
});

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
  res.status(500).json({ error: 'Something went wrong' });
});

const officeAddresses = lanAddresses();
if (officeAddresses[0]) publishOfficeName(officeAddresses[0]);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kanabana API listening on ${PORT}`);
  if (!officeAddresses.length) return;
  console.log(`On this Wi-Fi, open http://kanabana.local:5173`);
  console.log(`Office API is http://${officeAddresses[0]}:${PORT}`);
});


