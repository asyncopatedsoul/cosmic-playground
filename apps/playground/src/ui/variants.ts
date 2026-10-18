import * as THREE from "three";
import { library } from "../persist/library";
import { baseOf, parseTemplate, serializeTemplate, templateFileName, templateFrom, TEMPLATE_FORMAT, type ToyTemplate } from "../persist/template";
import { configEntry, registerToy, toyEntry } from "../toys/registry";
import type { Toy } from "../toys/toy";
import type { World } from "../world";
import { announce, toast } from "./announce";

export interface VariantDeps {
  world: World;
  /** The toy shortcuts act on: the open panel's, the aimed one, else the last touched. */
  target: () => Toy | null;
  /** Where Ctrl+V puts a toy: the aim point on the ground, if any. */
  aimPoint: () => THREE.Vector3 | null;
}

/**
 * Toy variants (docs/SAVE-LOAD.md §6): keep a toy as a variant, place one,
 * export and import `.cosmic-toy.json`, copy and paste a toy as template JSON,
 * and offer a world's embedded variants to the chest.
 */
export class Variants {
  /** Ids already offered from a world this session (asked once). */
  private offered = new Set<string>();

  constructor(private d: VariantDeps) {
    addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyK") {
        e.preventDefault();
        const toy = this.d.target();
        if (toy) void this.keep(toy);
        else toast("Touch a toy first, then keep it.");
      }
    });
    // Copy and paste through the clipboard events, so no clipboard permission is needed.
    document.addEventListener("copy", (e) => {
      if (isTyping(e.target) || getSelection()?.toString()) return;
      const toy = this.d.target();
      if (!toy || !e.clipboardData) return;
      e.clipboardData.setData("text/plain", serializeTemplate(this.copyOf(toy), true));
      e.preventDefault();
      toast(`Copied ${this.label(toy)}`, toy.css);
    });
    document.addEventListener("paste", (e) => {
      if (isTyping(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text.includes(TEMPLATE_FORMAT)) return;
      const r = parseTemplate(text);
      if (!r.ok) return;
      e.preventDefault();
      // A variant this player (or this world) knows stays linked; any other copy is just a toy.
      const known = library.has(r.template.id) || this.worldTemplates()[r.template.id] !== undefined;
      this.place(known ? r.template : { ...r.template, tint: null }, this.d.aimPoint() ?? undefined, known);
    });
  }

  /** Save a toy as a new variant (the toy in the world stays as it is, now linked to it). */
  async keep(toy: Toy): Promise<ToyTemplate> {
    const base = baseOf(toy.entryId);
    const t = templateFrom(toy, library.names(), library.forBase(base).length + 1);
    toy.template = t.id;
    await library.put(t);
    toast(`Kept “${t.name}” in the chest`, t.tint ?? toy.css);
    announce(`Kept ${t.name}`);
    return t;
  }

  /** Place a variant: its state applies before the toy's first Pulse. */
  place(t: ToyTemplate, at?: THREE.Vector3, link = true): Toy | null {
    if (t.config && !toyEntry(t.config.id)) registerToy(configEntry(t.config));
    const kind = t.config?.id ?? t.base;
    if (!toyEntry(kind)) {
      toast(`“${t.name}” needs a newer Cosmic Playground.`);
      return null;
    }
    const toy = this.d.world.add(kind, at, undefined, { ...t.state, tint: t.tint });
    if (toy && link) {
      toy.template = t.id;
      // A pasted variant that isn't in the library travels with the world.
      if (!library.has(t.id)) this.d.world.kept.keys.templates = { ...this.worldTemplates(), [t.id]: t };
    }
    return toy;
  }

  rename(t: ToyTemplate, name: string) {
    const clean = name.trim().slice(0, 60);
    if (!clean || clean === t.name) return;
    void library.put({ ...t, name: clean });
  }

  remove(t: ToyTemplate) {
    void library.remove(t.id);
    toast(`Took “${t.name}” out of the chest (worlds that use it keep it)`);
  }

  /** Download a variant as `<name>.cosmic-toy.json`. */
  exportFile(t: ToyTemplate) {
    const blob = new Blob([serializeTemplate(t, true)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = templateFileName(t);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Add a `.cosmic-toy.json` (text) to the library. */
  async importText(text: string): Promise<boolean> {
    const r = parseTemplate(text);
    if (!r.ok) {
      toast(r.error);
      return false;
    }
    const t = r.template;
    if (library.has(t.id)) {
      toast(`“${t.name}” is already in the chest`);
      return true;
    }
    await library.put(t);
    const sealed = !toyEntry(t.config?.id ?? t.base) && !t.config;
    toast(sealed ? `Added “${t.name}”; it needs a newer Cosmic Playground to play.` : `Added “${t.name}” to the chest`, t.tint ?? undefined);
    return true;
  }

  /** Open the file picker for toy files. */
  pick() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.multiple = true;
    input.addEventListener("change", async () => {
      for (const f of input.files ?? []) await this.importText(await f.text());
    });
    input.click();
  }

  /** After a world opens: offer the variants it carries that aren't in the chest yet. */
  offer(templates: Record<string, unknown>) {
    const fresh: ToyTemplate[] = [];
    for (const raw of Object.values(templates)) {
      const r = parseTemplate(raw);
      if (r.ok && !library.has(r.template.id) && !this.offered.has(r.template.id)) fresh.push(r.template);
    }
    if (!fresh.length) return;
    for (const t of fresh) this.offered.add(t.id);
    const box = document.createElement("div");
    box.className = "cst-ask variant-offer";
    box.setAttribute("role", "alertdialog");
    box.innerHTML = `<p></p><div><button data-yes>Add</button><button data-no>Not now</button></div>`;
    box.querySelector("p")!.textContent =
      fresh.length === 1 ? `Add the variant “${fresh[0].name}” in this world to your chest?` : `Add the ${fresh.length} variants in this world to your chest?`;
    document.body.append(box);
    box.addEventListener("click", async (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      box.remove();
      if (b.hasAttribute("data-yes")) {
        for (const t of fresh) await library.put(t);
        toast(fresh.length === 1 ? `Added “${fresh[0].name}”` : `Added ${fresh.length} variants`);
      }
    });
  }

  /** A toy as template JSON: a linked variant keeps its id, name and look; anything else is a fresh copy. */
  private copyOf(toy: Toy): ToyTemplate {
    const linked = this.known(toy.template);
    const fresh = templateFrom(toy, library.names(), 1);
    return linked ? { ...linked, state: fresh.state } : { ...fresh, tint: null, badge: null };
  }

  /** A variant by id, from the library or the open world. */
  private known(id: string | null): ToyTemplate | undefined {
    if (!id) return undefined;
    const r = library.get(id) ? null : parseTemplate(this.worldTemplates()[id]);
    return library.get(id) ?? (r?.ok ? r.template : undefined);
  }

  private label(toy: Toy) {
    return this.known(toy.template)?.name ?? toyEntry(toy.entryId)?.name ?? "the toy";
  }

  private worldTemplates(): Record<string, unknown> {
    return (this.d.world.kept.keys.templates ?? {}) as Record<string, unknown>;
  }
}

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}
