import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../auth';
import { formatWhen, statusLabel } from '../util';

export default function Requests() {
  const toast = useToast();
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [choice, setChoice] = useState({});
  const [error, setError] = useState('');

  function load() {
    return Promise.all([api('/requests'), api('/departures')])
      .then(([requestData, departureData]) => {
        setRequests(requestData.requests);
        setDepartures(departureData.departures);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    load();
  }, []);

  async function act(request, action) {
    try {
      if (action === 'done') await api(`/tasks/${request.taskId}/status`, { method: 'PATCH', body: { status: 'done' } });
      if (action === 'delete') await api(`/tasks/${request.taskId}`, { method: 'DELETE' });
      if (action === 'decline') await api(`/requests/${request.id}/decline`, { method: 'POST', body: {} });
      toast(action === 'decline' ? 'Request declined' : action === 'delete' ? 'Task removed' : 'Marked done');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p className="lede">Review asks, removal notes, and people leaving the team land here for the team lead.</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      {departures.map((departure) => (
        <article key={departure.id} className="panel stack">
          <div className="row-between">
            <h2>Move {departure.userName}’s tasks</h2>
          </div>
          <p>
            {departure.userName} is leaving {departure.departments.join(', ') || 'the team'}.
            Choose someone on your team for each task. The account is removed once every team lead has done this.
          </p>
          {departure.tasks.map((task) => (
            <label key={task.id} className="field">
              <span>{task.title}{task.projectName ? ` · ${task.projectName}` : ''} · {statusLabel(task.status)}</span>
              <select
                value={choice[`task:${task.id}`] || ''}
                onChange={(event) => setChoice({ ...choice, [`task:${task.id}`]: event.target.value })}
              >
                <option value="">Choose someone on your team</option>
                {task.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </label>
          ))}
          {departure.rules.map((rule) => (
            <label key={rule.id} className="field">
              <span>{rule.title} · Repeating{rule.projectName ? ` · ${rule.projectName}` : ''}</span>
              <select
                value={choice[`rule:${rule.id}`] || ''}
                onChange={(event) => setChoice({ ...choice, [`rule:${rule.id}`]: event.target.value })}
              >
                <option value="">Choose someone on your team</option>
                {rule.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            </label>
          ))}
          <div className="actions">
            <button
              type="button"
              className="btn primary small"
              onClick={async () => {
                const tasks = departure.tasks.map((task) => ({ id: task.id, assigneeId: choice[`task:${task.id}`] }));
                const rules = departure.rules.map((rule) => ({ id: rule.id, assigneeId: choice[`rule:${rule.id}`] }));
                if ([...tasks, ...rules].some((item) => !item.assigneeId)) {
                  toast('Choose someone on your team for each task', 'bad');
                  return;
                }
                try {
                  const result = await api(`/departures/${departure.id}/move`, { method: 'POST', body: { tasks, rules } });
                  toast(result.message);
                  await load();
                } catch (err) {
                  toast(err.message, 'bad');
                }
              }}
            >
              Move these tasks
            </button>
          </div>
        </article>
      ))}
      {requests.length === 0 && departures.length === 0 ? <p className="muted">Nothing is waiting.</p> : null}
      <div className="stack">
        {requests.map((request) => (
          <article key={request.id} className="panel stack">
            <div className="row-between">
              <h2>{request.kind === 'remove' ? 'Remove task' : 'Review work'}</h2>
              <span className="muted">{formatWhen(request.createdAt)}</span>
            </div>
            <p>
              <strong>{request.requesterName}</strong>
              {request.kind === 'remove' ? ' asked to remove ' : ' asked you to review '}
              <button type="button" className="text-link" onClick={() => navigate({ pathname: '/', search: `?task=${request.taskId}` })}>
                {request.taskTitle}
              </button>
              {' '}· {request.assigneeName} · {statusLabel(request.taskStatus)}
            </p>
            {request.note ? <p className="banner wait">{request.note}</p> : null}
            {request.canAnswer ? (
              <div className="actions">
                {request.kind === 'review' ? <button type="button" className="btn primary small" onClick={() => act(request, 'done')}>Mark done</button> : null}
                {request.kind === 'remove' ? <button type="button" className="btn danger small" onClick={() => act(request, 'delete')}>Remove task</button> : null}
                <button type="button" className="btn ghost small" onClick={() => act(request, 'decline')}>Decline</button>
              </div>
            ) : (
              <p className="hint">Waiting on your team lead.</p>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
