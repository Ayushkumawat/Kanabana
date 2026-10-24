import fs from 'fs';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const txContext = new AsyncLocalStorage();

let client;
let transactionMode;

// One long-running Node process on a VM, office traffic (about 20 people, short requests).
// Pool stays small so an idle server does not hold Atlas connections (~1 MB each, plus
// two monitoring connections per replica member). Raise maxPoolSize only if Atlas shows
// operations waiting and the cluster CPU is not already busy.
const CLIENT_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 30_000,
};

export function loadEnv() {
  for (const file of [path.resolve(__dirname, '../.env'), path.resolve(__dirname, '.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const raw = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
      const eq = raw.indexOf('=');
      if (eq < 1) continue;
      const key = raw.slice(0, eq).trim();
      let value = raw.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function databaseName() {
  return process.env.MONGODB_DB || 'kanabana';
}

export function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now() {
  return new Date().toISOString();
}

export async function connectDb() {
  if (client) return client;
  loadEnv();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  const next = new MongoClient(uri, CLIENT_OPTIONS);
  try {
    await next.connect();
    await next.db(databaseName()).command({ ping: 1 });
    client = next;
    return client;
  } catch (error) {
    await next.close().catch(() => {});
    throw error;
  }
}

export async function closeDb() {
  const current = client;
  client = null;
  transactionMode = undefined;
  if (current) await current.close();
}

export async function ping() {
  if (!client) throw new Error('Database is not connected');
  await client.db(databaseName()).command({ ping: 1 });
}

function db() {
  if (!client) throw new Error('Database is not connected');
  return client.db(databaseName());
}

function collection(name) {
  return db().collection(name);
}

function sessionOpt() {
  const session = txContext.getStore();
  return session ? { session } : {};
}

function shape(doc) {
  if (!doc) return null;
  const shaped = { ...doc };
  delete shaped._id;
  return shaped;
}

function asUpdate(update) {
  if (update && Object.keys(update).some((key) => key.startsWith('$'))) return update;
  return { $set: update };
}

function uniqueError(error) {
  if (error?.code !== 11000) throw error;
  const wrapped = new Error('UNIQUE constraint failed');
  wrapped.code = 11000;
  throw wrapped;
}

export async function findOne(name, filter) {
  const doc = await collection(name).findOne(filter, sessionOpt());
  return shape(doc);
}

export async function findMany(name, filter = {}, { sort, limit } = {}) {
  let cursor = collection(name).find(filter, sessionOpt());
  if (sort) cursor = cursor.sort(sort);
  if (limit) cursor = cursor.limit(limit);
  const docs = await cursor.toArray();
  return docs.map(shape);
}

export async function aggregate(name, pipeline) {
  const docs = await collection(name).aggregate(pipeline, sessionOpt()).toArray();
  return docs.map(shape);
}

export async function count(name, filter = {}) {
  return collection(name).countDocuments(filter, sessionOpt());
}

export async function exists(name, filter) {
  const doc = await collection(name).findOne(filter, { projection: { _id: 1 }, ...sessionOpt() });
  return Boolean(doc);
}

export async function insertOne(name, doc) {
  const key = doc._id ?? doc.id;
  const toSave = { ...doc, _id: key };
  if (toSave.id == null && key != null && !String(key).includes(':')) toSave.id = key;
  try {
    await collection(name).insertOne(toSave, sessionOpt());
  } catch (error) {
    uniqueError(error);
  }
  return key;
}

export async function insertIgnore(name, doc, match) {
  const filter = match || { _id: doc._id ?? doc.id };
  if (await findOne(name, filter)) return false;
  try {
    await insertOne(name, doc);
    return true;
  } catch (error) {
    if (!txContext.getStore() && (error.code === 11000 || String(error.message).includes('UNIQUE'))) return false;
    throw error;
  }
}

export async function updateOne(name, filter, update) {
  const result = await collection(name).updateOne(filter, asUpdate(update), sessionOpt());
  return result.matchedCount;
}

export async function updateMany(name, filter, update) {
  const result = await collection(name).updateMany(filter, asUpdate(update), sessionOpt());
  return result.modifiedCount;
}

export async function deleteOne(name, filter) {
  const result = await collection(name).deleteOne(filter, sessionOpt());
  return result.deletedCount;
}

export async function deleteMany(name, filter) {
  const result = await collection(name).deleteMany(filter, sessionOpt());
  return result.deletedCount;
}

export async function replaceOne(name, doc) {
  const key = doc._id ?? doc.id;
  const toSave = { ...doc, _id: key };
  if (toSave.id == null && key != null && !String(key).includes(':')) toSave.id = key;
  await collection(name).replaceOne({ _id: key }, toSave, { upsert: true });
}

async function supportsTransactions() {
  if (transactionMode != null) return transactionMode;
  const hello = await db().admin().command({ hello: 1 });
  transactionMode = hello.msg === 'isdbgrid' || Boolean(hello.setName);
  return transactionMode;
}

export async function withTx(fn) {
  if (txContext.getStore()) return fn();
  if (!(await supportsTransactions())) return fn();
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await txContext.run(session, () => fn());
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export async function ensureIndexes() {
  const database = db();
  await database.collection('users').createIndex({ email: 1 }, { unique: true });
  await database.collection('users').createIndex({ role: 1, active: 1 });
  await database.collection('departments').createIndex({ name: 1 }, { unique: true });
  await database.collection('departments').createIndex({ lead_id: 1 });
  await database.collection('user_departments').createIndex({ user_id: 1 });
  await database.collection('user_departments').createIndex({ department_id: 1 });
  await database.collection('projects').createIndex({ created_by: 1 });
  await database.collection('projects').createIndex({ start_date: 1, name: 1 });
  await database.collection('project_departments').createIndex({ project_id: 1 });
  await database.collection('project_departments').createIndex({ department_id: 1 });
  await database.collection('project_members').createIndex({ project_id: 1 });
  await database.collection('project_members').createIndex({ user_id: 1 });
  await database.collection('tasks').createIndex({ assignee_id: 1, due_date: 1 });
  await database.collection('tasks').createIndex({ project_id: 1 });
  await database.collection('tasks').createIndex({ creator_id: 1 });
  await database.collection('tasks').createIndex({ parent_task_id: 1 });
  await database.collection('tasks').createIndex({ handoff_task_id: 1 });
  await database.collection('tasks').createIndex(
    { recurring_rule_id: 1, due_date: 1 },
    { unique: true, partialFilterExpression: { recurring_rule_id: { $type: 'string' } }, name: 'tasks_rule_due' },
  );
  await database.collection('comments').createIndex({ task_id: 1, created_at: 1 });
  await database.collection('notifications').createIndex({ user_id: 1, read: 1 });
  await database.collection('notifications').createIndex({ user_id: 1, area_seen: 1, area: 1 });
  await database.collection('activity').createIndex({ created_at: -1 });
  await database.collection('activity').createIndex({ actor_id: 1 });
  await database.collection('task_requests').createIndex({ task_id: 1, status: 1 });
  await database.collection('attendance').createIndex({ user_id: 1, day: 1 }, { unique: true });
  await database.collection('office_chores').createIndex({ created_at: -1 });
  await database.collection('departure_requests').createIndex({ user_id: 1, lead_id: 1 }, { unique: true });
  await database.collection('departure_requests').createIndex({ lead_id: 1, status: 1 });
  await database.collection('departure_requests').createIndex({ user_id: 1, status: 1 });
  await database.collection('departure_items').createIndex({ request_id: 1, done: 1 });
  await database.collection('knowledge_items').createIndex({ kind: 1, created_at: -1 });
  await database.collection('knowledge_items').createIndex({ user_id: 1 });
  await database.collection('knowledge_items').createIndex({ project_id: 1 });
  await database.collection('task_dependencies').createIndex({ task_id: 1, status: 1 });
  await database.collection('task_dependencies').createIndex({ depends_on_id: 1, status: 1 });
  await database.collection('hiring_positions').createIndex({ department_id: 1 });
  await database.collection('hiring_resumes').createIndex({ position_id: 1, status: 1 });
  await database.collection('hiring_checks').createIndex({ resume_id: 1 });
  await database.collection('notepad_days').createIndex({ user_id: 1, day: 1 }, { unique: true });
  await database.collection('notepad_days').createIndex({ user_id: 1, position: 1 });
  await database.collection('reports').createIndex({ created_at: -1 });
  await database.collection('report_shots').createIndex({ report_id: 1 });
  await database.collection('tenders').createIndex({ last_date: 1 });
  await database.collection('timeline_changes').createIndex({ project_id: 1, created_at: -1 });
  await database.collection('recurring_rules').createIndex({ assignee_id: 1 });
}
