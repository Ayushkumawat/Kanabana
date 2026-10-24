import nodemailer from 'nodemailer';
import { loadEnv } from './store.js';

let transportCache;

function transport() {
  loadEnv();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  if (!transportCache) {
    transportCache = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user, pass },
    });
  }
  return transportCache;
}

export function mailFrom() {
  loadEnv();
  return String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

export async function sendMail({ to, subject, text, html, ics }) {
  const tx = transport();
  if (!tx) {
    console.error('SMTP is not configured, so the email was not sent.');
    return false;
  }
  const from = mailFrom();
  if (!to || !from) return false;
  const message = {
    from: `Kanabana <${from}>`,
    to,
    subject,
    text,
    html,
  };
  if (ics) {
    message.icalEvent = {
      filename: 'invite.ics',
      method: 'REQUEST',
      content: ics,
    };
  }
  try {
    await tx.sendMail(message);
    return true;
  } catch (error) {
    console.error(`Email failed (${subject}): ${error.message}`);
    return false;
  }
}

export async function checkMail() {
  const tx = transport();
  if (!tx) {
    console.error('Set SMTP_USER and SMTP_PASS to send assignment and meeting emails.');
    return;
  }
  try {
    await tx.verify();
    console.log(`Mail is ready as ${mailFrom()}`);
  } catch (error) {
    console.error(`Mail login failed: ${error.message}`);
  }
}

function taskLines(actorName, task) {
  return [
    `${actorName} assigned you “${task.title}”.`,
    '',
    task.description?.trim() || 'No extra details.',
    '',
    `Due ${task.dueDate || task.due_date}.`,
    '',
    'Open Kanabana to see it on your board.',
  ].join('\n');
}

export async function sendAssignmentEmail(person, actor, task) {
  if (!person?.email || !actor || person.id === actor.id) return false;
  return sendMail({
    to: person.email,
    subject: `New task: ${task.title}`,
    text: taskLines(actor.name, task),
  });
}

export async function sendOverdueEmail(person, task) {
  if (!person?.email) return false;
  const lines = [
    `“${task.title}” was due ${task.due_date} and is still open.`,
    '',
    task.description?.trim() || 'No extra details.',
    '',
    'Open Kanabana to update it.',
  ];
  return sendMail({
    to: person.email,
    subject: `Deadline passed: ${task.title}`,
    text: lines.join('\n'),
  });
}

export async function sendDependencyEmail(person, actor, task, note) {
  if (!person?.email || !actor || person.id === actor.id) return false;
  const lines = [
    `${actor.name} is waiting on you for “${task.title}”.`,
    '',
    note?.trim() || 'No extra details.',
  ];
  if (task.description?.trim()) {
    lines.push('', 'Task details:', task.description.trim());
  }
  if (task.due_date) lines.push('', `Due ${task.due_date}.`);
  lines.push('', 'Open Kanabana to clear it when you are done.');
  return sendMail({
    to: person.email,
    subject: `Help needed: ${task.title}`,
    text: lines.join('\n'),
  });
}
