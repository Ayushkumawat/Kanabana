import { getToken } from './api';

export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const data = text.includes(',') ? text.slice(text.indexOf(',') + 1) : '';
      resolve({ name: file.name, data });
    };
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

function filePath(stored) {
  return String(stored || '').split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
}

const PREVIEW_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export async function previewFileUrl(stored, name) {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const ext = String(name || stored).split('.').pop().toLowerCase();
  const type = PREVIEW_TYPES[ext];
  if (!type) return { url: '', kind: '' };
  if (ext === 'pdf') {
    const ticketResponse = await fetch(`/api/files/${filePath(stored)}/ticket`, { method: 'POST', headers });
    if (ticketResponse.status === 404) throw new Error('That file is no longer available.');
    if (!ticketResponse.ok) throw new Error('Could not open that file');
    const data = await ticketResponse.json();
    const url = `/api/files/${filePath(stored)}?ticket=${encodeURIComponent(data.ticket)}&inline=1`;
    return { url, kind: 'pdf' };
  }
  const response = await fetch(`/api/files/${filePath(stored)}`, { headers });
  if (response.status === 404) throw new Error('That file is no longer available.');
  if (!response.ok) throw new Error('Could not open that file');
  const blob = new Blob([await response.arrayBuffer()], { type });
  return { url: URL.createObjectURL(blob), kind: 'image' };
}

export async function fileObjectUrl(stored) {
  const token = getToken();
  const response = await fetch(`/api/files/${filePath(stored)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('Could not open that file');
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export async function downloadFile(stored, name) {
  const token = getToken();
  const response = await fetch(`/api/files/${filePath(stored)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error('Could not open that file');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name || stored;
  link.click();
  URL.revokeObjectURL(url);
}
