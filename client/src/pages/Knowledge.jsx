import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../auth';
import Field from '../components/Field';
import FilePick from '../components/FilePick';
import { downloadFile, readFile } from '../files';
import { formatWhen } from '../util';

export default function Knowledge() {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);
  const [needsKt, setNeedsKt] = useState(false);
  const [kt, setKt] = useState({ title: '', note: '', file: null });
  const [doc, setDoc] = useState({ title: '', note: '', link: '', projectId: '', file: null });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    return api('/knowledge').then((data) => {
      setItems(data.items);
      setProjects(data.projects);
      setNeedsKt(data.needsKt);
      setDoc((current) => ({ ...current, projectId: current.projectId || data.projects[0]?.id || '' }));
    });
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  async function saveKt(event) {
    event.preventDefault();
    if (!kt.file) {
      setError('Attach the KT file');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const file = await readFile(kt.file);
      const data = await api('/knowledge', { method: 'POST', body: { kind: 'kt', title: kt.title, note: kt.note, file } });
      setKt({ title: '', note: '', file: null });
      toast(data.message || 'KT document saved');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveDoc(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const file = doc.file ? await readFile(doc.file) : null;
      await api('/knowledge', { method: 'POST', body: { kind: 'project', title: doc.title, note: doc.note, link: doc.link, projectId: doc.projectId, file } });
      setDoc({ title: '', note: '', link: '', projectId: doc.projectId, file: null });
      toast('Added to the project');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const people = items.filter((item) => item.kind === 'kt');
  const projectItems = items.filter((item) => item.kind === 'project');
  const groups = new Map();
  for (const item of projectItems) {
    const key = item.projectName || 'Project';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="lede">KT documents for people, and the links and files that belong to each project.</p>
        </div>
      </div>
      {needsKt ? <p className="banner">Your account is waiting to be removed. Upload a KT file before that can finish.</p> : null}
      {error ? <p className="banner">{error}</p> : null}
      <form className="panel stack" onSubmit={saveKt}>
        <h3>KT document</h3>
        <div className="fields two">
          <Field label="Title"><input value={kt.title} onChange={(event) => setKt({ ...kt, title: event.target.value })} required maxLength={140} /></Field>
          <FilePick required onFile={(file) => setKt({ ...kt, file })} />
        </div>
        <Field label="Note"><textarea value={kt.note} onChange={(event) => setKt({ ...kt, note: event.target.value })} /></Field>
        <div className="form-actions"><button className="btn primary" disabled={busy}>Upload KT</button></div>
      </form>
      <form className="panel stack" onSubmit={saveDoc}>
        <h3>Project link or document</h3>
        <div className="fields two">
          <Field label="Project">
            <select value={doc.projectId} onChange={(event) => setDoc({ ...doc, projectId: event.target.value })} required>
              <option value="">Choose</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </Field>
          <Field label="Title"><input value={doc.title} onChange={(event) => setDoc({ ...doc, title: event.target.value })} required maxLength={140} /></Field>
        </div>
        <Field label="Link"><input value={doc.link} onChange={(event) => setDoc({ ...doc, link: event.target.value })} placeholder="https://" /></Field>
        <FilePick onFile={(file) => setDoc({ ...doc, file })} />
        <Field label="Note"><textarea value={doc.note} onChange={(event) => setDoc({ ...doc, note: event.target.value })} /></Field>
        <div className="form-actions"><button className="btn primary" disabled={busy}>Add to project</button></div>
      </form>
      <section className="stack">
        <h2>People</h2>
        {people.length === 0 ? <p className="muted">No KT documents yet.</p> : people.map((item) => (
          <article key={item.id} className="panel stack">
            <div className="row-between">
              <h3>{item.title}</h3>
              <span className="pill">{item.personName}</span>
            </div>
            {item.note ? <p>{item.note}</p> : null}
            <p className="muted">{item.authorName || 'Former member'} · {formatWhen(item.createdAt)}</p>
            {item.fileStored ? <button type="button" className="btn small" onClick={() => downloadFile(item.fileStored, item.fileName).catch((err) => toast(err.message, 'bad'))}>{item.fileName}</button> : null}
          </article>
        ))}
      </section>
      <section className="stack">
        <h2>Projects</h2>
        {groups.size === 0 ? <p className="muted">No project documents yet.</p> : [...groups.entries()].map(([name, rows]) => (
          <div key={name} className="stack">
            <h3>{name}</h3>
            {rows.map((item) => (
              <article key={item.id} className="panel stack">
                <h3>{item.title}</h3>
                {item.note ? <p>{item.note}</p> : null}
                {item.link ? <a href={item.link} target="_blank" rel="noreferrer">{item.link}</a> : null}
                <p className="muted">{item.authorName || 'Former member'} · {formatWhen(item.createdAt)}</p>
                {item.fileStored ? <button type="button" className="btn small" onClick={() => downloadFile(item.fileStored, item.fileName).catch((err) => toast(err.message, 'bad'))}>{item.fileName}</button> : null}
              </article>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
