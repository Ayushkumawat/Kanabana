const TOKEN_KEY = 'kanabana_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

const LOOPBACK_ORIGIN = 'http://127.0.0.1:4050';
const OFFICE_APP = 'http://kanabana.local:5173';

let officeOrigin = '';
let officeReady;

function onOfficeNetwork(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.local')) return true;
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part > 255)) return false;
  if (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // Tailscale addresses are 100.64.0.0/10. The page is already being served from this computer.
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function prepareOffice() {
  if (!officeReady) officeReady = chooseOffice();
  return officeReady;
}

async function chooseOffice() {
  if (onOfficeNetwork(location.hostname)) return;
  if (await thisHostServesApi()) return;
  try {
    const response = await fetch(`${LOOPBACK_ORIGIN}/api/health`, { targetAddressSpace: 'loopback' });
    if (response.ok) {
      officeOrigin = LOOPBACK_ORIGIN;
      return;
    }
  } catch {
    // This browser is not on the computer running npm run dev.
  }
  const path = location.pathname.replace(/^\/Kanabana(?=\/|$)/, '') || '/';
  location.replace(`${OFFICE_APP}${path}${location.search}${location.hash}`);
  await new Promise(() => {});
}

async function thisHostServesApi() {
  try {
    const response = await fetch('/api/health');
    return response.ok;
  } catch {
    return false;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  await prepareOffice();
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  if (officeOrigin) init.targetAddressSpace = 'loopback';
  let response;
  try {
    response = await fetch(`${officeOrigin}/api${path}`, init);
  } catch {
    throw new Error('Cannot reach the office server on this Wi-Fi. Run npm run dev on the hosting computer.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong');
    error.status = response.status;
    throw error;
  }
  return data;
}
