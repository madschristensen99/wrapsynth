// store.js — crash-safe JSON persistence.
//
// Secrets are written IMMEDIATELY after generation (before any on-chain call
// that depends on them) — if the process dies between provide_lp_key and the
// deposit sweep, the lpSecret is the only thing that can recover the XMR.
// Writes are atomic (tmp + rename) so a crash mid-write can't corrupt the map.

import fs from 'fs';
import path from 'path';

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run / corrupt file — start empty but keep a backup */
      if (fs.existsSync(file)) {
        try {
          fs.copyFileSync(file, file + '.corrupt-' + Date.now());
        } catch {}
      }
    }
  }

  get(id) {
    return this.data[id];
  }

  /** Merge fields into the entry and persist atomically. */
  set(id, fields) {
    this.data[id] = { ...(this.data[id] || {}), ...fields };
    this.flush();
  }

  delete(id) {
    delete this.data[id];
    this.flush();
  }

  flush() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
