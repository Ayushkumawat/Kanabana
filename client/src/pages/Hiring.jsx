import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import FilePick from '../components/FilePick';
import Modal from '../components/Modal';
import { downloadFile, previewFileUrl, readFile } from '../files';
import { formatDay } from '../util';

const FILTERS = [
  { id: 'pending', label: 'Review pending' },
  { id: 'selected', label: 'Selected' },
  { id: 'rejected', label: 'Not selected' },
];

function resumeBucket(status) {
  if (status === 'new' || status === 'in_review') return 'pending';
  if (status === 'passed' || status === 'discarded') return 'rejected';
  return 'selected';
}

const STATUS_LABEL = {
  new: 'New',
  in_review: 'In review',
  shortlisted: 'Selected for interview',
  passed: 'Not selected',
  scheduled: 'Interview scheduled',
  next_round: 'Next round',
  final: 'Final selection',
  discarded: 'Discarded',
  account_requested: 'Account requested',
  joined: 'Joined',
};

export default function Hiring() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState({ positions: [], resumes: [], departments: [], people: [], isHr: false, isAdmin: false });
  const [position, setPosition] = useState({ title: '', description: '', departmentId: '' });
  const [resume, setResume] = useState({ positionId: '', candidateName: '', comment: '', referral: false, referralName: '', file: null });
  const [reviewer, setReviewer] = useState({});
  const [picked, setPicked] = useState({});
  const [resumeView, setResumeView] = useState({});
  const [schedule, setSchedule] = useState({});
  const [account, setAccount] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/hiring').then((next) => {
      setData(next);
      setPosition((current) => ({ ...current, departmentId: current.departmentId || next.departments[0]?.id || '' }));
      setResume((current) => ({ ...current, positionId: current.positionId || next.positions.find((item) => item.status === 'open')?.id || '' }));
    });
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function run(work, message) {
    setBusy(true);
    setError('');
    try {
      await work();
      if (message) toast(message);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const openPositions = data.positions.filter((item) => item.status === 'open');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Hiring</h1>
          <p className="lede">Open positions by department. Add resumes, ask someone to review them, schedule interviews, then ask admin to create the account.</p>
        </div>
      </div>
      {data.storageReady === false ? <p className="banner">This server cannot store resumes yet. Add the AWS storage keys on the hosted machine and restart it.</p> : null}
      {error ? <p className="banner">{error}</p> : null}
      {data.isHr ? <form className="panel stack" onSubmit={(event) => {
        event.preventDefault();
        run(() => api('/hiring/positions', { method: 'POST', body: position }).then(() => setPosition({ title: '', description: '', departmentId: position.departmentId })), 'Position opened');
      }}>
        <h3>Open a position</h3>
        <div className="fields two">
          <Field label="Position"><input value={position.title} onChange={(event) => setPosition({ ...position, title: event.target.value })} required /></Field>
          <Field label="Department">
            <select value={position.departmentId} onChange={(event) => setPosition({ ...position, departmentId: event.target.value })} required>
              {data.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description"><textarea value={position.description} onChange={(event) => setPosition({ ...position, description: event.target.value })} /></Field>
        <div className="form-actions"><button className="btn primary" disabled={busy}>Add position</button></div>
      </form> : null}
      {data.isHr ? <form className="panel stack" onSubmit={(event) => {
        event.preventDefault();
        if (resume.referral && !resume.referralName.trim()) {
          setError('Write the referrer’s name');
          return;
        }
        if (!resume.file) {
          setError('Attach the resume');
          return;
        }
        run(async () => {
          const file = await readFile(resume.file);
          await api('/hiring/resumes', {
            method: 'POST',
            body: { ...resume, file },
          });
          setResume({ positionId: resume.positionId, candidateName: '', comment: '', referral: false, referralName: '', file: null });
        }, 'Resume added');
      }}>
        <h3>Add a resume</h3>
        <div className="fields two">
          <Field label="Position">
            <select value={resume.positionId} onChange={(event) => setResume({ ...resume, positionId: event.target.value })} required>
              <option value="">Choose</option>
              {openPositions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.departmentName}</option>)}
            </select>
          </Field>
          <Field label="Candidate"><input value={resume.candidateName} onChange={(event) => setResume({ ...resume, candidateName: event.target.value })} required /></Field>
        </div>
        <Field label="Comment"><textarea value={resume.comment} onChange={(event) => setResume({ ...resume, comment: event.target.value })} /></Field>
        <label className="check">
          <input type="checkbox" checked={resume.referral} onChange={(event) => setResume({ ...resume, referral: event.target.checked })} />
          Referral
        </label>
        {resume.referral ? (
          <Field label="Referred by"><input value={resume.referralName} onChange={(event) => setResume({ ...resume, referralName: event.target.value })} required /></Field>
        ) : null}
        <FilePick label="Resume file" required onFile={(file) => setResume({ ...resume, file })} />
        <div className="form-actions"><button className="btn primary" disabled={busy}>Add resume</button></div>
      </form> : null}
      {data.positions.map((item) => {
        const resumes = data.resumes.filter((row) => row.positionId === item.id);
        const pendingCount = resumes.filter((row) => resumeBucket(row.status) === 'pending').length;
        const filter = resumeView[item.id] || (pendingCount ? 'pending' : 'selected');
        const shown = resumes.filter((row) => resumeBucket(row.status) === filter);
        const selected = picked[item.id] || [];
        const pickedHere = selected.filter((id) => shown.some((row) => row.id === id));
        return (
          <section key={item.id} className="panel stack">
            <div className="row-between">
              <h2>{item.title}</h2>
              <span className="pill">{item.departmentName}</span>
            </div>
            {item.description ? <p>{item.description}</p> : null}
            {item.status === 'open' && resumes.some((row) => row.status === 'new') ? (
              <form className="fields two" onSubmit={(event) => {
                event.preventDefault();
                run(() => api(`/hiring/positions/${item.id}/review`, { method: 'POST', body: { reviewerId: reviewer[item.id] } }), 'Review requested');
              }}>
                <Field label="Ask someone to review the new resumes">
                  <select value={reviewer[item.id] || ''} onChange={(event) => setReviewer({ ...reviewer, [item.id]: event.target.value })} required>
                    <option value="">Choose</option>
                    {data.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </select>
                </Field>
                <div className="form-actions"><button className="btn small" disabled={busy}>Send for review</button></div>
              </form>
            ) : null}
            {resumes.length === 0 ? <p className="muted">No resumes yet.</p> : (
            <>
            <div className="segment">
              {FILTERS.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className={filter === entry.id ? 'on' : ''}
                  onClick={() => setResumeView({ ...resumeView, [item.id]: entry.id })}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            {shown.length === 0 ? <p className="muted">Nothing in {FILTERS.find((entry) => entry.id === filter).label.toLowerCase()}.</p> : (
            <div className="hire-grid">
            {shown.map((row) => (
              <ResumeCard
                key={row.id}
                row={row}
                user={user}
                data={data}
                busy={busy}
                selected={selected.includes(row.id)}
                onToggle={() => setPicked({
                  ...picked,
                  [item.id]: selected.includes(row.id) ? selected.filter((id) => id !== row.id) : [...selected, row.id],
                })}
                schedule={schedule[row.id] || { meetLink: '', date: '', time: '' }}
                onSchedule={(next) => setSchedule({ ...schedule, [row.id]: next })}
                account={account[row.id] || { email: '', password: '', birthday: '', workAnniversary: '', departmentIds: [item.departmentId] }}
                onAccount={(next) => setAccount({ ...account, [row.id]: next })}
                departments={data.departments}
                run={run}
                toast={toast}
              />
            ))}
            </div>
            )}
            {((filter === 'rejected') || (filter === 'pending' && shown.some((row) => row.status === 'in_review' && pickedHere.includes(row.id)))) && pickedHere.length ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => run(() => api(`/hiring/positions/${item.id}/submit`, { method: 'POST', body: { resumeIds: pickedHere } }), 'Selection sent')}
              >
                Submit selected resumes
              </button>
            ) : null}
            </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ResumeView({ url }) {
  const hostRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    let task;
    setError('');
    (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      task = pdfjs.getDocument({ url });
      const pdf = await task.promise;
      if (cancelled) return;
      host.replaceChildren();
      const width = Math.max(host.clientWidth - 24, 280);
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(1.5, width / base.width) });
        const wrap = document.createElement('div');
        wrap.className = 'resume-page';
        wrap.style.width = `${viewport.width}px`;
        wrap.style.height = `${viewport.height}px`;
        const canvas = document.createElement('canvas');
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const links = document.createElement('div');
        links.className = 'resume-links';
        wrap.append(canvas, links);
        host.appendChild(wrap);
        const transform = ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0];
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform }).promise;
        const notes = await page.getAnnotations();
        for (const note of notes) {
          const href = note.url || note.unsafeUrl || '';
          if (note.subtype !== 'Link' || !href || !note.rect) continue;
          const [x1, y1] = viewport.convertToViewportPoint(note.rect[0], note.rect[1]);
          const [x2, y2] = viewport.convertToViewportPoint(note.rect[2], note.rect[3]);
          const link = document.createElement('a');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.style.left = `${Math.min(x1, x2)}px`;
          link.style.top = `${Math.min(y1, y2)}px`;
          link.style.width = `${Math.abs(x2 - x1)}px`;
          link.style.height = `${Math.abs(y2 - y1)}px`;
          links.appendChild(link);
        }
      }
    })().catch((err) => {
      if (!cancelled) setError(err.message || 'Could not open that file');
    });
    return () => {
      cancelled = true;
      task?.destroy();
    };
  }, [url]);

  return (
    <>
      {error ? <p className="error">{error}</p> : null}
      <div className="resume-pages" ref={hostRef} />
    </>
  );
}

function ReplaceResume({ busy, onFile }) {
  const inputRef = useRef(null);
  return (
    <>
      <button type="button" className="btn small" disabled={busy} onClick={() => inputRef.current?.click()}>
        Re-upload resume
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.md,.zip"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0] || null;
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
    </>
  );
}

function ResumeMenu({ row, people, busy, onReplace, onReviewer, onDelete }) {
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const [reviewerId, setReviewerId] = useState(row.reviewerId || '');
  const ref = useRef(null);

  useEffect(() => {
    function onDown(event) {
      if (!ref.current?.contains(event.target)) {
        setOpen(false);
        setChanging(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  function close() {
    setOpen(false);
    setChanging(false);
  }

  return (
    <div className="card-menu" ref={ref}>
      <button type="button" className="dots" aria-label="Resume actions" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>⋯</button>
      {open ? (
        <div className="menu-pop">
          <ReplaceResume busy={busy} onFile={(file) => { close(); onReplace(file); }} />
          {changing ? (
            <form onSubmit={(event) => {
              event.preventDefault();
              if (!reviewerId) return;
              close();
              onReviewer(reviewerId);
            }}>
              <label>
                Reviewer
                <select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} required>
                  <option value="">Choose</option>
                  {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </label>
              <button className="btn small" disabled={busy || !reviewerId}>Done</button>
            </form>
          ) : (
            <button type="button" className="btn small" disabled={busy} onClick={() => setChanging(true)}>Change reviewer</button>
          )}
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => { close(); onDelete(); }}>Delete resume</button>
        </div>
      ) : null}
    </div>
  );
}

function ResumeCard({ row, user, data, busy, selected, onToggle, schedule, onSchedule, account, onAccount, departments, run, toast }) {
  const canSchedule = ['shortlisted', 'next_round'].includes(row.status) && (row.uploadedBy === user.id || data.isAdmin || data.isHr);
  const canOutcome = row.status === 'scheduled' && (row.reviewerId === user.id || row.uploadedBy === user.id || data.isAdmin || data.isHr);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');

  function closePreview() {
    if (preview?.url?.startsWith('blob:')) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setPreviewError('');
  }

  async function replaceResume(file) {
    const body = await readFile(file);
    closePreview();
    await run(() => api(`/hiring/resumes/${row.id}/file`, { method: 'POST', body: { file: body } }), 'Resume uploaded');
  }

  function changeReviewer(reviewerId) {
    return run(() => api(`/hiring/resumes/${row.id}/reviewer`, { method: 'POST', body: { reviewerId } }), 'Reviewer updated');
  }

  function removeCard() {
    if (!window.confirm(`Delete ${row.candidateName}'s resume card?`)) return undefined;
    return run(() => api(`/hiring/resumes/${row.id}`, { method: 'DELETE' }), 'Resume removed');
  }

  async function openPreview() {
    setPreview({ url: '', kind: '', loading: true });
    setPreviewError('');
    try {
      const next = await previewFileUrl(row.fileStored, row.fileName);
      setPreview({ ...next, loading: false });
    } catch (err) {
      setPreview(null);
      setPreviewError(err.message);
      toast(err.message, 'bad');
    }
  }

  return (
    <article className="hire-card">
      <div className="row-between">
        <strong>{row.candidateName}</strong>
        <div className="row-actions">
          <span className="pill">{STATUS_LABEL[row.status] || row.status}{row.round > 1 ? ` · round ${row.round}` : ''}</span>
          <ResumeMenu
            row={row}
            people={data.people}
            busy={busy}
            onReplace={replaceResume}
            onReviewer={changeReviewer}
            onDelete={removeCard}
          />
        </div>
      </div>
      {row.comment ? <p>{row.comment}</p> : null}
      <p className="muted">
        Added by {row.uploaderName}
        {row.referral ? ` · Referral ${row.referralName}` : ''}
        {row.reviewerName ? ` · Reviewer ${row.reviewerName}` : ''}
      </p>
      <div className="row-actions">
        <button type="button" className="btn small" onClick={openPreview}>View resume</button>
      </div>
      {row.reviewerId === user.id ? (
        <div className="segment" role="group" aria-label={`Move ${row.candidateName}`}>
          {FILTERS.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={resumeBucket(row.status) === entry.id ? 'on' : ''}
              disabled={busy || resumeBucket(row.status) === entry.id}
              onClick={() => run(() => api(`/hiring/resumes/${row.id}/bucket`, { method: 'POST', body: { bucket: entry.id } }), 'Status updated')}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
      {row.fileAvailable === false ? <p className="error">The resume file is missing.</p> : null}
      {preview || previewError ? (
        <Modal title={row.candidateName} className="resume" onClose={closePreview}>
          <div className="resume-bar">
            <p className="muted">{row.fileName}</p>
            <div className="row-actions">
              {previewError ? null : (
                <button type="button" className="btn small" onClick={() => downloadFile(row.fileStored, row.fileName).catch((err) => toast(err.message, 'bad'))}>Download</button>
              )}
            </div>
          </div>
          {previewError ? <p className="error">{previewError}</p> : null}
          {preview?.loading ? <p className="muted">Opening the resume…</p> : null}
          {preview?.kind === 'pdf' && preview.url ? <ResumeView url={preview.url} /> : null}
          {preview?.kind === 'image' && preview.url ? (
            <img className="resume-frame" alt={row.fileName} src={preview.url} />
          ) : null}
          {preview && !preview.loading && !preview.kind ? (
            <p className="muted">This file can’t be shown on the page. Download it to open it.</p>
          ) : null}
        </Modal>
      ) : null}
      {row.status === 'in_review' && (row.reviewerId === user.id || data.isAdmin) ? (
        <label className="check">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          Select for interview
        </label>
      ) : null}
      {(row.status === 'passed' || row.status === 'discarded') ? (
        <label className="check">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          Select
        </label>
      ) : null}
      {canSchedule ? (
        <form className="fields two" onSubmit={(event) => {
          event.preventDefault();
          run(() => api(`/hiring/resumes/${row.id}/interview`, { method: 'POST', body: schedule }), 'Interview scheduled');
        }}>
          <Field label="Google Meet link"><input value={schedule.meetLink} onChange={(event) => onSchedule({ ...schedule, meetLink: event.target.value })} required /></Field>
          <Field label="Date"><input type="date" value={schedule.date} onChange={(event) => onSchedule({ ...schedule, date: event.target.value })} required /></Field>
          <Field label="Time"><input value={schedule.time} onChange={(event) => onSchedule({ ...schedule, time: event.target.value })} required placeholder="11:00" /></Field>
          <div className="form-actions"><button className="btn small" disabled={busy}>Share schedule</button></div>
        </form>
      ) : null}
      {row.status === 'scheduled' ? (
        <p className="muted">{formatDay(row.interviewDate)} · {row.interviewTime} · <a href={row.meetLink} target="_blank" rel="noreferrer">{row.meetLink}</a></p>
      ) : null}
      {canOutcome ? (
        <div className="row-actions">
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api(`/hiring/resumes/${row.id}/outcome`, { method: 'POST', body: { result: 'selected', next: 'round' } }), 'Next round')}>Selected · next round</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api(`/hiring/resumes/${row.id}/outcome`, { method: 'POST', body: { result: 'selected', next: 'final' } }), 'Final selection')}>Selected · final</button>
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => run(() => api(`/hiring/resumes/${row.id}/outcome`, { method: 'POST', body: { result: 'rejected' } }), 'Discarded')}>Not selected</button>
        </div>
      ) : null}
      {row.status === 'final' ? (
        <div className="row-actions">
          <button type="button" className="btn ghost small" disabled={busy} onClick={() => run(() => api(`/hiring/resumes/${row.id}/discard`, { method: 'POST' }), 'Discarded')}>Discard</button>
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api(`/hiring/resumes/${row.id}/request-account`, { method: 'POST' }), 'Asked admin to create the account')}>Ask admin to create the account</button>
        </div>
      ) : null}
      {row.status === 'account_requested' && data.isAdmin ? (
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          run(() => api(`/hiring/resumes/${row.id}/account`, { method: 'POST', body: account }), 'Account created');
        }}>
          <div className="fields two">
            <Field label="Email"><input type="email" value={account.email} onChange={(event) => onAccount({ ...account, email: event.target.value })} required /></Field>
            <Field label="Temporary password"><input value={account.password} onChange={(event) => onAccount({ ...account, password: event.target.value })} required minLength={8} /></Field>
          </div>
          <div className="fields two">
            <Field label="Birthday"><input type="date" value={account.birthday} onChange={(event) => onAccount({ ...account, birthday: event.target.value })} required /></Field>
            <Field label="Work anniversary"><input type="date" value={account.workAnniversary} onChange={(event) => onAccount({ ...account, workAnniversary: event.target.value })} required /></Field>
          </div>
          <div className="form-actions"><button className="btn small" disabled={busy}>Create account</button></div>
        </form>
      ) : null}
      {row.status === 'joined' && data.isHr ? (
        <div className="stack">
          <p className="hint">Account created. HR checklist</p>
          {row.checks.map((item) => (
            <label key={item.id} className="check">
              <input
                type="checkbox"
                checked={item.done}
                onChange={(event) => run(() => api(`/hiring/checks/${item.id}`, { method: 'POST', body: { done: event.target.checked } }))}
              />
              {item.label}
            </label>
          ))}
        </div>
      ) : null}
    </article>
  );
}
