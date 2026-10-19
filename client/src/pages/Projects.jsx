import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import Field from '../components/Field';
import Modal from '../components/Modal';
import { formatDay } from '../util';

const EMPTY_STAGE = { name: '', startDate: '', endDate: '' };

export default function Projects() {
  const { user } = useAuth();
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
    stages: [{ ...EMPTY_STAGE }],
  });
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/projects').then((data) => setProjects(data.projects)).catch((err) => setError(err.message));
  }

  const canCreate = user.isAdmin || user.isLead;
  const departmentChoices = departments;

  useEffect(() => {
    load();
    if (user.isAdmin || user.isLead) {
      api('/departments').then((data) => setDepartments(data.departments)).catch(() => {});
      api('/users').then((data) => setPeople(data.users.filter((person) => person.active))).catch(() => {});
    }
  }, [user.isAdmin, user.isLead]);

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
        body: {
          ...form,
          stages: form.stages.filter((stage) => stage.name.trim()),
        },
      });
      setCreating(false);
      setForm({ name: '', description: '', startDate: '', endDate: '', departmentIds: [], memberIds: [], stages: [{ ...EMPTY_STAGE }] });
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
          <p className="lede">A project has a timeline, stages, and the teams sharing it.</p>
        </div>
        {canCreate ? <button type="button" className="btn primary" onClick={() => setCreating(true)}>New project</button> : null}
      </div>
      {error ? <p className="banner">{error}</p> : null}
      {projects.length === 0 ? <p className="muted">No projects yet. An admin or a team lead can add one.</p> : null}
      <div className="project-grid">
        {projects.map((project) => {
          const pct = project.taskCount ? Math.round((project.doneCount / project.taskCount) * 100) : 0;
          return (
            <Link key={project.id} to={`/projects/${project.id}`} className="project-card">
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
              <Field label="Starts"><input type="date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} required /></Field>
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
            <div className="stack">
              <span className="field-label">Stages</span>
              {form.stages.map((stage, index) => (
                <div key={index} className="fields three">
                  <input placeholder="Stage name" value={stage.name} onChange={(event) => {
                    const stages = form.stages.slice();
                    stages[index] = { ...stage, name: event.target.value };
                    setForm({ ...form, stages });
                  }} required />
                  <input type="date" value={stage.startDate} onChange={(event) => {
                    const stages = form.stages.slice();
                    stages[index] = { ...stage, startDate: event.target.value };
                    setForm({ ...form, stages });
                  }} required />
                  <input type="date" value={stage.endDate} onChange={(event) => {
                    const stages = form.stages.slice();
                    stages[index] = { ...stage, endDate: event.target.value };
                    setForm({ ...form, stages });
                  }} required />
                </div>
              ))}
              <button type="button" className="btn ghost small" onClick={() => setForm({ ...form, stages: [...form.stages, { ...EMPTY_STAGE }] })}>Add stage</button>
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
