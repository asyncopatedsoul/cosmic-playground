import { openDb } from "./store";
import { parseTemplate, type ToyTemplate } from "./template";

/**
 * The player's variants (SAVE-LOAD.md §6.4): IndexedDB `templates/<id>`,
 * mirrored in memory so the chest and saves can read them synchronously.
 */
export class TemplateLibrary {
  private all = new Map<string, ToyTemplate>();
  /** Called after any change (the chest redraws, the autosave checks). */
  readonly listeners: (() => void)[] = [];

  async load() {
    try {
      const db = await openDb();
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction("templates", "readonly").objectStore("templates").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const row of rows) {
        const r = parseTemplate(row);
        if (r.ok) this.all.set(r.template.id, r.template);
      }
    } catch (e) {
      console.warn("variants: couldn't read the library", e);
    }
    this.changed();
  }

  get(id: string | null | undefined): ToyTemplate | undefined {
    return id ? this.all.get(id) : undefined;
  }

  has(id: string) {
    return this.all.has(id);
  }

  /** The variants of one toy type, oldest first. */
  forBase(base: string): ToyTemplate[] {
    return [...this.all.values()].filter((t) => t.base === base).sort((a, b) => a.created.localeCompare(b.created));
  }

  names(): string[] {
    return [...this.all.values()].map((t) => t.name);
  }

  async put(t: ToyTemplate) {
    this.all.set(t.id, t);
    this.changed();
    await this.write("readwrite", (s) => s.put(structuredClone(t)));
  }

  async remove(id: string) {
    this.all.delete(id);
    this.changed();
    await this.write("readwrite", (s) => s.delete(id));
  }

  private async write(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const req = fn(db.transaction("templates", mode).objectStore("templates"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn("variants: couldn't save", e);
    }
  }

  private changed() {
    for (const l of this.listeners) l();
  }
}

/** The one library; saves read it to embed the variants a world uses. */
export const library = new TemplateLibrary();
