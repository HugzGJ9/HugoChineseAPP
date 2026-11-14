// Test helper: an in-memory File System Access folder (FileSystemDirectoryHandle / FileHandle / writable), enough for
// folder.ts: queryPermission, requestPermission, getFileHandle (with `create`), getFile, createWritable with
// write/close/abort. A writable only lands on close, like the browser's swap file. Switches deny the permission or make
// a write throw (e.g. NoModificationAllowedError while Excel has the file open). Not used by the app.

export interface FakeFile {
  bytes: Uint8Array;
  modified: number;
}

export class FakeDir {
  readonly kind = 'directory';
  name: string;
  files = new Map<string, FakeFile>();
  /** What queryPermission answers; requestPermission answers `grant` (and then grants it). */
  permission: PermissionState = 'granted';
  grant: PermissionState = 'granted';
  /** Error name a writable's write() throws (once set, every write throws until it is cleared). */
  failWrite: string | null = null;
  /** Names a writable was opened for, in order. */
  opened: string[] = [];
  /** Names written (closed), in order. */
  written: string[] = [];
  /** Writables aborted. */
  aborted = 0;

  constructor(name = 'OneDrive') {
    this.name = name;
  }

  /** Put a file in the folder (as Excel or OneDrive would), saved at `modified`. */
  put(name: string, bytes: Uint8Array, modified = Date.now()): void {
    this.files.set(name, { bytes: bytes.slice(), modified });
  }

  bytes(name: string): Uint8Array | undefined {
    return this.files.get(name)?.bytes;
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    if (this.grant === 'granted') this.permission = 'granted';
    return this.grant;
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}) {
    if (this.permission !== 'granted') throw new DOMException('no permission', 'NotAllowedError');
    if (!this.files.has(name)) {
      if (!opts.create) throw new DOMException(`${name} not found`, 'NotFoundError');
      this.files.set(name, { bytes: new Uint8Array(0), modified: Date.now() });
    }
    return new FakeFileHandle(this, name);
  }
}

export class FakeFileHandle {
  readonly kind = 'file';
  constructor(
    private dir: FakeDir,
    readonly name: string,
  ) {}

  async getFile(): Promise<File> {
    const f = this.dir.files.get(this.name);
    if (!f) throw new DOMException(`${this.name} not found`, 'NotFoundError');
    return new File([f.bytes.slice()], this.name, { lastModified: f.modified });
  }

  async createWritable() {
    const dir = this.dir;
    const name = this.name;
    dir.opened.push(name);
    const parts: Uint8Array[] = [];
    let done = false;
    return {
      async write(data: Uint8Array | ArrayBuffer) {
        if (done) throw new TypeError('closed');
        if (dir.failWrite) throw new DOMException('cannot write', dir.failWrite);
        parts.push(new Uint8Array(data instanceof ArrayBuffer ? data : data.slice()));
      },
      async close() {
        if (done) throw new TypeError('closed');
        done = true;
        const n = parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        dir.files.set(name, { bytes: out, modified: Date.now() });
        dir.written.push(name);
      },
      async abort() {
        if (done) return;
        done = true;
        dir.aborted++;
      },
    };
  }
}
