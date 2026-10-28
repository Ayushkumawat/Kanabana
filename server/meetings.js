import { AUTO_NOTE, mailFrom, sendMail } from './mail.js';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTime(value) {
  return typeof value === 'string' && TIME.test(value);
}

// The office clock is India Standard Time, which does not use daylight saving.
export function officeInstant(day, time) {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, date, hour - 5, minute - 30));
}

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function icsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\n|\r/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function inviteHtml({ meeting, when, names, meetUrl }) {
  const link = meetUrl
    ? `<p><a href="${escapeHtml(meetUrl)}">Join Google Meet</a><br>${escapeHtml(meetUrl)}</p>`
    : '';
  return [
    `<p>${escapeHtml(meeting.organizer_name)} scheduled “${escapeHtml(meeting.title)}”.</p>`,
    link,
    `<p>${escapeHtml(when)}</p>`,
    `<p>${escapeHtml(meeting.agenda).replace(/\n/g, '<br>')}</p>`,
    `<p>With ${escapeHtml(names)}.</p>`,
    '<p>Accept the calendar invitation in this email to add it to your calendar.</p>',
  ].join('');
}

function fold(line) {
  const parts = [];
  let rest = line;
  while (rest.length > 73) {
    parts.push(rest.slice(0, 73));
    rest = ` ${rest.slice(73)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

export function buildInvite({ meeting, attendees }) {
  const from = mailFrom();
  const start = officeInstant(meeting.day, meeting.start_time);
  const end = officeInstant(meeting.day, meeting.end_time);
  const meetUrl = meeting.meet_url || '';
  const description = [meeting.agenda, meetUrl ? `Join Google Meet: ${meetUrl}` : '', AUTO_NOTE].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Kanabana//Meetings//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${meeting.id}@aiunika.com`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    fold(`SUMMARY:${icsText(meeting.title)}`),
    fold(`DESCRIPTION:${icsText(description)}`),
  ];
  if (meetUrl) {
    lines.push(
      fold(`LOCATION:${icsText(meetUrl)}`),
      fold(`URL:${meetUrl}`),
      fold(`X-GOOGLE-CONFERENCE:${meetUrl}`),
    );
  }
  lines.push(`ORGANIZER;CN=Kanabana:mailto:${from}`);
  for (const person of attendees) {
    if (!person.email) continue;
    lines.push(fold(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${icsText(person.name)}:mailto:${person.email}`));
  }
  lines.push('STATUS:CONFIRMED', 'SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

export async function sendInvites(meeting, attendees) {
  const ics = buildInvite({ meeting, attendees });
  const when = `${meeting.day} ${meeting.start_time}–${meeting.end_time} IST`;
  const names = attendees.map((person) => person.name).join(', ');
  let sent = 0;
  const failed = [];
  for (const person of attendees) {
    if (!person.email) {
      failed.push(person.name);
      continue;
    }
    const meetUrl = meeting.meet_url || '';
    const text = [
      `${meeting.organizer_name} scheduled “${meeting.title}”.`,
      meetUrl ? `Google Meet: ${meetUrl}` : '',
      when,
      meeting.agenda,
      `With ${names}.`,
      'Accept the calendar invitation in this email to add it to your calendar.',
    ].filter(Boolean).join('\n\n');
    const ok = await sendMail({
      to: person.email,
      subject: `Meeting: ${meeting.title}`,
      text,
      html: inviteHtml({ meeting, when, names, meetUrl }),
      ics,
    });
    if (ok) sent += 1;
    else failed.push(person.name);
  }
  return { sent, failed };
}
