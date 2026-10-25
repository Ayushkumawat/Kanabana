import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import {
  CHECKIN_CUTOFF,
  CHECKOUT_CUTOFF,
  clockMinutes,
  currentMonth,
  daysInMonth,
  formatClock,
  formatDay,
  formatHours,
  FULL_DAY_MINUTES,
  isSunday,
  monthLabel,
  shiftMonth,
  workedMinutes,
} from '../util';

function toneIn(value) {
  if (!value) return '';
  return clockMinutes(value) > CHECKIN_CUTOFF ? 'mark-red' : 'mark-green';
}

function toneOut(value) {
  if (!value) return '';
  return clockMinutes(value) < CHECKOUT_CUTOFF ? 'mark-red' : 'mark-green';
}

function sameMonthDay(day, value) {
  return Boolean(value) && day.slice(5) === value.slice(5);
}

function dayTones(checkIn, checkOut) {
  const minutes = workedMinutes(checkIn, checkOut);
  let inTone = toneIn(checkIn);
  let outTone = toneOut(checkOut);
  let hoursTone = '';
  if (minutes == null) return { minutes, inTone, outTone, hoursTone };
  if (minutes > FULL_DAY_MINUTES) {
    if (inTone === 'mark-red') inTone = 'mark-plain';
    if (outTone === 'mark-red') outTone = 'mark-plain';
    hoursTone = 'mark-green';
  } else if (minutes < FULL_DAY_MINUTES) {
    hoursTone = 'mark-red';
  } else {
    hoursTone = 'mark-green';
  }
  return { minutes, inTone, outTone, hoursTone };
}

export default function Attendance() {
  const { user } = useAuth();
  const [month, setMonth] = useState(currentMonth);
  const [userId, setUserId] = useState(user.id);
  const [people, setPeople] = useState([]);
  const [records, setRecords] = useState([]);
  const [dates, setDates] = useState({ birthday: null, workAnniversary: null });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user.isAdmin && !user.isLead && !user.isManager) return undefined;
    api('/users')
      .then((data) => {
        const wide = user.isAdmin || user.isManager;
        const list = data.users.filter((person) => person.active && (
          wide || person.id === user.id || (!person.isManager && person.departmentIds.some((id) => user.leadDepartmentIds.includes(id)))
        ));
        setPeople(list);
      })
      .catch(() => {});
    return undefined;
  }, [user]);

  useEffect(() => {
    let cancel = false;
    setError('');
    api(`/attendance?month=${month}&userId=${encodeURIComponent(userId)}`)
      .then((data) => {
        if (!cancel) {
          setRecords(data.records);
          setDates({ birthday: data.birthday, workAnniversary: data.workAnniversary });
        }
      })
      .catch((err) => {
        if (!cancel) setError(err.message);
      });
    return () => {
      cancel = true;
    };
  }, [month, userId]);

  const byDay = new Map(records.map((record) => [record.day, record]));
  const viewed = people.find((person) => person.id === userId);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Attendance</h1>
          <p className="lede">
            {userId === user.id ? 'Your check-in and check-out for the month.' : `${viewed?.name || 'This person'}’s month.`}
            {dates.birthday ? ` Birthday ${formatDay(dates.birthday)}.` : ''}
            {dates.workAnniversary ? ` Work anniversary ${formatDay(dates.workAnniversary)}.` : ''}
            {' '}Work days are Monday to Saturday. Sunday is off. Check-in before 10:00 is green, and after 10:00 is red. Check-out before 6:30 is red, and after 6:30 is green. A day longer than 8:30 clears the red times and shows the hours in green. A shorter day keeps the times as they are and shows the hours in red.
          </p>
        </div>
      </div>
      <div className="toolbar">
        <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>‹</button>
        <strong>{monthLabel(month)}</strong>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>›</button>
        {people.length > 1 ? (
          <select value={userId} onChange={(event) => setUserId(event.target.value)}>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        ) : null}
      </div>
      {error ? <p className="banner">{error}</p> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Check in</th>
              <th>Check out</th>
              <th>Hours</th>
              <th>Birthday</th>
              <th>Work anniversary</th>
            </tr>
          </thead>
          <tbody>
            {daysInMonth(month).map((day) => {
              const record = byDay.get(day);
              const off = isSunday(day);
              const tones = off ? { minutes: null, inTone: '', outTone: '', hoursTone: '' } : dayTones(record?.checkIn, record?.checkOut);
              return (
                <tr key={day} className={off ? 'off' : ''}>
                  <td>{formatDay(day)}</td>
                  <td className={tones.inTone}>{off ? 'Off' : record?.checkIn ? formatClock(record.checkIn) : '—'}</td>
                  <td className={tones.outTone}>{off ? 'Off' : record?.checkOut ? formatClock(record.checkOut) : '—'}</td>
                  <td className={tones.hoursTone}>{off ? 'Off' : formatHours(tones.minutes)}</td>
                  <td>{sameMonthDay(day, dates.birthday) ? 'Birthday' : ''}</td>
                  <td>{sameMonthDay(day, dates.workAnniversary) ? 'Anniversary' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
