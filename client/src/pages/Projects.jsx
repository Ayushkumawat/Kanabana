import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import Modal from '../components/Modal';
import { formatDay } from '../util';

const LOCKED = 'You’re not part of this project. Ask the team lead to add you.';

export default function Projects() {
  const { user } = useAuth();
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [people, setPeople] = useState([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    departmentIds: [],
    memberIds: [],
  });
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState('');

  function load() {
    return api('/projects').then((data) => setProjects(data.projects)).catch((err) => setError(err.message));
  }

  const canCreate = user.isAdmin || user.isLead || user.isManager;
  const departmentChoices = departments;

  useEffect(() => {
    load();
    if (user.isAdmin || user.isLead || user.isManager) {
      api('/departments').then((data) => setDepartments(data.departments)).catch(() => {});
      api('/users').then((data) => setPeople(data.users.filter((person) => person.active))).catch(() => {});
    }
  }, [user.isAdmin, user.isLead, user.isManager]);

  const memberChoices = useMemo(
    () => people.filter((person) => person.departments.some((item) => form.departmentIds.includes(item.id))),
    [people, form.departmentIds],
  );

  function toggle(list, id) {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api('/projects', {
        method: 'POST',
        body: form,
      });
      setCreating(false);
      setForm({ name: '', description: '', startDate: '', endDate: '', departmentIds: [], memberIds: [] });
      await load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="lede">{user.isAdmin || user.isManager ? 'Every project is open to you, including the work inside it.' : 'Every project is listed. You can open the ones you’re on. Each team on a project sets its own timeline.'}</p>
        </div>
        {canCreate ? <button type="button" className="btn primary" onClick={() => setCreating(true)}>New project</button> : null}
      </div>
      {error ? <p className="banner">{error}</p> : null}
      {blocked ? <p className="banner">{LOCKED}</p> : null}
      {projects.length === 0 ? <p className="muted">No projects yet. An admin, a manager, or a team lead can add one.</p> : null}
      <div className="project-grid">
        {projects.map((project) => {
          const pct = project.taskCount ? Math.round((project.doneCount / project.taskCount) * 100) : 0;
          const body = (
            <>
              <div className="row-between">
                <span className={`pill ${project.status}`}>{project.status}</span>
                <span className="muted">{formatDay(project.startDate)} – {formatDay(project.endDate)}</span>
              </div>
              <h2>{project.name}</h2>
              <p className="muted">{project.description}</p>
              <div className="chips">
                {project.departments.map((item) => <span key={item.id} className="chip">{item.name}</span>)}
              </div>
              <div className="progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
              <small className="muted">{project.doneCount} of {project.taskCount} done · {project.members.length} people · {project.createdByName}</small>
              {project.canOpen ? null : <small className="late">You’re not on this project</small>}
            </>
          );
          if (!project.canOpen) {
            return (
              <button
                key={project.id}
                type="button"
                className="project-card locked"
                onClick={() => {
                  setBlocked(project.id);
                  toast(LOCKED, 'bad');
                }}
              >
                {body}
              </button>
            );
          }
          return (
            <Link key={project.id} to={`/projects/${project.id}`} className="project-card">
              {body}
            </Link>
          );
        })}
      </div>
      {creating ? (
        <Modal title="New project" wide onClose={() => setCreating(false)}>
          <form className="stack" onSubmit={create}>
            <Field label="Name"><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
            <Field label="Description"><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
            <div className="fields two">
              <Field label="Starts" hint="Project window. Each team lead sets that team’s own timeline afterward."><input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} required /></Field>
              <Field label="Ends"><input type="date" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} required /></Field>
            </div>
            <div className="field">
              <span>Teams on this project</span>
              <p className="hint">A team lead can include other teams, then pick people from those teams.</p>
              <div className="checks">
                {departmentChoices.map((item) => (
                  <label key={item.id} className="check">
                    <input
                      type="checkbox"
                      checked={form.departmentIds.includes(item.id)}
                      onChange={() => setForm({
                        ...form,
                        departmentIds: toggle(form.departmentIds, item.id),
                        memberIds: form.memberIds.filter((id) => people.find((person) => person.id === id)?.departments.some((dep) => toggle(form.departmentIds, item.id).includes(dep.id))),
                      })}
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span>People</span>
              <div className="checks">
                {memberChoices.map((person) => (
                  <label key={person.id} className="check">
                    <input type="checkbox" checked={form.memberIds.includes(person.id)} onChange={() => setForm({ ...form, memberIds: toggle(form.memberIds, person.id) })} />
                    {person.name}
                  </label>
                ))}
                {form.departmentIds.length === 0 ? <p className="hint">Choose a department first.</p> : null}
              </div>
            </div>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create project'}</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
