import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { addDays, eachDate, isoDate, startOfWeek, weekdayMon1 } from './dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'kanabana.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 3000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  lead_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_departments (
  user_id TEXT NOT NULL REFERENCES users(id),
  department_id TEXT NOT NULL REFERENCES departments(id),
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_departments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  department_id TEXT NOT NULL REFERENCES departments(id),
  PRIMARY KEY (project_id, department_id)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_stages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL,
  weekday INTEGER,
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id),
  stage_id TEXT REFERENCES project_stages(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  assignee_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  due_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  recurring_rule_id TEXT REFERENCES recurring_rules(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  handoff_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  task_id TEXT,
  project_id TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_rule_due
  ON tasks(recurring_rule_id, due_date)
  WHERE recurring_rule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due ON tasks(assignee_id, due_date);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

CREATE TABLE IF NOT EXISTS task_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  requester_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_requests_task ON task_requests(task_id, status);
`);

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

export function logActivity(actorId, message, taskId = null, projectId = null) {
  db.prepare(`
    INSERT INTO activity (id, actor_id, message, task_id, project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id('act'), actorId, message, taskId, projectId, now());
}

export function notify(userId, message, taskId = null, projectId = null, area = null) {
  if (!userId) return;
  const user = db.prepare('SELECT active FROM users WHERE id = ?').get(userId);
  if (!user?.active) return;
  const section = area || (taskId ? 'board' : projectId ? 'projects' : null);
  db.prepare(`
    INSERT INTO notifications (id, user_id, message, task_id, project_id, read, area, area_seen, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)
  `).run(id('ntf'), userId, message, taskId, projectId, section, now());
}

const insertOccurrence = db.prepare(`
  INSERT OR IGNORE INTO tasks (
    id, title, description, project_id, stage_id, creator_id, assignee_id,
    status, priority, due_date, kind, recurring_rule_id, parent_task_id, handoff_task_id,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'upcoming', ?, ?, 'recurring', ?, NULL, NULL, ?, ?)
`);

export function ensureRecurring(weekStart, weekEnd) {
  const currentStart = isoDate(startOfWeek(new Date()));
  if (weekEnd < currentStart) return;
  const rules = db.prepare('SELECT * FROM recurring_rules WHERE active = 1').all();
  const stamp = now();
  const run = db.transaction(() => {
    for (const date of eachDate(weekStart, weekEnd)) {
      if (date < currentStart) continue;
      const weekday = weekdayMon1(date);
      for (const rule of rules) {
        if (rule.cadence === 'daily' && weekday === 7) continue;
        if (rule.cadence === 'weekly' && weekday !== rule.weekday) continue;
        insertOccurrence.run(
          id('task'),
          rule.title,
          rule.description,
          rule.project_id,
          rule.assignee_id,
          rule.assignee_id,
          rule.priority,
          date,
          rule.id,
          stamp,
          stamp,
        );
      }
    }
  });
  run();
}

const taskColumns = db.prepare('PRAGMA table_info(tasks)').all();
if (!taskColumns.some((column) => column.name === 'completed_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN completed_at TEXT');
}
db.prepare(`
  UPDATE tasks
  SET completed_at = updated_at
  WHERE status = 'done' AND (completed_at IS NULL OR completed_at = '')
`).run();

const noteColumns = db.prepare('PRAGMA table_info(notifications)').all();
if (!noteColumns.some((column) => column.name === 'area')) {
  db.exec('ALTER TABLE notifications ADD COLUMN area TEXT');
}
if (!noteColumns.some((column) => column.name === 'area_seen')) {
  db.exec('ALTER TABLE notifications ADD COLUMN area_seen INTEGER NOT NULL DEFAULT 0');
}
db.exec(`
  UPDATE notifications
  SET area = CASE
    WHEN task_id IS NOT NULL THEN 'board'
    WHEN project_id IS NOT NULL THEN 'projects'
    ELSE area
  END
  WHERE area IS NULL
`);
db.exec('UPDATE notifications SET area_seen = 1 WHERE read = 1');

db.exec(`
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  check_in TEXT,
  check_out TEXT,
  UNIQUE(user_id, day)
);

CREATE TABLE IF NOT EXISTS office_chores (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  requester_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attendance_user_day ON attendance(user_id, day);
CREATE INDEX IF NOT EXISTS idx_chores_created ON office_chores(created_at);

CREATE TABLE IF NOT EXISTS departure_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  lead_id TEXT NOT NULL REFERENCES users(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  UNIQUE(user_id, lead_id)
);

CREATE TABLE IF NOT EXISTS departure_items (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES departure_requests(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES recurring_rules(id) ON DELETE CASCADE,
  department_ids TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_departure_lead ON departure_requests(lead_id, status);
CREATE INDEX IF NOT EXISTS idx_departure_items_request ON departure_items(request_id, done);
`);

db.exec('DROP TABLE IF EXISTS task_details');

for (const [table, column] of [['comments', 'author_name'], ['timeline_changes', 'actor_name']]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

const userColumns = db.prepare('PRAGMA table_info(users)').all();
if (!userColumns.some((column) => column.name === 'birthday')) db.exec('ALTER TABLE users ADD COLUMN birthday TEXT');
if (!userColumns.some((column) => column.name === 'work_anniversary')) db.exec('ALTER TABLE users ADD COLUMN work_anniversary TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS departure_holds (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  link TEXT,
  file_name TEXT,
  file_stored TEXT,
  person_name TEXT NOT NULL DEFAULT '',
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  organisation TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '',
  emd TEXT NOT NULL DEFAULT '',
  last_date TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL REFERENCES users(id),
  depends_on_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hiring_positions (
  id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES departments(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hiring_resumes (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL REFERENCES hiring_positions(id) ON DELETE CASCADE,
  candidate_name TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  referral INTEGER NOT NULL DEFAULT 0,
  referral_name TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  file_stored TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'new',
  reviewer_id TEXT REFERENCES users(id),
  round INTEGER NOT NULL DEFAULT 1,
  meet_link TEXT NOT NULL DEFAULT '',
  interview_date TEXT,
  interview_time TEXT NOT NULL DEFAULT '',
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hiring_checks (
  id TEXT PRIMARY KEY,
  resume_id TEXT NOT NULL REFERENCES hiring_resumes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS personal_notes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_kind ON knowledge_items(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_dependencies_task ON task_dependencies(task_id, status);
CREATE INDEX IF NOT EXISTS idx_resumes_position ON hiring_resumes(position_id, status);
`);

const bootMonday = startOfWeek(new Date());
ensureRecurring(isoDate(bootMonday), isoDate(addDays(bootMonday, 13)));
