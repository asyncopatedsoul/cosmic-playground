import type { WorldDoc } from "./doc";

/** A saved world in a list: enough to draw the recent list without loading it. */
export interface WorldMeta {
  id: string;
  name: string;
  modified: string;
  toys: number;
  thumbnail?: string;
}

/**
 * Where worlds live (docs/SAVE-LOAD.md §5, REVISIONS.md R3.2). Every adapter
 * (IndexedDB now; files, rooms and Cosmic Cloud later) stores the same WorldDoc.
 */
export interface WorldStore {
  list(): Promise<WorldMeta[]>;
  get(id: string): Promise<WorldDoc | null>;
  put(id: string, doc: WorldDoc): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The store key of the rolling autosave. */
export const AUTOSAVE = "autosave";

interface Row {
  id: string;
  name: string;
  modified: string;
  toys: number;
  thumbnail?: string;
  doc: WorldDoc;
}

/** IndexedDB `worlds/<id>`: the autosave and named saves, one row per world. */
export class IdbStore implements WorldStore {
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction("worlds", mode).objectStore("worlds"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async list(): Promise<WorldMeta[]> {
    const rows = await this.tx<Row[]>("readonly", (s) => s.getAll());
    return rows
      .filter((r) => r.id !== AUTOSAVE)
      .map(({ id, name, modified, toys, thumbnail }) => ({ id, name, modified, toys, thumbnail }))
      .sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async get(id: string): Promise<WorldDoc | null> {
    const row = await this.tx<Row | undefined>("readonly", (s) => s.get(id));
    return row?.doc ?? null;
  }

  async put(id: string, doc: WorldDoc): Promise<void> {
    const row: Row = { id, name: doc.name, modified: doc.modified, toys: doc.toys.length, thumbnail: doc.thumbnail, doc };
    await this.tx("readwrite", (s) => s.put(row));
  }

  async remove(id: string): Promise<void> {
    await this.tx("readwrite", (s) => s.delete(id));
  }
}

let db: Promise<IDBDatabase> | null = null;

/** The app's IndexedDB database: `worlds/<id>` and `templates/<id>` (variants, SAVE-LOAD.md §6.4). */
export function openDb(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("cosmic-playground", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("worlds")) d.createObjectStore("worlds", { keyPath: "id" });
      if (!d.objectStoreNames.contains("templates")) d.createObjectStore("templates", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("storage is busy in another tab"));
  });
  db.catch(() => (db = null));
  return db;
}

/** Ask the browser not to evict saves under storage pressure (once, after the first named save). */
export function persistStorage() {
  void navigator.storage?.persist?.().catch(() => {});
}
