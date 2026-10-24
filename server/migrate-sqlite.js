import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { closeDb, connectDb, count, databaseName, ensureIndexes, loadEnv, replaceOne } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABLES = [
  'users',
  'departments',
  'user_departments',
  'projects',
  'project_departments',
  'project_members',
  'project_stages',
  'timeline_changes',
  'recurring_rules',
  'tasks',
  'comments',
  'notifications',
  'activity',
  'task_requests',
  'attendance',
  'office_chores',
  'departure_requests',
  'departure_items',
  'departure_holds',
  'knowledge_items',
  'tenders',
  'task_dependencies',
  'hiring_positions',
  'hiring_resumes',
  'hiring_checks',
  'personal_notes',
  'notepad_days',
  'reports',
  'report_shots',
];

function identity(table, row) {
  if (table === 'user_departments') return `${row.user_id}:${row.department_id}`;
  if (table === 'project_departments') return `${row.project_id}:${row.department_id}`;
  if (table === 'project_members') return `${row.project_id}:${row.user_id}`;
  if (table === 'departure_holds' || table === 'personal_notes') return row.user_id;
  return row.id;
}

function document(table, row) {
  const key = identity(table, row);
  const doc = { _id: key };
  for (const [field, value] of Object.entries(row)) doc[field] = value;
  if (row.id != null) doc.id = row.id;
  return doc;
}

async function main() {
  loadEnv();
  const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'kanabana.db');
  if (!fs.existsSync(sqlitePath)) {
    console.error(`No SQLite file at ${sqlitePath}.`);
    console.error('Start the app against an empty Atlas database and add people in Kanabana, or set SQLITE_PATH.');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('Set MONGODB_URI to the Atlas connection string, then run this again.');
    process.exit(1);
  }
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch {
    console.error('Install the SQLite reader once, from the server folder: npm install better-sqlite3');
    process.exit(1);
  }
  const sqlite = new Database(sqlitePath, { fileMustExist: true, readonly: true });
  await connectDb();
  const force = process.argv.includes('--force');
  const existing = await count('users');
  if (existing && !force) {
    console.error(`MongoDB database “${databaseName()}” already has ${existing} people.`);
    console.error('Re-run with --force only if you mean to overwrite those records with the SQLite file.');
    process.exit(1);
  }
  for (const table of TABLES) {
    const found = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!found) {
      console.log(`${table}: skipped, not in this SQLite file`);
      continue;
    }
    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    for (const row of rows) await replaceOne(table, document(table, row));
    console.log(`${table}: ${rows.length}`);
  }
  await ensureIndexes();
  const people = await count('users');
  const departments = await count('departments');
  console.log(`Copied into “${databaseName()}”. People: ${people}. Departments: ${departments}.`);
  console.log('Passwords were copied as they are, so the same logins keep working.');
  sqlite.close();
  await closeDb();
}

const isDirect = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
