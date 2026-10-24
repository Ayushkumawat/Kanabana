import bcrypt from 'bcryptjs';
import { addDays, isoDate, parseISODate, startOfWeek, todayISO } from './dates.js';
import { count, insertOne, now, updateOne } from './store.js';

const admin = 'usr_admin';
const priya = 'usr_priya';
const arun = 'usr_arun';
const lena = 'usr_lena';
const samir = 'usr_samir';
const fullstack = 'dep_fullstack';
const ai = 'dep_ai';
const project = 'prj_portal';
const sketch = 'task_sketch';
const nav = 'task_nav';
const shell = 'task_shell';
const model = 'task_model';
const evaluation = 'task_eval';
const review = 'task_review';
const audit = 'task_audit';
const confirm = 'task_confirm';
const ruleDeploy = 'rule_deploy';
const ruleQuality = 'rule_quality';

export async function seedIfEmpty() {
  if (await count('users')) {
    console.log('Database already has people. Skipping the demo office.');
    return false;
  }
  const stamp = now();
  const earlier = new Date(Date.now() - 86400000).toISOString();
  const adminHash = bcrypt.hashSync('Admin123!', 10);
  const demoHash = bcrypt.hashSync('Demo123!', 10);
  const monday = startOfWeek(new Date());
  const mon = isoDate(monday);
  const tue = isoDate(addDays(monday, 1));
  const fri = isoDate(addDays(monday, 4));
  const nextWed = isoDate(addDays(monday, 9));
  const launchEnd = isoDate(addDays(monday, 25));
  const earlierLaunchEnd = isoDate(addDays(parseISODate(launchEnd), -2));
  const lastWed = isoDate(addDays(monday, -5));
  const yesterday = isoDate(addDays(parseISODate(todayISO()), -1));

  const addUser = (id, name, email, password, role) => insertOne('users', {
    id, name, email, password_hash: password, role, active: 1, created_at: stamp, birthday: null, work_anniversary: null,
  });
  await addUser(admin, 'Asha Menon', 'admin@kanabana.local', adminHash, 'admin');
  await addUser(priya, 'Priya Shah', 'priya@kanabana.local', demoHash, 'member');
  await addUser(arun, 'Arun Mehta', 'arun@kanabana.local', demoHash, 'member');
  await addUser(lena, 'Lena Ortiz', 'lena@kanabana.local', demoHash, 'member');
  await addUser(samir, 'Samir Khan', 'samir@kanabana.local', demoHash, 'member');

  await insertOne('departments', { id: fullstack, name: 'Full-stack', lead_id: priya, created_at: stamp });
  await insertOne('departments', { id: ai, name: 'AI', lead_id: lena, created_at: stamp });
  for (const userId of [admin, priya, arun]) {
    await insertOne('user_departments', { _id: `${userId}:${fullstack}`, user_id: userId, department_id: fullstack });
  }
  for (const userId of [admin, lena, samir]) {
    await insertOne('user_departments', { _id: `${userId}:${ai}`, user_id: userId, department_id: ai });
  }

  await insertOne('projects', {
    id: project,
    name: 'Client portal refresh',
    description: 'Replace the portal shell, then connect the summary model. Full-stack and AI share one timeline.',
    status: 'active',
    start_date: mon,
    end_date: launchEnd,
    created_by: admin,
    created_at: stamp,
  });
  await insertOne('project_departments', { _id: `${project}:${fullstack}`, project_id: project, department_id: fullstack });
  await insertOne('project_departments', { _id: `${project}:${ai}`, project_id: project, department_id: ai });
  for (const userId of [priya, arun, lena, samir]) {
    await insertOne('project_members', { _id: `${project}:${userId}`, project_id: project, user_id: userId });
  }

  await insertOne('timeline_changes', {
    id: 'tlc_seed',
    project_id: project,
    actor_id: priya,
    actor_name: null,
    reason: 'Launch moved out two days so the evaluation set can land before release.',
    before_json: JSON.stringify({ startDate: mon, endDate: earlierLaunchEnd }),
    after_json: JSON.stringify({ startDate: mon, endDate: launchEnd }),
    created_at: earlier,
  });

  const addTask = (id, title, description, projectId, stageId, creatorId, assigneeId, status, priority, due, kind, parentId, created, updated) => insertOne('tasks', {
    id,
    title,
    description,
    project_id: projectId,
    stage_id: stageId,
    creator_id: creatorId,
    assignee_id: assigneeId,
    status,
    priority,
    due_date: due,
    kind,
    recurring_rule_id: null,
    parent_task_id: parentId,
    handoff_task_id: null,
    created_at: created,
    updated_at: updated,
    completed_at: status === 'done' ? updated : null,
  });
  await addTask(sketch, 'Sketch the navigation', 'Map the signed-in header, the project list, and the empty state.', project, null, priya, priya, 'done', 'medium', tue, 'project', null, stamp, stamp);
  await addTask(nav, 'Build the navigation', 'Turn the sketch into the shared header and side navigation.', project, null, priya, arun, 'upcoming', 'high', fri, 'project', sketch, stamp, stamp);
  await addTask(shell, 'Set up the portal shell', 'Stand up the app shell, routing, and the place the model response will land.', project, null, arun, arun, 'in_progress', 'high', fri, 'project', null, stamp, stamp);
  await addTask(model, 'Wire the summary model', 'Connect the summary endpoint and show a readable result on the project page.', project, null, arun, samir, 'upcoming', 'high', nextWed, 'project', shell, stamp, stamp);
  await addTask(evaluation, 'Draft the evaluation set', 'Collect ten real portal questions and the answer we expect from the model.', project, null, lena, lena, 'upcoming', 'medium', isoDate(addDays(monday, 2)), 'project', null, stamp, stamp);
  await addTask(review, 'Review the API contracts', 'Check the routes Arun is exposing before Samir binds the model to them.', project, null, priya, priya, 'in_progress', 'high', yesterday, 'project', null, stamp, stamp);
  await addTask(audit, 'Audit the old portal', 'Note which screens people still use before we replace them.', project, null, arun, arun, 'done', 'low', lastWed, 'project', null, earlier, earlier);
  await addTask(confirm, 'Confirm department leads for the quarter', 'Check Full-stack and AI still have the right leads.', null, null, admin, admin, 'upcoming', 'medium', fri, 'personal', null, stamp, stamp);
  await updateHandoff(sketch, nav);
  await updateHandoff(shell, model);

  await insertOne('comments', { id: 'cmt_shell_note', task_id: shell, author_id: arun, author_name: null, body: 'Repo is linked and the base layout is up. Auth screens are still open.', created_at: stamp });
  await insertOne('comments', { id: 'cmt_shell', task_id: shell, author_id: priya, author_name: null, body: 'Leave the model endpoint as a clear handoff point for Samir.', created_at: stamp });

  await insertOne('recurring_rules', {
    id: ruleDeploy, title: 'Check deploy queue', description: 'Look through overnight deploys and note anything red.',
    cadence: 'daily', weekday: null, priority: 'medium', assignee_id: priya, created_by: priya, project_id: null, active: 1, created_at: stamp,
  });
  await insertOne('recurring_rules', {
    id: ruleQuality, title: 'Model quality note', description: 'Write what the evaluation set caught this week.',
    cadence: 'weekly', weekday: 5, priority: 'medium', assignee_id: lena, created_by: lena, project_id: null, active: 1, created_at: stamp,
  });
  await insertOne('tasks', {
    id: 'task_old_deploy',
    title: 'Check deploy queue',
    description: 'Look through overnight deploys and note anything red.',
    project_id: null,
    stage_id: null,
    creator_id: priya,
    assignee_id: priya,
    status: 'done',
    priority: 'medium',
    due_date: lastWed,
    kind: 'recurring',
    recurring_rule_id: ruleDeploy,
    parent_task_id: null,
    handoff_task_id: null,
    created_at: earlier,
    updated_at: earlier,
    completed_at: earlier,
  });

  await insertOne('notifications', {
    id: 'ntf_samir', user_id: samir, message: 'Arun handed you “Wire the summary model” after “Set up the portal shell”.',
    task_id: model, project_id: project, read: 0, area: 'board', area_seen: 0, created_at: stamp,
  });
  await insertOne('notifications', {
    id: 'ntf_arun', user_id: arun, message: 'Priya finished “Sketch the navigation”. “Build the navigation” is ready for you.',
    task_id: nav, project_id: project, read: 0, area: 'board', area_seen: 0, created_at: stamp,
  });
  await insertOne('activity', { id: 'act_office', actor_id: admin, message: 'Asha Menon opened the office and added Full-stack and AI.', task_id: null, project_id: null, created_at: earlier });
  await insertOne('activity', { id: 'act_time', actor_id: priya, message: 'Priya Shah changed the timeline for Client portal refresh. Launch moved out two days so the evaluation set can land before release.', task_id: null, project_id: project, created_at: earlier });
  await insertOne('activity', { id: 'act_hand', actor_id: arun, message: 'Arun Mehta handed “Wire the summary model” to Samir Khan.', task_id: model, project_id: project, created_at: stamp });
  console.log('Demo office loaded. Admin login is admin@kanabana.local / Admin123!');
  return true;
}

function updateHandoff(taskId, handoffId) {
  return updateOne('tasks', { _id: taskId }, { handoff_task_id: handoffId });
}
