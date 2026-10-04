import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Journal of runs. It holds identifiers and bookkeeping only: never
 * credentials, the test code, message text, or screenshots.
 *
 * Each record carries the `engine` that ran its browser. Records without one
 * were written by the earlier version that used an OpenAI-hosted browser.
 */

function latestOpen(records, ownerHash) {
  return (
    [...records.values()]
      .filter((record) => record.ownerHash === ownerHash && record.sessionId && !record.endedAt)
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

export class Journal {
  #file;
  #records = new Map();

  constructor(dataDir) {
    this.#file = path.join(dataDir, 'runs.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(readFileSync(this.#file, 'utf8'));
      for (const record of saved.runs ?? []) this.#records.set(record.id, record);
    } catch {
      // No journal yet, or unreadable: start empty.
    }
  }

  save(record) {
    this.#records.set(record.id, record);
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ runs: [...this.#records.values()] }, null, 2), {
      mode: 0o600,
    });
    renameSync(temp, this.#file);
  }

  get(id) {
    return this.#records.get(id) ?? null;
  }

  /** The owner's most recent run that has a session and has not ended. */
  findOpen(ownerHash) {
    return latestOpen(this.#records, ownerHash);
  }
}

/** Journal that keeps nothing on disk, for tests. */
export class MemoryJournal {
  records = new Map();

  save(record) {
    this.records.set(record.id, structuredClone(record));
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  findOpen(ownerHash) {
    return latestOpen(this.records, ownerHash);
  }
}
