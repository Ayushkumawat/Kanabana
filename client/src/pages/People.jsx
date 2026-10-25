import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import Avatar from '../components/Avatar';
import Board from './Board';

export default function People() {
  const { user } = useAuth();
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/users')
      .then((data) => {
        const wide = user.isAdmin || user.isManager;
        const list = data.users.filter((person) => person.active && (
          wide || (!person.isManager && person.departmentIds.some((id) => user.leadDepartmentIds.includes(id)))
        ));
        setPeople(list);
        setSelected((current) => (list.some((person) => person.id === current) ? current : list[0]?.id || ''));
      })
      .catch((err) => setError(err.message));
  }, [user.isAdmin, user.isManager, user.leadDepartmentIds]);

  if (!user.isAdmin && !user.isLead && !user.isManager) return <Navigate to="/" replace />;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p className="lede">{user.isAdmin || user.isManager ? 'Open anyone’s board and see the week the way they see it.' : 'Open a board for someone on a team you lead.'}</p>
        </div>
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <div className="people-layout">
        <aside className="people-list">
          {people.map((person) => (
            <button
              type="button"
              key={person.id}
              className={person.id === selected ? 'on' : ''}
              onClick={() => setSelected(person.id)}
            >
              <Avatar name={person.name} size={28} />
              <span>
                <strong>{person.name}</strong>
                <small>{person.departments.map((item) => item.name).join(', ')}</small>
              </span>
            </button>
          ))}
        </aside>
        {selected ? <Board key={selected} scope="person" personId={selected} /> : <p className="muted">Choose a person.</p>}
      </div>
    </div>
  );
}
