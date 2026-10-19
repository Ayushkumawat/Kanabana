import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { db, id, logActivity, notify, now } from './db.js';

const uploadDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'uploads');
const ALLOWED = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'txt', 'md', 'zip']);
const ONBOARDING = ['Adding to Razorpay', 'Gate access', 'Document verification', 'System access'];

function saveFile(file) {
  if (!file?.name || !file?.data) return null;
  const ext = String(file.name).split('.').pop().toLowerCase();
  if (!ALLOWED.has(ext)) {
    const error = new Error('Use a pdf, office, image, text, or zip file');
    error.status = 400;
    throw error;
  }
  const raw = Buffer.from(String(file.data), 'base64');
  if (!raw.length) {
    const error = new Error('That file was empty');
    error.status = 400;
    throw error;
  }
  if (raw.length > 8 * 1024 * 1024) {
    const error = new Error('Keep the file under 8 MB');
    error.status = 400;
    throw error;
  }
  fs.mkdirSync(uploadDir, { recursive: true });
  const stored = `${id('file')}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, stored), raw);
  return { stored, name: String(file.name).slice(0, 180) };
}

function canOffice(auth) {
  return auth.isAdmin || auth.isLead || auth.isHr;
}

export function registerSections(app, ctx) {
  const {
    requireAuth, requireAdmin, bad, readText, activeUser, isHr, hrUserIds,
    rawTask, maybeFinishDeparture, isISODate, uniqueList,
  } = ctx;

  app.get('/api/notepad', requireAuth, (req, res) => {
    const row = db.prepare('SELECT body, updated_at AS updatedAt FROM personal_notes WHERE user_id = ?').get(req.auth.id);
    res.json({ body: row?.body || '', updatedAt: row?.updatedAt || null });
  });

  app.put('/api/notepad', requireAuth, (req, res) => {
    const body = readText(req.body.body, 8000, 'the note');
    if (body.error) return bad(res, 400, body.error);
    db.prepare(`
      INSERT INTO personal_notes (user_id, body, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
    `).run(req.auth.id, body.value, now());
    res.json({ ok: true, updatedAt: now() });
  });

  app.get('/api/files/:stored', requireAuth, (req, res) => {
    const stored = path.basename(String(req.params.stored || ''));
    const full = path.join(uploadDir, stored);
    if (!stored || !fs.existsSync(full)) return bad(res, 404, 'File not found');
    res.download(full);
  });

  app.get('/api/knowledge', requireAuth, (req, res) => {
    const items = db.prepare(`
      SELECT k.id, k.kind, k.title, k.note, k.link, k.file_name AS fileName, k.file_stored AS fileStored,
        k.person_name AS personName, k.user_id AS userId, k.project_id AS projectId, k.task_id AS taskId,
        k.created_at AS createdAt, p.name AS projectName, u.name AS authorName
      FROM knowledge_items k
      LEFT JOIN projects p ON p.id = k.project_id
      LEFT JOIN users u ON u.id = k.author_id
      ORDER BY k.created_at DESC
    `).all();
    const pending = Boolean(db.prepare(`
      SELECT 1 FROM departure_requests WHERE user_id = ? AND status = 'open'
      UNION SELECT 1 FROM departure_holds WHERE user_id = ?
    `).get(req.auth.id, req.auth.id));
    const hasKt = items.some((item) => item.kind === 'kt' && item.userId === req.auth.id && item.fileStored);
    res.json({
      items,
      needsKt: pending && !hasKt,
      projects: db.prepare('SELECT id, name FROM projects ORDER BY name').all(),
    });
  });

  app.post('/api/knowledge', requireAuth, (req, res) => {
    const kind = req.body.kind === 'kt' ? 'kt' : 'project';
    const title = readText(req.body.title, 140, 'a title', true);
    if (title.error) return bad(res, 400, title.error);
    const note = readText(req.body.note, 2000, 'a note');
    if (note.error) return bad(res, 400, note.error);
    const link = String(req.body.link || '').trim();
    let file = null;
    try {
      file = req.body.file ? saveFile(req.body.file) : null;
    } catch (error) {
      return bad(res, error.status || 400, error.message);
    }
    if (kind === 'kt') {
      if (!file) return bad(res, 400, 'Attach the KT file');
      const userId = req.body.userId || req.auth.id;
      if (userId !== req.auth.id && !req.auth.isAdmin) return bad(res, 403, 'You can upload your own KT document');
      const person = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
      if (!person) return bad(res, 404, 'Person not found');
      db.prepare(`
        INSERT INTO knowledge_items (
          id, kind, title, note, link, file_name, file_stored, person_name, user_id, project_id, task_id, author_id, created_at
        ) VALUES (?, 'kt', ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(id('kno'), title.value, note.value, file.name, file.stored, person.name, person.id, req.auth.id, now());
      logActivity(req.auth.id, `${req.auth.name} added a KT document for ${person.name}.`);
      const finished = maybeFinishDeparture(person.id, req.auth);
      return res.status(201).json({ ok: true, removed: finished.removed, message: finished.removed ? finished.message : 'KT document saved' });
    }
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(req.body.projectId);
    if (!project) return bad(res, 400, 'Choose a project');
    if (!link && !file) return bad(res, 400, 'Add a link or a file');
    if (link && !/^https?:\/\//i.test(link)) return bad(res, 400, 'The link should start with http:// or https://');
    const taskId = req.body.taskId || null;
    if (taskId) {
      const task = rawTask(taskId);
      if (!task || task.project_id !== project.id) return bad(res, 400, 'That task is not on this project');
    }
    db.prepare(`
      INSERT INTO knowledge_items (
        id, kind, title, note, link, file_name, file_stored, person_name, user_id, project_id, task_id, author_id, created_at
      ) VALUES (?, 'project', ?, ?, ?, ?, ?, '', NULL, ?, ?, ?, ?)
    `).run(id('kno'), title.value, note.value, link || null, file?.name || null, file?.stored || null, project.id, taskId, req.auth.id, now());
    const members = db.prepare('SELECT user_id FROM project_members WHERE project_id = ?').all(project.id);
    for (const member of members) {
      if (member.user_id !== req.auth.id) {
        notify(member.user_id, `${req.auth.name} added “${title.value}” to the ${project.name} knowledge base.`, taskId, project.id, 'knowledge');
      }
    }
    logActivity(req.auth.id, `${req.auth.name} added “${title.value}” to the ${project.name} knowledge base.`, taskId, project.id);
    res.status(201).json({ ok: true });
  });

  app.get('/api/tenders', requireAuth, (req, res) => {
    if (!canOffice(req.auth)) return bad(res, 403, 'Tenders are for team leads and HR');
    const tenders = db.prepare(`
      SELECT t.id, t.name, t.description, t.organisation, t.amount, t.emd, t.last_date AS lastDate,
        t.link, t.status, t.created_at AS createdAt, u.name AS createdByName
      FROM tenders t JOIN users u ON u.id = t.created_by
      ORDER BY t.last_date, t.created_at DESC
    `).all();
    res.json({ tenders });
  });

  app.post('/api/tenders', requireAuth, (req, res) => {
    if (!canOffice(req.auth)) return bad(res, 403, 'Tenders are for team leads and HR');
    const name = readText(req.body.name, 160, 'a name', true);
    if (name.error) return bad(res, 400, name.error);
    const description = readText(req.body.description, 4000, 'a description', true);
    if (description.error) return bad(res, 400, description.error);
    const organisation = readText(req.body.organisation, 160, 'the organisation');
    if (organisation.error) return bad(res, 400, organisation.error);
    const amount = readText(req.body.amount, 40, 'an amount', true);
    if (amount.error) return bad(res, 400, amount.error);
    const emd = readText(req.body.emd, 40, 'the EMD', true);
    if (emd.error) return bad(res, 400, emd.error);
    if (!isISODate(req.body.lastDate)) return bad(res, 400, 'Choose the last date');
    const link = String(req.body.link || '').trim();
    if (link && !/^https?:\/\//i.test(link)) return bad(res, 400, 'The link should start with http:// or https://');
    const tenderId = id('tdr');
    db.prepare(`
      INSERT INTO tenders (id, name, description, organisation, amount, emd, last_date, link, status, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(tenderId, name.value, description.value, organisation.value, amount.value, emd.value, req.body.lastDate, link, req.auth.id, now());
    const watchers = new Set([...hrUserIds(), ...db.prepare('SELECT DISTINCT lead_id AS id FROM departments WHERE lead_id IS NOT NULL').all().map((row) => row.id)]);
    for (const userId of watchers) {
      if (userId !== req.auth.id) notify(userId, `${req.auth.name} added the tender “${name.value}”.`, null, null, 'tenders');
    }
    logActivity(req.auth.id, `${req.auth.name} added the tender “${name.value}”.`);
    res.status(201).json({ id: tenderId });
  });

  app.post('/api/tenders/:id/status', requireAuth, (req, res) => {
    if (!canOffice(req.auth)) return bad(res, 403, 'Tenders are for team leads and HR');
    const tender = db.prepare('SELECT * FROM tenders WHERE id = ?').get(req.params.id);
    if (!tender) return bad(res, 404, 'Tender not found');
    if (!['open', 'applied', 'skipped'].includes(req.body.status)) return bad(res, 400, 'Choose a status');
    db.prepare('UPDATE tenders SET status = ? WHERE id = ?').run(req.body.status, tender.id);
    res.json({ ok: true });
  });

  app.get('/api/dependencies', requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT d.id, d.note, d.status, d.created_at AS createdAt,
        d.requester_id AS requesterId, ru.name AS requesterName,
        d.depends_on_id AS dependsOnId, du.name AS dependsOnName,
        t.id AS taskId, t.title AS taskTitle, t.status AS taskStatus
      FROM task_dependencies d
      JOIN users ru ON ru.id = d.requester_id
      JOIN users du ON du.id = d.depends_on_id
      JOIN tasks t ON t.id = d.task_id
      WHERE d.status = 'open' AND (d.requester_id = ? OR d.depends_on_id = ?)
      ORDER BY d.created_at DESC
    `).all(req.auth.id, req.auth.id);
    const tasks = db.prepare(`
      SELECT t.id, t.title, u.name AS assigneeName
      FROM tasks t JOIN users u ON u.id = t.assignee_id
      WHERE t.status != 'done'
      ORDER BY t.due_date, t.title
    `).all();
    const people = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
    res.json({
      waitingOnMe: rows.filter((row) => row.dependsOnId === req.auth.id),
      raised: rows.filter((row) => row.requesterId === req.auth.id),
      tasks,
      people,
    });
  });

  app.post('/api/dependencies', requireAuth, (req, res) => {
    const task = rawTask(req.body.taskId);
    if (!task) return bad(res, 404, 'Task not found');
    if (task.status === 'done') return bad(res, 400, 'That task is already done');
    const person = activeUser(req.body.dependsOnId);
    if (!person) return bad(res, 400, 'Choose the person this depends on');
    if (person.id === req.auth.id) return bad(res, 400, 'Choose someone else');
    const note = readText(req.body.note, 500, 'what you need', true);
    if (note.error) return bad(res, 400, note.error);
    if (db.prepare(`SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ? AND status = 'open'`).get(task.id, person.id)) {
      return bad(res, 400, `${person.name} already has an open request on this task`);
    }
    db.prepare(`
      INSERT INTO task_dependencies (id, task_id, requester_id, depends_on_id, note, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id('dep'), task.id, req.auth.id, person.id, note.value, now());
    notify(person.id, `${req.auth.name} needs you on “${task.title}”. ${note.value}`, task.id, task.project_id, 'dependencies');
    logActivity(req.auth.id, `${req.auth.name} asked ${person.name} for help on “${task.title}”.`, task.id, task.project_id);
    res.status(201).json({ ok: true });
  });

  app.post('/api/dependencies/:id/done', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM task_dependencies WHERE id = ?').get(req.params.id);
    if (!row || row.status !== 'open') return bad(res, 404, 'Request not found');
    if (row.depends_on_id !== req.auth.id && !req.auth.isAdmin) return bad(res, 403, 'Only that person can clear this');
    db.prepare(`UPDATE task_dependencies SET status = 'done' WHERE id = ?`).run(row.id);
    const task = rawTask(row.task_id);
    notify(row.requester_id, `${req.auth.name} cleared the dependency on “${task?.title || 'a task'}”.`, row.task_id, task?.project_id || null, 'dependencies');
    res.json({ ok: true });
  });

  function hiringGate(req, res) {
    if (!canOffice(req.auth)) {
      bad(res, 403, 'Hiring is for team leads and HR');
      return false;
    }
    return true;
  }

  function resumeView(row) {
    return {
      id: row.id,
      positionId: row.position_id,
      candidateName: row.candidate_name,
      comment: row.comment,
      referral: Boolean(row.referral),
      referralName: row.referral_name,
      fileName: row.file_name,
      fileStored: row.file_stored,
      uploadedBy: row.uploaded_by,
      uploaderName: row.uploader_name,
      status: row.status,
      reviewerId: row.reviewer_id,
      reviewerName: row.reviewer_name,
      round: row.round,
      meetLink: row.meet_link,
      interviewDate: row.interview_date,
      interviewTime: row.interview_time,
      userId: row.user_id,
      createdAt: row.created_at,
      checks: db.prepare('SELECT id, label, done FROM hiring_checks WHERE resume_id = ? ORDER BY label').all(row.id)
        .map((item) => ({ ...item, done: Boolean(item.done) })),
    };
  }

  const RESUME_SQL = `
    SELECT r.*, up.name AS uploader_name, rv.name AS reviewer_name
    FROM hiring_resumes r
    JOIN users up ON up.id = r.uploaded_by
    LEFT JOIN users rv ON rv.id = r.reviewer_id
  `;

  app.get('/api/hiring', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const positions = db.prepare(`
      SELECT p.id, p.title, p.description, p.status, p.department_id AS departmentId, d.name AS departmentName,
        p.created_at AS createdAt
      FROM hiring_positions p JOIN departments d ON d.id = p.department_id
      ORDER BY p.status, d.name, p.title
    `).all();
    const resumes = db.prepare(`${RESUME_SQL} ORDER BY r.created_at DESC`).all().map(resumeView);
    const departments = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
    const people = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
    res.json({ positions, resumes, departments, people, isHr: isHr(req.auth), isAdmin: req.auth.isAdmin });
  });

  app.post('/api/hiring/positions', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const title = readText(req.body.title, 120, 'a position', true);
    if (title.error) return bad(res, 400, title.error);
    const description = readText(req.body.description, 2000, 'a description');
    if (description.error) return bad(res, 400, description.error);
    const department = db.prepare('SELECT id, name FROM departments WHERE id = ?').get(req.body.departmentId);
    if (!department) return bad(res, 400, 'Choose a department');
    const positionId = id('pos');
    db.prepare(`
      INSERT INTO hiring_positions (id, department_id, title, description, status, created_by, created_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(positionId, department.id, title.value, description.value, req.auth.id, now());
    for (const userId of hrUserIds()) {
      if (userId !== req.auth.id) notify(userId, `${req.auth.name} opened hiring for ${title.value} in ${department.name}.`, null, null, 'hiring');
    }
    res.status(201).json({ id: positionId });
  });

  app.post('/api/hiring/resumes', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const position = db.prepare('SELECT * FROM hiring_positions WHERE id = ?').get(req.body.positionId);
    if (!position || position.status !== 'open') return bad(res, 400, 'Choose an open position');
    const candidate = readText(req.body.candidateName, 80, 'the candidate’s name', true);
    if (candidate.error) return bad(res, 400, candidate.error);
    const comment = readText(req.body.comment, 1000, 'a comment');
    if (comment.error) return bad(res, 400, comment.error);
    const referral = Boolean(req.body.referral);
    const referralName = readText(req.body.referralName, 80, 'the referrer’s name', referral);
    if (referralName.error) return bad(res, 400, referralName.error);
    let file;
    try {
      file = saveFile(req.body.file);
    } catch (error) {
      return bad(res, error.status || 400, error.message);
    }
    if (!file) return bad(res, 400, 'Attach the resume');
    db.prepare(`
      INSERT INTO hiring_resumes (
        id, position_id, candidate_name, comment, referral, referral_name, file_name, file_stored,
        uploaded_by, status, round, meet_link, interview_time, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 1, '', '', ?)
    `).run(id('res'), position.id, candidate.value, comment.value, referral ? 1 : 0, referral ? referralName.value : '', file.name, file.stored, req.auth.id, now());
    res.status(201).json({ ok: true });
  });

  app.post('/api/hiring/positions/:id/review', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const position = db.prepare('SELECT * FROM hiring_positions WHERE id = ?').get(req.params.id);
    if (!position) return bad(res, 404, 'Position not found');
    const reviewer = activeUser(req.body.reviewerId);
    if (!reviewer) return bad(res, 400, 'Choose who should review');
    const open = db.prepare(`SELECT COUNT(*) AS n FROM hiring_resumes WHERE position_id = ? AND status = 'new'`).get(position.id).n;
    if (!open) return bad(res, 400, 'There are no new resumes to review');
    db.prepare(`
      UPDATE hiring_resumes SET status = 'in_review', reviewer_id = ?
      WHERE position_id = ? AND status = 'new'
    `).run(reviewer.id, position.id);
    notify(reviewer.id, `${req.auth.name} asked you to review resumes for ${position.title}.`, null, null, 'hiring');
    res.json({ ok: true });
  });

  app.post('/api/hiring/positions/:id/submit', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const position = db.prepare('SELECT * FROM hiring_positions WHERE id = ?').get(req.params.id);
    if (!position) return bad(res, 404, 'Position not found');
    const mine = db.prepare(`SELECT * FROM hiring_resumes WHERE position_id = ? AND status = 'in_review' AND reviewer_id = ?`).all(position.id, req.auth.id);
    if (!mine.length && !req.auth.isAdmin) return bad(res, 403, 'These resumes are not waiting on you');
    const pool = mine.length ? mine : db.prepare(`SELECT * FROM hiring_resumes WHERE position_id = ? AND status = 'in_review'`).all(position.id);
    const chosen = new Set(Array.isArray(req.body.resumeIds) ? req.body.resumeIds : []);
    if (![...chosen].some((resumeId) => pool.some((row) => row.id === resumeId))) {
      return bad(res, 400, 'Select at least one resume');
    }
    for (const row of pool) {
      if (chosen.has(row.id)) {
        db.prepare(`UPDATE hiring_resumes SET status = 'shortlisted' WHERE id = ?`).run(row.id);
        notify(row.uploaded_by, `${row.candidate_name} is selected for interview for ${position.title}. Add the meet link, date, and time.`, null, null, 'hiring');
      } else {
        db.prepare(`UPDATE hiring_resumes SET status = 'passed' WHERE id = ?`).run(row.id);
      }
    }
    res.json({ ok: true });
  });

  app.post('/api/hiring/resumes/:id/interview', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = db.prepare('SELECT * FROM hiring_resumes WHERE id = ?').get(req.params.id);
    if (!row) return bad(res, 404, 'Resume not found');
    if (!['shortlisted', 'next_round'].includes(row.status)) return bad(res, 400, 'This candidate is not waiting on a schedule');
    if (row.uploaded_by !== req.auth.id && !req.auth.isAdmin && !isHr(req.auth)) return bad(res, 403, 'The person who added the resume schedules the interview');
    const link = String(req.body.meetLink || '').trim();
    if (!/^https?:\/\//i.test(link)) return bad(res, 400, 'Add the Google Meet link');
    if (!isISODate(req.body.date)) return bad(res, 400, 'Choose the interview date');
    const time = readText(req.body.time, 20, 'a time', true);
    if (time.error) return bad(res, 400, time.error);
    db.prepare(`
      UPDATE hiring_resumes SET status = 'scheduled', meet_link = ?, interview_date = ?, interview_time = ? WHERE id = ?
    `).run(link, req.body.date, time.value, row.id);
    if (row.reviewer_id) {
      notify(row.reviewer_id, `Interview for ${row.candidate_name} is ${req.body.date} at ${time.value}. ${link}`, null, null, 'hiring');
    }
    res.json({ ok: true });
  });

  app.post('/api/hiring/resumes/:id/outcome', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = db.prepare('SELECT * FROM hiring_resumes WHERE id = ?').get(req.params.id);
    if (!row || row.status !== 'scheduled') return bad(res, 400, 'Schedule the interview first');
    const position = db.prepare('SELECT title FROM hiring_positions WHERE id = ?').get(row.position_id);
    if (req.body.result === 'rejected') {
      db.prepare(`UPDATE hiring_resumes SET status = 'discarded' WHERE id = ?`).run(row.id);
      notify(row.uploaded_by, `${row.candidate_name} was not selected for ${position?.title || 'the role'}.`, null, null, 'hiring');
      return res.json({ ok: true });
    }
    if (req.body.result !== 'selected') return bad(res, 400, 'Choose selected or rejected');
    if (req.body.next === 'round') {
      db.prepare(`
        UPDATE hiring_resumes
        SET status = 'next_round', round = round + 1, meet_link = '', interview_date = NULL, interview_time = ''
        WHERE id = ?
      `).run(row.id);
      notify(row.uploaded_by, `${row.candidate_name} is through to the next round for ${position?.title || 'the role'}. Schedule it.`, null, null, 'hiring');
      return res.json({ ok: true });
    }
    if (req.body.next !== 'final') return bad(res, 400, 'Choose the next round or mark this final');
    db.prepare(`UPDATE hiring_resumes SET status = 'final' WHERE id = ?`).run(row.id);
    notify(row.uploaded_by, `${row.candidate_name} is a final selection for ${position?.title || 'the role'}.`, null, null, 'hiring');
    res.json({ ok: true });
  });

  app.post('/api/hiring/resumes/:id/discard', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = db.prepare('SELECT * FROM hiring_resumes WHERE id = ?').get(req.params.id);
    if (!row || !['final', 'shortlisted', 'next_round', 'passed'].includes(row.status)) return bad(res, 400, 'This resume can’t be discarded from here');
    db.prepare(`UPDATE hiring_resumes SET status = 'discarded' WHERE id = ?`).run(row.id);
    res.json({ ok: true });
  });

  app.post('/api/hiring/resumes/:id/request-account', requireAuth, (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = db.prepare('SELECT * FROM hiring_resumes WHERE id = ?').get(req.params.id);
    if (!row || row.status !== 'final') return bad(res, 400, 'Mark the interview as the final round first');
    db.prepare(`UPDATE hiring_resumes SET status = 'account_requested' WHERE id = ?`).run(row.id);
    const admins = db.prepare(`SELECT id FROM users WHERE role = 'admin' AND active = 1`).all();
    for (const admin of admins) {
      notify(admin.id, `${req.auth.name} asked you to create an account for ${row.candidate_name}.`, null, null, 'hiring');
    }
    res.json({ ok: true });
  });

  app.post('/api/hiring/resumes/:id/account', requireAuth, requireAdmin, (req, res) => {
    const row = db.prepare(`
      SELECT r.*, p.department_id, p.title AS position_title
      FROM hiring_resumes r JOIN hiring_positions p ON p.id = r.position_id
      WHERE r.id = ?
    `).get(req.params.id);
    if (!row || !['account_requested', 'final'].includes(row.status)) return bad(res, 400, 'This candidate is not ready for an account');
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 400, 'Enter a valid email');
    const password = String(req.body.password || '');
    if (password.length < 8) return bad(res, 400, 'Use at least 8 characters for the password');
    if (!isISODate(req.body.birthday)) return bad(res, 400, 'Choose a birthday');
    if (!isISODate(req.body.workAnniversary)) return bad(res, 400, 'Choose a work anniversary');
    const departmentIds = uniqueList(req.body.departmentIds?.length ? req.body.departmentIds : [row.department_id]);
    if (!departmentIds.length) return bad(res, 400, 'Choose a department');
    for (const departmentId of departmentIds) {
      if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId)) return bad(res, 400, 'Choose a department');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 400, 'That email is already in use');
    const userId = id('usr');
    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, role, active, birthday, work_anniversary, created_at)
        VALUES (?, ?, ?, ?, 'member', 1, ?, ?, ?)
      `).run(userId, row.candidate_name, email, bcrypt.hashSync(password, 10), req.body.birthday, req.body.workAnniversary, now());
      const link = db.prepare('INSERT INTO user_departments (user_id, department_id) VALUES (?, ?)');
      for (const departmentId of departmentIds) link.run(userId, departmentId);
      db.prepare(`UPDATE hiring_resumes SET status = 'joined', user_id = ? WHERE id = ?`).run(userId, row.id);
      const addCheck = db.prepare('INSERT INTO hiring_checks (id, resume_id, label, done) VALUES (?, ?, ?, 0)');
      for (const label of ONBOARDING) addCheck.run(id('chk'), row.id, label);
      logActivity(req.auth.id, `${req.auth.name} created an account for ${row.candidate_name}.`);
    })();
    for (const userIdHr of hrUserIds()) {
      notify(userIdHr, `${row.candidate_name}’s account is created. Finish the hiring checklist.`, null, null, 'hiring');
    }
    res.status(201).json({ ok: true, userId });
  });

  app.post('/api/hiring/checks/:id', requireAuth, (req, res) => {
    if (!isHr(req.auth)) return bad(res, 403, 'HR updates the checklist');
    const row = db.prepare('SELECT * FROM hiring_checks WHERE id = ?').get(req.params.id);
    if (!row) return bad(res, 404, 'Checklist item not found');
    db.prepare('UPDATE hiring_checks SET done = ? WHERE id = ?').run(req.body.done ? 1 : 0, row.id);
    res.json({ ok: true });
  });
}
