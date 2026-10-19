import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { formatWhen } from '../util';

export default function Activity() {
  const navigate = useNavigate();
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/activity').then((data) => setEvents(data.events)).catch((err) => setError(err.message));
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="lede">Assignments, comments, and timeline changes.</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <div className="panel feed">
        {events.length === 0 ? <p className="muted">Nothing recorded yet.</p> : events.map((event) => (
          <button
            type="button"
            key={event.id}
            className="feed-item"
            onClick={() => {
              if (event.taskId) navigate({ pathname: '/', search: `?task=${event.taskId}` });
              else if (event.projectId) navigate(`/projects/${event.projectId}`);
            }}
          >
            <strong>{event.message}</strong>
            <small>{event.actorName} · {formatWhen(event.createdAt)}</small>
          </button>
        ))}
      </div>
      <p className="watermark">made with ❤️ by Ayush at AIunika</p>
    </div>
  );
}
