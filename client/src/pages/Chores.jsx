import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../auth';
import { formatWhen } from '../util';
import Field from '../components/Field';

const CATEGORIES = [
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'purchasing', label: 'Purchasing' },
];

export default function Chores() {
  const toast = useToast();
  const [chores, setChores] = useState([]);
  const [canClose, setCanClose] = useState(false);
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
        setCanClose(data.canClose);
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

  async function closeChore(id) {
    try {
      await api(`/chores/${id}/done`, { method: 'POST' });
      toast('Marked done');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  const shown = chores.filter((item) => filter === 'all' || item.category === filter || (filter === 'open' && item.status === 'open'));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Office chores</h1>
          <p className="lede">Raise a maintenance or purchasing request. HR is notified. Everyone can see what has been raised.</p>
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
              <span className={`pill ${item.status === 'done' ? 'done' : 'upcoming'}`}>
                {item.status === 'done' ? 'Done' : 'Open'}
              </span>
            </div>
            <p className="muted">{CATEGORIES.find((entry) => entry.id === item.category)?.label} · {item.requesterName} · {formatWhen(item.createdAt)}</p>
            {item.details ? <p>{item.details}</p> : null}
            {canClose && item.status !== 'done' ? (
              <button type="button" className="btn small" onClick={() => closeChore(item.id)}>Mark done</button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
