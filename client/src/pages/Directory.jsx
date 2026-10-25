import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Avatar from '../components/Avatar';
import Field from '../components/Field';
import Modal from '../components/Modal';
import { roleLabel } from '../util';

export default function Directory() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [error, setError] = useState('');
  const [personOpen, setPersonOpen] = useState(false);
  const [deptOpen, setDeptOpen] = useState(false);
  const [edit, setEdit] = useState(null);
  const [reset, setReset] = useState(null);
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState('');
  const [person, setPerson] = useState({ name: '', email: '', password: '', birthday: '', workAnniversary: '', departmentIds: [], leadDepartmentId: '', manager: false });
  const [department, setDepartment] = useState({ name: '', leadId: '' });

  function load() {
    return Promise.all([api('/users'), api('/departments')])
      .then(([userData, departmentData]) => {
        setUsers(userData.users);
        setDepartments(departmentData.departments);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function createPerson(event) {
    event.preventDefault();
    setFormError('');
    try {
      await api('/users', {
        method: 'POST',
        body: { ...person, leadDepartmentId: person.leadDepartmentId || null },
      });
      setPersonOpen(false);
      setPerson({ name: '', email: '', password: '', birthday: '', workAnniversary: '', departmentIds: [], leadDepartmentId: '', manager: false });
      toast('Person added. They can sign in with that email.');
      await load();
    } catch (err) {
      setFormError(err.message);
    }
  }

  async function createDepartment(event) {
    event.preventDefault();
    setFormError('');
    try {
      await api('/departments', { method: 'POST', body: department });
      setDeptOpen(false);
      setDepartment({ name: '', leadId: '' });
      toast('Department added');
      await load();
    } catch (err) {
      setFormError(err.message);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Directory</h1>
          <p className="lede">Everyone belongs to at least one department. Each department has a team lead.</p>
        </div>
        {user.isAdmin ? (
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => { setFormError(''); setDeptOpen(true); }}>New department</button>
            <button type="button" className="btn primary" onClick={() => { setFormError(''); setPersonOpen(true); }}>New person</button>
          </div>
        ) : null}
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <div className="dept-grid">
        {departments.map((item) => (
          <DepartmentCard key={item.id} department={item} users={users} canManage={user.isAdmin} onSaved={load} />
        ))}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Email</th>
              <th>Departments</th>
              <th>Role</th>
              <th>Status</th>
              {user.isAdmin ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {users.map((personRow) => (
              <tr key={personRow.id} className={personRow.active ? '' : 'dim'}>
                <td>
                  <span className="person"><Avatar name={personRow.name} size={24} /> {personRow.name}</span>
                </td>
                <td>{personRow.email}</td>
                <td>{personRow.departments.map((item) => item.name).join(', ')}</td>
                <td>{accountRole(personRow)}</td>
                <td>{personRow.active ? 'Active' : 'Deactivated'}</td>
                {user.isAdmin ? (
                  <td className="actions">
                    <button type="button" className="btn ghost small" onClick={() => { setEdit({ ...personRow, departmentIds: personRow.departmentIds.slice(), manager: Boolean(personRow.isManager) }); setFormError(''); }}>Edit</button>
                    <button type="button" className="btn ghost small" onClick={() => { setReset(personRow); setPassword(''); setFormError(''); }}>Reset password</button>
                    {personRow.departureLeads?.length ? (
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => toast(`Waiting on ${personRow.departureLeads.join(', ')} to move ${personRow.name}’s tasks.`)}
                      >
                        Waiting on lead
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn danger small"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${personRow.name}? Their team lead will move any open tasks to someone on that team. The account is removed once every lead has done that.`)) return;
                          try {
                            const result = await api(`/users/${personRow.id}`, { method: 'DELETE' });
                            toast(result.pending ? result.message : `${personRow.name} deleted`);
                            await load();
                          } catch (err) {
                            toast(err.message, 'bad');
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {personOpen ? (
        <Modal title="New person" onClose={() => setPersonOpen(false)}>
          <form className="stack" onSubmit={createPerson}>
            <Field label="Name"><input value={person.name} onChange={(event) => setPerson({ ...person, name: event.target.value })} required /></Field>
            <Field label="Email" hint="This is their login."><input type="email" value={person.email} onChange={(event) => setPerson({ ...person, email: event.target.value })} required /></Field>
            <Field label="Temporary password" hint="They can change it after signing in."><input type="text" value={person.password} onChange={(event) => setPerson({ ...person, password: event.target.value })} required minLength={8} /></Field>
            <Field label="Birthday"><input type="date" value={person.birthday} onChange={(event) => setPerson({ ...person, birthday: event.target.value })} required /></Field>
            <Field label="Work anniversary"><input type="date" value={person.workAnniversary} onChange={(event) => setPerson({ ...person, workAnniversary: event.target.value })} required /></Field>
            <label className="check">
              <input
                type="checkbox"
                checked={person.manager}
                onChange={(event) => {
                  const manager = event.target.checked;
                  setPerson({
                    ...person,
                    manager,
                    departmentIds: manager ? departments.map((item) => item.id) : person.departmentIds,
                  });
                }}
              />
              Manager
            </label>
            <p className="hint">Sees every project, every team board, and everyone’s board. Their own tasks stay off team boards and off People for team leads. Other managers can still open their board. They join every team.</p>
            <div className="field">
              <span>Departments</span>
              <div className="checks">
                {departments.map((item) => (
                  <label key={item.id} className="check">
                    <input
                      type="checkbox"
                      checked={person.manager || person.departmentIds.includes(item.id)}
                      disabled={person.manager}
                      onChange={() => {
                        const departmentIds = person.departmentIds.includes(item.id)
                          ? person.departmentIds.filter((id) => id !== item.id)
                          : [...person.departmentIds, item.id];
                        setPerson({
                          ...person,
                          departmentIds,
                          leadDepartmentId: departmentIds.includes(person.leadDepartmentId) ? person.leadDepartmentId : '',
                        });
                      }}
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            </div>
            <Field label="Also make team lead of" hint="This replaces the current lead of that department.">
              <select value={person.leadDepartmentId} onChange={(event) => setPerson({ ...person, leadDepartmentId: event.target.value })}>
                <option value="">Not a lead</option>
                {departments.filter((item) => person.manager || person.departmentIds.includes(item.id)).map((item) => (
                  <option key={item.id} value={item.id}>{item.name}{item.leadName ? ` (now ${item.leadName})` : ''}</option>
                ))}
              </select>
            </Field>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setPersonOpen(false)}>Cancel</button>
              <button className="btn primary">Create login</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {deptOpen ? (
        <Modal title="New department" onClose={() => setDeptOpen(false)}>
          <form className="stack" onSubmit={createDepartment}>
            <Field label="Name"><input value={department.name} onChange={(event) => setDepartment({ ...department, name: event.target.value })} required /></Field>
            <Field label="Team lead">
              <select value={department.leadId} onChange={(event) => setDepartment({ ...department, leadId: event.target.value })} required>
                <option value="">Choose</option>
                {users.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </Field>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setDeptOpen(false)}>Cancel</button>
              <button className="btn primary">Create department</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {edit ? (
        <Modal title={`Edit ${edit.name}`} onClose={() => setEdit(null)}>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              setFormError('');
              try {
                await api(`/users/${edit.id}`, {
                  method: 'PATCH',
                  body: { name: edit.name, email: edit.email, departmentIds: edit.manager ? departments.map((item) => item.id) : edit.departmentIds, active: edit.active, birthday: edit.birthday, workAnniversary: edit.workAnniversary, manager: Boolean(edit.manager) },
                });
                if (edit.id === user.id) await refresh();
                setEdit(null);
                await load();
              } catch (err) {
                setFormError(err.message);
              }
            }}
          >
            <Field label="Name"><input value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} required /></Field>
            <Field label="Email"><input type="email" value={edit.email} onChange={(event) => setEdit({ ...edit, email: event.target.value })} required /></Field>
            <Field label="Birthday"><input type="date" value={edit.birthday || ''} onChange={(event) => setEdit({ ...edit, birthday: event.target.value })} /></Field>
            <Field label="Work anniversary"><input type="date" value={edit.workAnniversary || ''} onChange={(event) => setEdit({ ...edit, workAnniversary: event.target.value })} /></Field>
            <label className="check">
              <input
                type="checkbox"
                checked={Boolean(edit.manager)}
                onChange={(event) => {
                  const manager = event.target.checked;
                  setEdit({
                    ...edit,
                    manager,
                    departmentIds: manager ? departments.map((item) => item.id) : edit.departmentIds,
                  });
                }}
              />
              Manager
            </label>
            <p className="hint">{edit.manager ? 'They stay on every team. Turn this off to choose teams. Their tasks stay hidden from team leads, and other managers can still see that board.' : 'Their tasks stay visible to their team lead. Check this to give them every team, every project, and every board.'}</p>
            <div className="field">
              <span>Departments</span>
              <div className="checks">
                {departments.map((item) => (
                  <label key={item.id} className="check">
                    <input
                      type="checkbox"
                      checked={edit.manager || edit.departmentIds.includes(item.id)}
                      disabled={Boolean(edit.manager)}
                      onChange={() => setEdit({
                        ...edit,
                        departmentIds: edit.departmentIds.includes(item.id)
                          ? edit.departmentIds.filter((id) => id !== item.id)
                          : [...edit.departmentIds, item.id],
                      })}
                    />
                    {item.name}
                  </label>
                ))}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={edit.active} onChange={(event) => setEdit({ ...edit, active: event.target.checked })} />
              Active
            </label>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {reset ? (
        <Modal title={`Reset password for ${reset.name}`} onClose={() => setReset(null)}>
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              setFormError('');
              try {
                await api(`/users/${reset.id}/password`, { method: 'POST', body: { password } });
                setReset(null);
                toast('Password reset. Tell them the new one.');
              } catch (err) {
                setFormError(err.message);
              }
            }}
          >
            <Field label="New password"><input type="text" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} /></Field>
            {formError ? <p className="error">{formError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setReset(null)}>Cancel</button>
              <button className="btn primary">Reset</button>
            </div>
          </form>
        </Modal>
      ) : null}
      {!user.isAdmin ? <p className="hint">Signed in as {roleLabel(user)}. An admin creates logins and departments.</p> : null}
    </div>
  );
}

function accountRole(person) {
  const parts = [];
  if (person.isAdmin) parts.push('Admin');
  if (person.isManager) parts.push('Manager');
  if (person.leadOf.length) parts.push(`Lead · ${person.leadOf.map((item) => item.name).join(', ')}`);
  return parts.length ? parts.join(' · ') : 'Member';
}

function DepartmentCard({ department, users, canManage, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(department.name);
  const [leadId, setLeadId] = useState(department.leadId || '');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    setName(department.name);
    setLeadId(department.leadId || '');
  }, [department]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (event) => {
      if (menuRef.current && menuRef.current.contains(event.target)) return;
      setMenuOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  if (!canManage) {
    return (
      <article className="panel stack">
        <h2>{department.name}</h2>
        <p>Lead: {department.leadName || 'Unassigned'}</p>
        <p className="muted">{department.members.map((member) => member.name).join(', ')}</p>
      </article>
    );
  }

  return (
    <form
      className="panel stack dept-card"
      onSubmit={async (event) => {
        event.preventDefault();
        setMenuOpen(false);
        try {
          await api(`/departments/${department.id}`, { method: 'PATCH', body: { name, leadId } });
          toast(`${name} updated`);
          onSaved();
        } catch (err) {
          toast(err.message, 'bad');
        }
      }}
    >
      <div className="row-between">
        <span className="kicker">Department</span>
        <div className="menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            aria-label="Department actions"
            aria-expanded={menuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen((open) => !open);
            }}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="pop-menu">
              <button type="submit" className="menu-item">Save department</button>
              <button
                type="button"
                className="menu-item danger"
                onClick={async () => {
                  setMenuOpen(false);
                  if (!window.confirm(`Delete the ${department.name} department?`)) return;
                  try {
                    await api(`/departments/${department.id}`, { method: 'DELETE' });
                    toast(`${department.name} deleted`);
                    onSaved();
                  } catch (err) {
                    toast(err.message, 'bad');
                  }
                }}
              >
                Delete department
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field>
      <Field label="Team lead">
        <select value={leadId} onChange={(event) => setLeadId(event.target.value)}>
          {users.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>
      <p className="muted">{department.members.map((member) => member.name).join(', ')}</p>
    </form>
  );
}
