import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../auth';
import Field from '../components/Field';
import { formatDay } from '../util';

const EMPTY = { name: '', description: '', organisation: '', amount: '', emd: '', lastDate: '', link: '' };

export default function Tenders() {
  const toast = useToast();
  const [tenders, setTenders] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/tenders').then((data) => setTenders(data.tenders));
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/tenders', { method: 'POST', body: form });
      setForm(EMPTY);
      toast('Tender added');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id, status) {
    try {
      await api(`/tenders/${id}/status`, { method: 'POST', body: { status } });
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Tenders</h1>
          <p className="lede">Tenders the office should apply for. Team leads and HR can add and update them.</p>
        </div>
      </div>
      <form className="panel stack" onSubmit={submit}>
        <div className="fields two">
          <Field label="Name"><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></Field>
          <Field label="Organisation"><input value={form.organisation} onChange={(event) => setForm({ ...form, organisation: event.target.value })} /></Field>
        </div>
        <Field label="Description"><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} required /></Field>
        <div className="fields two">
          <Field label="Amount"><input value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} required /></Field>
          <Field label="EMD"><input value={form.emd} onChange={(event) => setForm({ ...form, emd: event.target.value })} required /></Field>
        </div>
        <div className="fields two">
          <Field label="Last date"><input type="date" value={form.lastDate} onChange={(event) => setForm({ ...form, lastDate: event.target.value })} required /></Field>
          <Field label="Link"><input value={form.link} onChange={(event) => setForm({ ...form, link: event.target.value })} placeholder="https://" /></Field>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="form-actions"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Add tender'}</button></div>
      </form>
      {tenders.length === 0 ? <p className="muted">No tenders yet.</p> : tenders.map((item) => (
        <article key={item.id} className="panel stack">
          <div className="row-between">
            <h3>{item.name}</h3>
            <span className={`pill ${item.status}`}>{item.status}</span>
          </div>
          <p>{item.description}</p>
          <p className="muted">
            {item.organisation ? `${item.organisation} · ` : ''}Amount {item.amount} · EMD {item.emd} · Last date {formatDay(item.lastDate)} · {item.createdByName}
          </p>
          {item.link ? <a href={item.link} target="_blank" rel="noreferrer">{item.link}</a> : null}
          <div className="row-actions">
            {['open', 'applied', 'skipped'].map((status) => (
              <button key={status} type="button" className={`btn small ${item.status === status ? 'primary' : 'ghost'}`} onClick={() => setStatus(item.id, status)}>{status}</button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
