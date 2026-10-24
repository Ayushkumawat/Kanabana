import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import { formatDay, formatWhen } from '../util';

export default function Meetings() {
  const { user } = useAuth();
  const toast = useToast();
  const [meetings, setMeetings] = useState([]);
  const [people, setPeople] = useState([]);
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [day, setDay] = useState('');
  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('11:00');
  const [userIds, setUserIds] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/meetings').then((data) => setMeetings(data.meetings));
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
    api('/users').then((data) => setPeople(data.users.filter((person) => person.active && person.id !== user.id))).catch(() => {});
  }, [user.id]);

  function toggle(id) {
    setUserIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function submit(event) {
    event.preventDefault();
    if (!userIds.length) {
      setError('Choose at least one person');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await api('/meetings', {
        method: 'POST',
        body: { title, agenda, day, startTime, endTime, userIds },
      });
      setTitle('');
      setAgenda('');
      setDay('');
      setUserIds([]);
      toast(data.warning || 'Invitations sent');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Meetings</h1>
          <p className="lede">Pick the people, the day, and the time, and write the agenda. Each person gets a calendar invitation by email, with the Google Meet link in the message. Accepting it adds the meeting to their calendar.</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <form className="panel stack" onSubmit={submit}>
        <Field label="Title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={140} required />
        </Field>
        <Field label="Agenda">
          <textarea value={agenda} onChange={(event) => setAgenda(event.target.value)} maxLength={4000} required rows={4} />
        </Field>
        <div className="fields three">
          <Field label="Date">
            <input type="date" value={day} onChange={(event) => setDay(event.target.value)} required />
          </Field>
          <Field label="Start">
            <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required />
          </Field>
          <Field label="End">
            <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} required />
          </Field>
        </div>
        <Field label="People" hint="You are included. Times are India Standard Time.">
          <div className="pick-list">
            {people.map((person) => (
              <label key={person.id}>
                <input type="checkbox" checked={userIds.includes(person.id)} onChange={() => toggle(person.id)} />
                {person.name}
              </label>
            ))}
          </div>
        </Field>
        <div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Schedule meeting'}</button>
        </div>
      </form>
      <div className="panel report-list">
        {meetings.length === 0 ? <p className="muted">No meetings yet.</p> : meetings.map((meeting) => (
          <article key={meeting.id} className="report-card">
            <header>
              <div>
                <strong>{meeting.title}</strong>
                <small>{formatDay(meeting.day)} · {meeting.startTime}–{meeting.endTime} IST · {meeting.organizerName} · {formatWhen(meeting.createdAt)}</small>
              </div>
            </header>
            <p>{meeting.agenda}</p>
            {meeting.meetUrl ? <p><a href={meeting.meetUrl} target="_blank" rel="noreferrer">Join Google Meet</a></p> : null}
            <small>{meeting.people.join(', ')}</small>
          </article>
        ))}
      </div>
    </div>
  );
}
