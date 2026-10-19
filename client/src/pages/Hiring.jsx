import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import FilePick from '../components/FilePick';
import { downloadFile, readFile } from '../files';
import { formatDay } from '../util';

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
      {error ? <p className="banner">{error}</p> : null}
      <form className="panel stack" onSubmit={(event) => {
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
      </form>
      <form className="panel stack" onSubmit={(event) => {
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
      </form>
      {data.positions.map((item) => {
        const resumes = data.resumes.filter((row) => row.positionId === item.id);
        const mine = resumes.filter((row) => row.status === 'in_review' && (row.reviewerId === user.id || data.isAdmin));
        const selected = picked[item.id] || [];
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
            {resumes.length === 0 ? <p className="muted">No resumes yet.</p> : resumes.map((row) => (
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
            {mine.length ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => run(() => api(`/hiring/positions/${item.id}/submit`, { method: 'POST', body: { resumeIds: selected } }), 'Selection sent')}
              >
                Submit selected resumes
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ResumeCard({ row, user, data, busy, selected, onToggle, schedule, onSchedule, account, onAccount, departments, run, toast }) {
  const canSchedule = ['shortlisted', 'next_round'].includes(row.status) && (row.uploadedBy === user.id || data.isAdmin || data.isHr);
  const canOutcome = row.status === 'scheduled' && (row.reviewerId === user.id || row.uploadedBy === user.id || data.isAdmin || data.isHr);
  return (
    <article className="stack">
      <div className="row-between">
        <strong>{row.candidateName}</strong>
        <span className="pill">{STATUS_LABEL[row.status] || row.status}{row.round > 1 ? ` · round ${row.round}` : ''}</span>
      </div>
      {row.comment ? <p>{row.comment}</p> : null}
      <p className="muted">
        Added by {row.uploaderName}
        {row.referral ? ` · Referral ${row.referralName}` : ''}
        {row.reviewerName ? ` · Reviewer ${row.reviewerName}` : ''}
      </p>
      <button type="button" className="btn small ghost" onClick={() => downloadFile(row.fileStored, row.fileName).catch((err) => toast(err.message, 'bad'))}>{row.fileName}</button>
      {row.status === 'in_review' && (row.reviewerId === user.id || data.isAdmin) ? (
        <label className="check">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          Select for interview
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
