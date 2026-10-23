import { spawn } from 'node:child_process';
import os from 'node:os';

const SKIP_INTERFACE = /^(lo|docker|br-|veth|tailscale|tun|zt|wg|virbr)/;

function isPrivate(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

export function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (SKIP_INTERFACE.test(name)) continue;
    for (const entry of entries || []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!ipv4 || entry.internal || !isPrivate(entry.address)) continue;
      found.push(entry.address);
    }
  }
  return found;
}

export function publishOfficeName(address) {
  const child = spawn('avahi-publish-address', ['-R', 'kanabana.local', address], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.on('error', () => {
    console.error('This computer could not publish kanabana.local. Other devices can still use the Wi-Fi address above.');
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(text);
  });
  process.on('exit', () => {
    child.kill();
  });
}
