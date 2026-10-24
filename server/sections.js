import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import {
  count,
  deleteOne,
  exists,
  findMany,
  findOne,
  id,
  insertOne,
  logActivity,
  notify,
  now,
  updateMany,
  updateOne,
  usersByIds,
  withTx,
} from './db.js';

const uploadDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'uploads');
const ALLOWED = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'png', 'jpg', 'jpeg', 'txt', 'md', 'zip']);
const ONBOARDING = ['Adding to Razorpay', 'Gate access', 'Document verification', 'System access'];
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

function saveImage(file) {
  if (!file?.name || !file?.data) return null;
  const ext = String(file.name).split('.').pop().toLowerCase();
  if (!IMAGES.has(ext)) {
    const error = new Error('Use a png, jpg, webp, or gif screenshot');
    error.status = 400;
    throw error;
  }
  const raw = Buffer.from(String(file.data), 'base64');
  if (!raw.length) {
    const error = new Error('That screenshot was empty');
    error.status = 400;
    throw error;
  }
  if (raw.length > 3 * 1024 * 1024) {
    const error = new Error('Keep each screenshot under 3 MB');
    error.status = 400;
    throw error;
  }
  fs.mkdirSync(uploadDir, { recursive: true });
  const stored = `${id('file')}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, stored), raw);
  return { stored, name: String(file.name).slice(0, 180) };
}

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
    rawTask, maybeFinishDeparture, isISODate, uniqueList, wrap,
  } = ctx;

  async function notepadList(userId) {
    const countNotes = await count('notepad_days', { user_id: userId });
    if (!countNotes) {
      const legacy = await findOne('personal_notes', { user_id: userId });
      if (legacy?.body?.trim()) {
        const day = String(legacy.updated_at || now()).slice(0, 10);
        await insertOne('notepad_days', {
          id: id('note'),
          user_id: userId,
          day,
          body: legacy.body,
          position: 0,
          updated_at: legacy.updated_at || now(),
        });
      }
    }
    const notes = await findMany('notepad_days', { user_id: userId });
    notes.sort((left, right) => left.position - right.position || right.day.localeCompare(left.day));
    return notes.map((note) => ({
      id: note.id,
      day: note.day,
      body: note.body,
      position: note.position,
      updatedAt: note.updated_at,
    }));
  }

  app.get('/api/notepad', requireAuth, wrap(async (req, res) => {
    res.json({ notes: await notepadList(req.auth.id) });
  }));

  app.post('/api/notepad', requireAuth, wrap(async (req, res) => {
    if (!isISODate(req.body.day)) return bad(res, 400, 'Choose a day');
    await notepadList(req.auth.id);
    const existing = await findOne('notepad_days', { user_id: req.auth.id, day: req.body.day });
    if (!existing) {
      const notes = await findMany('notepad_days', { user_id: req.auth.id });
      const min = notes.length ? Math.min(...notes.map((note) => note.position)) : null;
      await insertOne('notepad_days', {
        id: id('note'),
        user_id: req.auth.id,
        day: req.body.day,
        body: '',
        position: min == null ? 0 : min - 1,
        updated_at: now(),
      });
    }
    res.status(existing ? 200 : 201).json({ notes: await notepadList(req.auth.id) });
  }));

  app.post('/api/notepad/order', requireAuth, wrap(async (req, res) => {
    const notes = await notepadList(req.auth.id);
    const known = new Set(notes.map((note) => note.id));
    const wanted = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((noteId) => known.has(noteId));
    if (!wanted.length) return bad(res, 400, 'Choose notes to rearrange');
    const queue = [...wanted];
    const next = notes.map((note) => (wanted.includes(note.id) ? queue.shift() : note.id));
    await withTx(async () => {
      for (let index = 0; index < next.length; index += 1) {
        await updateOne('notepad_days', { _id: next[index], user_id: req.auth.id }, { position: index });
      }
    });
    res.json({ notes: await notepadList(req.auth.id) });
  }));

  app.patch('/api/notepad/:id', requireAuth, wrap(async (req, res) => {
    const note = await findOne('notepad_days', { _id: req.params.id, user_id: req.auth.id });
    if (!note) return bad(res, 404, 'Note not found');
    const body = readText(req.body.body, 4000, 'the note');
    if (body.error) return bad(res, 400, body.error);
    const stamp = now();
    await updateOne('notepad_days', { _id: note.id }, { body: body.value, updated_at: stamp });
    res.json({ id: note.id, body: body.value, updatedAt: stamp });
  }));

  app.delete('/api/notepad/:id', requireAuth, wrap(async (req, res) => {
    const note = await findOne('notepad_days', { _id: req.params.id, user_id: req.auth.id });
    if (!note) return bad(res, 404, 'Note not found');
    await deleteOne('notepad_days', { _id: note.id });
    res.json({ notes: await notepadList(req.auth.id) });
  }));

  app.get('/api/files/:stored', requireAuth, (req, res) => {
    const stored = path.basename(String(req.params.stored || ''));
    const full = path.join(uploadDir, stored);
    if (!stored || !fs.existsSync(full)) return bad(res, 404, 'File not found');
    res.download(full);
  });

  app.get('/api/knowledge', requireAuth, wrap(async (req, res) => {
    const rows = (await findMany('knowledge_items', {})).sort((left, right) => right.created_at.localeCompare(left.created_at));
    const projects = await findMany('projects', { _id: { $in: rows.map((row) => row.project_id).filter(Boolean) } });
    const authors = await usersByIds(rows.map((row) => row.author_id));
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    const items = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      note: row.note,
      link: row.link,
      fileName: row.file_name,
      fileStored: row.file_stored,
      personName: row.person_name,
      userId: row.user_id,
      projectId: row.project_id,
      taskId: row.task_id,
      createdAt: row.created_at,
      projectName: row.project_id ? (projectMap.get(row.project_id)?.name || null) : null,
      authorName: authors.get(row.author_id)?.name || null,
    }));
    const pending = await exists('departure_requests', { user_id: req.auth.id, status: 'open' })
      || await exists('departure_holds', { user_id: req.auth.id });
    const hasKt = items.some((item) => item.kind === 'kt' && item.userId === req.auth.id && item.fileStored);
    const projectChoices = (await findMany('projects', {})).sort((left, right) => left.name.localeCompare(right.name))
      .map((project) => ({ id: project.id, name: project.name }));
    res.json({ items, needsKt: pending && !hasKt, projects: projectChoices });
  }));

  app.post('/api/knowledge', requireAuth, wrap(async (req, res) => {
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
      const person = await findOne('users', { _id: userId });
      if (!person) return bad(res, 404, 'Person not found');
      await insertOne('knowledge_items', {
        id: id('kno'),
        kind: 'kt',
        title: title.value,
        note: note.value,
        link: null,
        file_name: file.name,
        file_stored: file.stored,
        person_name: person.name,
        user_id: person.id,
        project_id: null,
        task_id: null,
        author_id: req.auth.id,
        created_at: now(),
      });
      await logActivity(req.auth.id, `${req.auth.name} added a KT document for ${person.name}.`);
      const finished = await maybeFinishDeparture(person.id, req.auth);
      return res.status(201).json({ ok: true, removed: finished.removed, message: finished.removed ? finished.message : 'KT document saved' });
    }
    const project = await findOne('projects', { _id: req.body.projectId });
    if (!project) return bad(res, 400, 'Choose a project');
    if (!link && !file) return bad(res, 400, 'Add a link or a file');
    if (link && !/^https?:\/\//i.test(link)) return bad(res, 400, 'The link should start with http:// or https://');
    const taskId = req.body.taskId || null;
    if (taskId) {
      const task = await rawTask(taskId);
      if (!task || task.project_id !== project.id) return bad(res, 400, 'That task is not on this project');
    }
    await insertOne('knowledge_items', {
      id: id('kno'),
      kind: 'project',
      title: title.value,
      note: note.value,
      link: link || null,
      file_name: file?.name || null,
      file_stored: file?.stored || null,
      person_name: '',
      user_id: null,
      project_id: project.id,
      task_id: taskId,
      author_id: req.auth.id,
      created_at: now(),
    });
    const members = await findMany('project_members', { project_id: project.id });
    for (const member of members) {
      if (member.user_id !== req.auth.id) {
        await notify(member.user_id, `${req.auth.name} added “${title.value}” to the ${project.name} knowledge base.`, taskId, project.id, 'knowledge');
      }
    }
    await logActivity(req.auth.id, `${req.auth.name} added “${title.value}” to the ${project.name} knowledge base.`, taskId, project.id);
    res.status(201).json({ ok: true });
  }));

  app.get('/api/tenders', requireAuth, wrap(async (req, res) => {
    if (!canOffice(req.auth)) return bad(res, 403, 'Tenders are for team leads and HR');
    const rows = await findMany('tenders', {});
    const users = await usersByIds(rows.map((row) => row.created_by));
    const tenders = rows.flatMap((row) => {
      const creator = users.get(row.created_by);
      if (!creator) return [];
      return [{
        id: row.id,
        name: row.name,
        description: row.description,
        organisation: row.organisation,
        amount: row.amount,
        emd: row.emd,
        lastDate: row.last_date,
        link: row.link,
        status: row.status,
        createdAt: row.created_at,
        createdByName: creator.name,
      }];
    }).sort((left, right) => left.lastDate.localeCompare(right.lastDate) || right.createdAt.localeCompare(left.createdAt));
    res.json({ tenders });
  }));

  app.post('/api/tenders', requireAuth, wrap(async (req, res) => {
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
    await insertOne('tenders', {
      id: tenderId,
      name: name.value,
      description: description.value,
      organisation: organisation.value,
      amount: amount.value,
      emd: emd.value,
      last_date: req.body.lastDate,
      link,
      status: 'open',
      created_by: req.auth.id,
      created_at: now(),
    });
    const leads = (await findMany('departments', { lead_id: { $ne: null } })).map((row) => row.lead_id);
    const watchers = new Set([...(await hrUserIds()), ...leads]);
    for (const userId of watchers) {
      if (userId !== req.auth.id) await notify(userId, `${req.auth.name} added the tender “${name.value}”.`, null, null, 'tenders');
    }
    await logActivity(req.auth.id, `${req.auth.name} added the tender “${name.value}”.`);
    res.status(201).json({ id: tenderId });
  }));

  app.post('/api/tenders/:id/status', requireAuth, wrap(async (req, res) => {
    if (!canOffice(req.auth)) return bad(res, 403, 'Tenders are for team leads and HR');
    const tender = await findOne('tenders', { _id: req.params.id });
    if (!tender) return bad(res, 404, 'Tender not found');
    if (!['open', 'applied', 'skipped'].includes(req.body.status)) return bad(res, 400, 'Choose a status');
    await updateOne('tenders', { _id: tender.id }, { status: req.body.status });
    res.json({ ok: true });
  }));

  app.get('/api/dependencies', requireAuth, wrap(async (req, res) => {
    const deps = (await findMany('task_dependencies', {
      status: 'open',
      $or: [{ requester_id: req.auth.id }, { depends_on_id: req.auth.id }],
    })).sort((left, right) => right.created_at.localeCompare(left.created_at));
    const tasks = await findMany('tasks', { _id: { $in: deps.map((dep) => dep.task_id) } });
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const users = await usersByIds(deps.flatMap((dep) => [dep.requester_id, dep.depends_on_id]));
    const rows = deps.flatMap((dep) => {
      const task = taskMap.get(dep.task_id);
      const requester = users.get(dep.requester_id);
      const depends = users.get(dep.depends_on_id);
      if (!task || !requester || !depends) return [];
      return [{
        id: dep.id,
        note: dep.note,
        status: dep.status,
        createdAt: dep.created_at,
        requesterId: dep.requester_id,
        requesterName: requester.name,
        dependsOnId: dep.depends_on_id,
        dependsOnName: depends.name,
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
      }];
    });
    const openTasks = (await findMany('tasks', { status: { $ne: 'done' } })).sort((left, right) => left.due_date.localeCompare(right.due_date) || left.title.localeCompare(right.title));
    const assignees = await usersByIds(openTasks.map((task) => task.assignee_id));
    const people = (await findMany('users', { active: 1 })).sort((left, right) => left.name.localeCompare(right.name))
      .map((person) => ({ id: person.id, name: person.name }));
    res.json({
      waitingOnMe: rows.filter((row) => row.dependsOnId === req.auth.id),
      raised: rows.filter((row) => row.requesterId === req.auth.id),
      tasks: openTasks.flatMap((task) => {
        const assignee = assignees.get(task.assignee_id);
        if (!assignee) return [];
        return [{ id: task.id, title: task.title, assigneeName: assignee.name }];
      }),
      people,
    });
  }));

  app.post('/api/dependencies', requireAuth, wrap(async (req, res) => {
    const task = await rawTask(req.body.taskId);
    if (!task) return bad(res, 404, 'Task not found');
    if (task.status === 'done') return bad(res, 400, 'That task is already done');
    const person = await activeUser(req.body.dependsOnId);
    if (!person) return bad(res, 400, 'Choose the person this depends on');
    if (person.id === req.auth.id) return bad(res, 400, 'Choose someone else');
    const note = readText(req.body.note, 500, 'what you need', true);
    if (note.error) return bad(res, 400, note.error);
    if (await exists('task_dependencies', { task_id: task.id, depends_on_id: person.id, status: 'open' })) {
      return bad(res, 400, `${person.name} already has an open request on this task`);
    }
    await insertOne('task_dependencies', {
      id: id('dep'),
      task_id: task.id,
      requester_id: req.auth.id,
      depends_on_id: person.id,
      note: note.value,
      status: 'open',
      created_at: now(),
    });
    await notify(person.id, `${req.auth.name} needs you on “${task.title}”. ${note.value}`, task.id, task.project_id, 'dependencies');
    await logActivity(req.auth.id, `${req.auth.name} asked ${person.name} for help on “${task.title}”.`, task.id, task.project_id);
    res.status(201).json({ ok: true });
  }));

  app.post('/api/dependencies/:id/done', requireAuth, wrap(async (req, res) => {
    const row = await findOne('task_dependencies', { _id: req.params.id });
    if (!row || row.status !== 'open') return bad(res, 404, 'Request not found');
    if (row.depends_on_id !== req.auth.id && !req.auth.isAdmin) return bad(res, 403, 'Only that person can clear this');
    await updateOne('task_dependencies', { _id: row.id }, { status: 'done' });
    const task = await rawTask(row.task_id);
    await notify(row.requester_id, `${req.auth.name} cleared the dependency on “${task?.title || 'a task'}”.`, row.task_id, task?.project_id || null, 'dependencies');
    res.json({ ok: true });
  }));

  function hiringGate(req, res) {
    if (!canOffice(req.auth)) {
      bad(res, 403, 'Hiring is for team leads and HR');
      return false;
    }
    return true;
  }

  async function resumeView(row) {
    const checks = (await findMany('hiring_checks', { resume_id: row.id })).sort((left, right) => left.label.localeCompare(right.label));
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
      checks: checks.map((item) => ({ id: item.id, label: item.label, done: Boolean(item.done) })),
    };
  }

  async function loadResumes(filter = {}) {
    const rows = (await findMany('hiring_resumes', filter)).sort((left, right) => right.created_at.localeCompare(left.created_at));
    const users = await usersByIds(rows.flatMap((row) => [row.uploaded_by, row.reviewer_id]));
    return rows.flatMap((row) => {
      const uploader = users.get(row.uploaded_by);
      if (!uploader) return [];
      return [{
        ...row,
        uploader_name: uploader.name,
        reviewer_name: row.reviewer_id ? (users.get(row.reviewer_id)?.name || null) : null,
      }];
    });
  }

  app.get('/api/hiring', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const departmentRows = (await findMany('departments', {})).sort((left, right) => left.name.localeCompare(right.name));
    const deptMap = new Map(departmentRows.map((department) => [department.id, department]));
    const positions = (await findMany('hiring_positions', {})).flatMap((position) => {
      const department = deptMap.get(position.department_id);
      if (!department) return [];
      return [{
        id: position.id,
        title: position.title,
        description: position.description,
        status: position.status,
        departmentId: position.department_id,
        departmentName: department.name,
        createdAt: position.created_at,
      }];
    }).sort((left, right) => left.status.localeCompare(right.status) || left.departmentName.localeCompare(right.departmentName) || left.title.localeCompare(right.title));
    const resumes = await Promise.all((await loadResumes()).map((row) => resumeView(row)));
    const people = (await findMany('users', { active: 1 })).sort((left, right) => left.name.localeCompare(right.name))
      .map((person) => ({ id: person.id, name: person.name }));
    res.json({
      positions,
      resumes,
      departments: departmentRows.map((department) => ({ id: department.id, name: department.name })),
      people,
      isHr: isHr(req.auth),
      isAdmin: req.auth.isAdmin,
    });
  }));

  app.post('/api/hiring/positions', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const title = readText(req.body.title, 120, 'a position', true);
    if (title.error) return bad(res, 400, title.error);
    const description = readText(req.body.description, 2000, 'a description');
    if (description.error) return bad(res, 400, description.error);
    const department = await findOne('departments', { _id: req.body.departmentId });
    if (!department) return bad(res, 400, 'Choose a department');
    const positionId = id('pos');
    await insertOne('hiring_positions', {
      id: positionId,
      department_id: department.id,
      title: title.value,
      description: description.value,
      status: 'open',
      created_by: req.auth.id,
      created_at: now(),
    });
    for (const userId of await hrUserIds()) {
      if (userId !== req.auth.id) await notify(userId, `${req.auth.name} opened hiring for ${title.value} in ${department.name}.`, null, null, 'hiring');
    }
    res.status(201).json({ id: positionId });
  }));

  app.post('/api/hiring/resumes', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const position = await findOne('hiring_positions', { _id: req.body.positionId });
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
    await insertOne('hiring_resumes', {
      id: id('res'),
      position_id: position.id,
      candidate_name: candidate.value,
      comment: comment.value,
      referral: referral ? 1 : 0,
      referral_name: referral ? referralName.value : '',
      file_name: file.name,
      file_stored: file.stored,
      uploaded_by: req.auth.id,
      status: 'new',
      reviewer_id: null,
      round: 1,
      meet_link: '',
      interview_date: null,
      interview_time: '',
      user_id: null,
      created_at: now(),
    });
    res.status(201).json({ ok: true });
  }));

  app.post('/api/hiring/positions/:id/review', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const position = await findOne('hiring_positions', { _id: req.params.id });
    if (!position) return bad(res, 404, 'Position not found');
    const reviewer = await activeUser(req.body.reviewerId);
    if (!reviewer) return bad(res, 400, 'Choose who should review');
    const open = await count('hiring_resumes', { position_id: position.id, status: 'new' });
    if (!open) return bad(res, 400, 'There are no new resumes to review');
    await updateMany('hiring_resumes', { position_id: position.id, status: 'new' }, { status: 'in_review', reviewer_id: reviewer.id });
    await notify(reviewer.id, `${req.auth.name} asked you to review resumes for ${position.title}.`, null, null, 'hiring');
    res.json({ ok: true });
  }));

  app.post('/api/hiring/positions/:id/submit', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const position = await findOne('hiring_positions', { _id: req.params.id });
    if (!position) return bad(res, 404, 'Position not found');
    const mine = await findMany('hiring_resumes', { position_id: position.id, status: 'in_review', reviewer_id: req.auth.id });
    if (!mine.length && !req.auth.isAdmin) return bad(res, 403, 'These resumes are not waiting on you');
    const pool = mine.length ? mine : await findMany('hiring_resumes', { position_id: position.id, status: 'in_review' });
    const chosen = new Set(Array.isArray(req.body.resumeIds) ? req.body.resumeIds : []);
    if (![...chosen].some((resumeId) => pool.some((row) => row.id === resumeId))) {
      return bad(res, 400, 'Select at least one resume');
    }
    for (const row of pool) {
      if (chosen.has(row.id)) {
        await updateOne('hiring_resumes', { _id: row.id }, { status: 'shortlisted' });
        await notify(row.uploaded_by, `${row.candidate_name} is selected for interview for ${position.title}. Add the meet link, date, and time.`, null, null, 'hiring');
      } else {
        await updateOne('hiring_resumes', { _id: row.id }, { status: 'passed' });
      }
    }
    res.json({ ok: true });
  }));

  app.post('/api/hiring/resumes/:id/interview', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = await findOne('hiring_resumes', { _id: req.params.id });
    if (!row) return bad(res, 404, 'Resume not found');
    if (!['shortlisted', 'next_round'].includes(row.status)) return bad(res, 400, 'This candidate is not waiting on a schedule');
    if (row.uploaded_by !== req.auth.id && !req.auth.isAdmin && !isHr(req.auth)) return bad(res, 403, 'The person who added the resume schedules the interview');
    const link = String(req.body.meetLink || '').trim();
    if (!/^https?:\/\//i.test(link)) return bad(res, 400, 'Add the Google Meet link');
    if (!isISODate(req.body.date)) return bad(res, 400, 'Choose the interview date');
    const time = readText(req.body.time, 20, 'a time', true);
    if (time.error) return bad(res, 400, time.error);
    await updateOne('hiring_resumes', { _id: row.id }, {
      status: 'scheduled',
      meet_link: link,
      interview_date: req.body.date,
      interview_time: time.value,
    });
    if (row.reviewer_id) {
      await notify(row.reviewer_id, `Interview for ${row.candidate_name} is ${req.body.date} at ${time.value}. ${link}`, null, null, 'hiring');
    }
    res.json({ ok: true });
  }));

  app.post('/api/hiring/resumes/:id/outcome', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = await findOne('hiring_resumes', { _id: req.params.id });
    if (!row || row.status !== 'scheduled') return bad(res, 400, 'Schedule the interview first');
    const position = await findOne('hiring_positions', { _id: row.position_id });
    if (req.body.result === 'rejected') {
      await updateOne('hiring_resumes', { _id: row.id }, { status: 'discarded' });
      await notify(row.uploaded_by, `${row.candidate_name} was not selected for ${position?.title || 'the role'}.`, null, null, 'hiring');
      return res.json({ ok: true });
    }
    if (req.body.result !== 'selected') return bad(res, 400, 'Choose selected or rejected');
    if (req.body.next === 'round') {
      await updateOne('hiring_resumes', { _id: row.id }, {
        $set: { status: 'next_round', meet_link: '', interview_date: null, interview_time: '' },
        $inc: { round: 1 },
      });
      await notify(row.uploaded_by, `${row.candidate_name} is through to the next round for ${position?.title || 'the role'}. Schedule it.`, null, null, 'hiring');
      return res.json({ ok: true });
    }
    if (req.body.next !== 'final') return bad(res, 400, 'Choose the next round or mark this final');
    await updateOne('hiring_resumes', { _id: row.id }, { status: 'final' });
    await notify(row.uploaded_by, `${row.candidate_name} is a final selection for ${position?.title || 'the role'}.`, null, null, 'hiring');
    res.json({ ok: true });
  }));

  app.post('/api/hiring/resumes/:id/discard', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = await findOne('hiring_resumes', { _id: req.params.id });
    if (!row || !['final', 'shortlisted', 'next_round', 'passed'].includes(row.status)) return bad(res, 400, 'This resume can’t be discarded from here');
    await updateOne('hiring_resumes', { _id: row.id }, { status: 'discarded' });
    res.json({ ok: true });
  }));

  app.post('/api/hiring/resumes/:id/request-account', requireAuth, wrap(async (req, res) => {
    if (!hiringGate(req, res)) return undefined;
    const row = await findOne('hiring_resumes', { _id: req.params.id });
    if (!row || row.status !== 'final') return bad(res, 400, 'Mark the interview as the final round first');
    await updateOne('hiring_resumes', { _id: row.id }, { status: 'account_requested' });
    for (const admin of await findMany('users', { role: 'admin', active: 1 })) {
      await notify(admin.id, `${req.auth.name} asked you to create an account for ${row.candidate_name}.`, null, null, 'hiring');
    }
    res.json({ ok: true });
  }));

  app.post('/api/hiring/resumes/:id/account', requireAuth, requireAdmin, wrap(async (req, res) => {
    const row = await findOne('hiring_resumes', { _id: req.params.id });
    const position = row ? await findOne('hiring_positions', { _id: row.position_id }) : null;
    if (!row || !position || !['account_requested', 'final'].includes(row.status)) return bad(res, 400, 'This candidate is not ready for an account');
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 400, 'Enter a valid email');
    const password = String(req.body.password || '');
    if (password.length < 8) return bad(res, 400, 'Use at least 8 characters for the password');
    if (!isISODate(req.body.birthday)) return bad(res, 400, 'Choose a birthday');
    if (!isISODate(req.body.workAnniversary)) return bad(res, 400, 'Choose a work anniversary');
    const departmentIds = uniqueList(req.body.departmentIds?.length ? req.body.departmentIds : [position.department_id]);
    if (!departmentIds.length) return bad(res, 400, 'Choose a department');
    for (const departmentId of departmentIds) {
      if (!await exists('departments', { _id: departmentId })) return bad(res, 400, 'Choose a department');
    }
    if (await exists('users', { email })) return bad(res, 400, 'That email is already in use');
    const userId = id('usr');
    await withTx(async () => {
      await insertOne('users', {
        id: userId,
        name: row.candidate_name,
        email,
        password_hash: bcrypt.hashSync(password, 10),
        role: 'member',
        active: 1,
        birthday: req.body.birthday,
        work_anniversary: req.body.workAnniversary,
        created_at: now(),
      });
      for (const departmentId of departmentIds) {
        await insertOne('user_departments', { _id: `${userId}:${departmentId}`, user_id: userId, department_id: departmentId });
      }
      await updateOne('hiring_resumes', { _id: row.id }, { status: 'joined', user_id: userId });
      for (const label of ONBOARDING) {
        await insertOne('hiring_checks', { id: id('chk'), resume_id: row.id, label, done: 0 });
      }
      await logActivity(req.auth.id, `${req.auth.name} created an account for ${row.candidate_name}.`);
    });
    for (const userIdHr of await hrUserIds()) {
      await notify(userIdHr, `${row.candidate_name}’s account is created. Finish the hiring checklist.`, null, null, 'hiring');
    }
    res.status(201).json({ ok: true, userId });
  }));

  app.post('/api/hiring/checks/:id', requireAuth, wrap(async (req, res) => {
    if (!isHr(req.auth)) return bad(res, 403, 'HR updates the checklist');
    const row = await findOne('hiring_checks', { _id: req.params.id });
    if (!row) return bad(res, 404, 'Checklist item not found');
    await updateOne('hiring_checks', { _id: row.id }, { done: req.body.done ? 1 : 0 });
    res.json({ ok: true });
  }));

  async function reportList() {
    const rows = (await findMany('reports', {}, { sort: { created_at: -1 }, limit: 200 }));
    const users = await usersByIds(rows.map((row) => row.author_id));
    const shots = rows.length ? await findMany('report_shots', { report_id: { $in: rows.map((row) => row.id) } }) : [];
    const byReport = new Map();
    for (const shot of shots) {
      if (!byReport.has(shot.report_id)) byReport.set(shot.report_id, []);
      byReport.get(shot.report_id).push({ id: shot.id, name: shot.file_name, stored: shot.file_stored });
    }
    return rows.flatMap((row) => {
      const author = users.get(row.author_id);
      if (!author) return [];
      return [{
        id: row.id,
        kind: row.kind,
        title: row.title,
        details: row.details,
        page: row.page,
        status: row.status,
        createdAt: row.created_at,
        authorId: row.author_id,
        authorName: author.name,
        shots: byReport.get(row.id) || [],
      }];
    });
  }

  app.get('/api/reports', requireAuth, wrap(async (_req, res) => {
    res.json({ reports: await reportList() });
  }));

  app.post('/api/reports', requireAuth, wrap(async (req, res) => {
    const kind = req.body.kind === 'suggestion' ? 'suggestion' : req.body.kind === 'bug' ? 'bug' : '';
    if (!kind) return bad(res, 400, 'Choose a bug or a suggestion');
    const title = readText(req.body.title, 140, 'a title', true);
    if (title.error) return bad(res, 400, title.error);
    const details = readText(req.body.details, 4000, 'the details', true);
    if (details.error) return bad(res, 400, details.error);
    const page = readText(req.body.page, 200, 'the page');
    if (page.error) return bad(res, 400, page.error);
    const incoming = Array.isArray(req.body.shots) ? req.body.shots.filter((file) => file?.name || file?.data) : [];
    if (incoming.length > 3) return bad(res, 400, 'Attach up to 3 screenshots');
    let saved = [];
    try {
      saved = incoming.map((file) => saveImage(file)).filter(Boolean);
    } catch (error) {
      return bad(res, error.status || 400, error.message);
    }
    const reportId = id('rpt');
    await withTx(async () => {
      await insertOne('reports', {
        id: reportId,
        kind,
        title: title.value,
        details: details.value,
        page: page.value || null,
        author_id: req.auth.id,
        status: 'open',
        created_at: now(),
      });
      for (const file of saved) {
        await insertOne('report_shots', { id: id('shot'), report_id: reportId, file_name: file.name, file_stored: file.stored });
      }
      await logActivity(req.auth.id, `${req.auth.name} reported a ${kind === 'bug' ? 'bug' : 'suggestion'}: ${title.value}.`);
    });
    res.status(201).json({ reports: await reportList() });
  }));

  app.patch('/api/reports/:id', requireAuth, wrap(async (req, res) => {
    const row = await findOne('reports', { _id: req.params.id });
    if (!row) return bad(res, 404, 'Report not found');
    const status = req.body.status === 'fixed' ? 'fixed' : req.body.status === 'open' ? 'open' : '';
    if (!status) return bad(res, 400, 'Choose open or fixed');
    if (row.author_id !== req.auth.id && !req.auth.isAdmin && !req.auth.isLead) {
      return bad(res, 403, 'Only the author or a lead can update this');
    }
    await updateOne('reports', { _id: row.id }, { status });
    res.json({ reports: await reportList() });
  }));
}
