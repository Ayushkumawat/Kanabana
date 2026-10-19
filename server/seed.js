import bcrypt from 'bcryptjs';
import { addDays, isoDate, parseISODate, startOfWeek, todayISO } from './dates.js';

const admin = 'usr_admin';
const priya = 'usr_priya';
const arun = 'usr_arun';
const lena = 'usr_lena';
const samir = 'usr_samir';
const fullstack = 'dep_fullstack';
const ai = 'dep_ai';
const project = 'prj_portal';
const discovery = 'stg_discovery';
const build = 'stg_build';
const launch = 'stg_launch';
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

export function seed(db) {
  const stamp = new Date().toISOString();
  const earlier = new Date(Date.now() - 86400000).toISOString();
  const adminHash = bcrypt.hashSync('Admin123!', 10);
  const demoHash = bcrypt.hashSync('Demo123!', 10);
  const monday = startOfWeek(new Date());
  const mon = isoDate(monday);
  const tue = isoDate(addDays(monday, 1));
  const fri = isoDate(addDays(monday, 4));
  const nextWed = isoDate(addDays(monday, 9));
  const buildStart = isoDate(addDays(monday, 7));
  const buildEnd = isoDate(addDays(monday, 18));
  const launchStart = isoDate(addDays(monday, 21));
  const launchEnd = isoDate(addDays(monday, 25));
  const earlierLaunchEnd = isoDate(addDays(parseISODate(launchEnd), -2));
  const lastWed = isoDate(addDays(monday, -5));
  const yesterday = isoDate(addDays(parseISODate(todayISO()), -1));

  const tx = db.transaction(() => {
    const addUser = db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `);
    addUser.run(admin, 'Asha Menon', 'admin@kanabana.local', adminHash, 'admin', stamp);
    addUser.run(priya, 'Priya Shah', 'priya@kanabana.local', demoHash, 'member', stamp);
    addUser.run(arun, 'Arun Mehta', 'arun@kanabana.local', demoHash, 'member', stamp);
    addUser.run(lena, 'Lena Ortiz', 'lena@kanabana.local', demoHash, 'member', stamp);
    addUser.run(samir, 'Samir Khan', 'samir@kanabana.local', demoHash, 'member', stamp);

    const addDept = db.prepare('INSERT INTO departments (id, name, lead_id, created_at) VALUES (?, ?, ?, ?)');
    addDept.run(fullstack, 'Full-stack', priya, stamp);
    addDept.run(ai, 'AI', lena, stamp);

    const link = db.prepare('INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)');
    for (const userId of [admin, priya, arun]) link.run(userId, fullstack);
    for (const userId of [admin, lena, samir]) link.run(userId, ai);

    db.prepare(`
      INSERT INTO projects (id, name, description, status, start_date, end_date, created_by, created_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      project,
      'Client portal refresh',
      'Replace the portal shell, then connect the summary model. Full-stack and AI share one timeline.',
      mon,
      launchEnd,
      admin,
      stamp,
    );

    const addProjectDept = db.prepare('INSERT INTO project_departments (project_id, department_id) VALUES (?, ?)');
    addProjectDept.run(project, fullstack);
    addProjectDept.run(project, ai);

    const addMember = db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)');
    for (const userId of [priya, arun, lena, samir]) addMember.run(project, userId);

    const addStage = db.prepare(`
      INSERT INTO project_stages (id, project_id, name, start_date, end_date, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    addStage.run(discovery, project, 'Discovery', mon, fri, 0);
    addStage.run(build, project, 'Build', buildStart, buildEnd, 1);
    addStage.run(launch, project, 'Launch', launchStart, launchEnd, 2);

    const before = {
      startDate: mon,
      endDate: earlierLaunchEnd,
      stages: [
        { id: discovery, name: 'Discovery', startDate: mon, endDate: fri },
        { id: build, name: 'Build', startDate: buildStart, endDate: buildEnd },
        { id: launch, name: 'Launch', startDate: launchStart, endDate: earlierLaunchEnd },
      ],
    };
    const after = {
      startDate: mon,
      endDate: launchEnd,
      stages: [
        { id: discovery, name: 'Discovery', startDate: mon, endDate: fri },
        { id: build, name: 'Build', startDate: buildStart, endDate: buildEnd },
        { id: launch, name: 'Launch', startDate: launchStart, endDate: launchEnd },
      ],
    };
    db.prepare(`
      INSERT INTO timeline_changes (id, project_id, actor_id, reason, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'tlc_seed',
      project,
      priya,
      'Launch moved out two days so the evaluation set can land before release.',
      JSON.stringify(before),
      JSON.stringify(after),
      earlier,
    );

    const addTask = db.prepare(`
      INSERT INTO tasks (
        id, title, description, project_id, stage_id, creator_id, assignee_id,
        status, priority, due_date, kind, recurring_rule_id, parent_task_id, handoff_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
    `);
    addTask.run(sketch, 'Sketch the navigation', 'Map the signed-in header, the project list, and the empty state.', project, discovery, priya, priya, 'done', 'medium', tue, 'project', null, stamp, stamp);
    addTask.run(nav, 'Build the navigation', 'Turn the sketch into the shared header and side navigation.', project, discovery, priya, arun, 'upcoming', 'high', fri, 'project', sketch, stamp, stamp);
    addTask.run(shell, 'Set up the portal shell', 'Stand up the app shell, routing, and the place the model response will land.', project, discovery, arun, arun, 'in_progress', 'high', fri, 'project', null, stamp, stamp);
    addTask.run(model, 'Wire the summary model', 'Connect the summary endpoint and show a readable result on the project page.', project, build, arun, samir, 'upcoming', 'high', nextWed, 'project', shell, stamp, stamp);
    addTask.run(evaluation, 'Draft the evaluation set', 'Collect ten real portal questions and the answer we expect from the model.', project, discovery, lena, lena, 'upcoming', 'medium', isoDate(addDays(monday, 2)), 'project', null, stamp, stamp);
    addTask.run(review, 'Review the API contracts', 'Check the routes Arun is exposing before Samir binds the model to them.', project, discovery, priya, priya, 'in_progress', 'high', yesterday, 'project', null, stamp, stamp);
    addTask.run(audit, 'Audit the old portal', 'Note which screens people still use before we replace them.', project, discovery, arun, arun, 'done', 'low', lastWed, 'project', null, earlier, earlier);
    addTask.run(confirm, 'Confirm department leads for the quarter', 'Check Full-stack and AI still have the right leads.', null, null, admin, admin, 'upcoming', 'medium', fri, 'personal', null, stamp, stamp);

    db.prepare('UPDATE tasks SET handoff_task_id = ? WHERE id = ?').run(nav, sketch);
    db.prepare('UPDATE tasks SET handoff_task_id = ? WHERE id = ?').run(model, shell);

    const addComment = db.prepare(`
      INSERT INTO comments (id, task_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)
    `);
    addComment.run('cmt_shell_note', shell, arun, 'Repo is linked and the base layout is up. Auth screens are still open.', stamp);
    addComment.run('cmt_shell', shell, priya, 'Leave the model endpoint as a clear handoff point for Samir.', stamp);

    db.prepare(`
      INSERT INTO recurring_rules (
        id, title, description, cadence, weekday, priority, assignee_id, created_by, project_id, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
    `).run(ruleDeploy, 'Check deploy queue', 'Look through overnight deploys and note anything red.', 'daily', null, 'medium', priya, priya, stamp);
    db.prepare(`
      INSERT INTO recurring_rules (
        id, title, description, cadence, weekday, priority, assignee_id, created_by, project_id, active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
    `).run(ruleQuality, 'Model quality note', 'Write what the evaluation set caught this week.', 'weekly', 5, 'medium', lena, lena, stamp);

    db.prepare(`
      INSERT INTO tasks (
        id, title, description, project_id, stage_id, creator_id, assignee_id,
        status, priority, due_date, kind, recurring_rule_id, parent_task_id, handoff_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, 'done', 'medium', ?, 'recurring', ?, NULL, NULL, ?, ?)
    `).run('task_old_deploy', 'Check deploy queue', 'Look through overnight deploys and note anything red.', priya, priya, lastWed, ruleDeploy, earlier, earlier);

    const addNote = db.prepare(`
      INSERT INTO notifications (id, user_id, message, task_id, project_id, read, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `);
    addNote.run('ntf_samir', samir, 'Arun handed you “Wire the summary model” after “Set up the portal shell”.', model, project, stamp);
    addNote.run('ntf_arun', arun, 'Priya finished “Sketch the navigation”. “Build the navigation” is ready for you.', nav, project, stamp);

    const addEvent = db.prepare(`
      INSERT INTO activity (id, actor_id, message, task_id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    addEvent.run('act_office', admin, 'Asha Menon opened the office and added Full-stack and AI.', null, null, earlier);
    addEvent.run('act_time', priya, 'Priya Shah changed the timeline for Client portal refresh. Launch moved out two days so the evaluation set can land before release.', null, project, earlier);
    addEvent.run('act_hand', arun, 'Arun Mehta handed “Wire the summary model” to Samir Khan.', model, project, stamp);
  });

  tx();
}
