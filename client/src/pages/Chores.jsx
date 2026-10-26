import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../auth';
import { formatWhen } from '../util';
import Field from '../components/Field';

const CATEGORIES = [
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'purchasing', label: 'Purchasing' },
];

const STEPS = [
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

export default function Chores() {
  const toast = useToast();
  const [chores, setChores] = useState([]);
  const [canMove, setCanMove] = useState(false);
  const [moving, setMoving] = useState('');
  const [category, setCategory] = useState('maintenance');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');

  function load() {
    return api('/chores')
      .then((data) => {
        setChores(data.chores);
        setCanMove(Boolean(data.canMove));
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/chores', { method: 'POST', body: { category, title, details } });
      setTitle('');
      setDetails('');
      toast('Sent to HR');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function moveChore(item, status) {
    if (item.status === status || moving) return;
    setMoving(item.id);
    try {
      await api(`/chores/${item.id}/status`, { method: 'POST', body: { status } });
      toast(status === 'done' ? 'Marked done' : status === 'in_progress' ? 'Moved to in progress' : 'Moved to open');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setMoving('');
    }
  }

  const shown = chores.filter((item) => filter === 'all' || item.category === filter || (filter === 'open' && item.status !== 'done'));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Office chores</h1>
          <p className="lede">Raise a maintenance or purchasing request. Everyone can see it. Human Resource and Admin can move it from open to in progress or done.</p>
        </div>
      </div>
      <form className="panel stack" onSubmit={submit}>
        <div className="fields two">
          <Field label="Category">
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              {CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </Field>
          <Field label="What is needed">
            <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={140} />
          </Field>
        </div>
        <Field label="Details">
          <textarea value={details} onChange={(event) => setDetails(event.target.value)} />
        </Field>
        {error ? <p className="error">{error}</p> : null}
        <div className="form-actions">
          <button className="btn primary" disabled={busy}>{busy ? 'Sending…' : 'Raise request'}</button>
        </div>
      </form>
      <div className="segment">
        <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
        <button type="button" className={filter === 'maintenance' ? 'on' : ''} onClick={() => setFilter('maintenance')}>Maintenance</button>
        <button type="button" className={filter === 'purchasing' ? 'on' : ''} onClick={() => setFilter('purchasing')}>Purchasing</button>
        <button type="button" className={filter === 'open' ? 'on' : ''} onClick={() => setFilter('open')}>Open</button>
      </div>
      <div className="stack">
        {shown.length === 0 ? <p className="muted">No requests yet.</p> : shown.map((item) => (
          <article key={item.id} className="panel stack">
            <div className="row-between">
              <h3>{item.title}</h3>
              {canMove ? (
                <div className="segment" role="group" aria-label={`Move ${item.title}`}>
                  {STEPS.map((step) => (
                    <button
                      type="button"
                      key={step.id}
                      className={item.status === step.id ? 'on' : ''}
                      disabled={moving === item.id}
                      onClick={() => moveChore(item, step.id)}
                    >
                      {step.label}
                    </button>
                  ))}
                </div>
              ) : (
                <span className={`pill ${item.status === 'done' ? 'done' : item.status === 'in_progress' ? 'in_progress' : 'upcoming'}`}>
                  {STEPS.find((step) => step.id === item.status)?.label || 'Open'}
                </span>
              )}
            </div>
            <p className="muted">{CATEGORIES.find((entry) => entry.id === item.category)?.label} · {item.requesterName} · {formatWhen(item.createdAt)}</p>
            {item.details ? <p>{item.details}</p> : null}
          </article>
        ))}
      </div>
    </div>
  );
}
