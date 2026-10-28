import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AUTO_NOTE } from './mail.js';
import { loadEnv } from './store.js';

const tokenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'google-calendar.json');
const pending = new Map();
let cached = null;

function readTokenFile() {
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeEnv(key, value) {
  const envPath = path.resolve(path.dirname(tokenPath), '../../.env');
  if (!fs.existsSync(envPath)) return;
  const line = `${key}=${JSON.stringify(value)}`;
  let env = fs.readFileSync(envPath, 'utf8');
  if (new RegExp(`^${key}=`, 'm').test(env)) env = env.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  else env += (env.endsWith('\n') ? '' : '\n') + `${line}\n`;
  fs.writeFileSync(envPath, env);
}

function fail(message) {
  const error = new Error(message);
  error.status = 502;
  return error;
}

function credentials() {
  loadEnv();
  const file = readTokenFile();
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || file.clientId || '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || file.clientSecret || '').trim(),
    refreshToken: String(process.env.GOOGLE_REFRESH_TOKEN || file.refreshToken || '').trim(),
  };
}

export function googleConnected() {
  const { clientId, clientSecret, refreshToken } = credentials();
  return Boolean(clientId && clientSecret && refreshToken);
}

let readyUntil = 0;
let readyValue = false;

export async function googleReady() {
  if (Date.now() < readyUntil) return readyValue;
  if (!googleConnected()) {
    readyValue = false;
    readyUntil = Date.now() + 30 * 1000;
    return false;
  }
  try {
    await accessToken();
    readyValue = true;
    readyUntil = Date.now() + 10 * 60 * 1000;
  } catch (error) {
    console.error(error.message);
    readyValue = false;
    readyUntil = Date.now() + 30 * 1000;
  }
  return readyValue;
}

export function googleAuthUrl() {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    throw fail('Google Calendar is not configured on the server.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, Date.now());
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', 'http://127.0.0.1:4050/api/google/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function finishGoogleAuth(code, state) {
  const started = pending.get(state);
  pending.delete(state);
  if (!started || Date.now() - started > 15 * 60 * 1000) {
    throw fail('That Google sign-in expired. Try connecting again.');
  }
  const { clientId, clientSecret } = credentials();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: 'http://127.0.0.1:4050/api/google/callback',
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw fail('Google Calendar did not stay connected. Try again and allow calendar access.');
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify({ clientId, clientSecret, refreshToken: data.refresh_token }));
  writeEnv('GOOGLE_REFRESH_TOKEN', data.refresh_token);
  process.env.GOOGLE_REFRESH_TOKEN = data.refresh_token;
  cached = null;
  readyUntil = 0;
}

async function accessToken() {
  const { clientId, clientSecret, refreshToken } = credentials();
  if (!clientId || !clientSecret || !refreshToken) {
    throw fail('Google Calendar is not connected, so a Meet link could not be created.');
  }
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw fail('Google Calendar could not be reached. The office connection needs to be signed in again.');
  }
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
  };
  return cached.token;
}

function meetUrlFrom(event) {
  return event.hangoutLink
    || event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')?.uri
    || '';
}

async function insertEvent(meeting, attendees, sendUpdates) {
  const token = await accessToken();
  const body = {
    summary: meeting.title,
    description: `${meeting.agenda}\n\n${AUTO_NOTE}`,
    start: { dateTime: `${meeting.day}T${meeting.start_time}:00`, timeZone: 'Asia/Kolkata' },
    end: { dateTime: `${meeting.day}T${meeting.end_time}:00`, timeZone: 'Asia/Kolkata' },
    conferenceData: {
      createRequest: {
        requestId: `${meeting.id}-${sendUpdates}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };
  if (attendees.length) body.attendees = attendees;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=${sendUpdates}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error?.message || '';
    if (/has not been used|is disabled|accessNotConfigured/i.test(message)) {
      throw fail('Google Calendar is turned off for the office account.');
    }
    throw fail('Google Meet could not be created.');
  }
  const meetUrl = meetUrlFrom(data);
  if (!/^https:\/\/meet\.google\.com\//.test(meetUrl)) {
    if (data.id) await deleteGoogleEvent(data.id);
    throw fail('Google Calendar did not return a Meet link.');
  }
  return { meetUrl, eventId: data.id || '', invited: sendUpdates === 'all' };
}

export async function createGoogleMeet(meeting, attendees = []) {
  if (!googleConnected()) return { meetUrl: '', eventId: '', invited: false };
  const people = attendees
    .filter((person) => person?.email)
    .map((person) => ({ email: person.email, optional: Boolean(person.optional) }));
  try {
    if (people.length) {
      try {
        return await insertEvent(meeting, people, 'all');
      } catch (error) {
        if (error.message !== 'Google Meet could not be created.') throw error;
        console.error('Google could not invite the attendees directly, so the office email will send the invitation.');
      }
    }
    return await insertEvent(meeting, [], 'none');
  } catch (error) {
    console.error(error.message);
    return { meetUrl: '', eventId: '', invited: false };
  }
}

export async function deleteGoogleEvent(eventId) {
  if (!eventId) return;
  const token = await accessToken();
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}
