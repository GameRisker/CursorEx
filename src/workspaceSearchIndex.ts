import * as path from 'path';
import * as vscode from 'vscode';

export interface IndexedFileEntry {
  uri: vscode.Uri;
  fileName: string;
  relativePath: string;
  extension: string;
  normalizedName: string;
  acronym: string;
  tokens: string[];
  mtime: number;
  size: number;
  lastIndexedAt: number;
}

export interface IndexedSymbolEntry {
  uri: vscode.Uri;
  name: string;
  kind: 'class' | 'struct' | 'interface' | 'enum' | 'function' | 'method' | 'constructor';
  line: number;
  container?: string;
  fileName: string;
  relativePath: string;
  normalizedName: string;
  acronym: string;
  tokens: string[];
  mtime: number;
}

export interface SearchIndexSnapshot {
  fileCount: number;
  symbolCount: number;
  lastRebuildAt: number | null;
  ready: boolean;
  stale: boolean;
  cacheLoaded: boolean;
}

interface SearchIndexQueryOptions {
  limit?: number;
  includeExtensions?: string[];
  includeDirectories?: string[];
  caseSensitive?: boolean;
}

interface PersistedIndexFileEntry {
  uri: string;
  fileName: string;
  relativePath: string;
  extension: string;
  normalizedName: string;
  acronym: string;
  tokens: string[];
  mtime: number;
  size: number;
  lastIndexedAt: number;
}

interface PersistedIndexSymbolEntry {
  uri: string;
  name: string;
  kind: 'class' | 'struct' | 'interface' | 'enum' | 'function' | 'method' | 'constructor';
  line: number;
  container?: string;
  fileName: string;
  relativePath: string;
  normalizedName: string;
  acronym: string;
  tokens: string[];
  mtime: number;
}

interface PersistedSearchIndex {
  version: number;
  workspaceKey: string;
  lastRebuildAt: number | null;
  savedAt: number;
  files: PersistedIndexFileEntry[];
  symbols: PersistedIndexSymbolEntry[];
}

const INDEX_CACHE_VERSION = 2;
const DEFAULT_INDEX_EXCLUDES = [
  '**/node_modules/**',
  '**/bin/**',
  '**/obj/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.vs/**',
  '**/Library/**',
  '**/Temp/**',
  '**/target/**'
];

const SYMBOL_EXTENSIONS = new Set([
  'cs', 'csx', 'ts', 'tsx', 'js', 'jsx', 'java', 'go', 'cpp', 'c', 'h', 'hpp',
  'py', 'rs', 'kt', 'kts', 'swift', 'php', 'rb', 'fs', 'vb', 'lua', 'd', 'm',
  'mm', 'json', 'xml', 'xaml', 'yaml', 'yml', 'gradle', 'props', 'targets'
]);

function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function splitTokens(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function camelAcronym(value: string): string {
  const parts = value.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  if (!parts || !parts.length) {
    return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  }
  return parts.map(p => p[0]).join('').toLowerCase();
}

function isSubsequenceMatch(query: string, target: string): boolean {
  if (!query) {
    return true;
  }
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      qi++;
    }
  }
  return qi === query.length;
}

function fuzzyScore(query: string, name: string, filePath: string): number {
  const q = normalizeForSearch(query);
  const n = normalizeForSearch(name);
  const p = normalizeForSearch(filePath);
  if (!q) {
    return 0;
  }

  let score = -1;
  if (n === q) score = Math.max(score, 10000);
  if (n.startsWith(q)) score = Math.max(score, 8000 - Math.min(n.length, 200));
  if (n.includes(q)) score = Math.max(score, 6000 - n.indexOf(q) * 10);

  const ac = camelAcronym(name);
  if (ac && isSubsequenceMatch(q, ac)) {
    score = Math.max(score, 7000 - ac.length * 10);
  }
  if (isSubsequenceMatch(q, n)) {
    score = Math.max(score, 5000 - n.length);
  }
  if (p.includes(q)) {
    score = Math.max(score, 2000 - p.indexOf(q));
  }
  return score;
}

function relativePathFor(uri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder): string {
  if (!workspaceFolder) {
    return uri.fsPath.replace(/\\/g, '/');
  }
  const root = workspaceFolder.uri.fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const full = uri.fsPath.replace(/\\/g, '/');
  if (full.toLowerCase().startsWith(root.toLowerCase() + '/')) {
    return full.substring(root.length + 1);
  }
  return full;
}

function toStorageSafeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '_');
}

const FUNCTION_NAME_BLACKLIST = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return',
  'sizeof', 'typeof', 'nameof', 'new', 'else', 'do', 'try'
]);

export class WorkspaceSearchIndex implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly fileByUri = new Map<string, IndexedFileEntry>();
  private readonly symbolsByUri = new Map<string, IndexedSymbolEntry[]>();
  private readonly filesByName = new Map<string, Set<string>>();
  private readonly filesByExt = new Map<string, Set<string>>();
  private readonly symbolsByName = new Map<string, Set<string>>();
  private readonly pendingChangedUris = new Set<string>();

  private rebuilding = false;
  private stale = false;
  private ready = false;
  private cacheLoaded = false;
  private lastRebuildAt: number | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private pendingFlushTimer: NodeJS.Timeout | null = null;
  private pendingChangeTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private flushing = false;
  private readonly cacheFileUri: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.cacheFileUri = vscode.Uri.joinPath(
      context.globalStorageUri,
      'search-index',
      `${this.getWorkspaceCacheKey()}.json`
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
      watcher,
      vscode.workspace.onDidCreateFiles(e => this.handleCreateFiles(e)),
      vscode.workspace.onDidDeleteFiles(e => this.handleDeleteFiles(e)),
      vscode.workspace.onDidRenameFiles(e => this.handleRenameFiles(e)),
      vscode.workspace.onDidSaveTextDocument(doc => this.handleSaveDocument(doc)),
      watcher.onDidCreate(uri => this.handleExternalCreate(uri)),
      watcher.onDidChange(uri => this.handleExternalChange(uri)),
      watcher.onDidDelete(uri => this.handleExternalDelete(uri)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (
          e.affectsConfiguration('cursorToolWindow.search') ||
          e.affectsConfiguration('files.exclude') ||
          e.affectsConfiguration('files.watcherExclude')
        ) {
          this.scheduleRebuild('configuration-change');
        }
      })
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    if (this.pendingChangeTimer) {
      clearTimeout(this.pendingChangeTimer);
      this.pendingChangeTimer = null;
    }
    this._onDidChange.dispose();
  }

  getSnapshot(): SearchIndexSnapshot {
    return {
      fileCount: this.fileByUri.size,
      symbolCount: this.symbolsByUri.size === 0
        ? 0
        : Array.from(this.symbolsByUri.values()).reduce((sum, items) => sum + items.length, 0),
      lastRebuildAt: this.lastRebuildAt,
      ready: this.ready,
      stale: this.stale,
      cacheLoaded: this.cacheLoaded
    };
  }

  async initialize(): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.context.globalStorageUri, 'search-index'));
    await this.loadPersistedIndex();
    if (!this.cacheLoaded) {
      await this.rebuildAll('initial');
      return;
    }

    this.ready = true;
    this._onDidChange.fire();
    void this.reconcileWithWorkspace('startup-reconcile');
  }

  async rebuildAll(reason: string = 'manual'): Promise<void> {
    if (this.disposed || this.rebuilding) {
      this.stale = true;
      return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) {
      return;
    }

    this.rebuilding = true;
    this.ready = false;
    this.stale = true;

    try {
      this.clearIndex();

      const uris = await vscode.workspace.findFiles('**/*', `{${DEFAULT_INDEX_EXCLUDES.join(',')}}`);
      let processed = 0;
      for (const uri of uris) {
        if (this.disposed) {
          break;
        }
        await this.indexUri(uri);
        processed++;
        if (processed % 200 === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }

      this.lastRebuildAt = Date.now();
      this.ready = true;
      this.stale = false;
      this.cacheLoaded = true;
      this._onDidChange.fire();
      this.schedulePersist();
    } finally {
      this.rebuilding = false;
    }

    if (this.stale && !this.disposed) {
      this.scheduleRebuild(`follow-up:${reason}`);
    }
  }

  async indexUri(uri: vscode.Uri): Promise<void> {
    if (this.disposed || !this.isWorkspaceUri(uri)) {
      return;
    }

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      this.removeUri(uri);
      return;
    }

    if ((stat.type & vscode.FileType.Directory) !== 0) {
      await this.indexDirectory(uri);
      return;
    }

    await this.indexFile(uri, stat);
  }

  removeUri(uri: vscode.Uri): void {
    const target = uri.toString();
    const uriKeys = Array.from(this.fileByUri.keys());
    for (const key of uriKeys) {
      if (key === target || key.startsWith(target + '/')) {
        const oldFile = this.fileByUri.get(key);
        if (oldFile) {
          this.removeFileFromLookups(key, oldFile);
        }
        this.fileByUri.delete(key);
      }
    }

    const symbolKeys = Array.from(this.symbolsByUri.keys());
    for (const key of symbolKeys) {
      if (key === target || key.startsWith(target + '/')) {
        const symbols = this.symbolsByUri.get(key) || [];
        for (const symbol of symbols) {
          this.removeSymbolFromLookups(key, symbol);
        }
        this.symbolsByUri.delete(key);
      }
    }
    this._onDidChange.fire();
    this.schedulePersist();
  }

  async renameUri(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    this.removeUri(oldUri);
    await this.indexUri(newUri);
  }

  async queryFiles(query: string, options: SearchIndexQueryOptions = {}): Promise<IndexedFileEntry[]> {
    const limit = options.limit ?? 100;
    const includeExtensions = options.includeExtensions?.map(e => e.toLowerCase().replace(/^\./, '')).filter(Boolean) ?? [];
    const includeDirectories = options.includeDirectories?.map(v => v.toLowerCase()).filter(Boolean) ?? [];
    const q = query.trim();
    const scored: Array<{ entry: IndexedFileEntry; score: number }> = [];

    for (const entry of this.fileByUri.values()) {
      if (includeExtensions.length && !includeExtensions.includes(entry.extension.toLowerCase())) {
        continue;
      }
      if (includeDirectories.length) {
        const rel = entry.relativePath.toLowerCase().replace(/\\/g, '/');
        const matched = includeDirectories.some(dir => rel.includes(dir));
        if (!matched) {
          continue;
        }
      }
      const score = fuzzyScore(q, entry.fileName, entry.relativePath);
      if (score < 0) {
        continue;
      }
      scored.push({ entry, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.entry.fileName.length !== b.entry.fileName.length) return a.entry.fileName.length - b.entry.fileName.length;
      return a.entry.relativePath.localeCompare(b.entry.relativePath);
    });

    return scored.slice(0, limit).map(s => s.entry);
  }

  async querySymbols(query: string, options: SearchIndexQueryOptions = {}): Promise<IndexedSymbolEntry[]> {
    const limit = options.limit ?? 100;
    const includeExtensions = options.includeExtensions?.map(e => e.toLowerCase().replace(/^\./, '')).filter(Boolean) ?? [];
    const includeDirectories = options.includeDirectories?.map(v => v.toLowerCase()).filter(Boolean) ?? [];
    const q = query.trim();
    const scored: Array<{ entry: IndexedSymbolEntry; score: number }> = [];

    for (const symbols of this.symbolsByUri.values()) {
      for (const symbol of symbols) {
        if (includeExtensions.length && !includeExtensions.includes(this.getExtension(symbol.uri))) {
          continue;
        }
        if (includeDirectories.length) {
          const rel = symbol.relativePath.toLowerCase().replace(/\\/g, '/');
          const matched = includeDirectories.some(dir => rel.includes(dir));
          if (!matched) {
            continue;
          }
        }
        const score = fuzzyScore(q, symbol.name, symbol.relativePath);
        if (score < 0) {
          continue;
        }
        scored.push({ entry: symbol, score });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.entry.name.length !== b.entry.name.length) return a.entry.name.length - b.entry.name.length;
      return a.entry.relativePath.localeCompare(b.entry.relativePath);
    });

    return scored.slice(0, limit).map(s => s.entry);
  }

  private scheduleRebuild(reason: string): void {
    this.stale = true;
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuildAll(reason);
    }, 250);
  }

  private schedulePersist(): void {
    if (this.disposed) {
      return;
    }
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
    }
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      void this.persistIndex();
    }, 400);
  }

  private scheduleChangedUri(uri: vscode.Uri): void {
    if (!this.isWorkspaceUri(uri)) {
      return;
    }
    this.pendingChangedUris.add(uri.toString());
    if (this.pendingChangeTimer) {
      clearTimeout(this.pendingChangeTimer);
    }
    this.pendingChangeTimer = setTimeout(() => {
      this.pendingChangeTimer = null;
      void this.flushPendingChangedUris();
    }, 200);
  }

  private async flushPendingChangedUris(): Promise<void> {
    const targets = Array.from(this.pendingChangedUris);
    this.pendingChangedUris.clear();
    for (const rawUri of targets) {
      if (this.disposed) {
        return;
      }
      await this.indexUri(vscode.Uri.parse(rawUri));
    }
  }

  private async handleCreateFiles(event: vscode.FileCreateEvent): Promise<void> {
    for (const file of event.files) {
      await this.indexUri(file);
    }
  }

  private async handleDeleteFiles(event: vscode.FileDeleteEvent): Promise<void> {
    for (const file of event.files) {
      this.removeUri(file);
    }
  }

  private async handleRenameFiles(event: vscode.FileRenameEvent): Promise<void> {
    for (const file of event.files) {
      await this.renameUri(file.oldUri, file.newUri);
    }
  }

  private async handleSaveDocument(doc: vscode.TextDocument): Promise<void> {
    if (doc.isUntitled || !this.isWorkspaceUri(doc.uri)) {
      return;
    }
    await this.indexUri(doc.uri);
  }

  private handleExternalCreate(uri: vscode.Uri): void {
    this.scheduleChangedUri(uri);
  }

  private handleExternalChange(uri: vscode.Uri): void {
    this.scheduleChangedUri(uri);
  }

  private handleExternalDelete(uri: vscode.Uri): void {
    if (!this.isWorkspaceUri(uri)) {
      return;
    }
    this.removeUri(uri);
  }

  private async indexDirectory(root: vscode.Uri): Promise<void> {
    const pattern = new vscode.RelativePattern(root, '**/*');
    const files = await vscode.workspace.findFiles(pattern, `{${DEFAULT_INDEX_EXCLUDES.join(',')}}`);
    for (const file of files) {
      await this.indexFile(file, await vscode.workspace.fs.stat(file));
    }
  }

  private async indexFile(uri: vscode.Uri, stat?: vscode.FileStat): Promise<void> {
    const key = uri.toString();
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = relativePathFor(uri, workspaceFolder);
    const fileName = path.basename(uri.fsPath) || key;
    const extension = this.getExtension(uri);
    const existing = this.fileByUri.get(key);
    const nextMtime = stat ? stat.mtime : Date.now();
    const nextSize = stat ? stat.size : 0;

    if (existing && existing.mtime === nextMtime && existing.size === nextSize) {
      return;
    }

    const entry: IndexedFileEntry = {
      uri,
      fileName,
      relativePath,
      extension,
      normalizedName: normalizeForSearch(fileName),
      acronym: camelAcronym(fileName),
      tokens: splitTokens(relativePath + ' ' + fileName),
      mtime: nextMtime,
      size: nextSize,
      lastIndexedAt: Date.now()
    };

    if (existing) {
      this.removeFileFromLookups(key, existing);
    }
    this.fileByUri.set(key, entry);
    this.addFileToLookups(key, entry);

    if (SYMBOL_EXTENSIONS.has(extension)) {
      const text = await this.readTextIfPossible(uri);
      if (text !== null) {
        this.indexSymbolsForFile(uri, text, nextMtime);
      } else {
        this.clearSymbolsForUri(key);
      }
    } else {
      this.clearSymbolsForUri(key);
    }

    this._onDidChange.fire();
    this.schedulePersist();
  }

  private async readTextIfPossible(uri: vscode.Uri): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return null;
    }
  }

  private indexSymbolsForFile(uri: vscode.Uri, text: string, mtime: number): void {
    const key = uri.toString();
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = relativePathFor(uri, workspaceFolder);
    const fileName = path.basename(uri.fsPath) || key;
    const extension = this.getExtension(uri);
    const lines = text.split(/\r?\n/);
    const typeRegex = /\b(class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

    const symbols: IndexedSymbolEntry[] = [];
    const seen = new Set<string>();
    const pushSymbol = (name: string, kind: IndexedSymbolEntry['kind'], line: number) => {
      if (!name || FUNCTION_NAME_BLACKLIST.has(name.toLowerCase())) {
        return;
      }
      const uniqueKey = `${kind}:${name}:${line}`;
      if (seen.has(uniqueKey)) {
        return;
      }
      seen.add(uniqueKey);
      symbols.push({
        uri,
        name,
        kind,
        line,
        fileName,
        relativePath,
        normalizedName: normalizeForSearch(name),
        acronym: camelAcronym(name),
        tokens: splitTokens(name),
        mtime
      });
    };

    for (let i = 0; i < lines.length; i++) {
      typeRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = typeRegex.exec(lines[i])) !== null) {
        const kind = match[1] as IndexedSymbolEntry['kind'];
        const name = match[2];
        pushSymbol(name, kind, i + 1);
      }

      const functionSymbols = this.extractFunctionSymbolsFromLine(lines[i], extension);
      for (const symbol of functionSymbols) {
        pushSymbol(symbol.name, symbol.kind, i + 1);
      }
    }

    this.clearSymbolsForUri(key);
    this.symbolsByUri.set(key, symbols);
    for (const symbol of symbols) {
      this.addSymbolToLookups(key, symbol);
    }
  }

  private extractFunctionSymbolsFromLine(line: string, extension: string): Array<{ name: string; kind: IndexedSymbolEntry['kind'] }> {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      return [];
    }

    const results: Array<{ name: string; kind: IndexedSymbolEntry['kind'] }> = [];
    const push = (name: string | undefined, kind: IndexedSymbolEntry['kind']) => {
      if (name && !FUNCTION_NAME_BLACKLIST.has(name.toLowerCase())) {
        results.push({ name, kind });
      }
    };

    if (extension === 'py') {
      const match = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      push(match?.[1], 'function');
      return results;
    }

    if (extension === 'go') {
      const match = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      push(match?.[1], 'function');
      return results;
    }

    if (extension === 'rb') {
      const match = trimmed.match(/^def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      push(match?.[1], 'function');
      return results;
    }

    if (extension === 'php') {
      const match = trimmed.match(/^(?:public|private|protected|static|abstract|final|\s)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      push(match?.[1], 'function');
      return results;
    }

    if (['ts', 'tsx', 'js', 'jsx'].includes(extension)) {
      const functionMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
      push(functionMatch?.[1], 'function');

      const assignmentMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/);
      push(assignmentMatch?.[1], 'function');

      const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+|get\s+|set\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^={]+)?\s*(?:\{|=>)/);
      push(methodMatch?.[1], methodMatch?.[1] === 'constructor' ? 'constructor' : 'method');
      return results;
    }

    const cFamilyMatch = trimmed.match(/^(?:(?:public|private|protected|internal|static|virtual|override|async|extern|sealed|abstract|partial|readonly|unsafe|final|synchronized|inline|constexpr|friend|native|open|operator)\s+)*(?:[A-Za-z_][A-Za-z0-9_:<>,\[\].?*&]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:[:\w\s,<>()[\].]*\{|=>|;)/);
    push(cFamilyMatch?.[1], 'method');

    return results;
  }

  private clearSymbolsForUri(key: string): void {
    const existing = this.symbolsByUri.get(key);
    if (!existing) {
      return;
    }
    for (const symbol of existing) {
      this.removeSymbolFromLookups(key, symbol);
    }
    this.symbolsByUri.delete(key);
  }

  private addFileToLookups(key: string, entry: IndexedFileEntry): void {
    this.addToMapSet(this.filesByName, entry.normalizedName, key);
    this.addToMapSet(this.filesByName, entry.acronym, key);
    for (const token of entry.tokens) {
      this.addToMapSet(this.filesByName, token, key);
    }
    this.addToMapSet(this.filesByExt, entry.extension, key);
  }

  private removeFileFromLookups(key: string, entry: IndexedFileEntry): void {
    this.deleteFromMapSet(this.filesByName, entry.normalizedName, key);
    this.deleteFromMapSet(this.filesByName, entry.acronym, key);
    for (const token of entry.tokens) {
      this.deleteFromMapSet(this.filesByName, token, key);
    }
    this.deleteFromMapSet(this.filesByExt, entry.extension, key);
  }

  private addSymbolToLookups(key: string, entry: IndexedSymbolEntry): void {
    this.addToMapSet(this.symbolsByName, entry.normalizedName, key);
    this.addToMapSet(this.symbolsByName, entry.acronym, key);
    for (const token of entry.tokens) {
      this.addToMapSet(this.symbolsByName, token, key);
    }
  }

  private removeSymbolFromLookups(key: string, entry: IndexedSymbolEntry): void {
    this.deleteFromMapSet(this.symbolsByName, entry.normalizedName, key);
    this.deleteFromMapSet(this.symbolsByName, entry.acronym, key);
    for (const token of entry.tokens) {
      this.deleteFromMapSet(this.symbolsByName, token, key);
    }
  }

  private addToMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
    const normalized = key.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    const bucket = map.get(normalized) || new Set<string>();
    bucket.add(value);
    map.set(normalized, bucket);
  }

  private deleteFromMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
    const normalized = key.trim().toLowerCase();
    if (!normalized) {
      return;
    }
    const bucket = map.get(normalized);
    if (!bucket) {
      return;
    }
    bucket.delete(value);
    if (bucket.size === 0) {
      map.delete(normalized);
    }
  }

  private clearIndex(): void {
    this.fileByUri.clear();
    this.symbolsByUri.clear();
    this.filesByName.clear();
    this.filesByExt.clear();
    this.symbolsByName.clear();
  }

  private async loadPersistedIndex(): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.cacheFileUri);
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(raw)) as PersistedSearchIndex;
      if (
        !parsed ||
        parsed.version !== INDEX_CACHE_VERSION ||
        parsed.workspaceKey !== this.getWorkspaceCacheKey()
      ) {
        return;
      }

      this.clearIndex();
      for (const file of parsed.files || []) {
        const entry: IndexedFileEntry = {
          ...file,
          uri: vscode.Uri.parse(file.uri)
        };
        const key = entry.uri.toString();
        this.fileByUri.set(key, entry);
        this.addFileToLookups(key, entry);
      }

      const groupedSymbols = new Map<string, IndexedSymbolEntry[]>();
      for (const symbol of parsed.symbols || []) {
        const entry: IndexedSymbolEntry = {
          ...symbol,
          uri: vscode.Uri.parse(symbol.uri)
        };
        const key = entry.uri.toString();
        const list = groupedSymbols.get(key) || [];
        list.push(entry);
        groupedSymbols.set(key, list);
        this.addSymbolToLookups(key, entry);
      }

      for (const [key, entries] of groupedSymbols) {
        this.symbolsByUri.set(key, entries);
      }

      this.lastRebuildAt = parsed.lastRebuildAt ?? null;
      this.cacheLoaded = true;
    } catch {
      // Ignore missing or corrupted cache and rebuild from workspace.
    }
  }

  private async persistIndex(): Promise<void> {
    if (this.disposed || this.flushing || !this.cacheLoaded) {
      return;
    }
    this.flushing = true;
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.context.globalStorageUri, 'search-index'));

      const payload: PersistedSearchIndex = {
        version: INDEX_CACHE_VERSION,
        workspaceKey: this.getWorkspaceCacheKey(),
        lastRebuildAt: this.lastRebuildAt,
        savedAt: Date.now(),
        files: Array.from(this.fileByUri.values()).map(entry => ({
          ...entry,
          uri: entry.uri.toString()
        })),
        symbols: Array.from(this.symbolsByUri.values())
          .flat()
          .map(symbol => ({
            ...symbol,
            uri: symbol.uri.toString()
          }))
      };

      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      await vscode.workspace.fs.writeFile(this.cacheFileUri, bytes);
    } catch {
      // Ignore cache write errors to avoid blocking search.
    } finally {
      this.flushing = false;
    }
  }

  private async reconcileWithWorkspace(reason: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    const uris = await vscode.workspace.findFiles('**/*', `{${DEFAULT_INDEX_EXCLUDES.join(',')}}`);
    const seen = new Set<string>();
    let changed = false;
    let processed = 0;

    for (const uri of uris) {
      if (this.disposed) {
        return;
      }
      const key = uri.toString();
      seen.add(key);
      let stat: vscode.FileStat | undefined;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      const existing = this.fileByUri.get(key);
      if (!existing || existing.mtime !== stat.mtime || existing.size !== stat.size) {
        await this.indexFile(uri, stat);
        changed = true;
      }
      processed++;
      if (processed % 200 === 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }

    const knownKeys = Array.from(this.fileByUri.keys());
    for (const key of knownKeys) {
      if (!seen.has(key)) {
        this.removeUri(vscode.Uri.parse(key));
        changed = true;
      }
    }

    this.ready = true;
    this.stale = false;
    this.lastRebuildAt = Date.now();
    this.cacheLoaded = true;
    this._onDidChange.fire();
    if (changed) {
      this.schedulePersist();
    }

    if (this.stale) {
      this.scheduleRebuild(`reconcile:${reason}`);
    }
  }

  private isWorkspaceUri(uri: vscode.Uri): boolean {
    return !!vscode.workspace.getWorkspaceFolder(uri);
  }

  private getExtension(uri: vscode.Uri): string {
    const fileName = path.basename(uri.fsPath) || '';
    const idx = fileName.lastIndexOf('.');
    return idx >= 0 ? fileName.substring(idx + 1).toLowerCase() : '';
  }

  private getWorkspaceCacheKey(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    const key = folders
      .map(folder => folder.uri.toString().toLowerCase())
      .sort()
      .join('|');
    return toStorageSafeName(key || 'empty-workspace');
  }
}
