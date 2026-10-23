import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import { formatClock, formatElapsed, isSunday, roleLabel } from '../util';
import Avatar from './Avatar';
import Field from './Field';
import Modal from './Modal';

const GROUPS = [
  {
    label: 'Work',
    links: [
      { to: '/', label: 'My board', area: 'board' },
      { to: '/team', label: 'Team', area: 'team' },
      { to: '/projects', label: 'Projects', area: 'projects' },
      { to: '/repeating', label: 'Repeating', area: 'repeating' },
    ],
  },
  {
    label: 'Office',
    links: [
      { to: '/requests', label: 'Requests', area: 'requests' },
      { to: '/chores', label: 'Chores', area: 'chores' },
      { to: '/knowledge', label: 'Knowledge', area: 'knowledge' },
      { to: '/dependencies', label: 'Help', area: 'dependencies' },
      { to: '/tenders', label: 'Tenders', area: 'tenders', gate: 'office' },
      { to: '/hiring', label: 'Hiring', area: 'hiring', gate: 'office' },
    ],
  },
  {
    label: 'People',
    links: [
      { to: '/people', label: 'People', area: 'people', gate: 'lead' },
      { to: '/attendance', label: 'Attendance', area: 'attendance' },
      { to: '/directory', label: 'Directory', area: 'directory' },
      { to: '/reports', label: 'Bugs & ideas', area: 'reports' },
    ],
  },
];

const LINKS = GROUPS.flatMap((group) => group.links);

function showLink(item, user) {
  if (!item.gate || user.isAdmin) return true;
  if (item.gate === 'lead') return user.isLead;
  if (item.gate === 'office') return user.isLead || user.isHr;
  return false;
}

function OfficeTimer({ checkIn, checkOut }) {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (!checkIn || checkOut) return undefined;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [checkIn, checkOut]);
  if (!checkIn) return null;
  const end = checkOut ? new Date(checkOut).getTime() : tick;
  return (
    <span className="pill clock-live" aria-live="polite" title="Time in office">
      {formatElapsed(new Date(checkIn).getTime(), end)}
    </span>
  );
}

function areaFor(pathname) {
  if (pathname === '/') return 'board';
  if (pathname.startsWith('/projects')) return 'projects';
  const link = LINKS.find((item) => item.to !== '/' && pathname.startsWith(item.to));
  return link?.area || '';
}

export default function Layout() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [notes, setNotes] = useState({ notifications: [], unreadCount: 0, areas: {} });
  const [today, setToday] = useState(null);
  const [clockBusy, setClockBusy] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const data = await api('/notifications');
        const area = areaFor(location.pathname);
        if (area && data.areas?.[area]) {
          await api('/notifications/seen', { method: 'POST', body: { area } });
          data.areas[area] = 0;
        }
        if (!stop) setNotes(data);
      } catch {
        /* The board still works if alerts fail to load. */
      }
    }
    load();
    const timer = setInterval(load, 20000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [user.id, location.pathname]);

  useEffect(() => {
    api('/attendance/today').then((data) => setToday(data.record)).catch(() => {});
  }, [user.id]);

  async function punch(path) {
    setClockBusy(true);
    try {
      const data = await api(path, { method: 'POST' });
      setToday(data.record);
      toast(path.endsWith('check-in') ? 'Checked in' : 'Checked out');
    } catch (error) {
      toast(error.message, 'bad');
    } finally {
      setClockBusy(false);
    }
  }

  useEffect(() => {
    if (!notesOpen && !menuOpen) return undefined;
    const close = (event) => {
      if (panel.current && panel.current.contains(event.target)) return;
      setNotesOpen(false);
      setMenuOpen(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [notesOpen, menuOpen]);

  async function toggleNotes(event) {
    event.stopPropagation();
    const next = !notesOpen;
    setNotesOpen(next);
    setMenuOpen(false);
    if (next && notes.unreadCount) {
      await api('/notifications/read', { method: 'POST', body: { all: true } });
      setNotes((current) => ({
        notifications: current.notifications.map((item) => ({ ...item, read: true })),
        unreadCount: 0,
      }));
    }
  }

  function openNote(note) {
    setNotesOpen(false);
    if (note.area === 'chores') navigate('/chores');
    else if (note.area === 'requests') navigate('/requests');
    else if (note.area === 'repeating') navigate('/repeating');
    else if (note.area === 'knowledge') navigate('/knowledge');
    else if (note.area === 'tenders') navigate('/tenders');
    else if (note.area === 'dependencies') navigate('/dependencies');
    else if (note.area === 'hiring') navigate('/hiring');
    else if (note.taskId) navigate({ pathname: '/', search: `?task=${note.taskId}` });
    else if (note.projectId) navigate(`/projects/${note.projectId}`);
  }

  async function savePassword(event) {
    event.preventDefault();
    if (nextPassword !== confirmPassword) {
      setPasswordError('The new passwords don’t match');
      return;
    }
    setBusy(true);
    setPasswordError('');
    try {
      await api('/me/password', { method: 'POST', body: { currentPassword, nextPassword } });
      setPasswordOpen(false);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      toast('Password updated');
    } catch (error) {
      setPasswordError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="brand-name">Kanabana</span>
        </div>
        <nav className="nav">
          {GROUPS.map((group) => {
            const links = group.links.filter((item) => showLink(item, user));
            if (!links.length) return null;
            return (
              <div key={group.label} className="nav-group">
                <p className="nav-label">{group.label}</p>
                {links.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {item.label}
                    {notes.areas?.[item.area] ? <span className="nav-dot" aria-label="New" /> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <p className="sidebar-foot">Mon–Sat · Sunday off</p>
      </aside>
      <div className="main">
        <header className="topbar">
          <p className="where">{user.departments.map((item) => item.name).join(' · ') || 'Office'}</p>
          <div className="top-actions" ref={panel}>
            <div className="day-clock">
              {isSunday(new Date()) ? <span className="pill">Sunday off</span> : (
                <>
                  {today?.checkIn ? <span className="pill">In {formatClock(today.checkIn)}</span> : (
                    <button type="button" className="btn small" disabled={clockBusy} onClick={() => punch('/attendance/check-in')}>Check in</button>
                  )}
                  <OfficeTimer checkIn={today?.checkIn} checkOut={today?.checkOut} />
                  {today?.checkOut ? <span className="pill">Out {formatClock(today.checkOut)}</span> : (
                    <button type="button" className="btn ghost small" disabled={clockBusy || !today?.checkIn} onClick={() => punch('/attendance/check-out')}>Check out</button>
                  )}
                </>
              )}
            </div>
            <div className="pop">
              <button type="button" className="icon-btn" aria-label="Notifications" onClick={toggleNotes}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M6 9a6 6 0 1 1 12 0c0 7 3 7 3 7H3s3 0 3-7" />
                  <path d="M10 20a2 2 0 0 0 4 0" />
                </svg>
                {notes.unreadCount > 0 ? <span className="count">{notes.unreadCount}</span> : null}
              </button>
              {notesOpen ? (
                <div className="popover">
                  {notes.notifications.length === 0 ? <p className="muted pad">No alerts yet.</p> : notes.notifications.map((note) => (
                    <button type="button" key={note.id} className={`note${note.read ? '' : ' unread'}`} onClick={() => openNote(note)}>
                      {note.message}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="pop">
              <button
                type="button"
                className="user-chip"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen((open) => !open);
                  setNotesOpen(false);
                }}
              >
                <Avatar name={user.name} />
                <span>
                  <strong>{user.name}</strong>
                  <small>{roleLabel(user)}</small>
                </span>
              </button>
              {menuOpen ? (
                <div className="popover menu">
                  <p className="muted pad">{user.email}</p>
                  <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); setPasswordOpen(true); }}>Change password</button>
                  <button type="button" className="menu-item" onClick={() => { logout(); navigate('/login'); }}>Log out</button>
                </div>
              ) : null}
            </div>
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
      {passwordOpen ? (
        <Modal title="Change password" onClose={() => setPasswordOpen(false)}>
          <form className="stack" onSubmit={savePassword}>
            <Field label="Current password">
              <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
            </Field>
            <Field label="New password">
              <input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} required minLength={8} />
            </Field>
            <Field label="Confirm new password">
              <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} />
            </Field>
            {passwordError ? <p className="error">{passwordError}</p> : null}
            <div className="form-actions">
              <button type="button" className="btn ghost" onClick={() => setPasswordOpen(false)}>Cancel</button>
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
