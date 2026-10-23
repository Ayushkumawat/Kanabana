import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import { fileObjectUrl, readFile } from '../files';
import { formatWhen } from '../util';

const FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'bug', label: 'Bugs' },
  { id: 'suggestion', label: 'Ideas' },
  { id: 'fixed', label: 'Fixed' },
];

function LocalShot({ file, onRemove }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  if (!url) return null;
  return (
    <figure>
      <img src={url} alt={file.name} />
      <button type="button" onClick={onRemove}>Remove</button>
    </figure>
  );
}

function Shot({ stored, name, onOpen }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    let cancel = false;
    let current = '';
    fileObjectUrl(stored)
      .then((next) => {
        current = next;
        if (!cancel) setUrl(next);
        else URL.revokeObjectURL(next);
      })
      .catch(() => {});
    return () => {
      cancel = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [stored]);

  if (!url) return <span className="shot-pending">{name}</span>;
  return (
    <button type="button" className="shot" onClick={() => onOpen(url, name)}>
      <img src={url} alt={name} />
    </button>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const toast = useToast();
  const [reports, setReports] = useState([]);
  const [kind, setKind] = useState('bug');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [page, setPage] = useState('');
  const [shots, setShots] = useState([]);
  const [pickerKey, setPickerKey] = useState(0);
  const [filter, setFilter] = useState('open');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null);

  function load() {
    return api('/reports').then((data) => setReports(data.reports));
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  function addShots(list) {
    const next = [...shots];
    for (const file of list) {
      if (next.length >= 3) {
        setError('Attach up to 3 screenshots');
        break;
      }
      if (!file.type.startsWith('image/')) {
        setError('Screenshots need to be images');
        continue;
      }
      if (file.size > 3 * 1024 * 1024) {
        setError('Keep each screenshot under 3 MB');
        continue;
      }
      next.push(file);
    }
    setShots(next);
    setPickerKey((value) => value + 1);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const files = [];
      for (const file of shots) files.push(await readFile(file));
      const data = await api('/reports', {
        method: 'POST',
        body: { kind, title, details, page, shots: files },
      });
      setReports(data.reports);
      setTitle('');
      setDetails('');
      setPage('');
      setShots([]);
      setPickerKey((value) => value + 1);
      setFilter(kind === 'bug' ? 'bug' : 'suggestion');
      toast(kind === 'bug' ? 'Bug reported' : 'Suggestion saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(report, status) {
    setError('');
    try {
      const data = await api(`/reports/${report.id}`, { method: 'PATCH', body: { status } });
      setReports(data.reports);
      toast(status === 'fixed' ? 'Marked fixed' : 'Reopened');
    } catch (err) {
      setError(err.message);
    }
  }

  const visible = reports.filter((item) => {
    if (filter === 'fixed') return item.status === 'fixed';
    if (item.status !== 'open') return false;
    if (filter === 'bug') return item.kind === 'bug';
    if (filter === 'suggestion') return item.kind === 'suggestion';
    return true;
  });

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Bugs & ideas</h1>
          <p className="lede">Report something broken on the site, or leave a suggestion. A screenshot and a short note are enough.</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <form className="panel report-form" onSubmit={submit}>
        <div className="segment">
          <button type="button" className={kind === 'bug' ? 'on' : ''} onClick={() => setKind('bug')}>Bug</button>
          <button type="button" className={kind === 'suggestion' ? 'on' : ''} onClick={() => setKind('suggestion')}>Suggestion</button>
        </div>
        <Field label="Title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={140} required placeholder={kind === 'bug' ? 'What went wrong' : 'What would help'} />
        </Field>
        <Field label="Details" hint="What you were doing, and what you expected to happen.">
          <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={4000} required rows={4} />
        </Field>
        <Field label="Page" hint="Optional. The screen where you saw it.">
          <input value={page} onChange={(event) => setPage(event.target.value)} maxLength={200} placeholder="My board, a project, login…" />
        </Field>
        <Field label="Screenshots" hint="Up to 3 images, each under 3 MB.">
          <input
            key={pickerKey}
            className="file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => addShots([...(event.target.files || [])])}
          />
        </Field>
        {shots.length ? (
          <div className="shot-row">
            {shots.map((file, index) => (
              <LocalShot key={`${file.name}-${file.lastModified}-${index}`} file={file} onRemove={() => setShots((current) => current.filter((_, item) => item !== index))} />
            ))}
          </div>
        ) : null}
        <div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Sending…' : kind === 'bug' ? 'Report bug' : 'Send suggestion'}</button>
        </div>
      </form>
      <div className="segment">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" className={filter === item.id ? 'on' : ''} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className="panel report-list">
        {visible.length === 0 ? <p className="muted">Nothing in this list yet.</p> : visible.map((report) => {
          const canUpdate = user.id === report.authorId || user.isAdmin || user.isLead;
          return (
            <article key={report.id} className={`report-card${report.status === 'fixed' ? ' fixed' : ''}`}>
              <header>
                <div>
                  <strong>{report.title}</strong>
                  <small>{report.kind === 'bug' ? 'Bug' : 'Suggestion'} · {report.authorName} · {formatWhen(report.createdAt)}{report.page ? ` · ${report.page}` : ''}</small>
                </div>
                {canUpdate ? (
                  <button type="button" className="btn ghost small" onClick={() => setStatus(report, report.status === 'fixed' ? 'open' : 'fixed')}>
                    {report.status === 'fixed' ? 'Reopen' : 'Mark fixed'}
                  </button>
                ) : <span className="pill">{report.status === 'fixed' ? 'Fixed' : 'Open'}</span>}
              </header>
              <p>{report.details}</p>
              {report.shots.length ? (
                <div className="report-shots">
                  {report.shots.map((shot) => (
                    <Shot key={shot.id} stored={shot.stored} name={shot.name} onOpen={(url, name) => setView({ url, name })} />
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {view ? (
        <button type="button" className="lightbox" onClick={() => setView(null)}>
          <img src={view.url} alt={view.name} />
        </button>
      ) : null}
      <p className="watermark">made with ❤️ by Ayush at AIunika</p>
    </div>
  );
}
