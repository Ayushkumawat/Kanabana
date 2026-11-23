import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Field from '../components/Field';
import Modal from '../components/Modal';
import { downloadFile, previewFileUrl, readFile } from '../files';
import { formatWhen } from '../util';

const KINDS = [
  ['kt', 'KT document'],
  ['architecture', 'Architecture'],
  ['credit', 'Credits'],
  ['procedure', 'Procedure'],
  ['note', 'Note'],
];

const KIND_LABEL = {
  kt: 'KT',
  architecture: 'Architecture',
  credit: 'Credits',
  procedure: 'Procedure',
  note: 'Note',
  project: 'Project',
};

const SOURCE_LABEL = {
  upload: 'Upload',
  chat: 'Chat',
  task: 'Task',
};

const PROMPTS = [
  'Where are the credentials stored for a project?',
  'How do I run a project or script?',
  'Which platform credits can we use, and how?',
];

function kindLabel(kind) {
  return KIND_LABEL[kind] || 'Note';
}

function isImageName(name) {
  return /\.(png|jpe?g|gif|webp)$/i.test(name || '');
}

function inline(text, key) {
  const bits = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) bits.push(text.slice(last, match.index));
    const token = match[0];
    const id = `${key}-${index}`;
    if (token.startsWith('`')) bits.push(<code key={id}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) bits.push(<strong key={id}>{token.slice(2, -2)}</strong>);
    else {
      const linked = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linked) bits.push(<a key={id} href={linked[2]} target="_blank" rel="noreferrer">{linked[1]}</a>);
    }
    index += 1;
    last = match.index + token.length;
  }
  if (last < text.length) bits.push(text.slice(last));
  return bits;
}

function Answer({ text }) {
  const blocks = [];
  String(text || '').split('```').forEach((part, index) => {
    if (index % 2 === 1) {
      const breakAt = part.indexOf('\n');
      const code = breakAt >= 0 ? part.slice(breakAt + 1) : part;
      blocks.push(<pre key={`code-${index}`}><code>{code.replace(/\n$/, '')}</code></pre>);
      return;
    }
    const lines = part.split('\n');
    let paragraph = [];
    let list = [];
    const flushParagraph = () => {
      const value = paragraph.join(' ').trim();
      paragraph = [];
      if (!value) return;
      blocks.push(<p key={`p-${index}-${blocks.length}`}>{inline(value, `p-${index}-${blocks.length}`)}</p>);
    };
    const flushList = () => {
      if (!list.length) return;
      const items = list;
      list = [];
      blocks.push(<ul key={`u-${index}-${blocks.length}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `li-${index}-${itemIndex}`)}</li>)}</ul>);
    };
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
      const heading = line.match(/^\s*#{1,3}\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        list.push((bullet || numbered)[1]);
      } else if (heading) {
        flushParagraph();
        flushList();
        blocks.push(<strong key={`h-${index}-${blocks.length}`} className="ask-h">{inline(heading[1], `h-${index}`)}</strong>);
      } else if (!line.trim()) {
        flushParagraph();
        flushList();
      } else {
        flushList();
        paragraph.push(line.trim());
      }
    }
    flushParagraph();
    flushList();
  });
  if (!blocks.length) return null;
  return <div className="ask-copy">{blocks}</div>;
}

function Shot({ stored, name }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!stored || !isImageName(name)) return undefined;
    let alive = true;
    let current = '';
    previewFileUrl(stored, name).then((result) => {
      if (!alive) {
        if (result.url.startsWith('blob:')) URL.revokeObjectURL(result.url);
        return;
      }
      if (result.kind === 'image') {
        current = result.url;
        setUrl(result.url);
      }
    }).catch(() => {});
    return () => {
      alive = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [stored, name]);
  if (!url) return null;
  return <img className="ask-shot" src={url} alt={name} />;
}

export default function Knowledge() {
  const { user } = useAuth();
  const toast = useToast();
  const logRef = useRef(null);
  const fileRef = useRef(null);
  const dragDepth = useRef(0);
  const openToken = useRef(0);
  const busyRef = useRef(false);
  const [ready, setReady] = useState(true);
  const [needsKt, setNeedsKt] = useState(false);
  const [projects, setProjects] = useState([]);
  const [chats, setChats] = useState([]);
  const [chatQuery, setChatQuery] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [title, setTitle] = useState('New chat');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadKind, setUploadKind] = useState('note');
  const [libraryOpen, setLibraryOpen] = useState(false);

  const active = chats.find((chat) => chat.id === activeId) || null;

  useEffect(() => {
    api('/assistant').then((data) => {
      setReady(Boolean(data.ready));
      setNeedsKt(Boolean(data.needsKt));
      setProjects(data.projects || []);
    }).catch((err) => setError(err.message));
    api('/assistant/chats').then((data) => setChats(data.chats || [])).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    setTitle(active?.title || 'New chat');
  }, [active?.id, active?.title]);

  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy, activeId]);

  function applyChat(data) {
    setActiveId(data.chat.id);
    setMessages(data.messages || []);
    setChats((list) => [data.chat, ...list.filter((item) => item.id !== data.chat.id)]);
    if (typeof data.needsKt === 'boolean') setNeedsKt(data.needsKt);
    if (data.notice) toast(data.notice);
  }

  function startChat() {
    openToken.current += 1;
    setActiveId(null);
    setMessages([]);
    setDraft('');
    setAttached([]);
    setError('');
    setTitle('New chat');
  }

  async function openChat(id) {
    const token = openToken.current + 1;
    openToken.current = token;
    setActiveId(id);
    setError('');
    setDraft('');
    setAttached([]);
    try {
      const data = await api(`/assistant/chats/${id}`);
      if (openToken.current !== token) return;
      setMessages(data.messages || []);
      if (typeof data.needsKt === 'boolean') setNeedsKt(data.needsKt);
    } catch (err) {
      if (openToken.current === token) setError(err.message);
    }
  }

  async function saveTitle() {
    const next = title.trim();
    if (!activeId || !next || next === active?.title) return;
    try {
      const data = await api(`/assistant/chats/${activeId}`, { method: 'PATCH', body: { title: next } });
      setChats((list) => list.map((item) => (item.id === data.chat.id ? data.chat : item)));
    } catch (err) {
      toast(err.message, 'bad');
      setTitle(active?.title || 'New chat');
    }
  }

  async function removeChat(chat) {
    if (!window.confirm(`Delete “${chat.title}”?`)) return;
    try {
      await api(`/assistant/chats/${chat.id}`, { method: 'DELETE' });
      setChats((list) => list.filter((item) => item.id !== chat.id));
      if (activeId === chat.id) startChat();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function addFiles(list) {
    const next = [...attached];
    for (const file of list) {
      if (next.length >= 3) {
        toast('Attach up to 3 files', 'bad');
        break;
      }
      if (file.size > 8 * 1024 * 1024) {
        toast(`${file.name} is over 8 MB`, 'bad');
        continue;
      }
      next.push(file);
    }
    setAttached(next);
  }

  async function send(options = {}) {
    const text = options.text ?? draft;
    const files = options.files ?? attached;
    const retry = Boolean(options.retry);
    const body = String(text || '').trim();
    if (busyRef.current) return;
    if (!retry && !body && !files.length) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const payload = [];
      for (const file of files) payload.push(await readFile(file));
      const data = await api('/assistant/chat', {
        method: 'POST',
        body: retry ? { chatId: activeId, retry: true } : { chatId: activeId, text: body, files: payload },
      });
      applyChat(data);
      if (!retry && options.text == null) {
        setDraft('');
        setAttached([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function decide(proposalId, action) {
    if (!activeId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await api(`/assistant/chats/${activeId}/proposal`, { method: 'POST', body: { id: proposalId, action } });
      applyChat(data);
    } catch (err) {
      setError(err.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function copyAnswer(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy that', 'bad');
    }
  }

  const visibleChats = chats.filter((chat) => chat.title.toLowerCase().includes(chatQuery.trim().toLowerCase()));
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');

  return (
    <div className="ask-page">
      {needsKt ? (
        <p className="banner">
          Your account is waiting to be removed. Upload a KT file before that can finish.
          {' '}
          <button type="button" className="btn small" onClick={() => { setUploadKind('kt'); setUploadOpen(true); }}>Upload KT</button>
        </p>
      ) : null}
      {!ready ? (
        <p className="banner wait">
          The assistant can search saved documents.
          {user.isAdmin ? ' Set GEMINI_API_KEY on the server for full answers.' : ' Full answers turn on once the office model is connected.'}
        </p>
      ) : null}
      <div className="ask-frame">
        <aside className="ask-side">
          <div className="ask-side-actions">
            <button type="button" className="btn primary" onClick={startChat}>New chat</button>
            <button type="button" className="btn ghost" onClick={() => { setUploadKind(needsKt ? 'kt' : 'note'); setUploadOpen(true); }}>Add document</button>
            {user.isAdmin ? <button type="button" className="btn ghost" onClick={() => setLibraryOpen(true)}>Knowledge base</button> : null}
          </div>
          <input
            type="search"
            value={chatQuery}
            onChange={(event) => setChatQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          <div className="ask-chats">
            {visibleChats.length === 0 ? <p className="muted">No chats yet.</p> : visibleChats.map((chat) => (
              <div key={chat.id} className={`ask-chat${chat.id === activeId ? ' on' : ''}`}>
                <button type="button" onClick={() => openChat(chat.id)}>
                  <strong>{chat.title}</strong>
                  <small>{formatWhen(chat.updatedAt)}</small>
                </button>
                <button type="button" className="ask-x" aria-label={`Delete ${chat.title}`} onClick={() => removeChat(chat)}>×</button>
              </div>
            ))}
          </div>
        </aside>
        <section
          className={`ask-main${drag ? ' over' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDrag(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            dragDepth.current -= 1;
            if (dragDepth.current <= 0) {
              dragDepth.current = 0;
              setDrag(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDrag(false);
            addFiles(event.dataTransfer.files);
          }}
        >
          <header className="ask-head">
            <input
              className="ask-title"
              aria-label="Chat title"
              value={title}
              maxLength={80}
              disabled={!activeId}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={saveTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            <span className="pill">{ready ? 'Assistant' : 'Search'}</span>
          </header>
          <div className="ask-log" ref={logRef}>
            {messages.length === 0 && !busy ? (
              <div className="ask-hello">
                <h1>Knowledge</h1>
                <p>Ask about a project, a script, or a credit. Attach a file for this chat, or add a document the whole team can use later.</p>
                <div className="ask-prompts">
                  {PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => send({ text: prompt, files: [] })}>{prompt}</button>
                  ))}
                  <button type="button" onClick={() => setDraft('Turn this into a short checklist for the team:\n')}>Draft a checklist</button>
                </div>
              </div>
            ) : messages.map((message) => (
              <article key={message.id} className={`ask-row ${message.role}`}>
                <div className={`ask-bubble ${message.role}`}>
                  {message.role === 'assistant' ? <Answer text={message.content} /> : <p className="ask-user">{message.content}</p>}
                  {message.attachments?.length ? (
                    <div className="ask-files">
                      {message.attachments.map((file) => (
                        <div key={file.stored} className="ask-file">
                          <Shot stored={file.stored} name={file.name} />
                          <button type="button" className="btn small ghost" onClick={() => downloadFile(file.stored, file.name).catch((err) => toast(err.message, 'bad'))}>{file.name}</button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {message.sources?.length ? (
                    <p className="ask-sources">
                      {message.sources.map((source) => `${source.title}${source.authorName ? ` · ${source.authorName}` : ''}`).join('  ·  ')}
                    </p>
                  ) : null}
                  {message.proposal ? (
                    <div className="ask-save">
                      <strong>{message.proposal.status === 'pending' ? 'Save this for the team?' : message.proposal.title}</strong>
                      {message.proposal.status === 'pending' ? (
                        <>
                          <p>{message.proposal.title}</p>
                          <p className="muted">{message.proposal.summary}</p>
                          <div className="row-actions">
                            <button type="button" className="btn small primary" disabled={busy} onClick={() => decide(message.proposal.id, 'save')}>Add to knowledge base</button>
                            <button type="button" className="btn small ghost" disabled={busy} onClick={() => decide(message.proposal.id, 'dismiss')}>Not now</button>
                          </div>
                        </>
                      ) : (
                        <p className="muted">{message.proposal.status === 'saved' ? 'Saved to the knowledge base, under your name.' : 'Left out of the knowledge base.'}</p>
                      )}
                    </div>
                  ) : null}
                  {message.role === 'assistant' && message.id === lastAssistant?.id && message.followUps?.length ? (
                    <div className="ask-prompts">
                      {message.followUps.map((follow) => (
                        <button key={follow} type="button" disabled={busy} onClick={() => send({ text: follow, files: [] })}>{follow}</button>
                      ))}
                    </div>
                  ) : null}
                  {message.role === 'assistant' ? (
                    <div className="row-actions">
                      <button type="button" className="btn small ghost" onClick={() => copyAnswer(message.content)}>Copy</button>
                      {message.id === lastAssistant?.id ? <button type="button" className="btn small ghost" disabled={busy} onClick={() => send({ retry: true, text: '', files: [] })}>Try again</button> : null}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
            {busy ? (
              <div className="ask-row assistant" aria-live="polite">
                <div className="ask-bubble assistant ask-wait"><i /><i /><i /></div>
              </div>
            ) : null}
          </div>
          {error ? <p className="banner">{error}</p> : null}
          <form
            className="ask-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            {attached.length ? (
              <div className="ask-chips">
                {attached.map((file, index) => (
                  <span key={`${file.name}-${index}`} className="chip">
                    {file.name}
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttached(attached.filter((_, item) => item !== index))}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              value={draft}
              rows={2}
              placeholder="Ask about a project, paste a note, or attach a file"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="ask-composer-bar">
              <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>Attach</button>
              <input
                ref={fileRef}
                className="ask-file-input"
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.zip"
                onChange={(event) => {
                  addFiles(event.target.files || []);
                  event.target.value = '';
                }}
              />
              <span className="hint">Enter to send. A file stays in this chat until you agree to save it.</span>
              <button className="btn primary" disabled={busy || (!draft.trim() && !attached.length)}>Send</button>
            </div>
          </form>
          {drag ? <div className="ask-drop">Drop files to attach them</div> : null}
        </section>
      </div>
      {uploadOpen ? (
        <UploadModal
          projects={projects}
          initialKind={uploadKind}
          name={user.name}
          busy={busy}
          onClose={() => setUploadOpen(false)}
          onSaved={(data) => {
            applyChat(data);
            setUploadOpen(false);
          }}
        />
      ) : null}
      {libraryOpen && user.isAdmin ? <LibraryModal onClose={() => setLibraryOpen(false)} /> : null}
    </div>
  );
}

function UploadModal({ projects, initialKind, name, busy, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', kind: initialKind || 'note', note: '', projectId: '', file: null });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!form.file) {
      setError('Attach the file');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const file = await readFile(form.file);
      const data = await api('/assistant/library', {
        method: 'POST',
        body: {
          title: form.title,
          kind: form.kind,
          note: form.note,
          projectId: form.projectId,
          file,
        },
      });
      onSaved(data);
    } catch (err) {
      setError(err.message);
      toast(err.message, 'bad');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add a document" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">This is saved for the team under {name}. The assistant will ask if a teammate would need anything else.</p>
        {error ? <p className="banner">{error}</p> : null}
        <div className="fields two">
          <Field label="Kind">
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
              {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Title">
            <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={140} />
          </Field>
        </div>
        <Field label="Project" hint="Optional. Ties the note to a project.">
          <select value={form.projectId} onChange={(event) => setForm({ ...form, projectId: event.target.value })}>
            <option value="">None</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </Field>
        <Field label="File" hint="pdf, office, image, text, or zip. Under 8 MB.">
          <input className="file-input" type="file" required accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.csv,.json,.zip" onChange={(event) => setForm({ ...form, file: event.target.files?.[0] || null })} />
        </Field>
        <Field label="Note"><textarea value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></Field>
        <div className="form-actions"><button className="btn primary" disabled={saving || busy}>Save for the team</button></div>
      </form>
    </Modal>
  );
}

function LibraryModal({ onClose }) {
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/assistant/library').then((data) => setEntries(data.entries || [])).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, []);

  async function open(entry) {
    setError('');
    try {
      const data = await api(`/assistant/library/${entry.id}`);
      setSelected(data.entry);
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(entry) {
    if (!window.confirm(`Remove “${entry.title}” from the knowledge base?`)) return;
    try {
      await api(`/assistant/library/${entry.id}`, { method: 'DELETE' });
      setEntries((list) => list.filter((item) => item.id !== entry.id));
      setSelected((current) => (current?.id === entry.id ? null : current));
      toast('Removed from the knowledge base');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  const shown = entries.filter((entry) => {
    if (kind && entry.kind !== kind) return false;
    const hay = `${entry.title} ${entry.authorName} ${entry.excerpt} ${entry.projectName}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });

  return (
    <Modal title="Knowledge base" onClose={onClose} className="library">
      <p className="muted">Documents and notes the assistant can use, with who added them and when. Only admins can open this list.</p>
      {error ? <p className="banner">{error}</p> : null}
      <div className="library-tools">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, person, or note" aria-label="Search the knowledge base" />
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          {Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="library-grid">
        <div className="library-list">
          {loading ? <p className="muted">Loading…</p> : null}
          {!loading && shown.length === 0 ? <p className="muted">Nothing in the knowledge base yet.</p> : null}
          {shown.map((entry) => (
            <button key={entry.id} type="button" className={`library-row${selected?.id === entry.id ? ' on' : ''}`} onClick={() => open(entry)}>
              <strong>{entry.title}</strong>
              <small>{kindLabel(entry.kind)} · {entry.authorName} · {formatWhen(entry.createdAt)}</small>
            </button>
          ))}
        </div>
        <div className="library-detail">
          {!selected ? <p className="muted">Choose a document to see who added it and what it says.</p> : (
            <div className="stack">
              <div className="row-between">
                <h3>{selected.title}</h3>
                <button type="button" className="btn small danger" onClick={() => remove(selected)}>Remove</button>
              </div>
              <div className="chips">
                <span className="pill">{kindLabel(selected.kind)}</span>
                <span className="pill">{SOURCE_LABEL[selected.source] || 'Upload'}</span>
                {selected.projectName ? <span className="pill">{selected.projectName}</span> : null}
              </div>
              <p><strong>{selected.authorName}</strong> · {formatWhen(selected.createdAt)}</p>
              {selected.body ? <pre className="library-body">{selected.body}</pre> : <p className="muted">No text could be read from this file.</p>}
              {selected.files?.map((file) => (
                <div key={file.stored} className="stack">
                  <Shot stored={file.stored} name={file.name} />
                  <button type="button" className="btn small" onClick={() => downloadFile(file.stored, file.name).catch((err) => toast(err.message, 'bad'))}>{file.name}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
