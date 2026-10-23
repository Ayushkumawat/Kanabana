import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import Modal from '../components/Modal';
import TaskDrawer from '../components/TaskDrawer';
import TaskForm from '../components/TaskForm';
import { formatDay, formatWhen, parseISODate, statusLabel, todayISO } from '../util';

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [meta, setMeta] = useState(null);
  const [timeline, setTimeline] = useState(null);
  const [memberId, setMemberId] = useState('');
  const [formError, setFormError] = useState('');

  function load() {
    return Promise.all([
      api(`/projects/${id}`),
      api(`/tasks?scope=project&projectId=${id}`),
    ]).then(([projectData, taskData]) => {
      setProject(projectData.project);
      setTasks(taskData.tasks);
      setMeta({
        name: projectData.project.name,
        description: projectData.project.description,
        status: projectData.project.status,
      });
    }).catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    api('/users').then((data) => setPeople(data.users.filter((person) => person.active))).catch(() => {});
  }, [id]);

  if (error && !project) return <p className="banner">{error}</p>;
  if (!project) return <p className="muted">Loading project…</p>;

  const start = parseISODate(project.startDate).getTime();
  const end = parseISODate(project.endDate).getTime();
  const span = Math.max(end - start, 1);
  const today = parseISODate(todayISO()).getTime();
  const showToday = today >= start && today <= end;
  const departmentIds = new Set(project.departments.map((item) => item.id));
  const memberOptions = people.filter((person) => (
    !project.members.some((member) => member.id === person.id)
    && person.departments.some((item) => departmentIds.has(item.id))
  ));
  const work = [...tasks].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));

  async function saveTimeline(event) {
    event.preventDefault();
    setFormError('');
    try {
      const data = await api(`/projects/${project.id}/timeline`, {
        method: 'PATCH',
        body: {
          startDate: timeline.startDate,
          endDate: timeline.endDate,
          reason: timeline.reason,
        },
      });
      setProject(data.project);
      setTimeline(null);
      toast('Timeline updated');
    } catch (err) {
      setFormError(err.message);
    }
  }

  return (
    <div className="stack">
      <Link to="/projects" className="text-link">All projects</Link>
      <div className="page-head">
        <div>
          <p className="kicker">{project.departments.map((item) => item.name).join(' · ')}</p>
          <h1>{project.name}</h1>
          <p className="lede">{project.description}</p>
        </div>
        <div className="actions">
          {project.canEditTimeline ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => setTimeline({
                startDate: project.startDate,
                endDate: project.endDate,
                reason: '',
              })}
            >
              Adjust timeline
            </button>
          ) : null}
          {project.canManage ? <button type="button" className="btn ghost" onClick={() => setEditing(true)}>Edit details</button> : null}
          {project.canDelete ? (
            <button
              type="button"
              className="btn danger"
              onClick={async () => {
                if (!window.confirm(`Delete ${project.name}? Every task on it is removed for everyone.`)) return;
                try {
                  await api(`/projects/${project.id}`, { method: 'DELETE' });
                  toast('Project deleted');
                  navigate('/projects');
                } catch (err) {
                  toast(err.message, 'bad');
                }
              }}
            >
              Delete project
            </button>
          ) : null}
          {project.canAddTask ? <button type="button" className="btn primary" onClick={() => setAdding(true)}>Add task</button> : null}
        </div>
      </div>
      <span className={`pill ${project.status}`}>{project.status}</span>
      <div className="timeline" aria-hidden="true">
        {showToday ? <div className="today-mark" style={{ left: `${((today - start) / span) * 100}%` }} /> : null}
      </div>
      <p className="muted">{formatDay(project.startDate)} – {formatDay(project.endDate)}</p>
      {!project.canAddTask ? <p className="hint">Ask a team lead or admin to add you before you can put your own work on this project.</p> : (
        <p className="hint">
          {project.canAssign
            ? 'Assign a task to someone on this project. It shows up in their To do. You mark it done after they send it to review.'
            : 'Your task starts in To do. Move it to In progress, then to Review. Your team lead marks it done. To remove it, ask them and leave a note.'}
        </p>
      )}
      <div className="split">
        <section className="panel stack">
          <h2>Work</h2>
          {work.length === 0 ? <p className="muted">No tasks on this project yet.</p> : work.map((task) => (
            project.canAssign || task.assigneeId === user.id || task.creatorId === user.id || user.isAdmin ? (
              <button type="button" key={task.id} className="handoff-row" onClick={() => setOpenId(task.id)}>
                <span>
                  <strong>{task.assigneeName}</strong> · {task.title}
                  <small>{formatDay(task.dueDate)} · {statusLabel(task.status)}</small>
                </span>
              </button>
            ) : (
              <div key={task.id} className="handoff-row">
                <span>
                  <strong>{task.assigneeName}</strong> · {task.title}
                  <small>{formatDay(task.dueDate)} · {statusLabel(task.status)}</small>
                </span>
              </div>
            )
          ))}
        </section>
        <div className="stack">
          <section className="panel stack">
            <h2>People</h2>
            {project.members.map((member) => (
              <div key={member.id} className="row-between">
                <span>{member.name}</span>
                {project.canAssign ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={async () => {
                      try {
                        const data = await api(`/projects/${project.id}/members/${member.id}`, { method: 'DELETE' });
                        setProject(data.project);
                      } catch (err) {
                        toast(err.message, 'bad');
                      }
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            {project.canAssign ? (
              <form
                className="stack"
                onSubmit={async (event) => {
                  event.preventDefault();
                  try {
                    const data = await api(`/projects/${project.id}/members`, { method: 'POST', body: { userId: memberId } });
                    setProject(data.project);
                    setMemberId('');
                  } catch (err) {
                    toast(err.message, 'bad');
                  }
                }}
              >
                <Field label="Add someone from these teams">
                  <select value={memberId} onChange={(event) => setMemberId(event.target.value)} required>
                    <option value="">Choose</option>
                    {memberOptions.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                </Field>
                <button className="btn small">Add</button>
              </form>
            ) : null}
          </section>
          <section className="panel stack">
            <h2>Why dates moved</h2>
            {project.history.length === 0 ? <p className="muted">No date changes yet.</p> : (
              <div className="history">
                {project.history.map((item) => (
                  <article key={item.id}>
                    <strong>{item.actorName}</strong>
                    <small className="muted"> {formatWhen(item.createdAt)}</small>
                    <p>{item.reason}</p>
                    <p className="muted">{formatDay(item.before.startDate)} – {formatDay(item.before.endDate)} → {formatDay(item.after.startDate)} – {formatDay(item.after.endDate)}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      {adding ? (
        <Modal title="Add my part" wide onClose={() => setAdding(false)}>
          <TaskForm
            projects={[project]}
            people={people}
            fixedProjectId={project.id}
            onCancel={() => setAdding(false)}
            onCreated={() => {
              setAdding(false);
              load();
              toast('Your part is on the board');
            }}
          />
        </Modal>
      ) : null}
      {editing && meta ? (
        <Modal title="Edit project" onClose={() => setEditing(false)}>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                const data = await api(`/projects/${project.id}`, { method: 'PATCH', body: meta });
                setProject(data.project);
                setEditing(false);
              } catch (err) {
                setFormError(err.message);
              }
            }}
          >
            <Field label="Name"><input value={meta.name} onChange={(event) => setMeta({ ...meta, name: event.target.value })} required /></Field>
            <Field label="Description"><textarea value={meta.description} onChange={(event) => setMeta({ ...meta, description: event.target.value })} /></Field>
            <Field label="Status">
              <select value={meta.status} onChange={(event) => setMeta({ ...meta, status: event.target.value })}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="done">Done</option>
              </select>
            </Field>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {timeline ? (
        <Modal title="Adjust timeline" wide onClose={() => { setTimeline(null); setFormError(''); }}>
          <form className="stack" onSubmit={saveTimeline}>
            <div className="fields two">
              <Field label="Project starts"><input type="date" value={timeline.startDate} onChange={(event) => setTimeline({ ...timeline, startDate: event.target.value })} required /></Field>
              <Field label="Project ends"><input type="date" value={timeline.endDate} onChange={(event) => setTimeline({ ...timeline, endDate: event.target.value })} required /></Field>
            </div>
            <Field
              label="Reason"
              hint={user.isAdmin ? 'Optional for an admin. It still stays on the project.' : 'Required. This stays on the project so the other team can see why the dates moved.'}
            >
              <textarea value={timeline.reason} onChange={(event) => setTimeline({ ...timeline, reason: event.target.value })} required={!user.isAdmin} />
            </Field>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setTimeline(null)}>Cancel</button>
              <button className="btn primary">Save timeline</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {openId ? (
        <TaskDrawer
          taskId={openId}
          people={people}
          projects={[project]}
          onClose={() => setOpenId(null)}
          onChanged={load}
          onOpen={setOpenId}
        />
      ) : null}
    </div>
  );
}
