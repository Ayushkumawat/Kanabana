import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useToast } from '../auth';
import { currentMonday, formatDay, shiftWeek, todayISO } from '../util';

const COLORS = ['#fff3b0', '#ffd7c2', '#d7f3df', '#f6d6ef', '#d7e6ff'];

export default function Notepad() {
  const toast = useToast();
  const [notes, setNotes] = useState([]);
  const [range, setRange] = useState('all');
  const [day, setDay] = useState('');
  const [drafts, setDrafts] = useState({});
  const [dragging, setDragging] = useState('');
  const [overId, setOverId] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api('/notepad')
      .then((data) => {
        setNotes(data.notes);
        setReady(true);
      })
      .catch((err) => toast(err.message, 'bad'));
  }, [toast]);

  const shown = useMemo(() => {
    if (day) return notes.filter((note) => note.day === day);
    const today = todayISO();
    if (range === 'week') {
      const start = currentMonday();
      const end = shiftWeek(start, 6);
      return notes.filter((note) => note.day >= start && note.day <= end);
    }
    if (range === 'month') return notes.filter((note) => note.day.startsWith(today.slice(0, 7)));
    return notes;
  }, [notes, range, day]);

  async function addDay(value) {
    try {
      const data = await api('/notepad', { method: 'POST', body: { day: value } });
      setNotes(data.notes);
      setDay('');
      setRange('all');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function textOf(note) {
    return drafts[note.id] === undefined ? note.body : drafts[note.id];
  }

  async function save(note, body) {
    if (body === note.body) return;
    try {
      const data = await api(`/notepad/${note.id}`, { method: 'PATCH', body: { body } });
      setNotes((list) => list.map((item) => (item.id === note.id ? { ...item, body: data.body, updatedAt: data.updatedAt } : item)));
      setDrafts((current) => {
        const next = { ...current };
        delete next[note.id];
        return next;
      });
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function remove(note) {
    if (!window.confirm(`Remove the note for ${formatDay(note.day)}?`)) return;
    try {
      const data = await api(`/notepad/${note.id}`, { method: 'DELETE' });
      setNotes(data.notes);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  async function dropOn(targetId) {
    const from = dragging;
    setDragging('');
    setOverId('');
    if (!from || from === targetId) return;
    const order = shown.map((note) => note.id);
    const fromIndex = order.indexOf(from);
    const toIndex = order.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    order.splice(fromIndex, 1);
    order.splice(toIndex, 0, from);
    const previous = notes;
    const byId = new Map(notes.map((note) => [note.id, note]));
    const queue = [...order];
    const nextIds = notes.map((note) => (order.includes(note.id) ? queue.shift() : note.id));
    setNotes(nextIds.map((id) => byId.get(id)));
    try {
      const data = await api('/notepad/order', { method: 'POST', body: { ids: order } });
      setNotes(data.notes);
    } catch (err) {
      setNotes(previous);
      toast(err.message, 'bad');
    }
  }

  async function sortByDate() {
    const ids = [...notes].sort((a, b) => b.day.localeCompare(a.day)).map((note) => note.id);
    try {
      const data = await api('/notepad/order', { method: 'POST', body: { ids } });
      setNotes(data.notes);
      setRange('all');
      setDay('');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <section className="stack notepad">
      <div className="row-between">
        <p className="hint">One sticky note for each day. Only you can see these. Drag a note by its date to rearrange it.</p>
        <button type="button" className="btn primary small" disabled={!ready} onClick={() => addDay(todayISO())}>Today’s note</button>
      </div>
      <div className="toolbar">
        <div className="segment">
          <button type="button" className={!day && range === 'all' ? 'on' : ''} onClick={() => { setRange('all'); setDay(''); }}>All</button>
          <button type="button" className={!day && range === 'week' ? 'on' : ''} onClick={() => { setRange('week'); setDay(''); }}>This week</button>
          <button type="button" className={!day && range === 'month' ? 'on' : ''} onClick={() => { setRange('month'); setDay(''); }}>This month</button>
        </div>
        <label className="field inline">
          <span>Day</span>
          <input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
        </label>
        <button type="button" className="btn ghost small" disabled={notes.length < 2} onClick={sortByDate}>Sort by date</button>
      </div>
      {shown.length === 0 ? (
        <div className="panel stack">
          <p className="muted">{day ? `No note for ${formatDay(day)}.` : 'No notes in this view.'}</p>
          {day ? <button type="button" className="btn small" onClick={() => addDay(day)}>Add {formatDay(day)}</button> : null}
        </div>
      ) : (
        <div className="sticky-board">
          {shown.map((note, index) => (
            <article
              key={note.id}
              className={`sticky${overId === note.id ? ' over' : ''}${dragging === note.id ? ' dragging' : ''}`}
              style={{ background: COLORS[index % COLORS.length] }}
              onDragOver={(event) => {
                event.preventDefault();
                setOverId(note.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOn(note.id);
              }}
            >
              <header
                draggable
                onDragStart={() => setDragging(note.id)}
                onDragEnd={() => { setDragging(''); setOverId(''); }}
              >
                <strong>{formatDay(note.day)}</strong>
                <button type="button" className="icon-btn" aria-label={`Remove ${formatDay(note.day)}`} onClick={() => remove(note)}>×</button>
              </header>
              <textarea
                value={textOf(note)}
                placeholder="Write the day here…"
                onChange={(event) => setDrafts({ ...drafts, [note.id]: event.target.value })}
                onBlur={(event) => save(note, event.target.value)}
              />
              <small className="muted">{note.day === todayISO() ? 'Today' : note.day}</small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
