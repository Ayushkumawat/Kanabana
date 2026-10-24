import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnv } from './store.js';

const uploadDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'uploads');
const FOLDERS = new Set(['resumes', 'knowledge', 'reports']);
const LEGACY = ['resumes', 'knowledge', 'reports', 'files'];

let client;
let clientRegion = '';

function settings() {
  loadEnv();
  return {
    bucket: process.env.S3_BUCKET || 'kanabana',
    region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
  };
}

function s3() {
  const { region } = settings();
  if (!client || clientRegion !== region) {
    client = new S3Client({ region });
    clientRegion = region;
  }
  return client;
}

export function safeKey(raw) {
  let key = String(raw || '').replace(/^\/+/, '');
  try {
    key = decodeURIComponent(key);
  } catch {
    return '';
  }
  if (!key || key.includes('..') || key.includes('\\') || key.includes('\0')) return '';
  if (/^(resumes|knowledge|reports|files)\/file_[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(key)) return key;
  if (/^file_[A-Za-z0-9-]+\.[A-Za-z0-9]+$/.test(key)) return key;
  return '';
}

function candidates(key) {
  if (key.includes('/')) return [key];
  return [...LEGACY.map((folder) => `${folder}/${key}`), key];
}

function missing(error) {
  const status = error?.$metadata?.httpStatusCode;
  return status === 404 || error?.name === 'NoSuchKey' || error?.name === 'NotFound';
}

export async function putStored(folder, filename, body, contentType) {
  if (!FOLDERS.has(folder)) {
    const error = new Error('Unknown file folder');
    error.status = 500;
    throw error;
  }
  const key = `${folder}/${filename}`;
  const { bucket } = settings();
  try {
    await s3().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }));
  } catch (error) {
    console.error(`Could not store ${key}: ${error.name || 'error'}`);
    const failure = new Error('The file could not be saved. Try again in a moment.');
    failure.status = 502;
    throw failure;
  }
  return key;
}

async function localFile(key) {
  const name = path.basename(key);
  if (!name || name !== key && !key.endsWith(`/${name}`)) return null;
  const full = path.join(uploadDir, name);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

export async function readStored(raw) {
  const key = safeKey(raw);
  if (!key) return null;
  const { bucket } = settings();
  for (const candidate of candidates(key)) {
    try {
      const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: candidate }));
      const bytes = Buffer.from(await res.Body.transformToByteArray());
      return { key: candidate, bytes, contentType: res.ContentType || 'application/octet-stream' };
    } catch (error) {
      if (missing(error)) continue;
      console.error(`Could not read ${candidate}: ${error.name || 'error'}`);
      const failure = new Error('The file could not be opened. Try again in a moment.');
      failure.status = 502;
      throw failure;
    }
  }
  const bytes = await localFile(key);
  if (!bytes) return null;
  const stored = key.includes('/') ? key : `files/${path.basename(key)}`;
  try {
    await s3().send(new PutObjectCommand({
      Bucket: bucket,
      Key: stored,
      Body: bytes,
      ContentType: 'application/octet-stream',
    }));
  } catch (error) {
    console.error(`Could not keep a local file: ${error.name || 'error'}`);
  }
  return { key: stored, bytes, contentType: 'application/octet-stream' };
}

export async function existsStored(raw) {
  const key = safeKey(raw);
  if (!key) return '';
  const { bucket } = settings();
  for (const candidate of candidates(key)) {
    try {
      await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: candidate }));
      return candidate;
    } catch (error) {
      if (missing(error)) continue;
      console.error(`Could not find ${candidate}: ${error.name || 'error'}`);
      const failure = new Error('The file could not be opened. Try again in a moment.');
      failure.status = 502;
      throw failure;
    }
  }
  const bytes = await localFile(key);
  return bytes ? key : '';
}

export async function deleteStored(raw) {
  const key = safeKey(raw);
  if (!key || !key.includes('/')) return;
  const { bucket } = settings();
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
