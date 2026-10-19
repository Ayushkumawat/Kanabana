import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import { weekdayLabel } from '../util';

export default function Recurring() {
  const { user } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState([]);
  const [people, setPeople] = useState([]);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    title: '',
    description: '',
    cadence: 'daily',
    weekday: 1,
    priority: 'medium',
    assigneeId: user.id,
    projectId: '',
  });

  function load() {
    return api('/recurring').then((data) => setRules(data.rules)).catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
    api('/users').then((data) => setPeople(data.users.filter((person) => person.active))).catch(() => {});
    api('/projects').then((data) => setProjects(data.projects.filter((project) => project.status !== 'done'))).catch(() => {});
  }, []);

  const assignable = user.isAdmin
    ? people
    : user.isLead
      ? people.filter((person) => person.id === user.id || person.departments.some((item) => user.leadDepartmentIds.includes(item.id)))
      : people.filter((person) => person.id === user.id);

  async function create(event) {
    event.preventDefault();
    try {
      await api('/recurring', {
        method: 'POST',
        body: { ...form, projectId: form.projectId || null, assigneeId: assignable.length > 1 ? form.assigneeId : user.id },
      });
      setForm({ ...form, title: '', description: '' });
      toast('It will show up on the board each day or week');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Repeating</h1>
          <p className="lede">Daily work appears Monday to Saturday. Sunday is off. Weekly work appears once on the day you choose.</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <div className="split">
        <section className="panel stack">
          <h2>New repeat</h2>
          <form className="stack" onSubmit={create}>
            <Field label="Title"><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></Field>
            <Field label="Details"><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
            <div className="fields two">
              <Field label="How often">
                <select value={form.cadence} onChange={(event) => setForm({ ...form, cadence: event.target.value })}>
                  <option value="daily">Monday to Saturday</option>
                  <option value="weekly">Once a week</option>
                </select>
              </Field>
              {form.cadence === 'weekly' ? (
                <Field label="On">
                  <select value={form.weekday} onChange={(event) => setForm({ ...form, weekday: Number(event.target.value) })}>
                    {[1, 2, 3, 4, 5, 6].map((day) => <option key={day} value={day}>{weekdayLabel(day)}</option>)}
                  </select>
                </Field>
              ) : <Field label="Days"><input value="Monday to Saturday" readOnly /></Field>}
            </div>
            {assignable.length > 1 ? (
              <Field label="For">
                <select value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })}>
                  {assignable.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Project">
              <select value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
                <option value="">No project</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
            <button className="btn primary">Save repeat</button>
          </form>
        </section>
        <section className="stack">
          {rules.length === 0 ? <p className="muted">No repeating tasks yet.</p> : rules.map((rule) => (
            <article key={rule.id} className="panel rule">
              <div className="row-between">
                <h3>{rule.title}</h3>
                <span className={`pill ${rule.active ? 'active' : 'paused'}`}>{rule.active ? 'On' : 'Paused'}</span>
              </div>
              <p className="muted">{rule.cadence === 'daily' ? 'Monday to Saturday' : `Every ${weekdayLabel(rule.weekday)}`} · {rule.assigneeName}{rule.projectName ? ` · ${rule.projectName}` : ''}</p>
              {rule.description ? <p>{rule.description}</p> : null}
              <div className="actions">
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={async () => {
                    try {
                      await api(`/recurring/${rule.id}`, { method: 'PATCH', body: { active: !rule.active } });
                      await load();
                    } catch (err) {
                      toast(err.message, 'bad');
                    }
                  }}
                >
                  {rule.active ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="btn danger small"
                  onClick={async () => {
                    if (!window.confirm('Stop future repeats? Tasks already on the board stay.')) return;
                    try {
                      await api(`/recurring/${rule.id}`, { method: 'DELETE' });
                      await load();
                    } catch (err) {
                      toast(err.message, 'bad');
                    }
                  }}
                >
                  Stop
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
