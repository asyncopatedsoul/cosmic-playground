import { MAX_FILE_BYTES, parseDoc, serialize, type ParseResult, type WorldDoc } from "./doc";

/** File names for exports: `<name>.constellation.json`, safe on every OS. */
export function fileName(name: string) {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").trim().slice(0, 60) || "world";
  return `${base}.constellation.json`;
}

/** Download a world as a `.constellation.json` file (SAVE-LOAD.md §5). */
export function exportFile(doc: WorldDoc) {
  const blob = new Blob([serialize(doc, true)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName(doc.name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a dropped or picked file as a world. */
export async function importFile(file: File): Promise<ParseResult> {
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: "That world is too big (over 2 MB)." };
  return parseDoc(await file.text());
}

/** Open the file picker for one world file. Resolves null if the player cancels. */
export function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
