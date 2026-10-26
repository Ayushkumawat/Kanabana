import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import { readFile } from '../files';
import { allowedMoves, canGovernTask, COLUMNS, formatDay, formatWhen, priorityLabel, statusLabel, todayISO } from '../util';
import Field from './Field';
import FilePick from './FilePick';

export default function TaskDrawer({ taskId, people, projects, onClose, onChanged, onOpen }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [admin, setAdmin] = useState(null);
  const [followup, setFollowup] = useState({ assigneeId: '', title: '', description: '', dueDate: '' });
  const [reassignId, setReassignId] = useState('');
  const [removalNote, setRemovalNote] = useState('');
  const [editNote, setEditNote] = useState('');
  const [knowledge, setKnowledge] = useState({ title: '', link: '', note: '', file: null });
  const [depend, setDepend] = useState({ dependsOnId: '', note: '' });

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setData(null);
    setFollowup({ assigneeId: '', title: '', description: '', dueDate: todayISO() });
  }, [taskId]);

  useEffect(() => {
    let cancel = false;
    setError('');
    api(`/tasks/${taskId}`)
      .then((payload) => {
        if (cancel) return;
        setData(payload);
        setAdmin({
          title: payload.task.title,
          description: payload.task.description || '',
          assigneeId: payload.task.assigneeId,
          dueDate: payload.task.dueDate,
          priority: payload.task.priority,
          status: payload.task.status,
        });
        setReassignId(payload.task.assigneeId);
        setFollowup((current) => ({
          ...current,
          assigneeId: current.assigneeId || payload.task.assigneeId,
          dueDate: current.dueDate || todayISO(),
        }));
      })
      .catch((err) => {
        if (!cancel) setError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [taskId, version]);

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      setVersion((value) => value + 1);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) {
    return (
      <div className="drawer-back" onMouseDown={onClose}>
        <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><p className="muted">Loading…</p></aside>
      </div>
    );
  }

  const task = data?.task;
  const project = task ? projects.find((item) => item.id === task.projectId) : null;
  const governs = task && canGovernTask(user, task);
  const moves = task ? allowedMoves(user, task) : [];
  const statusChoices = task ? COLUMNS.filter((column) => column.id === task.status || moves.includes(column.id)) : [];
  const peoplePool = project ? project.members.filter((member) => member.active !== false) : people;
  const removal = data?.requests?.find((item) => item.kind === 'remove');
  const editRequest = data?.requests?.find((item) => item.kind === 'edit');

  return (
    <div className="drawer-back" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
        {error && !task ? <p className="error">{error}</p> : null}
        {task ? (
          <div className="stack">
            <div className="row-between">
              <p className="kicker">{task.projectName || 'Personal'}</p>
              <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
            </div>
            <h2>{task.title}</h2>
            <p className="muted">{task.description || 'No description yet.'}</p>
            <div className="card-meta">
              <span className={`pill ${task.status}`}>{statusLabel(task.status)}</span>
              <span className="pill">{priorityLabel(task.priority)}</span>
              <span>Due {formatDay(task.dueDate)}</span>
              {task.cadence ? <span className="pill">Repeats</span> : null}
            </div>
            <p className="muted">Assigned to {task.assigneeName} · written by {task.creatorName}</p>
            {task.status === 'review' && !governs ? (
              <div className="banner wait">This is with your team lead for review. They mark it done.</div>
            ) : null}
            {task.status === 'review' && governs ? (
              <div className="banner ready">This is waiting on review. Mark it done when the work is ready.</div>
            ) : null}
            {editRequest ? (
              <div className="banner wait">{editRequest.requesterName} asked for edits. {editRequest.note}</div>
            ) : null}
            {removal ? (
              <div className="banner wait">{removal.requesterName} asked to delete this. {removal.note}</div>
            ) : null}
            {moves.length ? (
              <Field label="Move to" hint={governs ? 'You can mark this done.' : 'Move between To do and In progress, then send it to Review. Your team lead marks it done.'}>
                <select
                  value={task.status}
                  disabled={busy}
                  onChange={(event) => run(async () => {
                    await api(`/tasks/${task.id}/status`, { method: 'PATCH', body: { status: event.target.value } });
                    if (event.target.value === 'review' && !governs) toast('Sent to your team lead for review');
                  })}
                >
                  {statusChoices.map((column) => <option key={column.id} value={column.id}>{column.label}</option>)}
                </select>
              </Field>
            ) : (
              <p className="hint">{user.id === task.assigneeId ? 'This stays here until your team lead moves it.' : 'You can comment. The assignment itself is locked.'}</p>
            )}
            <details className="fold">
              <summary>Assign, ask for help, or add a file</summary>
            {governs ? (
              <section className="stack">
                <h3>Reassign</h3>
                <form
                  className="stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const person = peoplePool.find((item) => item.id === reassignId);
                    run(async () => {
                      await api(`/tasks/${task.id}`, {
                        method: 'PATCH',
                        body: {
                          title: task.title,
                          description: task.description || '',
                          assigneeId: reassignId,
                          dueDate: task.dueDate,
                          priority: task.priority,
                          status: task.status,
                        },
                      });
                      toast(person ? `Reassigned to ${person.name}` : 'Reassigned');
                    });
                  }}
                >
                  <Field label="Move this task to" hint="It stays in the same column on their board.">
                    <select value={reassignId} onChange={(event) => setReassignId(event.target.value)}>
                      {peoplePool.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                    </select>
                  </Field>
                  <button className="btn small" disabled={busy || reassignId === task.assigneeId}>Reassign</button>
                </form>
              </section>
            ) : null}
            {governs && task.status === 'review' ? (
              <section className="stack">
                <h3>Follow-up</h3>
                <p className="hint">Assign the next piece from this review. It lands in that person’s To do.</p>
                {(data.followups || []).length ? data.followups.map((item) => (
                  <button type="button" key={item.id} className="week-item" onClick={() => onOpen(item.id)}>
                    <span className="dot" />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.assigneeName} · {statusLabel(item.status)} · {formatDay(item.dueDate)}</small>
                    </span>
                  </button>
                )) : null}
                <form
                  className="stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(async () => {
                      await api(`/tasks/${task.id}/followup`, {
                        method: 'POST',
                        body: { ...followup, assigneeId: followup.assigneeId || task.assigneeId },
                      });
                      const person = peoplePool.find((item) => item.id === (followup.assigneeId || task.assigneeId));
                      setFollowup({ assigneeId: task.assigneeId, title: '', description: '', dueDate: todayISO() });
                      toast(person ? `Added to ${person.name}’s To do` : 'Follow-up added to To do');
                    });
                  }}
                >
                  <Field label="Follow-up title">
                    <input value={followup.title} onChange={(event) => setFollowup({ ...followup, title: event.target.value })} required />
                  </Field>
                  <Field label="Assign to">
                    <select value={followup.assigneeId || task.assigneeId} onChange={(event) => setFollowup({ ...followup, assigneeId: event.target.value })} required>
                      {peoplePool.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Their deadline">
                    <input type="date" value={followup.dueDate} onChange={(event) => setFollowup({ ...followup, dueDate: event.target.value })} required />
                  </Field>
                  <Field label="Notes">
                    <textarea value={followup.description} onChange={(event) => setFollowup({ ...followup, description: event.target.value })} />
                  </Field>
                  <button className="btn small" disabled={busy}>Add to To do</button>
                </form>
              </section>
            ) : null}
            {task.projectId ? (
              <section className="stack">
                <h3>Add to knowledge base</h3>
                <form
                  className="stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(async () => {
                      const file = knowledge.file ? await readFile(knowledge.file) : null;
                      await api('/knowledge', {
                        method: 'POST',
                        body: { kind: 'project', projectId: task.projectId, taskId: task.id, title: knowledge.title, link: knowledge.link, note: knowledge.note, file },
                      });
                      setKnowledge({ title: '', link: '', note: '', file: null });
                      toast('Added to the knowledge base');
                    });
                  }}
                >
                  <Field label="Title"><input value={knowledge.title} onChange={(event) => setKnowledge({ ...knowledge, title: event.target.value })} required /></Field>
                  <Field label="Link"><input value={knowledge.link} onChange={(event) => setKnowledge({ ...knowledge, link: event.target.value })} placeholder="https://" /></Field>
                  <FilePick onFile={(file) => setKnowledge({ ...knowledge, file })} />
                  <Field label="Note"><textarea value={knowledge.note} onChange={(event) => setKnowledge({ ...knowledge, note: event.target.value })} /></Field>
                  <button className="btn small" disabled={busy}>Add to {project?.name || 'the project'}</button>
                </form>
              </section>
            ) : null}
            {task.status !== 'done' ? (
              <section className="stack">
                <h3>Ask someone</h3>
                {task.waitingOn ? <p className="hint">Waiting on {task.waitingOn}. This stays open until they clear it.</p> : null}
                <form
                  className="stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(async () => {
                      await api('/dependencies', { method: 'POST', body: { taskId: task.id, dependsOnId: depend.dependsOnId, note: depend.note } });
                      setDepend({ dependsOnId: '', note: '' });
                      toast('Request sent');
                    });
                  }}
                >
                  <Field label="Depends on">
                    <select value={depend.dependsOnId} onChange={(event) => setDepend({ ...depend, dependsOnId: event.target.value })} required>
                      <option value="">Choose</option>
                      {people.filter((person) => person.id !== user.id && person.active !== false).map((person) => (
                        <option key={person.id} value={person.id}>{person.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="What you need"><textarea value={depend.note} onChange={(event) => setDepend({ ...depend, note: event.target.value })} required /></Field>
                  <button className="btn small" disabled={busy}>Raise request</button>
                </form>
              </section>
            ) : null}
            </details>
            <section className="stack">
              <h3>Comments</h3>
              {data.comments.length === 0 ? <p className="muted">No comments yet.</p> : data.comments.map((item) => (
                <article key={item.id}>
                  <p>{item.body}</p>
                  <small className="muted">{item.authorName} · {formatWhen(item.createdAt)}</small>
                </article>
              ))}
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  run(async () => {
                    await api(`/tasks/${task.id}/comments`, { method: 'POST', body: { body: comment } });
                    setComment('');
                  });
                }}
              >
                <Field label="Comment">
                  <textarea value={comment} onChange={(event) => setComment(event.target.value)} required />
                </Field>
                <button className="btn small" disabled={busy}>Comment</button>
              </form>
            </section>
            <details className="fold">
              <summary>Edit or remove</summary>
            {user.id === task.assigneeId && !governs ? (
              <div className="stack">
                {editRequest ? <p className="hint">Waiting on your team lead to answer the edit request.</p> : (
                  <form
                    className="stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(async () => {
                        await api(`/tasks/${task.id}/change`, { method: 'POST', body: { kind: 'edit', note: editNote } });
                        setEditNote('');
                        toast('Edit request sent to your team lead');
                      });
                    }}
                  >
                    <Field label="Ask for edits" hint="Say what should change. Your team lead sees this as an edit request.">
                      <textarea value={editNote} onChange={(event) => setEditNote(event.target.value)} required minLength={8} />
                    </Field>
                    <button className="btn ghost small" disabled={busy}>Send edit request</button>
                  </form>
                )}
                {removal ? <p className="hint">Waiting on your team lead to answer the delete request.</p> : (
                  <form
                    className="stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(async () => {
                        await api(`/tasks/${task.id}/change`, { method: 'POST', body: { kind: 'remove', note: removalNote } });
                        setRemovalNote('');
                        toast('Delete request sent to your team lead');
                      });
                    }}
                  >
                    <Field label="Ask to delete" hint="Your team lead sees this as a delete request. You can’t delete it yourself.">
                      <textarea value={removalNote} onChange={(event) => setRemovalNote(event.target.value)} required minLength={8} />
                    </Field>
                    <button className="btn ghost small" disabled={busy}>Send delete request</button>
                  </form>
                )}
              </div>
            ) : null}
            {governs && admin ? (
              <section className="stack">
                <button type="button" className="btn ghost small" onClick={() => setEditing((open) => !open)}>
                  {editing ? 'Close edit' : 'Edit task'}
                </button>
                {editing ? (
                  <form
                    className="stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(() => api(`/tasks/${task.id}`, { method: 'PATCH', body: admin }));
                    }}
                  >
                    <Field label="Title"><input value={admin.title} onChange={(event) => setAdmin({ ...admin, title: event.target.value })} required /></Field>
                    <Field label="Description"><textarea value={admin.description} onChange={(event) => setAdmin({ ...admin, description: event.target.value })} /></Field>
                    <Field label="Assignee">
                      <select value={admin.assigneeId} onChange={(event) => setAdmin({ ...admin, assigneeId: event.target.value })}>
                        {peoplePool.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                      </select>
                    </Field>
                    <div className="fields two">
                      <Field label="Due"><input type="date" value={admin.dueDate} onChange={(event) => setAdmin({ ...admin, dueDate: event.target.value })} required /></Field>
                      <Field label="Priority">
                        <select value={admin.priority} onChange={(event) => setAdmin({ ...admin, priority: event.target.value })}>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="urgent">Urgent</option>
                        </select>
                      </Field>
                    </div>
                    <button className="btn small" disabled={busy}>Save changes</button>
                  </form>
                ) : null}
                <button
                  type="button"
                  className="btn danger small"
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm('Delete this task? The next person’s card stays on their board.')) return;
                    setBusy(true);
                    try {
                      await api(`/tasks/${task.id}`, { method: 'DELETE' });
                      onChanged();
                      onClose();
                      toast('Task deleted');
                    } catch (err) {
                      setError(err.message);
                      setBusy(false);
                    }
                  }}
                >
                  Delete task
                </button>
              </section>
            ) : null}
            </details>
            {error ? <p className="error">{error}</p> : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
