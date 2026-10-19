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

export async function downloadFile(stored, name) {
  const token = getToken();
  const response = await fetch(`/api/files/${encodeURIComponent(stored)}`, {
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
