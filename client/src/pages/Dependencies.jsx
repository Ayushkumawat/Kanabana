import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import { formatWhen, statusLabel } from '../util';

export default function Dependencies() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState({ waitingOnMe: [], raised: [], tasks: [], people: [] });
  const [form, setForm] = useState({ taskId: '', dependsOnId: '', note: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/dependencies').then(setData);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/dependencies', { method: 'POST', body: form });
      setForm({ taskId: '', dependsOnId: '', note: '' });
      toast('Request sent');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function clear(id) {
    try {
      await api(`/dependencies/${id}/done`, { method: 'POST' });
      toast('Cleared');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function row(item, mine) {
    return (
      <article key={item.id} className="panel stack">
        <div className="row-between">
          <h3>{item.taskTitle}</h3>
          <span className="pill">{statusLabel(item.taskStatus)}</span>
        </div>
        <p>{item.note}</p>
        <p className="muted">
          {mine ? `Asked by ${item.requesterName}` : `Waiting on ${item.dependsOnName}`} · {formatWhen(item.createdAt)}
        </p>
        {mine ? <button type="button" className="btn small" onClick={() => clear(item.id)}>I’ve done my part</button> : null}
      </article>
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Dependencies</h1>
          <p className="lede">Ask someone for help or approval on any task, including across teams. The task stays open until they clear it.</p>
        </div>
      </div>
      <form className="panel stack" onSubmit={submit}>
        <div className="fields two">
          <Field label="Task">
            <select value={form.taskId} onChange={(event) => setForm({ ...form, taskId: event.target.value })} required>
              <option value="">Choose</option>
              {data.tasks.map((task) => <option key={task.id} value={task.id}>{task.title} · {task.assigneeName}</option>)}
            </select>
          </Field>
          <Field label="Depends on">
            <select value={form.dependsOnId} onChange={(event) => setForm({ ...form, dependsOnId: event.target.value })} required>
              <option value="">Choose</option>
              {data.people.filter((person) => person.id !== user.id).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="What you need"><textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} required /></Field>
        {error ? <p className="error">{error}</p> : null}
        <div className="form-actions"><button className="btn primary" disabled={busy}>Raise request</button></div>
      </form>
      <h2>Waiting on me</h2>
      {data.waitingOnMe.length === 0 ? <p className="muted">Nothing is waiting on you.</p> : data.waitingOnMe.map((item) => row(item, true))}
      <h2>I asked for</h2>
      {data.raised.length === 0 ? <p className="muted">You have no open requests.</p> : data.raised.map((item) => row(item, false))}
    </div>
  );
}
