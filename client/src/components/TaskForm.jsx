import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { PRIORITIES } from '../util';
import Field from './Field';

function listedPerson(person, user, people, wide) {
  if (wide || person.id === user.id) return true;
  const match = people.find((item) => item.id === person.id);
  return !(person.isManager || match?.isManager);
}

function PeoplePick({ groups, selected, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const names = groups.flatMap((group) => group.people).filter((person) => selected.includes(person.id)).map((person) => person.name);
  function toggle(id) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }
  return (
    <div className="people-pick">
      <button type="button" className="pick-face" disabled={disabled} onClick={() => setOpen((value) => !value)}>
        {names.length ? names.join(', ') : 'Choose people'}
      </button>
      {open && !disabled ? (
        <div className="pick-panel">
          <div className="assignee-list">
            {groups.map((group) => (
              <div key={group.label || 'people'} className="stack">
                {group.label ? <p className="hint">{group.label}</p> : null}
                {group.people.map((person) => (
                  <label key={person.id} className="check">
                    <input type="checkbox" checked={selected.includes(person.id)} onChange={() => toggle(person.id)} />
                    {person.name}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <button type="button" className="btn small" onClick={() => setOpen(false)}>Done</button>
        </div>
      ) : null}
    </div>
  );
}

export default function TaskForm({ projects, people, fixedProjectId = '', defaultAssigneeId = '', onCancel, onCreated }) {
  const { user } = useAuth();
  const choices = projects.filter((project) => project.canAddTask && project.status !== 'done');
  const [projectId, setProjectId] = useState(fixedProjectId);
  const [assigneeIds, setAssigneeIds] = useState([defaultAssigneeId || user.id]);
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
  const onProject = (project ? project.members.filter((member) => member.active !== false) : people)
    .filter((person) => listedPerson(person, user, people, wide));
  const fromTeams = project && canAssign
    ? people.filter((person) => person.active !== false
      && listedPerson(person, user, people, wide)
      && !project.members.some((member) => member.id === person.id)
      && (wide || person.departments?.some((item) => project.departments.some((team) => team.id === item.id))))
    : [];
  const adding = fromTeams.some((person) => assigneeIds.includes(person.id));
  const several = assigneeIds.length > 1;

  function chooseProject(value) {
    setProjectId(value);
    const nextProject = choices.find((item) => item.id === value) || projects.find((item) => item.id === value);
    const pool = (nextProject ? nextProject.members.filter((member) => member.active !== false) : people)
      .filter((person) => listedPerson(person, user, people, wide));
    const mayAssign = user.isAdmin || user.isManager || (user.isLead && (!value || nextProject?.canAssign));
    if (!mayAssign) {
      setAssigneeIds([user.id]);
      return;
    }
    setAssigneeIds((current) => {
      const allowed = new Set(pool.map((person) => person.id));
      const next = current.filter((id) => allowed.has(id));
      if (next.length) return next;
      return [pool[0]?.id || user.id];
    });
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
        const chosen = canAssign ? assigneeIds : [user.id];
        if (!chosen.length) {
          setError('Choose who should get this');
          return;
        }
        if (project) {
          for (const personId of chosen) {
            if (fromTeams.some((person) => person.id === personId)) {
              await api(`/projects/${project.id}/members`, { method: 'POST', body: { userId: personId } });
            }
          }
        }
        if (chosen.length === 1) body.assigneeId = chosen[0];
        else body.assigneeIds = chosen;
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
      <Field label={teamIds.length ? 'What the team will do' : (canAssign && (several || (assigneeIds[0] && assigneeIds[0] !== user.id)) ? 'What they’ll do' : 'What I’ll do')}>
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
        <Field label="Assign to" hint={teamIds.length ? 'Turned off while a whole team is selected.' : (adding ? 'People who are not on the project yet will be added, then this task goes to their To do.' : 'Tick everyone who should get this, then press Done.')}>
          <PeoplePick
            disabled={teamIds.length > 0}
            selected={assigneeIds}
            onChange={setAssigneeIds}
            groups={project ? [
              { label: 'On this project', people: onProject },
              ...(fromTeams.length ? [{ label: wide ? 'Anyone else' : 'Add from these teams', people: fromTeams }] : []),
            ] : [{ people: onProject }]}
          />
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
