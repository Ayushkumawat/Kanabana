import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useToast } from '../auth';
import Field from '../components/Field';
import { formatDay, formatWhen, statusLabel } from '../util';

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'all', label: 'All' },
  { id: 'closed', label: 'Closed' },
  { id: 'completion', label: 'Task completion' },
];

function requestTitle(request) {
  if (request.kind === 'remove') return 'Delete task';
  if (request.kind === 'edit') return 'Edit task';
  if (request.kind === 'timeline') return 'Set team timeline';
  return 'Task completion';
}

function outcome(request) {
  if (request.status === 'declined') return 'Declined';
  if (request.status === 'set') return 'Timeline set';
  if (request.status === 'accepted') return 'Accepted';
  return 'Closed';
}

function matches(request, filter) {
  if (filter === 'completion') return request.kind === 'review';
  if (filter === 'all') return true;
  if (filter === 'closed') return request.status !== 'open';
  return request.status === 'open';
}

export default function Requests() {
  const toast = useToast();
  const navigate = useNavigate();
  const [requests, setRequests] = useState([]);
  const [departures, setDepartures] = useState([]);
  const [filter, setFilter] = useState('open');
  const [choice, setChoice] = useState({});
  const [declineId, setDeclineId] = useState('');
  const [declineNote, setDeclineNote] = useState('');
  const [drafts, setDrafts] = useState({});
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

  async function act(request, action, note = '') {
    try {
      if (action === 'done') await api(`/tasks/${request.taskId}/status`, { method: 'PATCH', body: { status: 'done' } });
      if (action === 'delete') await api(`/tasks/${request.taskId}`, { method: 'DELETE' });
      if (action === 'accept') await api(`/requests/${request.id}/accept`, { method: 'POST', body: { note } });
      if (action === 'decline') await api(`/requests/${request.id}/decline`, { method: 'POST', body: { note } });
      const done = {
        decline: 'Request declined',
        delete: 'Task deleted',
        accept: 'Edit request closed',
        done: 'Marked done',
      };
      toast(done[action]);
      setDeclineId('');
      setDeclineNote('');
      await load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  const shown = requests.filter((request) => matches(request, filter));
  const showDepartures = filter === 'open' || filter === 'all';
  const empty = shown.length === 0 && (!showDepartures || departures.length === 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p className="lede">Open requests are listed first. All, Closed, and Task completion include ones already answered, with the note that was left.</p>
        </div>
      </div>
      <div className="segment">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" className={filter === item.id ? 'on' : ''} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {error ? <p className="banner">{error}</p> : null}
      {showDepartures ? departures.map((departure) => (
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
      )) : null}
      {empty ? <p className="muted">{filter === 'open' ? 'Nothing is waiting.' : 'Nothing in this view.'}</p> : null}
      <div className="stack">
        {shown.map((request) => {
          const draft = drafts[request.id] || { startDate: request.startDate || '', endDate: request.endDate || '', reason: '' };
          return (
            <article key={request.id} className="panel stack">
              <div className="row-between">
                <h2>{requestTitle(request)}</h2>
                <span className={`pill ${request.status === 'declined' ? 'paused' : request.status === 'open' ? 'review' : 'done'}`}>
                  {request.status === 'open' ? 'Open' : outcome(request)}
                </span>
              </div>
              <p className="muted">{formatWhen(request.createdAt)}</p>
              {request.kind === 'timeline' ? (
                <p>
                  <strong>{request.departmentName}</strong> needs its own timeline on <strong>{request.projectName}</strong>.
                  {request.status === 'open' ? ' This stays here until that team lead sets the dates.' : ' The dates are set.'}
                </p>
              ) : (
                <p>
                  <strong>{request.requesterName}</strong>
                  {request.kind === 'remove' ? ' asked to delete ' : request.kind === 'edit' ? ' asked for edits on ' : ' asked to complete '}
                  {request.taskMissing ? <strong>{request.taskTitle}</strong> : (
                    <button type="button" className="text-link" onClick={() => navigate({ pathname: '/', search: `?task=${request.taskId}` })}>
                      {request.taskTitle}
                    </button>
                  )}
                  {request.assigneeName ? ` · ${request.assigneeName}` : ''}
                  {request.taskStatus ? ` · ${statusLabel(request.taskStatus)}` : ''}
                </p>
              )}
              {request.note ? <p className="banner wait">{request.note}</p> : null}
              {request.kind === 'timeline' && request.startDate ? (
                <p className="muted">{formatDay(request.startDate)} – {formatDay(request.endDate)}</p>
              ) : null}
              {request.status !== 'open' ? (
                <p className="banner ready">{outcome(request)}{request.responseNote ? `: ${request.responseNote}` : ''}</p>
              ) : null}
              {request.canAnswer && request.kind === 'timeline' ? (
                <form
                  className="stack"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    try {
                      await api(`/projects/${request.projectId}/timeline`, {
                        method: 'PATCH',
                        body: {
                          departmentId: request.departmentId,
                          startDate: draft.startDate,
                          endDate: draft.endDate,
                          reason: draft.reason,
                        },
                      });
                      toast('Timeline set');
                      await load();
                    } catch (err) {
                      toast(err.message, 'bad');
                    }
                  }}
                >
                  <div className="fields two">
                    <Field label="Team starts"><input type="date" value={draft.startDate} required onChange={(event) => setDrafts({ ...drafts, [request.id]: { ...draft, startDate: event.target.value } })} /></Field>
                    <Field label="Team ends"><input type="date" value={draft.endDate} required onChange={(event) => setDrafts({ ...drafts, [request.id]: { ...draft, endDate: event.target.value } })} /></Field>
                  </div>
                  <Field label="Note" hint="Optional. It stays on this request after the dates are set.">
                    <textarea value={draft.reason} maxLength={500} onChange={(event) => setDrafts({ ...drafts, [request.id]: { ...draft, reason: event.target.value } })} />
                  </Field>
                  <div className="actions">
                    <button className="btn primary small">Set timeline</button>
                  </div>
                </form>
              ) : null}
              {request.canAnswer && request.kind !== 'timeline' ? (
                <div className="stack">
                  <div className="actions">
                    {request.kind === 'review' ? <button type="button" className="btn primary small" onClick={() => act(request, 'done')}>Mark done</button> : null}
                    {request.kind === 'edit' ? <button type="button" className="btn primary small" onClick={() => act(request, 'accept')}>Edits done</button> : null}
                    {request.kind === 'remove' ? <button type="button" className="btn danger small" onClick={() => act(request, 'delete')}>Delete task</button> : null}
                    {declineId === request.id ? null : (
                      <button type="button" className="btn ghost small" onClick={() => { setDeclineId(request.id); setDeclineNote(''); }}>Decline</button>
                    )}
                  </div>
                  {declineId === request.id ? (
                    <form
                      className="stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        act(request, 'decline', declineNote);
                      }}
                    >
                      <Field label="Note for them" hint="Optional. They’ll still see this request after it’s closed, with this note.">
                        <textarea value={declineNote} onChange={(event) => setDeclineNote(event.target.value)} maxLength={500} placeholder="Why you’re sending this back" />
                      </Field>
                      <div className="actions">
                        <button type="button" className="btn ghost small" onClick={() => setDeclineId('')}>Cancel</button>
                        <button className="btn small">Decline</button>
                      </div>
                    </form>
                  ) : null}
                </div>
              ) : null}
              {!request.canAnswer && request.status === 'open' && request.kind !== 'timeline' ? (
                <p className="hint">Waiting on your team lead.</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
