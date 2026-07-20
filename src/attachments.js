import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.resolve(__dirname, '../uploads');
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXT = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.txt',
]);
export function ensureUploadsDir() {
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
}
function safeFileName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
}
export function saveAttachmentData(txId, fileName, dataUrl) {
    ensureUploadsDir();
    const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
    if (!match) {
        throw new Error('Invalid attachment data');
    }
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) {
        throw new Error('Empty attachment');
    }
    if (buffer.length > MAX_BYTES) {
        throw new Error('Attachment too large (max 5 MB)');
    }
    const original = safeFileName(fileName);
    const ext = path.extname(original).toLowerCase();
    if (ext && !ALLOWED_EXT.has(ext)) {
        throw new Error('Unsupported attachment type');
    }
    const stored = `${txId}-${original}`;
    const fullPath = path.join(UPLOADS_DIR, stored);
    fs.writeFileSync(fullPath, buffer);
    return {
        attachmentName: original,
        attachmentPath: `/uploads/${stored}`,
    };
}
export function deleteAttachmentFile(attachmentPath) {
    if (!attachmentPath)
        return;
    const base = path.basename(attachmentPath);
    if (!base || base.includes('..'))
        return;
    const full = path.join(UPLOADS_DIR, base);
    if (fs.existsSync(full)) {
        try {
            fs.unlinkSync(full);
        }
        catch {
            // ignore
        }
    }
}
