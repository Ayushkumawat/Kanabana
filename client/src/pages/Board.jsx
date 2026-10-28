import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth, useToast } from '../auth';
import Kanban from '../components/Kanban';
import Modal from '../components/Modal';
import Notepad from '../components/Notepad';
import TaskDrawer from '../components/TaskDrawer';
import TaskForm from '../components/TaskForm';
import TrendChart from '../components/TrendChart';
import { canGovernTask, canMoveTask, clashInfo, currentMonday, formatDay, isOverdue, shiftWeek, weekLabel } from '../util';

export default function Board({ scope, personId = '' }) {
  const { user } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const current = currentMonday();
  const [monday, setMonday] = useState(current);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [projects, setProjects] = useState([]);
  const [people, setPeople] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(params.get('task'));
  const [trends, setTrends] = useState(null);
  const [pane, setPane] = useState('work');
  const [showTrends, setShowTrends] = useState(false);

  useEffect(() => {
    setOpenId(params.get('task'));
  }, [params]);

  useEffect(() => {
    api('/projects').then((data) => setProjects(data.projects)).catch(() => {});
    api('/users').then((data) => setPeople(data.users.filter((person) => person.active))).catch(() => {});
    if (scope === 'team') {
      api('/departments').then((data) => setDepartments(data.departments)).catch(() => {});
    }
  }, [scope]);

  useEffect(() => {
    if (scope !== 'team' || departmentId || departments.length === 0) return;
    const mine = departments.find((item) => user.departmentIds.includes(item.id));
    const options = user.isAdmin || user.isManager ? departments : departments.filter((item) => user.departmentIds.includes(item.id));
    setDepartmentId((mine || options[0] || departments[0]).id);
  }, [scope, departmentId, departments, user]);

  useEffect(() => {
    if (scope === 'team' && !departmentId) return undefined;
    if (scope === 'person' && !personId) return undefined;
    let cancel = false;
    setLoading(true);
    setError('');
    const search = new URLSearchParams({ scope, week: monday });
    if (scope === 'team') search.set('departmentId', departmentId);
    if (scope === 'person') search.set('userId', personId);
    api(`/tasks?${search}`)
      .then((data) => {
        if (!cancel) setTasks(data.tasks);
      })
      .catch((err) => {
        if (!cancel) setError(err.message);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [scope, monday, departmentId, personId, tick]);

  useEffect(() => {
    if (!showTrends || scope === 'team') return undefined;
    if (scope === 'person' && !personId) return undefined;
    let cancel = false;
    const userId = scope === 'person' ? personId : user.id;
    api(`/trends?userId=${encodeURIComponent(userId)}`)
      .then((data) => {
        if (!cancel) setTrends(data);
      })
      .catch(() => {
        if (!cancel) setTrends(null);
      });
    return () => {
      cancel = true;
    };
  }, [showTrends, scope, personId, user.id]);

  const teamOptions = user.isAdmin || user.isManager ? departments : departments.filter((item) => user.departmentIds.includes(item.id));
  const department = departments.find((item) => item.id === departmentId);
  const shown = tasks.filter((task) => {
    if (projectFilter === 'personal' && task.projectId) return false;
    if (projectFilter && projectFilter !== 'personal' && task.projectId !== projectFilter) return false;
    if (priorityFilter && task.priority !== priorityFilter) return false;
    if (query) {
      const blob = `${task.title} ${task.description || ''} ${task.projectName || ''} ${task.assigneeName}`.toLowerCase();
      if (!blob.includes(query.trim().toLowerCase())) return false;
    }
    return true;
  });
  const previous = shown.filter((task) => task.fromPreviousWeek);
  const fromNext = shown.filter((task) => task.fromNextWeek);
  const inWeek = shown.filter((task) => !task.spillover && !task.fromPreviousWeek && !task.fromNextWeek);
  const later = shown.filter((task) => task.spillover);
  const openCount = shown.filter((task) => task.status !== 'done' && !task.spillover).length;
  const overdueCount = shown.filter((task) => isOverdue(task)).length;
  const clashes = clashInfo(shown);
  const lastWeek = shiftWeek(current, -7);
  const nextWeek = shiftWeek(current, 7);

  function closeDrawer() {
    setOpenId(null);
    if (params.get('task')) {
      params.delete('task');
      setParams(params, { replace: true });
    }
  }

  async function moveTask(task, status) {
    if (!canMoveTask(user, task, status) || task.status === status) return;
    setTasks((current) => current.map((item) => (item.id === task.id ? { ...item, status } : item)));
    try {
      await api(`/tasks/${task.id}/status`, { method: 'PATCH', body: { status } });
      if (status === 'review' && !canGovernTask(user, task)) toast('Sent to your team lead for review');
      setTick((value) => value + 1);
    } catch (err) {
      setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));
      toast(err.message, 'bad');
    }
  }

  const viewed = people.find((person) => person.id === personId);
  const heading = scope === 'mine' ? 'My board' : scope === 'person' ? `${viewed?.name || 'Person'}’s board` : `${department?.name || 'Team'} board`;
  const wholeTeam = scope !== 'team' || user.isAdmin || user.isManager || user.leadDepartmentIds.includes(departmentId);
  const attention = [
    ...previous.map((task) => ({ task, note: 'Carried over' })),
    ...fromNext.map((task) => ({ task, note: 'Coming up' })),
    ...later.map((task) => ({ task, note: 'Follow-up' })),
  ];

  return (
    <div className="board-page">
      <div className="page-head">
        <div>
          <h1>{heading}</h1>
          <p className="lede">
            {scope === 'team' && !wholeTeam
              ? 'Your own tasks on this team. Your team lead sees everyone’s.'
              : (monday === current ? 'This week, plus anything still open from earlier weeks.' : `Work due ${weekLabel(monday)}, plus anything still open from earlier.`)}
          </p>
        </div>
        {pane === 'work' ? <button type="button" className="btn primary" onClick={() => setCreating(true)}>Add task</button> : null}
      </div>
      {scope === 'mine' ? (
        <div className="segment">
          <button type="button" className={pane === 'work' ? 'on' : ''} onClick={() => setPane('work')}>Tasks</button>
          <button type="button" className={pane === 'notes' ? 'on' : ''} onClick={() => setPane('notes')}>Notepad</button>
        </div>
      ) : null}
      {pane === 'notes' ? <Notepad /> : (
      <>
      <div className="toolbar">
        <button type="button" className="icon-btn" aria-label="Previous week" onClick={() => setMonday(shiftWeek(monday, -7))}>‹</button>
        <div className="segment">
          <button type="button" className={monday === lastWeek ? 'on' : ''} onClick={() => setMonday(lastWeek)}>Last week</button>
          <button type="button" className={monday === current ? 'on' : ''} onClick={() => setMonday(current)}>This week</button>
          <button type="button" className={monday === nextWeek ? 'on' : ''} onClick={() => setMonday(nextWeek)}>Next week</button>
        </div>
        <button type="button" className="icon-btn" aria-label="Next week" onClick={() => setMonday(shiftWeek(monday, 7))}>›</button>
        <strong>{weekLabel(monday)}</strong>
        {scope === 'team' && teamOptions.length > 1 ? (
          <select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}>
            {teamOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        ) : null}
      </div>
      <div className="toolbar">
        <div className="stats">
          <span className="stat">{openCount} open</span>
          <span className="stat">{inWeek.filter((task) => task.status === 'done').length} done</span>
          {overdueCount ? <span className="stat"><em>{overdueCount} overdue</em></span> : null}
          {previous.length ? <span className="stat"><em>{previous.length} carried over</em></span> : null}
          {fromNext.length ? <span className="stat">{fromNext.length} from next weeks</span> : null}
          {clashes.ids.size ? <span className="stat">{clashes.ids.size} clashing</span> : null}
          {later.length ? <span className="stat">{later.length} later</span> : null}
        </div>
        <div className="filters">
          <input type="search" placeholder="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">All work</option>
            <option value="personal">Personal</option>
            {projects.filter((project) => project.canOpen).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}>
            <option value="">All priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      {loading && tasks.length === 0 ? <p className="muted">Loading the week…</p> : null}
      {scope !== 'team' ? (
        <button type="button" className="btn ghost small" onClick={() => setShowTrends((open) => !open)}>
          {showTrends ? 'Hide trends' : 'Show trends'}
        </button>
      ) : null}
      {showTrends && scope !== 'team' && trends ? (
        <div className="insights">
          <TrendChart title="Completed each week" points={trends.weekly} unit="week" />
          <TrendChart title="Completed each month" points={trends.monthly} unit="month" />
        </div>
      ) : null}
      <div className="board-body">
        <Kanban tasks={shown} user={user} onOpen={setOpenId} onMove={moveTask} onAdd={() => setCreating(true)} clashIds={clashes.ids} />
        {attention.length || clashes.ids.size ? (
          <aside className="week-list">
            <h3>Needs a look</h3>
            {clashes.parallel.length > 1 ? clashes.parallel.map((task) => (
              <button type="button" key={task.id} className="week-item" onClick={() => setOpenId(task.id)}>
                <span className="dot clash" />
                <span><strong>{task.title}</strong><small>In progress together</small></span>
              </button>
            )) : null}
            {attention.map(({ task, note }) => (
              <button type="button" key={`${note}-${task.id}`} className="week-item" onClick={() => setOpenId(task.id)}>
                <span className={`dot${note === 'Carried over' ? ' overdue' : ''}`} />
                <span><strong>{task.title}</strong><small>{note} · {formatDay(task.dueDate)}</small></span>
              </button>
            ))}
          </aside>
        ) : null}
      </div>
      </>
      )}
      {creating ? (
        <Modal title="Add task" onClose={() => setCreating(false)} wide>
          <TaskForm
            projects={projects}
            people={people}
            defaultAssigneeId={scope === 'person' ? personId : ''}
            onCancel={() => setCreating(false)}
            onCreated={() => {
              setCreating(false);
              setTick((value) => value + 1);
              toast('Task added');
            }}
          />
        </Modal>
      ) : null}
      {openId ? (
        <TaskDrawer
          taskId={openId}
          people={people}
          projects={projects}
          onClose={closeDrawer}
          onChanged={() => setTick((value) => value + 1)}
          onOpen={setOpenId}
        />
      ) : null}
    </div>
  );
}

