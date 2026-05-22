import * as vscode from 'vscode';

export interface PinExItem {
  uri: vscode.Uri;
  isDirectory: boolean;
  // 用于“按最近打开/编辑排序”
  pinnedAt: number;
  lastUsedAt: number;
}

export class PinExManager {
  private static readonly STORAGE_KEY = 'cursorToolWindow.pinEx';

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private items: PinExItem[] = [];
  private touchSaveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = context.workspaceState.get<any[]>(PinExManager.STORAGE_KEY, []);
    if (Array.isArray(saved)) {
      for (const item of saved) {
        if (typeof item === 'string' && item) {
          // 旧格式：仅 uri 字符串
          this.items.push({
            uri: vscode.Uri.parse(item),
            isDirectory: false,
            pinnedAt: 0,
            lastUsedAt: 0
          });
        } else if (item && typeof (item as any).uri === 'string') {
          const pinnedAt = typeof (item as any).pinnedAt === 'number' ? (item as any).pinnedAt : 0;
          const lastUsedAt = typeof (item as any).lastUsedAt === 'number'
            ? (item as any).lastUsedAt
            : (typeof (item as any).lastOpenedAt === 'number' ? (item as any).lastOpenedAt : 0);
          this.items.push({
            uri: vscode.Uri.parse((item as any).uri),
            isDirectory: !!(item as any).isDirectory,
            pinnedAt: pinnedAt,
            lastUsedAt: lastUsedAt
          });
        }
      }
    }
  }

  getItems(): PinExItem[] {
    return this.items.slice();
  }

  getItemsSortedByRecent(): PinExItem[] {
    const copy = this.items.slice();
    // 最近使用（聚焦/编辑）优先，其次按 pinnedAt
    copy.sort((a, b) => {
      const la = typeof a.lastUsedAt === 'number' ? a.lastUsedAt : 0;
      const lb = typeof b.lastUsedAt === 'number' ? b.lastUsedAt : 0;
      if (la !== lb) {
        return lb - la;
      }
      const pa = typeof a.pinnedAt === 'number' ? a.pinnedAt : 0;
      const pb = typeof b.pinnedAt === 'number' ? b.pinnedAt : 0;
      if (pa !== pb) {
        return pb - pa;
      }
      return a.uri.toString().localeCompare(b.uri.toString());
    });
    return copy;
  }

  isPinned(uri: vscode.Uri): boolean {
    const key = uri.toString();
    return this.items.some(i => i.uri.toString() === key);
  }

  touch(uri: vscode.Uri | undefined): void {
    if (!uri) {
      return;
    }
    const key = uri.toString();
    const idx = this.items.findIndex(i => i.uri.toString() === key);
    if (idx < 0) {
      return;
    }
    this.items[idx].lastUsedAt = Date.now();
    this.saveDebounced();
  }

  async togglePin(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const idx = this.items.findIndex(i => i.uri.toString() === key);
    if (idx >= 0) {
      this.items.splice(idx, 1);
    } else {
      let isDirectory = false;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          isDirectory = true;
        }
      } catch {
        // ignore
      }
      const now = Date.now();
      this.items.push({ uri, isDirectory, pinnedAt: now, lastUsedAt: now });
    }
    this.save();
  }

  remove(uri: vscode.Uri): void {
    const key = uri.toString();
    const before = this.items.length;
    this.items = this.items.filter(i => i.uri.toString() !== key);
    if (this.items.length !== before) {
      this.save();
    }
  }

  clearAll(): void {
    if (!this.items.length) {
      return;
    }
    this.items = [];
    this.save();
  }

  private save(): void {
    const raw = this.items.map(i => ({
      uri: i.uri.toString(),
      isDirectory: i.isDirectory,
      pinnedAt: i.pinnedAt,
      lastUsedAt: i.lastUsedAt
    }));
    this.context.workspaceState.update(PinExManager.STORAGE_KEY, raw);
    this._onDidChange.fire();
  }

  private saveDebounced(): void {
    if (this.touchSaveTimer) {
      clearTimeout(this.touchSaveTimer);
      this.touchSaveTimer = null;
    }
    this.touchSaveTimer = setTimeout(() => {
      this.touchSaveTimer = null;
      this.save();
    }, 150);
  }

  handleRename(event: vscode.FileRenameEvent): void {
    if (!event || !Array.isArray(event.files) || !event.files.length) {
      return;
    }
    let changed = false;
    const updated: PinExItem[] = [];
    for (const item of this.items) {
      let current: PinExItem = item;
      const currentStr = item.uri.toString();
      for (const f of event.files) {
        const oldStr = f.oldUri.toString();
        const newStr = f.newUri.toString();
        if (currentStr === oldStr || currentStr.indexOf(oldStr + '/') === 0) {
          const rest = currentStr.substring(oldStr.length);
          current = {
            uri: vscode.Uri.parse(newStr + rest),
            isDirectory: item.isDirectory,
            pinnedAt: item.pinnedAt,
            lastUsedAt: item.lastUsedAt
          };
          changed = true;
          break;
        }
      }
      updated.push(current);
    }
    if (changed) {
      this.items = updated;
      this.save();
    }
  }

  handleDelete(event: vscode.FileDeleteEvent): void {
    if (!event || !Array.isArray(event.files) || !event.files.length) {
      return;
    }
    const deleted = event.files.map(f => f.toString());
    let changed = false;
    this.items = this.items.filter(it => {
      const s = it.uri.toString();
      for (const d of deleted) {
        if (s === d || s.indexOf(d + '/') === 0) {
          changed = true;
          return false;
        }
      }
      return true;
    });
    if (changed) {
      this.save();
    }
  }
}

