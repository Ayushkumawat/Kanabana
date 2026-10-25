import { useEffect, useRef, useState } from 'react';
import { canMoveTask, COLUMNS, formatDay, isOverdue } from '../util';

export default function Kanban({ tasks, user, onOpen, onMove, onAdd, clashIds }) {
  const [dragId, setDragId] = useState(null);
  const [over, setOver] = useState(null);
  const dragged = useRef(false);

  useEffect(() => {
    const clear = () => setOver(null);
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);

  return (
    <div className="lanes">
      {COLUMNS.map((column) => {
        const cards = tasks
          .filter((task) => task.status === column.id)
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));
        return (
          <section
            key={column.id}
            className={`lane${over === column.id ? ' over' : ''}`}
            onDragOver={(event) => {
              const task = tasks.find((item) => item.id === dragId);
              if (!task || !canMoveTask(user, task, column.id)) return;
              event.preventDefault();
              setOver(column.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = event.dataTransfer.getData('text/plain') || dragId;
              setOver(null);
              const task = tasks.find((item) => item.id === id);
              if (task && canMoveTask(user, task, column.id)) onMove(task, column.id);
            }}
          >
            <header className="lane-head">
              {column.label}
              <span className="lane-tools">
                {column.id === 'upcoming' && onAdd ? (
                  <button type="button" className="lane-add" aria-label="Add task" onClick={onAdd}>+</button>
                ) : null}
                <span>{cards.length}</span>
              </span>
            </header>
            <div className="lane-body">
              {cards.length === 0 ? <p className="empty">Nothing here</p> : null}
              {cards.map((task) => {
                const movable = canMoveTask(user, task);
                return (
                  <article
                    key={task.id}
                    className={`card pri-${task.priority}${isOverdue(task) ? ' overdue' : ''}${clashIds?.has(task.id) ? ' clash' : ''}${task.fromPreviousWeek ? ' carry' : ''}${dragId === task.id ? ' dragging' : ''}`}
                    draggable={movable}
                    role="button"
                    tabIndex={0}
                    onDragStart={(event) => {
                      dragged.current = true;
                      event.dataTransfer.setData('text/plain', task.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDragId(task.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setTimeout(() => {
                        dragged.current = false;
                      }, 80);
                    }}
                    onClick={() => {
                      if (!dragged.current) onOpen(task.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onOpen(task.id);
                    }}
                  >
                    <div className="card-title">{task.title}</div>
                    <p className="card-person">{task.assigneeName}</p>
                    <div className="card-meta">
                      <span className={isOverdue(task) ? 'late' : ''}>{formatDay(task.dueDate)}</span>
                      <span>{task.projectName || 'Personal'}</span>
                      {task.fromPreviousWeek ? <span className="late">Last week</span> : null}
                      {task.fromNextWeek ? <span>Later week</span> : null}
                      {task.waitingOn ? <span className="late">Waiting</span> : null}
                      {task.changeRequests?.includes('edit') ? <span className="ask">Edits requested</span> : null}
                      {task.changeRequests?.includes('remove') ? <span className="late">Delete requested</span> : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
