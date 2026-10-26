import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { PRIORITIES } from '../util';
import Field from './Field';

export default function TaskForm({ projects, people, fixedProjectId = '', defaultAssigneeId = '', onCancel, onCreated }) {
  const { user } = useAuth();
  const choices = projects.filter((project) => project.canAddTask && project.status !== 'done');
  const [projectId, setProjectId] = useState(fixedProjectId);
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId || user.id);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('medium');
  const [teamIds, setTeamIds] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const project = choices.find((item) => item.id === projectId) || projects.find((item) => item.id === projectId);
  const wide = user.isAdmin || user.isManager;
  const canAssign = wide || (user.isLead && (!projectId || project?.canAssign));
  const onProject = project ? project.members.filter((member) => member.active !== false) : people;
  const fromTeams = project && canAssign
    ? people.filter((person) => person.active !== false
      && !project.members.some((member) => member.id === person.id)
      && (wide || person.departments?.some((item) => project.departments.some((team) => team.id === item.id))))
    : [];
  const adding = fromTeams.some((person) => person.id === assigneeId);

  function chooseProject(value) {
    setProjectId(value);
    const nextProject = choices.find((item) => item.id === value) || projects.find((item) => item.id === value);
    const pool = nextProject ? nextProject.members.filter((member) => member.active !== false) : people;
    const mayAssign = user.isAdmin || user.isManager || (user.isLead && (!value || nextProject?.canAssign));
    if (mayAssign && pool[0] && !pool.some((person) => person.id === assigneeId)) setAssigneeId(pool[0].id);
    if (!mayAssign) setAssigneeId(user.id);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        title,
        description,
        dueDate,
        priority,
        projectId: projectId || null,
      };
      if (canAssign && teamIds.length) {
        body.departmentIds = teamIds;
      } else {
        const chosen = canAssign ? assigneeId : user.id;
        if (project && fromTeams.some((person) => person.id === chosen)) {
          await api(`/projects/${project.id}/members`, { method: 'POST', body: { userId: chosen } });
        }
        body.assigneeId = chosen;
      }
      await api('/tasks', { method: 'POST', body });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field label={teamIds.length ? 'What the team will do' : (canAssign && assigneeId !== user.id ? 'What they’ll do' : 'What I’ll do')}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={140} />
      </Field>
      <Field label="Details">
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="fields two">
        <Field label="Done by">
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} required />
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            {PRIORITIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </Field>
      </div>
      {fixedProjectId ? null : (
        <Field label="Project" hint={canAssign ? 'Leave this empty to assign work that isn’t on a project.' : 'Leave this empty for work that is just yours.'}>
          <select value={projectId} onChange={(event) => chooseProject(event.target.value)}>
            <option value="">{canAssign ? 'No project' : 'Just for me'}</option>
            {choices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
      )}
      {canAssign ? (
        <>
        <Field label="Assign to" hint={teamIds.length ? 'Turned off while a whole team is selected.' : (adding ? 'They will be added to the project, then this task goes to their To do.' : (projectId ? 'People already on the project are listed first.' : 'This shows up in their To do, with no project attached.'))}>
          <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={teamIds.length > 0}>
            {project ? <optgroup label="On this project">{onProject.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</optgroup> : onProject.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            {fromTeams.length ? (
              <optgroup label={user.isAdmin || user.isManager ? 'Anyone else' : 'Add from these teams'}>
                {fromTeams.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </optgroup>
            ) : null}
          </select>
        </Field>
        {user.leadOf?.length ? (
          <div className="stack">
            <p className="hint">Assign it to a whole team you lead. Everyone on that team gets the task, including you.</p>
            {user.leadOf.map((team) => (
              <label key={team.id} className="check">
                <input
                  type="checkbox"
                  checked={teamIds.includes(team.id)}
                  onChange={() => setTeamIds((current) => (current.includes(team.id) ? current.filter((id) => id !== team.id) : [...current, team.id]))}
                />
                Everyone in {team.name}
              </label>
            ))}
          </div>
        ) : null}
        </>
      ) : (
        <p className="hint">This lands in To do on your board. You can move it between To do and In progress, then send it to Review. Your team lead marks it done. To take it off the board, ask them and leave a note.</p>
      )}
      {error ? <p className="error">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy}>{busy ? 'Adding…' : 'Add task'}</button>
      </div>
    </form>
  );
}
