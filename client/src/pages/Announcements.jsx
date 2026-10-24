import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../auth';
import Field from '../components/Field';
import { formatWhen } from '../util';

export default function Announcements() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [people, setPeople] = useState([]);
  const [audience, setAudience] = useState('everyone');
  const [departmentIds, setDepartmentIds] = useState([]);
  const [userIds, setUserIds] = useState([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/announcements').then((data) => setItems(data.announcements));
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
    api('/departments').then((data) => setDepartments(data.departments)).catch(() => {});
    api('/users').then((data) => setPeople(data.users.filter((person) => person.active))).catch(() => {});
  }, []);

  function toggle(list, setList, id) {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/announcements', {
        method: 'POST',
        body: { title, body, audience, departmentIds, userIds },
      });
      setTitle('');
      setBody('');
      setDepartmentIds([]);
      setUserIds([]);
      setAudience('everyone');
      toast('Announcement posted');
      await load();
      window.dispatchEvent(new Event('kanabana-notes'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(id) {
    setError('');
    try {
      await api(`/announcements/${id}/ack`, { method: 'POST' });
      toast('Acknowledged');
      await load();
      window.dispatchEvent(new Event('kanabana-notes'));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Announcements</h1>
          <p className="lede">Anyone can post one. It starts for everyone, and you can aim it at a team or at particular people. Each person it applies to keeps a red dot until they acknowledge it.</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <form className="panel stack" onSubmit={submit}>
        <div className="segment">
          <button type="button" className={audience === 'everyone' ? 'on' : ''} onClick={() => setAudience('everyone')}>Everyone</button>
          <button type="button" className={audience === 'teams' ? 'on' : ''} onClick={() => setAudience('teams')}>Teams</button>
          <button type="button" className={audience === 'people' ? 'on' : ''} onClick={() => setAudience('people')}>People</button>
        </div>
        <Field label="Title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={140} required />
        </Field>
        <Field label="Announcement">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} required rows={4} />
        </Field>
        {audience === 'teams' ? (
          <Field label="Teams" hint="Everyone on the selected teams has to acknowledge it.">
            <div className="pick-list">
              {departments.map((department) => (
                <label key={department.id}>
                  <input
                    type="checkbox"
                    checked={departmentIds.includes(department.id)}
                    onChange={() => toggle(departmentIds, setDepartmentIds, department.id)}
                  />
                  {department.name}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        {audience === 'people' ? (
          <Field label="People" hint="Only these people have to acknowledge it. Everyone else can still read it.">
            <div className="pick-list">
              {people.map((person) => (
                <label key={person.id}>
                  <input
                    type="checkbox"
                    checked={userIds.includes(person.id)}
                    onChange={() => toggle(userIds, setUserIds, person.id)}
                  />
                  {person.name}
                </label>
              ))}
            </div>
          </Field>
        ) : null}
        <div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post announcement'}</button>
        </div>
      </form>
      <div className="panel report-list">
        {items.length === 0 ? <p className="muted">No announcements yet.</p> : items.map((item) => (
          <article key={item.id} className="report-card">
            <header>
              <div>
                <strong>{item.title}</strong>
                <small>{item.audienceLabel} · {item.authorName} · {formatWhen(item.createdAt)}</small>
              </div>
              {item.needsAck && !item.acked ? (
                <button type="button" className="btn small" onClick={() => acknowledge(item.id)}>Acknowledge</button>
              ) : item.acked ? <span className="pill">Acknowledged</span> : null}
            </header>
            <p>{item.body}</p>
            <small>{item.acknowledged} of {item.audienceSize} acknowledged{item.waiting.length ? ` · waiting on ${item.waiting.slice(0, 8).join(', ')}${item.waiting.length > 8 ? '…' : ''}` : ''}</small>
          </article>
        ))}
      </div>
    </div>
  );
}
