import * as path from 'path';
import * as vscode from 'vscode';

export interface CodeTodoItem {
  uri: vscode.Uri;
  line: number;
  text: string;
}

interface PersistedTodoItem {
  uri: string;
  line: number;
  text: string;
}

interface PersistedTodoFileEntry {
  uri: string;
  mtime: number;
  size: number;
  todos: PersistedTodoItem[];
}

interface PersistedTodoCache {
  version: number;
  workspaceKey: string;
  savedAt: number;
  files: PersistedTodoFileEntry[];
}

const TODO_CACHE_VERSION = 1;
const DEFAULT_TODO_EXTENSIONS = ['cs', 'csx', 'js', 'jsx', 'ts', 'tsx', 'cpp', 'c', 'h', 'hpp', 'java', 'go'];
const DEFAULT_TODO_EXCLUDES = ['**/node_modules/**', '**/bin/**', '**/obj/**'];

function toStorageSafeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '_');
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export class TodoScanner implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onScanningChange = new vscode.EventEmitter<boolean>();
  readonly onScanningChange = this._onScanningChange.event;

  private todos: CodeTodoItem[] = [];
  private readonly todoFiles = new Map<string, PersistedTodoFileEntry>();
  private readonly pendingUris = new Set<string>();
  private readonly cacheFileUri: vscode.Uri;
  private isScanning = false;
  private debounceTimer: NodeJS.Timeout | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  getIsScanning(): boolean {
    return this.isScanning;
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.cacheFileUri = vscode.Uri.joinPath(
      context.globalStorageUri,
      'todo-cache',
      `${this.getWorkspaceCacheKey()}.json`
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    context.subscriptions.push(
      this,
      watcher,
      vscode.workspace.onDidSaveTextDocument(doc => this.queueDocumentRefresh(doc.uri)),
      vscode.workspace.onDidChangeTextDocument(e => this.queueDocumentRefresh(e.document.uri)),
      vscode.workspace.onDidCloseTextDocument(doc => this.queueDocumentRefresh(doc.uri)),
      vscode.workspace.onDidDeleteFiles(e => e.files.forEach(uri => this.removeDocumentTodos(uri, true))),
      vscode.workspace.onDidRenameFiles(e => this.handleRenameFiles(e)),
      watcher.onDidChange(uri => this.queueDocumentRefresh(uri)),
      watcher.onDidCreate(uri => this.queueDocumentRefresh(uri)),
      watcher.onDidDelete(uri => this.removeDocumentTodos(uri, true)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('cursorToolWindow.todo')) {
          this.rebuildFromScratch();
        }
      })
    );

    void this.initialize();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this._onDidChange.dispose();
    this._onScanningChange.dispose();
  }

  getTodos(): CodeTodoItem[] {
    return this.todos.slice();
  }

  async refreshNow(): Promise<void> {
    await this.rebuildFromScratch();
  }

  private async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.context.globalStorageUri, 'todo-cache'));
    await this.loadCache();
    this.emitTodosChanged();
    void this.scanWorkspace();
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.cacheFileUri);
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(raw)) as PersistedTodoCache;
      if (!parsed || parsed.version !== TODO_CACHE_VERSION || parsed.workspaceKey !== this.getWorkspaceCacheKey()) {
        return;
      }
      this.todoFiles.clear();
      for (const file of Array.isArray(parsed.files) ? parsed.files : []) {
        if (!file || typeof file.uri !== 'string' || !Array.isArray(file.todos)) {
          continue;
        }
        this.todoFiles.set(file.uri, {
          uri: file.uri,
          mtime: typeof file.mtime === 'number' ? file.mtime : 0,
          size: typeof file.size === 'number' ? file.size : 0,
          todos: file.todos
            .filter(t => t && typeof t.uri === 'string' && typeof t.line === 'number' && typeof t.text === 'string')
            .map(t => ({ uri: t.uri, line: t.line, text: t.text }))
        });
      }
      this.rebuildTodosFromFileMap();
    } catch {
      // ignore cache read errors
    }
  }

  private async flushCache(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const payload: PersistedTodoCache = {
      version: TODO_CACHE_VERSION,
      workspaceKey: this.getWorkspaceCacheKey(),
      savedAt: Date.now(),
      files: Array.from(this.todoFiles.values()).sort((a, b) => a.uri.localeCompare(b.uri))
    };
    try {
      await vscode.workspace.fs.writeFile(
        this.cacheFileUri,
        new TextEncoder().encode(JSON.stringify(payload))
      );
    } catch {
      // ignore flush errors
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushCache();
    }, 200);
  }

  private getWorkspaceCacheKey(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) {
      return 'empty-workspace';
    }
    return toStorageSafeName(
      folders
        .map(folder => folder.uri.fsPath.toLowerCase().replace(/\\/g, '/'))
        .join('__')
    );
  }

  private getConfiguredExtensions(): string[] {
    return vscode.workspace
      .getConfiguration('cursorToolWindow.todo')
      .get<string[]>('extensions', DEFAULT_TODO_EXTENSIONS)
      .map(ext => ext.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
  }

  private getIncludeGlobs(): string[] {
    return vscode.workspace
      .getConfiguration('cursorToolWindow.todo')
      .get<string[]>('includeGlobs', [])
      .map(normalizeGlobPath)
      .filter(Boolean);
  }

  private getExcludePattern(): string | undefined {
    const excludeGlobs = vscode.workspace
      .getConfiguration('cursorToolWindow.todo')
      .get<string[]>('excludeGlobs', DEFAULT_TODO_EXCLUDES)
      .map(value => value.trim())
      .filter(Boolean);
    return excludeGlobs.length ? `{${excludeGlobs.join(',')}}` : undefined;
  }

  private buildIncludePatterns(): string[] {
    const exts = this.getConfiguredExtensions();
    if (!exts.length) {
      return [];
    }
    const extPart = exts.join(',');
    const includes = this.getIncludeGlobs();
    if (!includes.length) {
      return [`**/*.{${extPart}}`];
    }
    return includes.map(base => `${base}/**/*.{${extPart}}`);
  }

  private shouldScanUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }
    const exts = this.getConfiguredExtensions();
    if (!exts.length) {
      return false;
    }
    const lowerPath = uri.fsPath.toLowerCase();
    return exts.some(ext => lowerPath.endsWith('.' + ext));
  }

  private queueDocumentRefresh(uri: vscode.Uri): void {
    if (!this.shouldScanUri(uri)) {
      return;
    }
    this.pendingUris.add(uri.toString());
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refreshPendingUris();
    }, 400);
  }

  private async refreshPendingUris(): Promise<void> {
    const pending = Array.from(this.pendingUris);
    this.pendingUris.clear();
    if (!pending.length) {
      return;
    }
    for (const uriStr of pending) {
      try {
        await this.refreshFile(vscode.Uri.parse(uriStr), true);
      } catch {
        // ignore per-file refresh errors
      }
    }
    this.emitTodosChanged();
    this.scheduleFlush();
  }

  private async scanWorkspace(): Promise<void> {
    if (this.isScanning) {
      return;
    }
    this.isScanning = true;
    this._onScanningChange.fire(true);

    try {
      const patterns = this.buildIncludePatterns();
      if (!patterns.length) {
        this.todoFiles.clear();
        this.rebuildTodosFromFileMap();
        this.emitTodosChanged();
        this.scheduleFlush();
        return;
      }

      const excludePattern = this.getExcludePattern();
      const discovered = new Set<string>();

      for (const pattern of patterns) {
        const uris = await vscode.workspace.findFiles(pattern, excludePattern);
        for (const uri of uris) {
          discovered.add(uri.toString());
          await this.refreshFile(uri, false);
        }
      }

      Array.from(this.todoFiles.keys()).forEach(uriStr => {
        if (!discovered.has(uriStr)) {
          this.todoFiles.delete(uriStr);
        }
      });

      this.rebuildTodosFromFileMap();
      this.emitTodosChanged();
      this.scheduleFlush();
    } finally {
      this.isScanning = false;
      this._onScanningChange.fire(false);
    }
  }

  private async rebuildFromScratch(): Promise<void> {
    this.todoFiles.clear();
    this.rebuildTodosFromFileMap();
    this.emitTodosChanged();
    await this.scanWorkspace();
  }

  private async refreshFile(uri: vscode.Uri, emitLater: boolean): Promise<void> {
    if (!this.shouldScanUri(uri)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const existing = this.todoFiles.get(uri.toString());
      if (existing && existing.mtime === stat.mtime && existing.size === stat.size) {
        return;
      }
      const content = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf-8').decode(content);
      const todos = this.collectTodosFromText(uri, text);
      this.todoFiles.set(uri.toString(), {
        uri: uri.toString(),
        mtime: stat.mtime,
        size: stat.size,
        todos: todos.map(item => ({
          uri: item.uri.toString(),
          line: item.line,
          text: item.text
        }))
      });
      if (!emitLater) {
        return;
      }
    } catch {
      this.todoFiles.delete(uri.toString());
    }
  }

  private handleRenameFiles(e: vscode.FileRenameEvent): void {
    for (const file of e.files) {
      const oldKey = file.oldUri.toString();
      const existing = this.todoFiles.get(oldKey);
      if (existing) {
        this.todoFiles.delete(oldKey);
      }
      this.removeDocumentTodos(file.oldUri, false);
      this.queueDocumentRefresh(file.newUri);
    }
    this.emitTodosChanged();
    this.scheduleFlush();
  }

  private removeDocumentTodos(uri: vscode.Uri, emit: boolean): void {
    const removed = this.todoFiles.delete(uri.toString());
    if (removed) {
      this.rebuildTodosFromFileMap();
      if (emit) {
        this.emitTodosChanged();
        this.scheduleFlush();
      }
    }
  }

  private collectTodosFromText(uri: vscode.Uri, text: string): CodeTodoItem[] {
    const todoRegex = /\/\/\s*todo\b[\s:：-]*(.*)$/i;
    const lines = text.split(/\r?\n/);
    const items: CodeTodoItem[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(todoRegex);
      if (match) {
        const tail = match[1] ? match[1].trim() : '';
        const content = tail || line.trim();
        items.push({
          uri,
          line: i,
          text: content
        });
      }
    }

    return items;
  }

  private rebuildTodosFromFileMap(): void {
    const nextTodos: CodeTodoItem[] = [];
    for (const file of this.todoFiles.values()) {
      for (const todo of file.todos) {
        nextTodos.push({
          uri: vscode.Uri.parse(todo.uri),
          line: todo.line,
          text: todo.text
        });
      }
    }
    nextTodos.sort((a, b) => {
      const fa = vscode.workspace.asRelativePath(a.uri, false).toLowerCase();
      const fb = vscode.workspace.asRelativePath(b.uri, false).toLowerCase();
      if (fa < fb) return -1;
      if (fa > fb) return 1;
      return a.line - b.line;
    });
    this.todos = nextTodos;
  }

  private emitTodosChanged(): void {
    this._onDidChange.fire();
  }
}
