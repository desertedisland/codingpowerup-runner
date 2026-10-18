// The owner's uploaded files for a session, fetched from the control plane into a folder the
// agent may read and never write (the upload guard refuses edits under the attachments root).
import fs from 'fs';
import path from 'path';
import { attachmentsRootPath, isInsidePath } from '../config/paths';
import logger from '../log/logger';

export const attachmentsRoot = (): string => attachmentsRootPath();

export const sessionAttachmentsDir = (sessionId: string): string => path.join(attachmentsRoot(), sessionId);

export const isInsideAttachmentsRoot = (filePath: string): boolean => isInsidePath(attachmentsRoot(), filePath);

// Only a plain file name, never a path, so a name from the server cannot escape the folder
const safeName = (name: string): string | null => {
  const base = path.basename(name);
  return base && base === name && !name.startsWith('.') ? base : null;
};

export interface IAttachmentSource {
  serverUrl: string;
  credential: string;
}

// Download the named files of a session; the folder is returned when at least one is there
export const fetchSessionAttachments = async (source: IAttachmentSource, sessionId: string, names: string[]): Promise<string | undefined> => {

  if (names.length === 0) return undefined;
  const directory = sessionAttachmentsDir(sessionId);
  fs.mkdirSync(directory, { recursive: true });

  let fetched = 0;
  for (const name of names) {
    const base = safeName(name);
    if (!base) { logger.warn(`[attachments] Skipping an attachment with an unsafe name`); continue; }
    const target = path.join(directory, base);
    if (fs.existsSync(target)) { fetched += 1; continue; }
    const response = await fetch(`${source.serverUrl}/runner/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(base)}`, {
      headers: { Authorization: `Bearer ${source.credential}` },
    });
    if (!response.ok) { logger.warn(`[attachments] Could not fetch ${base} for session ${sessionId}: ${response.status}`); continue; }
    fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()), { mode: 0o444 });
    fetched += 1;
  }

  return fetched > 0 ? directory : undefined;

};
