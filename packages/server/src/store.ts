import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Snapshot } from "@collab/crdt";
import { Reader, readSnapshot, Writer, writeSnapshot } from "@collab/protocol";

export interface Store {
  load(id: string): Promise<Snapshot | null>;
  save(id: string, snapshot: Snapshot): Promise<void>;
}

export class MemoryStore implements Store {
  private docs = new Map<string, Snapshot>();

  async load(id: string): Promise<Snapshot | null> {
    return this.docs.get(id) ?? null;
  }

  async save(id: string, snapshot: Snapshot): Promise<void> {
    this.docs.set(id, snapshot);
  }
}

/**
 * One file per document holding the same binary snapshot format we send over
 * the wire. Written to a temp name and renamed so a crash mid-write leaves the
 * previous snapshot intact.
 */
export class FileStore implements Store {
  constructor(private readonly dir: string) {}

  async load(id: string): Promise<Snapshot | null> {
    try {
      const bytes = await readFile(this.pathFor(id));
      return readSnapshot(new Reader(new Uint8Array(bytes)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(id: string, snapshot: Snapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const w = new Writer();
    writeSnapshot(w, snapshot);

    const target = this.pathFor(id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, w.finish());
    await rename(temp, target);
  }

  private pathFor(id: string): string {
    return join(this.dir, `${safeName(id)}.doc`);
  }
}

/** Document ids come from the URL, so keep them from wandering the filesystem. */
export function safeName(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
  return cleaned.length > 0 ? cleaned : "untitled";
}
