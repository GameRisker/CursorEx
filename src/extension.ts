import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { promises as fs } from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { TodoScanner } from './todoScanner';
import { CommentManager } from './commentManager';
import { PinExManager } from './pinExManager';
import { WorkspaceSearchIndex } from './workspaceSearchIndex';

const EXTENSION_VERSION: string = require('../package.json').version;
const execFileAsync = promisify(execFile);
const UPDATE_API_URL = 'https://api.github.com/repos/GameRisker/CursorEx/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_STARTUP_DELAY_MS = 5000;
const LAST_STARTUP_UPDATE_CHECK_KEY = 'cursorToolWindow.update.lastStartupCheckAt';
const VCS_PROVIDER_STATE_KEY = 'cursorToolWindow.vcs.provider';

interface ReferenceResultItem {
  uri: string;
  file: string;
  line: number;
  character: number;
  preview: string;
  container: string; // 归类用：类/结构体/接口/枚举 名称；找不到则回退为文件名
  access?: 'read' | 'write'; // 字段/属性查询时区分读写
}

type ReferenceSearchMode = 'references' | 'implementations';

interface ReferenceSession {
  id: string;
  title: string;
  mode: ReferenceSearchMode;
  pinned: boolean;
  createdAt: number;
  totalCount?: number;
  query: {
    uri: string;
    line: number;
    character: number;
    symbol: string;
    kind: 'field' | 'property' | 'method' | 'unknown';
  };
  results: ReferenceResultItem[];
}

interface SearchProfile {
  type: string;
  searchFileExtensions: string[];
  searchIncludeDirectories: string[];
  searchExcludeDirectories: string[];
  todoExtensions: string[];
  todoIncludeGlobs: string[];
  todoExcludeGlobs: string[];
  pinexFileExtensions: string[];
}

interface P4OpenedItem {
  depotPath: string;
  localPath: string;
  localFsPath: string;
  action: string;
  change: string;
}

interface P4PendingChange {
  id: string;
  date: string;
  description: string;
}

interface P4Snapshot {
  available: boolean;
  status: string;
  clientName: string;
  clientRoot: string;
  opened: P4OpenedItem[];
  pendingChanges: P4PendingChange[];
  updatedAt: number;
}

interface SvnStatusItem {
  path: string;
  fsPath: string;
  status: string;
  propStatus: string;
  treeStatus: string;
}

interface SvnSnapshot {
  available: boolean;
  status: string;
  workingCopyRoot: string;
  url: string;
  revision: string;
  items: SvnStatusItem[];
  updatedAt: number;
}

interface SvnCommitFileItem {
  id: string;
  path: string;
  fsPath: string;
  status: string;
  statusText: string;
  propStatus: string;
  treeStatus: string;
  selected: boolean;
  isUnversioned: boolean;
  canCommit: boolean;
  canRevert: boolean;
  warning: string;
}

interface SvnCommitWorkbenchSnapshot {
  targetPath: string;
  targetLabel: string;
  workingCopyRoot: string;
  url: string;
  revision: string;
  status: string;
  items: SvnCommitFileItem[];
  selectedCount: number;
  committableCount: number;
  updatedAt: number;
}

interface SvnTargetInfo {
  workingCopyRoot: string;
  url: string;
  revision: string;
  statusTarget: string;
}

interface SvnHistoryChangedPath {
  action: string;
  path: string;
  kind: string;
  copyFromPath: string;
  copyFromRevision: string;
}

interface SvnHistoryEntry {
  revision: string;
  author: string;
  date: string;
  message: string;
  paths: SvnHistoryChangedPath[];
}

type UpdateState = 'idle' | 'checking' | 'available' | 'current' | 'installing' | 'installed' | 'error';
type VcsProviderMode = 'auto' | 'p4' | 'svn' | 'both' | 'none';
type ActiveVcsProvider = 'p4' | 'svn';

interface VcsVisibility {
  provider: VcsProviderMode;
  showP4: boolean;
  showSvn: boolean;
}

interface UpdateStatusPayload {
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  assetName?: string;
  state: UpdateState;
  message: string;
  canInstall: boolean;
  checkedAt?: number;
}

interface GithubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: GithubReleaseAsset[];
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  tagName: string;
  releaseUrl: string;
  assetName: string;
  downloadUrl: string;
  isUpdateAvailable: boolean;
}

const DEFAULT_SEARCH_PROFILE: SearchProfile = {
  type: 'General',
  searchFileExtensions: [],
  searchIncludeDirectories: [],
  searchExcludeDirectories: ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.git/**', '**/dist/**'],
  todoExtensions: ['cs', 'csx', 'js', 'jsx', 'ts', 'tsx', 'cpp', 'c', 'h', 'hpp', 'java', 'go'],
  todoIncludeGlobs: [],
  todoExcludeGlobs: ['**/node_modules/**', '**/bin/**', '**/obj/**'],
  pinexFileExtensions: []
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseSemver(value: string): [number, number, number] | null {
  const normalized = value.trim().replace(/^v/i, '').split(/[+-]/)[0];
  const parts = normalized.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const numbers = parts.map(part => {
    if (!/^\d+$/.test(part)) {
      return NaN;
    }
    return Number(part);
  });

  if (numbers.some(n => !Number.isFinite(n))) {
    return null;
  }

  return [numbers[0], numbers[1], numbers[2]];
}

function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    return null;
  }

  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

function httpsGetBuffer(url: string, headers: Record<string, string>, redirectCount = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, response => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;

      if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        if (redirectCount >= 5) {
          reject(new Error('Too many redirects while downloading update.'));
          return;
        }
        resolve(httpsGetBuffer(new URL(location, url).toString(), headers, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`GitHub request failed with HTTP ${statusCode}.`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error('GitHub request timed out.'));
    });
    request.on('error', reject);
  });
}

async function httpsGetJson<T>(url: string): Promise<T> {
  const buffer = await httpsGetBuffer(url, {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'CursorEx-Updater'
  });
  return JSON.parse(buffer.toString('utf8')) as T;
}

function toSafeFileName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || `cursor-tool-window-${Date.now()}.vsix`;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeHtmlText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(value)) !== null) {
    attrs[match[1]] = decodeXmlAttribute(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function getCommandOutputFromError(error: unknown): string {
  const anyError = error as any;
  const output = anyError && (anyError.stderr || anyError.stdout || anyError.message);
  return output ? String(output).trim() : getErrorMessage(error);
}

function normalizeVcsProviderMode(value: unknown): VcsProviderMode {
  if (value === 'p4' || value === 'svn' || value === 'both' || value === 'none') {
    return value;
  }
  return 'auto';
}

function getSavedVcsProvider(config: vscode.WorkspaceConfiguration, context?: vscode.ExtensionContext): VcsProviderMode {
  const inspected = config.inspect<string>('vcs.provider');
  const hasConfiguredValue = !!inspected && (
    typeof inspected.globalValue === 'string' ||
    typeof inspected.workspaceValue === 'string' ||
    typeof inspected.workspaceFolderValue === 'string'
  );
  const configured = normalizeVcsProviderMode(config.get<string>('vcs.provider', 'auto'));
  if (hasConfiguredValue || !context) {
    return configured;
  }
  return normalizeVcsProviderMode(context.globalState.get<string>(VCS_PROVIDER_STATE_KEY, configured));
}

async function saveVcsProvider(
  config: vscode.WorkspaceConfiguration,
  context: vscode.ExtensionContext,
  value: unknown
): Promise<VcsProviderMode> {
  const provider = normalizeVcsProviderMode(value);
  await config.update('vcs.provider', provider, vscode.ConfigurationTarget.Global);
  await context.globalState.update(VCS_PROVIDER_STATE_KEY, provider);
  return provider;
}

function postUpdateStatusToSettings(status: UpdateStatusPayload): void {
  settingsPanel?.webview.postMessage({
    type: 'updateStatus',
    status: status
  });
}

class GithubReleaseUpdateService {
  private status: UpdateStatusPayload = {
    currentVersion: EXTENSION_VERSION,
    state: 'idle',
    message: 'Ready to check for updates.',
    canInstall: false
  };
  private latestAvailableUpdate: UpdateInfo | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  getStatusPayload(): UpdateStatusPayload {
    return { ...this.status };
  }

  async checkFromCommand(): Promise<void> {
    try {
      const update = await this.checkForUpdates(true);
      if (!update.isUpdateAvailable) {
        vscode.window.showInformationMessage('Cursor Tools is already up to date.');
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `Cursor Tools v${update.latestVersion} is available.`,
        'Install Update',
        'Release Notes'
      );
      if (action === 'Install Update') {
        try {
          await this.installUpdate(update, true);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to install update: ${getErrorMessage(error)}`);
        }
      } else if (action === 'Release Notes') {
        await vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to check for updates: ${getErrorMessage(error)}`);
    }
  }

  async installFromCommand(): Promise<void> {
    try {
      const update = this.latestAvailableUpdate || await this.checkForUpdates(true);
      await this.installUpdate(update, true);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install update: ${getErrorMessage(error)}`);
    }
  }

  async checkFromSettings(): Promise<void> {
    try {
      await this.checkForUpdates(true);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to check for updates: ${getErrorMessage(error)}`);
    }
  }

  async installFromSettings(): Promise<void> {
    try {
      const update = this.latestAvailableUpdate || await this.checkForUpdates(true);
      await this.installUpdate(update, true);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install update: ${getErrorMessage(error)}`);
    }
  }

  async checkOnStartup(): Promise<void> {
    const now = Date.now();
    const lastCheckAt = this.context.globalState.get<number>(LAST_STARTUP_UPDATE_CHECK_KEY, 0);
    if (now - lastCheckAt < UPDATE_CHECK_INTERVAL_MS) {
      return;
    }

    await this.context.globalState.update(LAST_STARTUP_UPDATE_CHECK_KEY, now);

    try {
      const update = await this.checkForUpdates(false);
      if (!update.isUpdateAvailable) {
        return;
      }

      const action = await vscode.window.showInformationMessage(
        `Cursor Tools v${update.latestVersion} is available.`,
        'Install Update',
        'Release Notes'
      );
      if (action === 'Install Update') {
        try {
          await this.installUpdate(update, false);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to install update: ${getErrorMessage(error)}`);
        }
      } else if (action === 'Release Notes') {
        await vscode.env.openExternal(vscode.Uri.parse(update.releaseUrl));
      }
    } catch (error) {
      console.error('[CursorEx] Startup update check failed:', error);
    }
  }

  private async checkForUpdates(manual: boolean): Promise<UpdateInfo> {
    this.setStatus({
      state: 'checking',
      message: 'Checking GitHub Releases...',
      latestVersion: undefined,
      releaseUrl: undefined,
      assetName: undefined,
      canInstall: false,
      checkedAt: Date.now()
    });

    try {
      const release = await httpsGetJson<GithubRelease>(UPDATE_API_URL);
      const tagName = typeof release.tag_name === 'string' ? release.tag_name : '';
      const latestVersion = tagName.replace(/^v/i, '');
      const releaseUrl = typeof release.html_url === 'string' ? release.html_url : 'https://github.com/GameRisker/CursorEx/releases/latest';
      const asset = (Array.isArray(release.assets) ? release.assets : []).find(item => {
        return typeof item.name === 'string' &&
          item.name.toLowerCase().endsWith('.vsix') &&
          typeof item.browser_download_url === 'string';
      });

      const comparison = compareSemver(latestVersion, EXTENSION_VERSION);
      if (comparison === null) {
        this.latestAvailableUpdate = undefined;
        const info = this.createNoUpdateInfo(tagName || latestVersion || 'unknown', releaseUrl);
        this.setStatus({
          state: 'current',
          latestVersion: tagName || latestVersion || undefined,
          releaseUrl: releaseUrl,
          message: `No compatible update found. Latest release tag is ${tagName || 'unknown'}.`,
          canInstall: false,
          checkedAt: Date.now()
        });
        return info;
      }

      if (comparison <= 0) {
        this.latestAvailableUpdate = undefined;
        const info = this.createNoUpdateInfo(latestVersion, releaseUrl);
        this.setStatus({
          state: 'current',
          latestVersion: latestVersion,
          releaseUrl: releaseUrl,
          message: comparison === 0 ? 'You are on the latest version.' : `Installed version v${EXTENSION_VERSION} is newer than GitHub latest v${latestVersion}.`,
          canInstall: false,
          checkedAt: Date.now()
        });
        return info;
      }

      if (!asset || !asset.name || !asset.browser_download_url) {
        throw new Error(`Release ${tagName} does not include a VSIX asset.`);
      }

      const update: UpdateInfo = {
        currentVersion: EXTENSION_VERSION,
        latestVersion: latestVersion,
        tagName: tagName,
        releaseUrl: releaseUrl,
        assetName: asset.name,
        downloadUrl: asset.browser_download_url,
        isUpdateAvailable: true
      };

      this.latestAvailableUpdate = update;
      this.setStatus({
        state: 'available',
        latestVersion: update.latestVersion,
        releaseUrl: update.releaseUrl,
        assetName: update.assetName,
        message: `Update v${update.latestVersion} is available.`,
        canInstall: true,
        checkedAt: Date.now()
      });
      return update;
    } catch (error) {
      this.latestAvailableUpdate = undefined;
      this.setStatus({
        state: 'error',
        message: `Update check failed: ${getErrorMessage(error)}`,
        canInstall: false,
        checkedAt: Date.now()
      });
      if (manual) {
        throw error;
      }
      return this.createNoUpdateInfo('unknown', 'https://github.com/GameRisker/CursorEx/releases/latest');
    }
  }

  private async installUpdate(update: UpdateInfo, manual: boolean): Promise<void> {
    if (!update.isUpdateAvailable) {
      if (manual) {
        vscode.window.showInformationMessage('Cursor Tools is already up to date.');
      }
      return;
    }

    this.setStatus({
      state: 'installing',
      latestVersion: update.latestVersion,
      releaseUrl: update.releaseUrl,
      assetName: update.assetName,
      message: `Downloading ${update.assetName}...`,
      canInstall: false
    });

    try {
      const updatesDir = path.join(this.context.globalStorageUri.fsPath, 'updates');
      await fs.mkdir(updatesDir, { recursive: true });
      const targetPath = path.join(updatesDir, toSafeFileName(update.assetName));
      const buffer = await httpsGetBuffer(update.downloadUrl, {
        'Accept': 'application/octet-stream',
        'User-Agent': 'CursorEx-Updater'
      });
      await fs.writeFile(targetPath, buffer);

      this.setStatus({
        state: 'installing',
        message: `Installing v${update.latestVersion}...`,
        canInstall: false
      });

      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(targetPath));

      this.latestAvailableUpdate = undefined;
      this.setStatus({
        state: 'installed',
        latestVersion: update.latestVersion,
        releaseUrl: update.releaseUrl,
        assetName: update.assetName,
        message: `Installed v${update.latestVersion}. Reloading window...`,
        canInstall: false
      });

      void vscode.window.showInformationMessage(`Cursor Tools v${update.latestVersion} installed. Reloading window...`);
      await new Promise(resolve => setTimeout(resolve, 800));
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      this.setStatus({
        state: 'error',
        latestVersion: update.latestVersion,
        releaseUrl: update.releaseUrl,
        assetName: update.assetName,
        message: `Install failed: ${getErrorMessage(error)}`,
        canInstall: true
      });
      throw error;
    }
  }

  private createNoUpdateInfo(latestVersion: string, releaseUrl: string): UpdateInfo {
    return {
      currentVersion: EXTENSION_VERSION,
      latestVersion: latestVersion,
      tagName: latestVersion,
      releaseUrl: releaseUrl,
      assetName: '',
      downloadUrl: '',
      isUpdateAvailable: false
    };
  }

  private setStatus(next: Partial<UpdateStatusPayload>): void {
    this.status = {
      ...this.status,
      ...next,
      currentVersion: EXTENSION_VERSION
    };
    postUpdateStatusToSettings(this.status);
  }
}

class CursorToolSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursorToolWindow.sidebar';
  private static readonly REFERENCE_STORAGE_KEY = 'cursorToolWindow.referenceSessions.v1';
  private static readonly DEBUG_LOG_FILE = 'cursor-tools-debug.log';
  private static readonly DEBUG_HTML_FILE = 'cursor-tools-sidebar.html';

  private view: vscode.WebviewView | undefined;
  // 打开文件 MRU（最近使用：聚焦/编辑）
  private openFileMru: string[] = [];
  private postOpenFilesTimer: NodeJS.Timeout | null = null;
  private referenceSessions: ReferenceSession[] = [];
  private referenceSeq: number = 1;
  private activeReferenceSessionId: string | null = null;
  private isReferenceSearching: boolean = false;
  private readonly referenceQueryCache = new Map<string, { session: ReferenceSession; total: number; cachedAt: number }>();
  private readonly autoP4CheckoutSeen = new Set<string>();
  private readonly autoP4CheckoutInFlight = new Set<string>();
  private p4Snapshot: P4Snapshot = {
    available: false,
    status: 'Loading P4...',
    clientName: '',
    clientRoot: '',
    opened: [],
    pendingChanges: [],
    updatedAt: 0
  };
  private svnSnapshot: SvnSnapshot = {
    available: false,
    status: 'Loading SVN...',
    workingCopyRoot: '',
    url: '',
    revision: '',
    items: [],
    updatedAt: 0
  };
  private pendingPinExTab: string | null = null;
  private pendingPinExLocateUri: string | null = null;
  // (FRE Preview Panel 已移除)

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly scanner: TodoScanner,
    private readonly comments: CommentManager,
    private readonly pinEx: PinExManager
  ) {
    this.restoreReferenceSessions();
  }

  private getDebugLogPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, CursorToolSidebarProvider.DEBUG_LOG_FILE);
  }

  private getDebugHtmlPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, CursorToolSidebarProvider.DEBUG_HTML_FILE);
  }

  private async appendDebugLog(message: string): Promise<void> {
    try {
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
      const line = `[${new Date().toISOString()}] ${message}${os.EOL}`;
      await fs.appendFile(this.getDebugLogPath(), line, 'utf8');
    } catch (error) {
      console.error('[CursorEx] Failed to write debug log:', error);
    }
  }

  private async writeDebugHtml(html: string): Promise<void> {
    try {
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
      await fs.writeFile(this.getDebugHtmlPath(), html, 'utf8');
    } catch (error) {
      console.error('[CursorEx] Failed to write debug html:', error);
    }
  }

  async updatePinExContext(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    const pinned = !!uri && this.pinEx.isPinned(uri);
    await vscode.commands.executeCommand('setContext', 'cursorToolWindow.pinExPinned', pinned);
  }

  private restoreReferenceSessions(): void {
    const raw = this.context.workspaceState.get<any>(CursorToolSidebarProvider.REFERENCE_STORAGE_KEY, null);
    if (!raw || typeof raw !== 'object') {
      return;
    }

    const sessionsRaw: any[] = Array.isArray(raw.sessions) ? raw.sessions : [];
    const restored: ReferenceSession[] = [];

    for (let i = 0; i < sessionsRaw.length; i++) {
      const s: any = sessionsRaw[i];
      if (!s || typeof s !== 'object') continue;

      const id = typeof s.id === 'string' ? s.id : '';
      const title = typeof s.title === 'string' ? s.title : '';
      const mode: ReferenceSearchMode =
        (s.mode === 'implementations' || s.mode === 'references') ? s.mode : 'references';
      const pinned = typeof s.pinned === 'boolean' ? s.pinned : false;
      const createdAt = typeof s.createdAt === 'number' ? s.createdAt : 0;
      const totalCount = typeof s.totalCount === 'number' ? s.totalCount : undefined;

      const q: any = s.query;
      if (!q || typeof q !== 'object') continue;
      const qUri = typeof q.uri === 'string' ? q.uri : '';
      const qLine = typeof q.line === 'number' ? q.line : 0;
      const qCharacter = typeof q.character === 'number' ? q.character : 0;
      const qSymbol = typeof q.symbol === 'string' ? q.symbol : '';
      const qKind: any = q.kind;
      const kind: 'field' | 'property' | 'method' | 'unknown' =
        (qKind === 'field' || qKind === 'property' || qKind === 'method' || qKind === 'unknown') ? qKind : 'unknown';

      const resultsRaw: any[] = Array.isArray(s.results) ? s.results : [];
      const results: ReferenceResultItem[] = [];
      for (let j = 0; j < resultsRaw.length; j++) {
        const r: any = resultsRaw[j];
        if (!r || typeof r !== 'object') continue;
        const uri = typeof r.uri === 'string' ? r.uri : '';
        const file = typeof r.file === 'string' ? r.file : '';
        const line = typeof r.line === 'number' ? r.line : 0;
        const character = typeof r.character === 'number' ? r.character : 0;
        const preview = typeof r.preview === 'string' ? r.preview : '';
        const container = typeof r.container === 'string' ? r.container : '';
        const access: any = r.access;
        const accessOk: 'read' | 'write' | undefined = (access === 'read' || access === 'write') ? access : undefined;
        const callRole: any = r.callRole;
        const callRoleOk: 'call' | 'noncall' | undefined = (callRole === 'call' || callRole === 'noncall') ? callRole : undefined;
        results.push({
          uri: uri,
          file: file,
          line: line,
          character: character,
          preview: preview,
          container: container,
          access: accessOk,
          callRole: callRoleOk
        } as any);
      }

      if (!id) continue;
      restored.push({
        id: id,
        title: title || id,
        mode: mode,
        pinned: pinned,
        createdAt: createdAt || 0,
        totalCount: totalCount,
        query: {
          uri: qUri,
          line: qLine,
          character: qCharacter,
          symbol: qSymbol,
          kind: kind
        },
        results: results
      });
    }

    // 兼容当前规则：最多保留 1 个“未固定”的当前结果
    const pinnedList = restored.filter(s => !!s.pinned);
    const unpinnedList = restored.filter(s => !s.pinned).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const keepUnpinned = unpinnedList.length ? [unpinnedList[unpinnedList.length - 1]] : [];
    this.referenceSessions = pinnedList.concat(keepUnpinned);

    const activeId = (raw && typeof raw.activeId === 'string') ? raw.activeId : null;
    if (activeId && this.referenceSessions.some(s => s.id === activeId)) {
      this.activeReferenceSessionId = activeId;
    } else {
      const last = this.referenceSessions.length ? this.referenceSessions[this.referenceSessions.length - 1] : null;
      this.activeReferenceSessionId = last ? last.id : null;
    }
  }

  private persistReferenceSessions(): void {
    // workspaceState 关闭 Cursor/VS Code 后仍会保留
    try {
      this.context.workspaceState.update(CursorToolSidebarProvider.REFERENCE_STORAGE_KEY, {
        sessions: this.referenceSessions,
        activeId: this.activeReferenceSessionId
      });
    } catch {
      // ignore
    }
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    const pkg: any = this.context.extension.packageJSON;
    const version: string = (pkg && typeof pkg.version === 'string') ? pkg.version : 'dev';

    const html = getWebviewContent(version);
    webviewView.webview.html = html;
    void this.appendDebugLog(`resolveWebviewView version=${version} logPath=${this.getDebugLogPath()} htmlPath=${this.getDebugHtmlPath()}`);
    void this.writeDebugHtml(html);

    webviewView.webview.onDidReceiveMessage(msg => {
      if (!msg || typeof msg.type !== 'string') {
        return;
  }
      void this.appendDebugLog(`webview message type=${msg.type}`);
      switch (msg.type) {
        case 'debugLog':
          if (typeof msg.message === 'string') {
            void this.appendDebugLog(`[webview] ${msg.message}`);
          }
          break;
        case 'openSettings':
          vscode.commands.executeCommand('cursorToolWindow.openSettings');
          break;
        case 'revealTodo':
          if (msg.uri && typeof msg.line === 'number') {
            revealTodoLocation(vscode.Uri.parse(msg.uri), msg.line);
          }
          break;
        case 'revealComment':
          if (msg.uri && typeof msg.line === 'number') {
            revealTodoLocation(vscode.Uri.parse(msg.uri), msg.line);
          }
          break;
        case 'deleteComment':
          if (msg.uri && typeof msg.line === 'number') {
            this.comments.removeComment(vscode.Uri.parse(msg.uri), msg.line);
    }
          break;
        case 'deleteAllComments':
          this.comments.clearAll();
          break;
        case 'refreshTodos':
          void this.scanner.refreshNow();
          break;
        case 'getP4Snapshot':
        case 'refreshP4':
          void this.refreshP4Snapshot();
          break;
        case 'p4SyncDirectory':
          void this.p4Sync();
          break;
        case 'p4SubmitDirectory':
          void this.p4SubmitDirectory();
          break;
        case 'p4EditCurrent':
          void this.p4EditCurrentFile();
          break;
        case 'p4RevertCurrent':
          void this.p4RevertCurrentFile();
          break;
        case 'p4DiffCurrent':
          void this.p4DiffCurrentFile();
          break;
        case 'openP4File':
          if (typeof msg.path === 'string' && msg.path) {
            void this.openP4LocalFile(msg.path);
          }
          break;
        case 'getSvnSnapshot':
        case 'refreshSvn':
          void this.refreshSvnSnapshot();
          break;
        case 'svnUpdate':
          void this.svnUpdateWorkingCopy();
          break;
        case 'svnCommitDirectory':
          void this.svnCommitDirectory();
          break;
        case 'svnUpdatePath':
          if (typeof msg.path === 'string' && msg.path) {
            void this.svnUpdate(vscode.Uri.file(msg.path));
          }
          break;
        case 'svnCommitPath':
          if (typeof msg.path === 'string' && msg.path) {
            void this.svnCommitWorkbench(vscode.Uri.file(msg.path));
          }
          break;
        case 'svnAddPath':
          if (typeof msg.path === 'string' && msg.path) {
            void this.svnAddFile(vscode.Uri.file(msg.path));
          }
          break;
        case 'svnRevertPath':
          if (typeof msg.path === 'string' && msg.path) {
            void this.svnRevertFile(vscode.Uri.file(msg.path));
          }
          break;
        case 'svnDiffPath':
          if (typeof msg.path === 'string' && msg.path) {
            void this.svnDiffBaseFile(vscode.Uri.file(msg.path));
          }
          break;
        case 'svnHistoryPath':
          if (typeof msg.path === 'string' && msg.path) {
            void this.svnFileHistory(vscode.Uri.file(msg.path));
          }
          break;
        case 'svnAddCurrent':
          void this.svnAddCurrentFile();
          break;
        case 'svnRevertCurrent':
          void this.svnRevertCurrentFile();
          break;
        case 'svnDiffCurrent':
          void this.svnDiffCurrentFile();
          break;
        case 'svnHistoryCurrent':
          void this.svnFileHistory();
          break;
        case 'openSvnFile':
          if (typeof msg.path === 'string' && msg.path) {
            void this.openSvnLocalFile(msg.path);
          }
          break;
        case 'svnRevealInOS':
          if (typeof msg.path === 'string' && msg.path) {
            void this.openSvnPathInSystemFolder(msg.path);
          }
          break;
        case 'revealPinEx':
          if (msg.uri) {
            revealPinExFile(vscode.Uri.parse(msg.uri));
          }
          break;
        case 'deletePinEx':
          if (msg.uri) {
            this.pinEx.remove(vscode.Uri.parse(msg.uri));
          }
          break;
        case 'togglePinEx':
          if (msg.uri) {
            this.pinEx.togglePin(vscode.Uri.parse(msg.uri));
    }
          break;
        case 'deleteAllPinEx':
          this.pinEx.clearAll();
          break;
        case 'listPinExDir':
          if (msg.uri) {
            this.listPinExDir(vscode.Uri.parse(msg.uri));
          }
          break;
        case 'getSymbols':
          this.postSymbols();
          break;
        case 'revealSymbol':
          console.log('[CursorEx] revealSymbol received:', msg.uri, msg.line);
          if (msg.uri && typeof msg.line === 'number') {
            revealTodoLocation(vscode.Uri.parse(msg.uri), msg.line);
          }
          break;
        case 'revealReference':
          if (msg.uri && typeof msg.line === 'number') {
            revealReferenceLocation(
              vscode.Uri.parse(msg.uri),
              msg.line,
              typeof msg.character === 'number' ? msg.character : 0
            );
          }
          break;
        case 'getReferenceSessions':
          this.postReferenceSessions();
          break;
        case 'selectReferenceSession':
          if (typeof msg.id === 'string') {
            this.activeReferenceSessionId = msg.id;
            this.persistReferenceSessions();
            this.postReferenceSessions();
          }
          break;
        case 'toggleReferenceSessionPin':
          if (typeof msg.id === 'string' && typeof msg.pinned === 'boolean') {
            this.setReferenceSessionPinned(msg.id, msg.pinned);
          }
          break;
        case 'deleteReferenceSession':
          if (typeof msg.id === 'string') {
            this.deleteReferenceSession(msg.id);
          }
          break;
  }
    });

    // 延迟发送数据，确保 Webview 已准备好接收消息
    setTimeout(() => {
      this.postGlobalSettings();
      this.postTodos();
      this.postTodoContentFilter();
      this.postTodoScanning(this.scanner.getIsScanning());
      this.postComments();
      this.postPinEx();
      this.postPinExFilter();
      this.postActiveFile(vscode.window.activeTextEditor?.document.uri);
      this.postOpenFiles();
      this.postReferenceSessions();
      this.postReferenceSearching(this.isReferenceSearching);
      this.postP4Snapshot();
      if (this.pendingPinExTab) {
        this.postSwitchPinExTab(this.pendingPinExTab);
        this.pendingPinExTab = null;
      }
      if (this.pendingPinExLocateUri) {
        this.postPinExLocateToUriString(this.pendingPinExLocateUri);
        this.pendingPinExLocateUri = null;
      }
    }, 100);
  }

  noteOpenFileRecentlyUsed(uri: vscode.Uri | undefined): void {
    if (!uri || uri.scheme !== 'file') {
      return;
    }
    const key = uri.toString();
    const idx = this.openFileMru.indexOf(key);
    if (idx >= 0) {
      this.openFileMru.splice(idx, 1);
    }
    this.openFileMru.unshift(key);
    // 防止无限增长
    if (this.openFileMru.length > 200) {
      this.openFileMru.length = 200;
    }
  }

  schedulePostOpenFiles(): void {
    if (this.postOpenFilesTimer) {
      clearTimeout(this.postOpenFilesTimer);
      this.postOpenFilesTimer = null;
    }
    this.postOpenFilesTimer = setTimeout(() => {
      this.postOpenFilesTimer = null;
      this.postOpenFiles();
    }, 80);
  }

  postTodos(): void {
    if (!this.view) {
      return;
    }
    const todos = this.scanner.getTodos();
    const payload = todos.map(t => ({
      uri: t.uri.toString(),
      file: vscode.workspace.asRelativePath(t.uri, false),
      line: t.line,
      text: t.text
    }));
    this.view.webview.postMessage({ type: 'todos', todos: payload });
  }

  postTodoContentFilter(): void {
    if (!this.view) {
      return;
    }
    const config = vscode.workspace.getConfiguration('cursorToolWindow');
    const filter = config.get<string>('todo.contentFilter', '');
    this.view.webview.postMessage({ type: 'todoContentFilter', filter });
  }

  refreshTodoContentFilter(): void {
    this.postTodoContentFilter();
  }

  postTodoScanning(isScanning: boolean): void {
    if (!this.view) {
      return;
      }
    this.view.webview.postMessage({ type: 'todoScanning', isScanning });
  }

  postPinExFilter(): void {
    if (!this.view) {
      return;
    }
    const config = vscode.workspace.getConfiguration('cursorToolWindow');
    const extensions = config.get<string[]>('pinex.fileExtensions', []);
    this.view.webview.postMessage({ type: 'pinExFileExtensions', extensions });
  }

  refreshPinExFilter(): void {
    this.postPinExFilter();
    }

  postGlobalSettings(): void {
    if (!this.view) {
      return;
    }
    const config = vscode.workspace.getConfiguration('cursorToolWindow');
    const vcsVisibility = this.getVcsVisibility();
    this.view.webview.postMessage({
      type: 'globalSettings',
      fontSize: config.get<number>('global.fontSize', 13),
      accentColor: config.get<string>('global.accentColor', '#0e639c'),
      textColor: config.get<string>('global.textColor', '#f3f3f3'),
      mutedColor: config.get<string>('global.mutedColor', '#c5c5c5'),
      bgColor: config.get<string>('global.bgColor', '#1e1e1e'),
      borderColor: config.get<string>('global.borderColor', '#2d2d2d'),
      todoHoverColor: config.get<string>('todo.hoverColor', 'rgba(14,99,156,0.45)'),
      commentActiveColor: config.get<string>('comment.activeColor', 'rgba(14,99,156,0.6)'),
      commentHoverColor: config.get<string>('comment.hoverColor', 'rgba(14,99,156,0.45)'),
      pinexActiveColor: config.get<string>('pinex.activeColor', 'rgba(14,99,156,0.6)'),
      pinexHoverColor: config.get<string>('pinex.hoverColor', 'rgba(14,99,156,0.45)'),
      todoFontSize: config.get<number>('todo.fontSize', 0),
      commentFontSize: config.get<number>('comment.fontSize', 0),
      pinexFontSize: config.get<number>('pinex.fontSize', 0),
      vcsProvider: vcsVisibility.provider,
      showP4: vcsVisibility.showP4,
      showSvn: vcsVisibility.showSvn
    });
  }

  refreshGlobalSettings(): void {
    this.updateVcsContexts();
    this.postGlobalSettings();
  }

  postActiveFile(uri: vscode.Uri | undefined): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'activeFileChanged',
      uri: uri ? uri.toString() : null
    });
  }

  getOpenFilesSorted(): Array<{ uri: vscode.Uri; name: string; relativePath: string; isActive: boolean }> {
    // 获取所有打开的文件（tab）
    const openFiles: Array<{ uri: vscode.Uri; name: string; relativePath: string; isActive: boolean }> = [];
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    
    vscode.window.tabGroups.all.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.input && typeof (tab.input as any).uri !== 'undefined') {
          const uri = (tab.input as any).uri as vscode.Uri;
          if (uri.scheme === 'file') {
            const uriStr = uri.toString();
            // 避免重复
            if (!openFiles.some(f => f.uri.toString() === uriStr)) {
              openFiles.push({
                uri: uri,
                name: uri.fsPath.split(/[\\/]/).pop() || uriStr,
                relativePath: vscode.workspace.asRelativePath(uri, false),
                isActive: uriStr === activeUri
              });
            }
          }
        }
      });
    });

    // 确保当前活动文件在 MRU 顶部（用于排序）
    if (activeUri) {
      try {
        this.noteOpenFileRecentlyUsed(vscode.Uri.parse(activeUri));
      } catch {
        // ignore
      }
    }

    // 只保留仍在 openFiles 中的 MRU 项
    const openSet: { [k: string]: boolean } = {};
    for (let i = 0; i < openFiles.length; i++) {
      openSet[openFiles[i].uri.toString()] = true;
    }
    this.openFileMru = this.openFileMru.filter(u => !!openSet[u]);

    // MRU 排序：最近聚焦/编辑的文件排最上；活动文件永远优先
    openFiles.sort((a, b) => {
      if (a.isActive !== b.isActive) {
        return a.isActive ? -1 : 1;
      }
      const ia = this.openFileMru.indexOf(a.uri.toString());
      const ib = this.openFileMru.indexOf(b.uri.toString());
      const ra = ia >= 0 ? ia : 100000;
      const rb = ib >= 0 ? ib : 100000;
      if (ra !== rb) {
        return ra - rb;
      }
      // 兜底：按文件名排序，保证稳定
      return a.name.localeCompare(b.name);
    });

    return openFiles;
  }

  postOpenFiles(): void {
    if (!this.view) {
      return;
    }
    const openFiles = this.getOpenFilesSorted();
    const payload = openFiles.map(f => ({
      uri: f.uri.toString(),
      name: f.name,
      isActive: f.isActive
    }));

    this.view.webview.postMessage({
      type: 'openFilesChanged',
      files: payload
    });
  }

  postReferenceSessions(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'referenceSessions',
      sessions: this.referenceSessions,
      activeId: this.activeReferenceSessionId
    });
  }

  postReferenceSearching(isSearching: boolean): void {
    this.isReferenceSearching = isSearching;
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'referenceSearching',
      isSearching: isSearching
    });
  }

  postP4Snapshot(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'p4Snapshot',
      snapshot: this.p4Snapshot
    });
  }

  postSvnSnapshot(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'svnSnapshot',
      snapshot: this.svnSnapshot
    });
  }

  private getP4WorkingDirectory(): string {
    const editorPath = vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : '';
    if (editorPath) {
      const normalized = editorPath.replace(/[\\/][^\\/]+$/, '');
      if (normalized) {
        return normalized;
      }
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath || process.cwd();
  }

  private async runP4(args: string[], cwd?: string): Promise<string> {
    const result = await execFileAsync('p4', args, {
      cwd: cwd || this.getP4WorkingDirectory(),
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
  }

  private getSvnWorkingDirectory(): string {
    const editorPath = vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : '';
    if (editorPath) {
      const normalized = editorPath.replace(/[\\/][^\\/]+$/, '');
      if (normalized) {
        return normalized;
      }
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath || process.cwd();
  }

  private async runSvn(args: string[], cwd?: string, options?: { timeoutMs?: number }): Promise<string> {
    const result = await execFileAsync('svn', args, {
      cwd: cwd || this.getSvnWorkingDirectory(),
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options?.timeoutMs
    });
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
  }

  private async resolveSvnCommitTargetUri(resource?: any): Promise<vscode.Uri | null> {
    const uri = await this.resolveTargetUri(resource);
    if (uri) {
      try {
        const stat = await fs.stat(uri.fsPath);
        return stat.isDirectory() ? uri : vscode.Uri.file(path.dirname(uri.fsPath));
      } catch {
        return vscode.Uri.file(path.dirname(uri.fsPath));
      }
    }

    const editorUri = vscode.window.activeTextEditor?.document?.uri;
    if (editorUri && editorUri.scheme === 'file') {
      return vscode.Uri.file(path.dirname(editorUri.fsPath));
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri || null;
  }

  private parseSvnInfoText(infoText: string, fallbackRoot: string): Omit<SvnTargetInfo, 'statusTarget'> {
    const workingCopyRoot = (infoText.match(/^Working Copy Root Path:\s*(.+)$/m)?.[1] || '').trim();
    const url = (infoText.match(/^URL:\s*(.+)$/m)?.[1] || '').trim();
    const revision = (infoText.match(/^Revision:\s*(.+)$/m)?.[1] || '').trim();
    return {
      workingCopyRoot: workingCopyRoot || fallbackRoot,
      url,
      revision
    };
  }

  private isPathInside(parentPath: string, childPath: string): boolean {
    const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private getSvnDisplayPath(rawPath: string, root: string, fsPath?: string): string {
    const resolvedPath = fsPath || (path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath));
    const relativeToRoot = path.relative(root, resolvedPath);
    if (relativeToRoot && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot)) {
      return relativeToRoot.replace(/\\/g, '/');
    }
    if (!relativeToRoot) {
      return path.basename(resolvedPath) || resolvedPath;
    }

    const workspaceRelative = vscode.workspace.asRelativePath(vscode.Uri.file(resolvedPath), false);
    if (workspaceRelative && workspaceRelative !== resolvedPath && !path.isAbsolute(workspaceRelative)) {
      return workspaceRelative.replace(/\\/g, '/');
    }
    if (rawPath && !path.isAbsolute(rawPath)) {
      return rawPath.replace(/\\/g, '/');
    }
    return path.basename(resolvedPath) || resolvedPath;
  }

  private async getSvnInfoForTarget(targetPath: string): Promise<SvnTargetInfo> {
    const candidates: string[] = [];
    const addCandidate = (candidate: string) => {
      if (!candidate || candidates.includes(candidate)) {
        return;
      }
      candidates.push(candidate);
    };

    addCandidate(targetPath);
    const stat = await fs.stat(targetPath).catch(() => null);
    let current = stat?.isDirectory() ? targetPath : path.dirname(targetPath);
    const rootPath = path.parse(current).root;
    while (current) {
      addCandidate(current);
      if (current === rootPath) {
        break;
      }
      current = path.dirname(current);
    }

    for (const candidate of candidates) {
      try {
        const infoText = await this.runSvn(['info', candidate], path.dirname(candidate) || candidate, { timeoutMs: 10000 });
        const info = this.parseSvnInfoText(infoText, candidate);
        const statusTarget = this.isPathInside(info.workingCopyRoot, targetPath) ? targetPath : candidate;
        return {
          ...info,
          statusTarget
        };
      } catch {
        // Keep walking upward. Unversioned files fail `svn info`, but their parent working copy can still be scanned.
      }
    }

    throw new Error(`SVN working copy not found for ${targetPath}.`);
  }

  private createSvnCommitFileItem(
    rawPath: string,
    root: string,
    itemStatus: string,
    propStatus: string,
    treeConflicted: boolean
  ): SvnCommitFileItem | null {
    if (!rawPath) {
      return null;
    }

    const normalizedItem = (itemStatus || '').trim().toLowerCase();
    const normalizedProps = (propStatus || 'none').trim().toLowerCase();
    if (!treeConflicted && normalizedItem === 'normal' && (normalizedProps === 'none' || !normalizedProps)) {
      return null;
    }

    const fsPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    const displayPath = this.getSvnDisplayPath(rawPath, root, fsPath);

    let status = '?';
    let statusText = normalizedItem || 'changed';
    let canCommit = false;
    let canRevert = false;
    let isUnversioned = false;
    let warning = '';

    if (treeConflicted || normalizedItem === 'conflicted') {
      status = 'C';
      statusText = 'conflict';
      canRevert = true;
      warning = 'Resolve conflicts before committing.';
    } else if (normalizedItem === 'modified') {
      status = 'M';
      statusText = 'modified';
      canCommit = true;
      canRevert = true;
    } else if (normalizedItem === 'added') {
      status = 'A';
      statusText = 'added';
      canCommit = true;
      canRevert = true;
    } else if (normalizedItem === 'deleted') {
      status = 'D';
      statusText = 'deleted';
      canCommit = true;
      canRevert = true;
    } else if (normalizedItem === 'replaced') {
      status = 'R';
      statusText = 'replaced';
      canCommit = true;
      canRevert = true;
    } else if (normalizedItem === 'unversioned') {
      status = '?';
      statusText = 'unversioned';
      canCommit = true;
      isUnversioned = true;
      warning = 'Select to add before commit.';
    } else if (normalizedItem === 'missing') {
      status = '!';
      statusText = 'missing';
      canRevert = true;
      warning = 'Missing files must be restored or scheduled for delete before commit.';
    } else if (normalizedItem === 'obstructed') {
      status = '~';
      statusText = 'obstructed';
      warning = 'Obstructed items cannot be committed.';
    } else if (normalizedItem === 'ignored') {
      status = 'I';
      statusText = 'ignored';
      warning = 'Ignored items are not committable.';
    } else if (normalizedItem === 'external') {
      status = 'X';
      statusText = 'external';
      warning = 'External items are not committed with this working copy.';
    } else if (normalizedItem === 'normal' && normalizedProps !== 'none') {
      status = 'P';
      statusText = `properties ${normalizedProps}`;
      canCommit = true;
      canRevert = true;
    } else {
      status = (normalizedItem || '?').slice(0, 1).toUpperCase();
      statusText = normalizedItem || 'changed';
      warning = 'This SVN status is shown for review only.';
    }

    if (normalizedProps !== 'none' && normalizedItem !== 'normal') {
      statusText += `, properties ${normalizedProps}`;
    }

    return {
      id: fsPath,
      path: displayPath,
      fsPath,
      status,
      statusText,
      propStatus: normalizedProps || 'none',
      treeStatus: treeConflicted ? 'C' : '',
      selected: canCommit && !isUnversioned,
      isUnversioned,
      canCommit,
      canRevert,
      warning
    };
  }

  private parseSvnCommitStatusXml(xml: string, root: string): SvnCommitFileItem[] {
    const items: SvnCommitFileItem[] = [];
    const entryRegex = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRegex.exec(xml)) !== null) {
      const entryAttrs = parseXmlAttributes(entryMatch[1] || '');
      const rawPath = entryAttrs.path || '';
      const wcStatusMatch = entryMatch[2].match(/<wc-status\b([^>]*)\/?>/);
      if (!wcStatusMatch) {
        continue;
      }
      const wcAttrs = parseXmlAttributes(wcStatusMatch[1] || '');
      const item = this.createSvnCommitFileItem(
        rawPath,
        root,
        wcAttrs.item || '',
        wcAttrs.props || 'none',
        String(wcAttrs['tree-conflicted'] || '').toLowerCase() === 'true'
      );
      if (item) {
        items.push(item);
      }
    }

    const order: Record<string, number> = { C: 0, M: 1, P: 2, A: 3, D: 4, R: 5, '?': 6, '!': 7, '~': 8, I: 9, X: 10 };
    return items.sort((a, b) => {
      const left = order[a.status] ?? 99;
      const right = order[b.status] ?? 99;
      if (left !== right) return left - right;
      return a.path.localeCompare(b.path);
    });
  }

  private async buildSvnCommitSnapshot(targetUri: vscode.Uri): Promise<SvnCommitWorkbenchSnapshot> {
    const info = await this.getSvnInfoForTarget(targetUri.fsPath);
    const root = info.workingCopyRoot || targetUri.fsPath;
    const statusXml = await this.runSvn(['status', '--xml', info.statusTarget], root, { timeoutMs: 60000 });
    const items = this.parseSvnCommitStatusXml(statusXml, root);
    const targetLabel = this.getSvnDisplayPath(info.statusTarget, root, info.statusTarget);
    return {
      targetPath: info.statusTarget,
      targetLabel,
      workingCopyRoot: root,
      url: info.url,
      revision: info.revision,
      status: `SVN${info.revision ? ' · r' + info.revision : ''}`,
      items,
      selectedCount: items.filter(item => item.selected).length,
      committableCount: items.filter(item => item.canCommit).length,
      updatedAt: Date.now()
    };
  }

  private parseSvnStatusLine(line: string, root: string, externalPrefix = ''): SvnStatusItem | null {
    if (!line || line.length < 2) {
      return null;
    }
    const status = line.charAt(0);
    const propStatus = line.charAt(1);
    const treeStatus = line.charAt(6);
    let rawPath = line.length > 8 ? line.substring(8).trim() : '';
    if (!rawPath) {
      return null;
    }
    if (externalPrefix && !path.isAbsolute(rawPath)) {
      const normalizedRaw = rawPath.replace(/\\/g, '/');
      const normalizedPrefix = externalPrefix.replace(/\\/g, '/');
      if (normalizedRaw !== normalizedPrefix && !normalizedRaw.startsWith(`${normalizedPrefix}/`)) {
        rawPath = path.join(externalPrefix, rawPath);
      }
    }

    const fsPath = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(root, rawPath);
    const displayPath = this.getSvnDisplayPath(rawPath, root, fsPath);
    return {
      path: displayPath,
      fsPath: fsPath,
      status: status,
      propStatus: propStatus,
      treeStatus: treeStatus
    };
  }

  private getSvnActionLabel(item: SvnStatusItem): string {
    const status = String(item.status || '').trim();
    if (status === 'M') return 'modified';
    if (status === 'A') return 'added';
    if (status === 'D') return 'deleted';
    if (status === 'R') return 'replaced';
    if (status === 'C') return 'conflict';
    if (status === '?') return 'unversioned';
    if (status === '!') return 'missing';
    if (status === '~') return 'obstructed';
    if (status === 'I') return 'ignored';
    if (status === 'X') return 'external';
    return status || 'changed';
  }

  private getConfiguredVcsProvider(): VcsProviderMode {
    const config = vscode.workspace.getConfiguration('cursorToolWindow');
    return getSavedVcsProvider(config, this.context);
  }

  private getVcsVisibility(): VcsVisibility {
    const provider = this.getConfiguredVcsProvider();
    if (provider === 'none') {
      return { provider, showP4: false, showSvn: false };
    }
    if (provider === 'p4') {
      return { provider, showP4: true, showSvn: false };
    }
    if (provider === 'svn') {
      return { provider, showP4: false, showSvn: true };
    }
    if (provider === 'both') {
      return { provider, showP4: true, showSvn: true };
    }
    return {
      provider,
      showP4: !!this.p4Snapshot.available,
      showSvn: !!this.svnSnapshot.available
    };
  }

  updateVcsContexts(): void {
    const visibility = this.getVcsVisibility();
    void vscode.commands.executeCommand('setContext', 'cursorToolWindow.vcs.showP4', visibility.showP4);
    void vscode.commands.executeCommand('setContext', 'cursorToolWindow.vcs.showSvn', visibility.showSvn);
    void vscode.commands.executeCommand('setContext', 'cursorToolWindow.vcs.showAny', visibility.showP4 || visibility.showSvn);
  }

  private async pickActiveVcsProvider(action: string): Promise<ActiveVcsProvider | undefined> {
    const provider = this.getConfiguredVcsProvider();
    if (provider === 'none') {
      vscode.window.showWarningMessage('VCS is disabled in Cursor Tools settings.');
      return undefined;
    }
    if (provider === 'p4' || provider === 'svn') {
      return provider;
    }

    const p4Available = !!this.p4Snapshot.available;
    const svnAvailable = !!this.svnSnapshot.available;
    if (provider === 'auto') {
      if (p4Available && !svnAvailable) return 'p4';
      if (svnAvailable && !p4Available) return 'svn';
      if (!p4Available && !svnAvailable) {
        vscode.window.showWarningMessage(`No available VCS provider for ${action}.`);
        return undefined;
      }
    }

    const picked = await vscode.window.showQuickPick(
      [
        { label: 'P4', provider: 'p4' as ActiveVcsProvider },
        { label: 'SVN', provider: 'svn' as ActiveVcsProvider }
      ],
      {
        placeHolder: `Select VCS provider for ${action}`
      }
    );
    return picked?.provider;
  }

  private async resolveTargetUri(resource?: any): Promise<vscode.Uri | null> {
    if (resource instanceof vscode.Uri && resource.scheme === 'file') {
      return resource;
    }
    if (resource && resource.resourceUri instanceof vscode.Uri && resource.resourceUri.scheme === 'file') {
      return resource.resourceUri;
    }
    const editorUri = vscode.window.activeTextEditor?.document?.uri;
    return editorUri && editorUri.scheme === 'file' ? editorUri : null;
  }

  private async resolveTargetDirectoryUri(resource?: any): Promise<vscode.Uri | null> {
    const uri = await this.resolveTargetUri(resource);
    if (uri) {
      try {
        const stat = await fs.stat(uri.fsPath);
        if (stat.isDirectory()) {
          return uri;
        }
      } catch {
        // fall through to active/workspace directory
      }
    }

    const editorUri = vscode.window.activeTextEditor?.document?.uri;
    if (editorUri && editorUri.scheme === 'file') {
      return vscode.Uri.file(path.dirname(editorUri.fsPath));
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri || null;
  }

  private async getP4TargetSpec(uri: vscode.Uri): Promise<string> {
    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.isDirectory()) {
        return path.join(uri.fsPath, '...');
      }
    } catch {
      // use the raw path below
    }
    return uri.fsPath;
  }

  private async promptCommitMessage(provider: string, targetUri: vscode.Uri): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: `${provider}: Commit Directory`,
      prompt: `Commit ${vscode.workspace.asRelativePath(targetUri, false) || targetUri.fsPath}`,
      placeHolder: 'Commit message',
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'Commit message is required.'
    });
  }

  private async tryLaunchP4Vc(args: string[], cwd?: string): Promise<boolean> {
    const candidates = ['p4vc', 'p4vc.bat'];
    for (const candidate of candidates) {
      try {
        const child = spawn(candidate, args, {
          cwd: cwd || this.getP4WorkingDirectory(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: true
        });
        child.unref();
        return true;
      } catch {
        // try next
      }
    }
    return false;
  }

  async refreshP4Snapshot(): Promise<void> {
    const cwd = this.getP4WorkingDirectory();
    try {
      const infoText = await this.runP4(['-ztag', 'info'], cwd);
      const clientName = (infoText.match(/^\.\.\. clientName (.+)$/m)?.[1] || '').trim();
      const clientRoot = (infoText.match(/^\.\.\. clientRoot (.+)$/m)?.[1] || '').trim();

      const openedText = await this.runP4(['-ztag', 'opened'], cwd).catch(() => '');
      const openedBlocks = openedText
        ? openedText.split(/\r?\n\r?\n/).map(block => block.trim()).filter(Boolean)
        : [];
      const opened: P4OpenedItem[] = openedBlocks.map(block => {
        const depotPath = (block.match(/^\.\.\. depotFile (.+)$/m)?.[1] || '').trim();
        const clientFile = (block.match(/^\.\.\. clientFile (.+)$/m)?.[1] || '').trim();
        const action = (block.match(/^\.\.\. action (.+)$/m)?.[1] || '').trim();
        const change = (block.match(/^\.\.\. change (.+)$/m)?.[1] || '').trim();
        let localFsPath = '';
        if (clientRoot && clientName && clientFile.startsWith(`//${clientName}/`)) {
          const relativePart = clientFile.substring(clientName.length + 3).replace(/\//g, path.sep);
          localFsPath = path.join(clientRoot, relativePart);
        }
        const displayPath = localFsPath
          ? vscode.workspace.asRelativePath(vscode.Uri.file(localFsPath), false) || path.basename(localFsPath)
          : (depotPath.split('/').pop() || depotPath);
        return {
          depotPath,
          localPath: displayPath,
          localFsPath,
          action,
          change
        };
      }).filter(item => !!item.depotPath);

      const pendingText = clientName
        ? await this.runP4(['changes', '-s', 'pending', '-c', clientName, '-m', '20'], cwd).catch(() => '')
        : '';
      const pendingChanges: P4PendingChange[] = pendingText
        ? pendingText.split(/\r?\n/).map(line => {
            const match = line.match(/^Change (\d+) on ([0-9/]+) .*?\*pending\* '(.*)'$/);
            if (!match) {
              return null;
            }
            return {
              id: match[1],
              date: match[2],
              description: match[3]
            } as P4PendingChange;
          }).filter(Boolean) as P4PendingChange[]
        : [];

      const hasDefaultOpened = opened.some(item => {
        const changeValue = String(item.change || '').trim().toLowerCase();
        return !changeValue || changeValue === 'default';
      });
      if (hasDefaultOpened && !pendingChanges.some(change => String(change.id).toLowerCase() === 'default')) {
        pendingChanges.unshift({
          id: 'default',
          date: '',
          description: 'Default Changelist'
        });
      }

      this.p4Snapshot = {
        available: true,
        status: `Connected${clientName ? ' · ' + clientName : ''}`,
        clientName,
        clientRoot,
        opened,
        pendingChanges,
        updatedAt: Date.now()
      };
    } catch (error: any) {
      this.p4Snapshot = {
        available: false,
        status: (error && error.message) ? `P4 unavailable: ${error.message}` : 'P4 unavailable',
        clientName: '',
        clientRoot: '',
        opened: [],
        pendingChanges: [],
        updatedAt: Date.now()
      };
    }
    this.updateVcsContexts();
    this.postGlobalSettings();
    this.postP4Snapshot();
  }

  async refreshSvnSnapshot(): Promise<void> {
    const cwd = this.getSvnWorkingDirectory();
    try {
      const infoText = await this.runSvn(['info'], cwd);
      const workingCopyRoot = (infoText.match(/^Working Copy Root Path:\s*(.+)$/m)?.[1] || '').trim();
      const url = (infoText.match(/^URL:\s*(.+)$/m)?.[1] || '').trim();
      const revision = (infoText.match(/^Revision:\s*(.+)$/m)?.[1] || '').trim();
      const root = workingCopyRoot || cwd;

      const statusText = await this.runSvn(['status'], root).catch(() => '');
      const items: SvnStatusItem[] = [];
      if (statusText) {
        let externalPrefix = '';
        for (const line of statusText.split(/\r?\n/)) {
          const externalMatch = line.match(/^Performing status on external item at ['"](.+)['"]:/);
          if (externalMatch) {
            externalPrefix = externalMatch[1].trim();
            continue;
          }
          const item = this.parseSvnStatusLine(line, root, externalPrefix);
          if (item) {
            items.push(item);
          }
        }
      }

      this.svnSnapshot = {
        available: true,
        status: `Connected${revision ? ' · r' + revision : ''}`,
        workingCopyRoot: root,
        url: url,
        revision: revision,
        items: items,
        updatedAt: Date.now()
      };
    } catch (error: any) {
      this.svnSnapshot = {
        available: false,
        status: (error && error.message) ? `SVN unavailable: ${error.message}` : 'SVN unavailable',
        workingCopyRoot: '',
        url: '',
        revision: '',
        items: [],
        updatedAt: Date.now()
      };
    }
    this.updateVcsContexts();
    this.postGlobalSettings();
    this.postSvnSnapshot();
  }

  private async svnUpdateWorkingCopy(): Promise<void> {
    const root = this.svnSnapshot.workingCopyRoot || this.getSvnWorkingDirectory();
    const output = await this.runSvn(['update'], root);
    await this.refreshSvnSnapshot();
    vscode.window.showInformationMessage(output || 'SVN: working copy updated.');
  }

  private async svnAddCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('SVN: no active local file.');
      return;
    }
    await this.svnAddFile(uri);
  }

  private async svnRevertCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('SVN: no active local file.');
      return;
    }
    await this.svnRevertFile(uri);
  }

  private async svnDiffCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('SVN: no active local file.');
      return;
    }
    await this.svnDiffBaseFile(uri);
  }

  async svnUpdate(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    const target = uri ? uri.fsPath : (this.svnSnapshot.workingCopyRoot || this.getSvnWorkingDirectory());
    const output = await this.runSvn(['update', target], this.getSvnWorkingDirectory());
    await this.refreshSvnSnapshot();
    vscode.window.setStatusBarMessage(output || 'SVN updated.', 3000);
  }

  async svnAddFile(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('SVN: no local file selected.');
      return;
    }
    await this.runSvn(['add', uri.fsPath], this.getSvnWorkingDirectory());
    await this.refreshSvnSnapshot();
    vscode.window.setStatusBarMessage(`SVN add: ${vscode.workspace.asRelativePath(uri, false)}`, 2000);
  }

  async svnRevertFile(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('SVN: no local file selected.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `SVN: revert ${vscode.workspace.asRelativePath(uri, false)}?`,
      { modal: true },
      'Revert'
    );
    if (confirm !== 'Revert') {
      return;
    }
    await this.runSvn(['revert', uri.fsPath], this.getSvnWorkingDirectory());
    await this.refreshSvnSnapshot();
    vscode.window.setStatusBarMessage(`SVN reverted: ${vscode.workspace.asRelativePath(uri, false)}`, 2000);
  }

  async svnDiffBaseFile(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('SVN: no local file selected.');
      return;
    }
    const diffText = await this.runSvn(['diff', uri.fsPath], this.getSvnWorkingDirectory()).catch((error: any) => {
      return (error && (error.stdout || error.stderr || error.message)) ? String(error.stdout || error.stderr || error.message) : 'No diff output.';
    });
    const doc = await vscode.workspace.openTextDocument({
      language: 'diff',
      content: diffText || 'No diff output.'
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async svnFileHistory(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('SVN: no local file selected.');
      return;
    }

    let root = path.dirname(uri.fsPath);
    let targetLabel = vscode.workspace.asRelativePath(uri, false) || uri.fsPath;
    let entries: SvnHistoryEntry[] = [];
    let errorMessage = '';

    try {
      const info = await this.getSvnInfoForTarget(uri.fsPath);
      root = info.workingCopyRoot || root;
      targetLabel = this.getSvnDisplayPath(uri.fsPath, root, uri.fsPath);
      void this.appendDebugLog(`svnFileHistory start target=${uri.fsPath}`);
      const historyXml = await this.runSvn(['log', '--xml', '--verbose', '-l', '50', uri.fsPath], root, { timeoutMs: 60000 });
      entries = this.parseSvnHistoryXml(historyXml);
      void this.appendDebugLog(`svnFileHistory success target=${uri.fsPath} entries=${entries.length}`);
    } catch (error) {
      errorMessage = getCommandOutputFromError(error) || 'SVN file history failed.';
      void this.appendDebugLog(`svnFileHistory error target=${uri.fsPath} error=${errorMessage}`);
    }

    const panel = vscode.window.createWebviewPanel(
      'cursorToolWindow.svnFileHistory',
      `SVN History: ${path.basename(uri.fsPath) || targetLabel}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.onDidReceiveMessage(msg => {
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      if (msg.type === 'diffRevision' && typeof msg.revision === 'string') {
        void this.openSvnHistoryRevisionDiff(uri, root, msg.revision);
      }
    });
    panel.webview.html = getSvnFileHistoryHtml(targetLabel, uri.fsPath, entries, errorMessage);
  }

  private parseSvnHistoryXml(xml: string): SvnHistoryEntry[] {
    const entries: SvnHistoryEntry[] = [];
    const entryRegex = /<logentry\b([^>]*)>([\s\S]*?)<\/logentry>/g;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRegex.exec(xml)) !== null) {
      const attrs = parseXmlAttributes(entryMatch[1] || '');
      const body = entryMatch[2] || '';
      entries.push({
        revision: attrs.revision || '',
        author: this.getSvnXmlTagText(body, 'author'),
        date: this.getSvnXmlTagText(body, 'date'),
        message: this.getSvnXmlTagText(body, 'msg'),
        paths: this.parseSvnHistoryPaths(body)
      });
    }
    return entries;
  }

  private parseSvnHistoryPaths(body: string): SvnHistoryChangedPath[] {
    const paths: SvnHistoryChangedPath[] = [];
    const pathsMatch = body.match(/<paths>([\s\S]*?)<\/paths>/);
    const pathsBody = pathsMatch ? pathsMatch[1] : '';
    const pathRegex = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = pathRegex.exec(pathsBody)) !== null) {
      const attrs = parseXmlAttributes(pathMatch[1] || '');
      paths.push({
        action: attrs.action || '',
        path: decodeXmlAttribute((pathMatch[2] || '').trim()),
        kind: attrs.kind || '',
        copyFromPath: attrs['copyfrom-path'] || '',
        copyFromRevision: attrs['copyfrom-rev'] || ''
      });
    }
    return paths;
  }

  private getSvnXmlTagText(body: string, tagName: string): string {
    const match = body.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`));
    return match ? decodeXmlAttribute(match[1].trim()) : '';
  }

  private async openSvnHistoryRevisionDiff(uri: vscode.Uri, root: string, revision: string): Promise<void> {
    if (!/^\d+$/.test(revision)) {
      vscode.window.showWarningMessage(`SVN: invalid revision ${revision}.`);
      return;
    }
    try {
      const diffText = await this.runSvn(['diff', '-c', revision, uri.fsPath], root, { timeoutMs: 60000 });
      const doc = await vscode.workspace.openTextDocument({
        language: 'diff',
        content: diffText || `No file diff output for r${revision}.`
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (error) {
      vscode.window.showErrorMessage(`SVN history diff failed: ${getCommandOutputFromError(error)}`);
    }
  }

  private getSvnCommitItemsByPath(paths: unknown, currentItems: SvnCommitFileItem[]): SvnCommitFileItem[] {
    if (!Array.isArray(paths)) {
      return [];
    }
    const byPath = new Map(currentItems.map(item => [path.normalize(item.fsPath), item]));
    const selected: SvnCommitFileItem[] = [];
    const seen = new Set<string>();
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string' || !rawPath) {
        continue;
      }
      const key = path.normalize(rawPath);
      if (seen.has(key)) {
        continue;
      }
      const item = byPath.get(key);
      if (item) {
        selected.push(item);
        seen.add(key);
      }
    }
    return selected;
  }

  private async writeSvnTargetsFile(root: string, items: SvnCommitFileItem[]): Promise<string> {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'svn-targets');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `commit-targets-${Date.now()}-${Math.round(Math.random() * 100000)}.txt`);
    const lines = items.map(item => {
      const relative = path.relative(root, item.fsPath);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : item.fsPath;
    });
    await fs.writeFile(filePath, lines.join(os.EOL), 'utf8');
    return filePath;
  }

  private async openSvnCommitDiff(item: SvnCommitFileItem, root: string): Promise<boolean> {
    const status = String(item.status || '').toUpperCase();
    if (item.isUnversioned || status === 'A') {
      await this.openSvnLocalFile(item.fsPath);
      return true;
    }
    if (status === 'C') {
      vscode.window.showWarningMessage('SVN: resolve conflicts before using the commit diff view.');
      return false;
    }
    if (status === '!' || status === 'D') {
      vscode.window.showWarningMessage('SVN: deleted or missing files cannot be opened in the commit diff view.');
      return false;
    }

    try {
      const baseText = await this.runSvn(['cat', '-r', 'BASE', item.fsPath], root);
      const diffDir = path.join(this.context.globalStorageUri.fsPath, 'svn-diff');
      await fs.mkdir(diffDir, { recursive: true });
      const ext = path.extname(item.fsPath);
      const stem = path.basename(item.fsPath, ext);
      const basePath = path.join(diffDir, `${toSafeFileName(stem)}-${Date.now()}.BASE${ext}`);
      await fs.writeFile(basePath, baseText, 'utf8');
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(basePath),
        vscode.Uri.file(item.fsPath),
        `SVN Diff: ${item.path}`
      );
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`SVN diff failed: ${getCommandOutputFromError(error)}`);
      return false;
    }
  }

  async svnCommitWorkbench(resource?: any): Promise<void> {
    const targetUri = await this.resolveSvnCommitTargetUri(resource);
    if (!targetUri) {
      vscode.window.showWarningMessage('SVN: no local directory selected.');
      return;
    }

    const targetName = path.basename(targetUri.fsPath) || targetUri.fsPath;
    const panel = vscode.window.createWebviewPanel(
      'cursorToolWindow.svnCommitWorkbench',
      `SVN Commit: ${targetName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    let currentSnapshot: SvnCommitWorkbenchSnapshot | null = null;
    let busy = false;
    let disposed = false;
    let initialRefreshStarted = false;
    void this.appendDebugLog(`svnCommitWorkbench open target=${targetUri.fsPath}`);

    const postBusy = (message: string): void => {
      panel.webview.postMessage({ type: 'busy', message });
    };

    const postError = (message: string): void => {
      panel.webview.postMessage({ type: 'operationError', message });
    };

    const postInfo = (message: string): void => {
      panel.webview.postMessage({ type: 'operationInfo', message });
    };

    const refresh = async (): Promise<void> => {
      postBusy('Refreshing SVN status...');
      void this.appendDebugLog(`svnCommitWorkbench refresh start target=${targetUri.fsPath}`);
      try {
        currentSnapshot = await this.buildSvnCommitSnapshot(targetUri);
        void this.appendDebugLog(
          `svnCommitWorkbench refresh success target=${currentSnapshot.targetPath} items=${currentSnapshot.items.length}`
        );
        panel.webview.postMessage({
          type: 'snapshot',
          snapshot: currentSnapshot
        });
      } catch (error) {
        const message = getCommandOutputFromError(error);
        currentSnapshot = null;
        void this.appendDebugLog(`svnCommitWorkbench refresh error target=${targetUri.fsPath} error=${message || getErrorMessage(error)}`);
        postError(message || 'SVN status failed.');
      }
    };

    const runOperation = async (label: string, operation: () => Promise<void>): Promise<void> => {
      if (busy) {
        return;
      }
      busy = true;
      postBusy(label);
      try {
        await operation();
      } catch (error) {
        const message = getCommandOutputFromError(error);
        postError(message || `${label} failed.`);
        vscode.window.showErrorMessage(`SVN: ${message || `${label} failed.`}`);
      } finally {
        busy = false;
      }
    };

    panel.webview.onDidReceiveMessage(msg => {
      if (!msg || typeof msg.type !== 'string') {
        return;
      }
      switch (msg.type) {
        case 'ready':
          void this.appendDebugLog(`svnCommitWorkbench message=ready target=${targetUri.fsPath}`);
          if (!initialRefreshStarted) {
            initialRefreshStarted = true;
            void runOperation('Refreshing SVN status...', refresh);
          }
          break;
        case 'refresh':
          void this.appendDebugLog(`svnCommitWorkbench message=refresh target=${targetUri.fsPath}`);
          void runOperation('Refreshing SVN status...', refresh);
          break;
        case 'clientError':
          if (typeof msg.message === 'string' && msg.message) {
            void this.appendDebugLog(`svnCommitWorkbench clientError target=${targetUri.fsPath} error=${msg.message}`);
            postError(`SVN Commit UI error: ${msg.message}`);
          }
          break;
        case 'cancel':
          panel.dispose();
          break;
        case 'diff':
          void runOperation('Opening diff...', async () => {
            const items = this.getSvnCommitItemsByPath([msg.path], currentSnapshot?.items || []);
            const item = items[0];
            if (!item || !currentSnapshot) {
              postError('Select a changed file first.');
              return;
            }
            const opened = await this.openSvnCommitDiff(item, currentSnapshot.workingCopyRoot || targetUri.fsPath);
            if (opened) {
              postInfo(`Opened diff for ${item.path}.`);
            }
          });
          break;
        case 'add':
          void runOperation('Adding files...', async () => {
            const items = this.getSvnCommitItemsByPath(msg.paths, currentSnapshot?.items || [])
              .filter(item => item.isUnversioned);
            if (!items.length) {
              postError('Select one or more unversioned files to add.');
              return;
            }
            const root = currentSnapshot?.workingCopyRoot || targetUri.fsPath;
            for (const item of items) {
              await this.runSvn(['add', '--parents', item.fsPath], root);
            }
            postInfo(`Added ${items.length} file(s).`);
            await refresh();
            await this.refreshSvnSnapshot();
          });
          break;
        case 'revert':
          void runOperation('Reverting files...', async () => {
            const items = this.getSvnCommitItemsByPath(msg.paths, currentSnapshot?.items || [])
              .filter(item => item.canRevert);
            if (!items.length) {
              postError('Select one or more versioned files to revert.');
              return;
            }
            const confirm = await vscode.window.showWarningMessage(
              `SVN: revert ${items.length} selected file(s)?`,
              { modal: true },
              'Revert'
            );
            if (confirm !== 'Revert') {
              postInfo('Revert canceled.');
              return;
            }
            const root = currentSnapshot?.workingCopyRoot || targetUri.fsPath;
            for (const item of items) {
              await this.runSvn(['revert', item.fsPath], root);
            }
            postInfo(`Reverted ${items.length} file(s).`);
            await refresh();
            await this.refreshSvnSnapshot();
          });
          break;
        case 'commit':
          void runOperation('Committing selected files...', async () => {
            const message = typeof msg.message === 'string' ? msg.message.trim() : '';
            if (!message) {
              postError('Commit message is required.');
              return;
            }
            const selectedItems = this.getSvnCommitItemsByPath(msg.paths, currentSnapshot?.items || [])
              .filter(item => item.canCommit);
            if (!selectedItems.length) {
              postError('Select one or more committable files.');
              return;
            }

            const root = currentSnapshot?.workingCopyRoot || targetUri.fsPath;
            const unversioned = selectedItems.filter(item => item.isUnversioned);
            for (const item of unversioned) {
              await this.runSvn(['add', '--parents', item.fsPath], root);
            }

            const targetsFile = await this.writeSvnTargetsFile(root, selectedItems);
            try {
              const output = await this.runSvn(['commit', '--targets', targetsFile, '-m', message], root);
              postInfo(output || `Committed ${selectedItems.length} file(s).`);
              vscode.window.showInformationMessage(output || `SVN: committed ${selectedItems.length} file(s).`);
            } finally {
              await fs.unlink(targetsFile).catch(() => undefined);
            }

            await refresh();
            await this.refreshSvnSnapshot();
          });
          break;
        default:
          break;
      }
    });

    panel.onDidDispose(() => {
      disposed = true;
    });

    panel.webview.html = getSvnCommitWorkbenchHtml();
    setTimeout(() => {
      if (disposed || initialRefreshStarted) {
        return;
      }
      initialRefreshStarted = true;
      void this.appendDebugLog(`svnCommitWorkbench fallback refresh target=${targetUri.fsPath}`);
      void runOperation('Refreshing SVN status...', refresh);
    }, 800);
  }

  async svnCommitDirectory(resource?: any): Promise<void> {
    await this.svnCommitWorkbench(resource);
  }

  private async openSvnLocalFile(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.noteOpenFileRecentlyUsed(uri);
      this.schedulePostOpenFiles();
    } catch {
      vscode.window.showWarningMessage(`SVN: unable to open file: ${filePath}`);
    }
  }

  private async openSvnPathInSystemFolder(targetPath: string): Promise<void> {
    try {
      const stat = await fs.stat(targetPath).catch(() => null);
      const folderPath = stat?.isDirectory() ? targetPath : path.dirname(targetPath);
      await vscode.env.openExternal(vscode.Uri.file(folderPath));
    } catch {
      vscode.window.showWarningMessage(`SVN: unable to open system folder: ${targetPath}`);
    }
  }

  async p4Sync(resource?: any): Promise<void> {
    const uri = resource ? await this.resolveTargetUri(resource) : await this.resolveTargetDirectoryUri();
    const target = uri ? await this.getP4TargetSpec(uri) : path.join(this.getP4WorkingDirectory(), '...');
    const output = await this.runP4(['sync', target], this.getP4WorkingDirectory());
    await this.refreshP4Snapshot();
    vscode.window.showInformationMessage(output || 'P4: sync complete.');
  }

  async p4SubmitDirectory(resource?: any): Promise<void> {
    const uri = await this.resolveTargetDirectoryUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('P4: no local directory selected.');
      return;
    }
    const message = await this.promptCommitMessage('P4', uri);
    if (!message) {
      return;
    }
    const target = await this.getP4TargetSpec(uri);
    const output = await this.runP4(['submit', '-d', message, target], this.getP4WorkingDirectory());
    await this.refreshP4Snapshot();
    vscode.window.showInformationMessage(output || `P4: submitted ${vscode.workspace.asRelativePath(uri, false) || uri.fsPath}.`);
  }

  async vcsUpdateDirectory(resource?: any): Promise<void> {
    const provider = await this.pickActiveVcsProvider('directory update');
    const target = await this.resolveTargetDirectoryUri(resource);
    if (!target) {
      vscode.window.showWarningMessage('VCS: no local directory selected.');
      return;
    }
    if (provider === 'p4') {
      await this.p4Sync(target);
    } else if (provider === 'svn') {
      await this.svnUpdate(target);
    }
  }

  async vcsCommitDirectory(resource?: any): Promise<void> {
    const provider = await this.pickActiveVcsProvider('directory commit');
    if (provider === 'p4') {
      await this.p4SubmitDirectory(resource);
    } else if (provider === 'svn') {
      await this.svnCommitDirectory(resource);
    }
  }

  async vcsDiffFile(resource?: any): Promise<void> {
    const provider = await this.pickActiveVcsProvider('file diff');
    if (provider === 'p4') {
      await this.p4DiffDepotFile(resource);
    } else if (provider === 'svn') {
      await this.svnDiffBaseFile(resource);
    }
  }

  private async p4EditCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('P4: no active local file.');
      return;
    }
    await this.runP4(['edit', uri.fsPath], this.getP4WorkingDirectory());
    await this.refreshP4Snapshot();
    vscode.window.showInformationMessage('P4: current file opened for edit.');
  }

  private async p4RevertCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('P4: no active local file.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'P4: revert current file?',
      { modal: true },
      'Revert'
    );
    if (confirm !== 'Revert') {
      return;
    }
    await this.runP4(['revert', uri.fsPath], this.getP4WorkingDirectory());
    await this.refreshP4Snapshot();
    vscode.window.showInformationMessage('P4: current file reverted.');
  }

  private async p4DiffCurrentFile(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document?.uri;
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('P4: no active local file.');
      return;
    }
    const diffText = await this.runP4(['diff', '-du', uri.fsPath], this.getP4WorkingDirectory()).catch((error: any) => {
      return (error && (error.stdout || error.stderr || error.message)) ? String(error.stdout || error.stderr || error.message) : 'No diff output.';
    });
    const doc = await vscode.workspace.openTextDocument({
      language: 'diff',
      content: diffText || 'No diff output.'
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private resolveTargetFileUri(resource?: any): vscode.Uri | null {
    if (resource instanceof vscode.Uri) {
      return resource.scheme === 'file' ? resource : null;
    }
    if (resource && resource.resourceUri instanceof vscode.Uri) {
      return resource.resourceUri.scheme === 'file' ? resource.resourceUri : null;
    }
    const editorUri = vscode.window.activeTextEditor?.document?.uri;
    return editorUri && editorUri.scheme === 'file' ? editorUri : null;
  }

  async p4EditFile(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('P4: no local file selected.');
      return;
    }
    await this.runP4(['edit', uri.fsPath], this.getP4WorkingDirectory());
    this.autoP4CheckoutSeen.add(uri.toString());
    await this.refreshP4Snapshot();
    vscode.window.setStatusBarMessage(`P4 edit: ${vscode.workspace.asRelativePath(uri, false)}`, 2000);
  }

  async p4RevertFile(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('P4: no local file selected.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `P4: revert ${vscode.workspace.asRelativePath(uri, false)}?`,
      { modal: true },
      'Revert'
    );
    if (confirm !== 'Revert') {
      return;
    }
    await this.runP4(['revert', uri.fsPath], this.getP4WorkingDirectory());
    this.clearAutoP4CheckoutTracking(uri);
    await this.refreshP4Snapshot();
    vscode.window.setStatusBarMessage(`P4 reverted: ${vscode.workspace.asRelativePath(uri, false)}`, 2000);
  }

  async p4DiffDepotFile(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('P4: no local file selected.');
      return;
    }
    const depotFile = await this.createDepotTempFilePath(uri);
    const depotText = await this.runP4(['print', '-q', uri.fsPath], this.getP4WorkingDirectory());
    await fs.writeFile(depotFile, depotText, 'utf8');

    if (await this.tryOpenExternalDiffTool(uri, depotText)) {
      return;
    }
    if (await this.tryLaunchP4Vc(['diff', uri.fsPath], this.getP4WorkingDirectory())) {
      return;
    }
    const depotDoc = await vscode.workspace.openTextDocument({
      language: uri.fsPath.split('.').pop() || 'text',
      content: depotText
    });
    const title = `${path.basename(uri.fsPath)} (Depot)`;
    await vscode.commands.executeCommand(
      'vscode.diff',
      depotDoc.uri,
      uri,
      `${title} ↔ ${path.basename(uri.fsPath)}`
    );
  }

  private async tryOpenExternalDiffTool(localUri: vscode.Uri, depotText: string): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('cursorToolWindow');
    const configuredToolPath = (config.get<string>('p4.externalDiffToolPath', '') || '').trim();
    const toolPath = configuredToolPath || await this.getP4ConfiguredDiffToolPath();
    if (!toolPath) {
      return false;
    }

    const argTemplate = config.get<string[]>('p4.externalDiffToolArgs', ['{left}', '{right}']) || ['{left}', '{right}'];
    const depotFile = await this.createDepotTempFilePath(localUri);
    await fs.writeFile(depotFile, depotText, 'utf8');

    const args = argTemplate.map(arg =>
      String(arg)
        .replace(/\{left\}/g, depotFile)
        .replace(/\{right\}/g, localUri.fsPath)
        .replace(/\{local\}/g, localUri.fsPath)
        .replace(/\{depot\}/g, depotFile)
    );

    const child = spawn(toolPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return true;
  }

  private async createDepotTempFilePath(localUri: vscode.Uri): Promise<string> {
    const ext = path.extname(localUri.fsPath) || '.txt';
    const base = path.basename(localUri.fsPath, ext);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-tool-window-p4-'));
    const revisionLabel = await this.getP4HaveRevisionLabel(localUri);
    return path.join(tempDir, `${base}.${revisionLabel}${ext}`);
  }

  private async getP4HaveRevisionLabel(localUri: vscode.Uri): Promise<string> {
    try {
      const output = await this.runP4(['have', localUri.fsPath], this.getP4WorkingDirectory());
      const match = output.match(/#(\d+)\s*-/);
      if (match && match[1]) {
        return `rev${match[1]}`;
      }
    } catch {
      // ignore and fall back
    }
    return 'depot';
  }

  private async getP4ConfiguredDiffToolPath(): Promise<string> {
    const cwd = this.getP4WorkingDirectory();
    const keys = ['P4DIFF', 'P4MERGE'];
    for (const key of keys) {
      try {
        const output = await this.runP4(['set', key], cwd);
        const match = output.match(new RegExp(`^${key}=(.+?)\\s*\\(set\\)$`, 'mi'));
        if (match && match[1]) {
          const value = match[1].trim().replace(/^"|"$/g, '');
          if (value) {
            return value;
          }
        }
      } catch {
        // try next
      }
    }
    return '';
  }

  async p4FileHistory(resource?: any): Promise<void> {
    const uri = this.resolveTargetFileUri(resource);
    if (!uri) {
      vscode.window.showWarningMessage('P4: no local file selected.');
      return;
    }
    if (await this.tryLaunchP4Vc(['history', uri.fsPath], this.getP4WorkingDirectory())) {
      return;
    }
    const historyText = await this.runP4(['filelog', '-l', uri.fsPath], this.getP4WorkingDirectory());
    const doc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: historyText || 'No history output.'
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async openP4LocalFile(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      this.noteOpenFileRecentlyUsed(uri);
      this.schedulePostOpenFiles();
    } catch {
      vscode.window.showWarningMessage(`P4: unable to open file: ${filePath}`);
    }
  }

  async autoCheckoutDocumentIfNeeded(document: vscode.TextDocument): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('cursorToolWindow').get<boolean>('p4.autoCheckoutOnEdit', true);
    if (!enabled || !document || document.isUntitled || document.uri.scheme !== 'file') {
      return;
    }

    const key = document.uri.toString();
    if (this.autoP4CheckoutSeen.has(key) || this.autoP4CheckoutInFlight.has(key)) {
      return;
    }

    this.autoP4CheckoutInFlight.add(key);
    try {
      const openedText = await this.runP4(['opened', document.uri.fsPath], this.getP4WorkingDirectory()).catch((error: any) => {
        return String(error?.stdout || error?.stderr || error?.message || '');
      });
      if (openedText && / - [a-zA-Z]+ change /.test(openedText)) {
        this.autoP4CheckoutSeen.add(key);
        return;
      }

      const editText = await this.runP4(['edit', document.uri.fsPath], this.getP4WorkingDirectory()).catch((error: any) => {
        return String(error?.stdout || error?.stderr || error?.message || '');
      });
      if (/ - opened for edit/i.test(editText) || / - currently opened/i.test(editText) || / - also opened/i.test(editText)) {
        this.autoP4CheckoutSeen.add(key);
        void this.refreshP4Snapshot();
      }
    } finally {
      this.autoP4CheckoutInFlight.delete(key);
    }
  }

  clearAutoP4CheckoutTracking(uri: vscode.Uri | undefined): void {
    if (!uri) {
      return;
    }
    const key = uri.toString();
    this.autoP4CheckoutSeen.delete(key);
    this.autoP4CheckoutInFlight.delete(key);
  }

  postSwitchPinExTab(tab: string): void {
    if (!this.view) {
      this.pendingPinExTab = tab;
      return;
    }
    this.view.webview.postMessage({
      type: 'switchPinExTab',
      tab: tab
    });
  }

  postPinExLocateToUri(uri: vscode.Uri): void {
    this.postPinExLocateToUriString(uri.toString());
  }

  private postPinExLocateToUriString(uri: string): void {
    if (!this.view) {
      this.pendingPinExLocateUri = uri;
      return;
    }
    this.view.webview.postMessage({
      type: 'pinExLocateToUri',
      uri: uri
    });
  }

  // (Cursor FRE Panel 预览已移除)

  private addOrReplaceReferenceSession(session: ReferenceSession): void {
    if (!session.pinned) {
      // 规则：最多保留 1 个“未固定”的当前结果；新的搜索会覆盖它
      const idx = this.referenceSessions.findIndex(s => !s.pinned);
      if (idx >= 0) {
        this.referenceSessions.splice(idx, 1, session);
      } else {
        this.referenceSessions.push(session);
      }
      this.activeReferenceSessionId = session.id;
      this.persistReferenceSessions();
      return;
    }

    // 固定结果：可保留多次搜索
    this.referenceSessions.push(session);
    this.activeReferenceSessionId = session.id;
    this.persistReferenceSessions();
  }

  private setReferenceSessionPinned(id: string, pinned: boolean): void {
    const idx = this.referenceSessions.findIndex(s => s.id === id);
    if (idx < 0) {
      return;
    }
    const session = this.referenceSessions[idx];
    session.pinned = pinned;

    if (!pinned) {
      // 取消固定后，仍然遵循“仅 1 个未固定结果”的规则
      for (let i = this.referenceSessions.length - 1; i >= 0; i--) {
        if (this.referenceSessions[i].id !== id && !this.referenceSessions[i].pinned) {
          this.referenceSessions.splice(i, 1);
        }
      }
      // 放到末尾作为“当前”
      this.referenceSessions.splice(idx, 1);
      this.referenceSessions.push(session);
    }

    this.activeReferenceSessionId = session.id;
    this.persistReferenceSessions();
    this.postReferenceSessions();
  }

  private deleteReferenceSession(id: string): void {
    const idx = this.referenceSessions.findIndex(s => s.id === id);
    if (idx < 0) {
      return;
    }
    this.referenceSessions.splice(idx, 1);
    if (this.activeReferenceSessionId === id) {
      const last = this.referenceSessions.length ? this.referenceSessions[this.referenceSessions.length - 1] : null;
      this.activeReferenceSessionId = last ? last.id : null;
    }
    this.persistReferenceSessions();
    this.postReferenceSessions();
  }

  private getContainerNameFromSymbols(symbols: vscode.DocumentSymbol[] | undefined, pos: vscode.Position): string | null {
    if (!symbols || !symbols.length) {
      return null;
    }
    let bestName: string | null = null;
    let bestSpan: number = Number.MAX_VALUE;

    const walk = (list: vscode.DocumentSymbol[]) => {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.range && s.range.contains(pos)) {
          // 只关心类型符号作为“容器”
          if (
            s.kind === vscode.SymbolKind.Class ||
            s.kind === vscode.SymbolKind.Struct ||
            s.kind === vscode.SymbolKind.Interface ||
            s.kind === vscode.SymbolKind.Enum
          ) {
            const span = (s.range.end.line - s.range.start.line) * 100000 + (s.range.end.character - s.range.start.character);
            if (span >= 0 && span < bestSpan) {
              bestSpan = span;
              bestName = s.name;
            }
          }
          if (s.children && s.children.length) {
            walk(s.children);
          }
        }
      }
    };
    walk(symbols);
    return bestName;
  }

  private getSymbolKindAtPosition(symbols: vscode.DocumentSymbol[] | undefined, pos: vscode.Position): 'field' | 'property' | 'method' | 'unknown' {
    if (!symbols || !symbols.length) {
      return 'unknown';
    }
    let bestKind: vscode.SymbolKind | null = null;
    let bestSpan: number = Number.MAX_VALUE;
    const walk = (list: vscode.DocumentSymbol[]) => {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.range && s.range.contains(pos)) {
          const span = (s.range.end.line - s.range.start.line) * 100000 + (s.range.end.character - s.range.start.character);
          if (span >= 0 && span < bestSpan) {
            bestSpan = span;
            bestKind = s.kind;
          }
          if (s.children && s.children.length) {
            walk(s.children);
          }
        }
      }
    };
    walk(symbols);
    if (bestKind === null) return 'unknown';
    if (bestKind === vscode.SymbolKind.Field || bestKind === vscode.SymbolKind.Variable) return 'field';
    if (bestKind === vscode.SymbolKind.Property) return 'property';
    if (bestKind === vscode.SymbolKind.Method || bestKind === vscode.SymbolKind.Function || bestKind === vscode.SymbolKind.Constructor) return 'method';
    return 'unknown';
  }

  private findTypeSymbolAtPosition(symbols: vscode.DocumentSymbol[] | undefined, pos: vscode.Position): vscode.DocumentSymbol | null {
    if (!symbols || !symbols.length) {
      return null;
    }
    let best: vscode.DocumentSymbol | null = null;
    let bestSpan: number = Number.MAX_VALUE;
    const walk = (list: vscode.DocumentSymbol[]) => {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.range && s.range.contains(pos)) {
          if (
            s.kind === vscode.SymbolKind.Class ||
            s.kind === vscode.SymbolKind.Struct ||
            s.kind === vscode.SymbolKind.Interface ||
            s.kind === vscode.SymbolKind.Enum
          ) {
            const span = (s.range.end.line - s.range.start.line) * 100000 + (s.range.end.character - s.range.start.character);
            if (span >= 0 && span < bestSpan) {
              bestSpan = span;
              best = s;
            }
          }
          if (s.children && s.children.length) {
            walk(s.children);
          }
        }
      }
    };
    walk(symbols);
    return best;
  }

  private inferSymbolKindByNameInContainer(
    symbols: vscode.DocumentSymbol[] | undefined,
    pos: vscode.Position,
    symbolName: string
  ): 'field' | 'property' | 'method' | 'unknown' {
    if (!symbols || !symbols.length || !symbolName) {
      return 'unknown';
    }
    const typeSym = this.findTypeSymbolAtPosition(symbols, pos);
    const list = typeSym && typeSym.children ? typeSym.children : symbols;

    let seenField = false;
    let seenProperty = false;
    let seenMethod = false;

    const walk = (arr: vscode.DocumentSymbol[]) => {
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.name === symbolName) {
          if (s.kind === vscode.SymbolKind.Field || s.kind === vscode.SymbolKind.Variable) {
            seenField = true;
          } else if (s.kind === vscode.SymbolKind.Property) {
            seenProperty = true;
          } else if (
            s.kind === vscode.SymbolKind.Method ||
            s.kind === vscode.SymbolKind.Function ||
            s.kind === vscode.SymbolKind.Constructor
          ) {
            seenMethod = true;
          }
        }
        if (s.children && s.children.length) {
          walk(s.children);
        }
      }
    };
    walk(list);

    // 优先级：字段 > 属性 > 方法
    if (seenField) return 'field';
    if (seenProperty) return 'property';
    if (seenMethod) return 'method';
    return 'unknown';
  }

  private classifyFieldAccess(lineText: string, symbol: string): 'read' | 'write' | undefined {
    if (!lineText || !symbol) {
      return undefined;
    }
    // 简单启发式：匹配到明显写入则算 write，否则算 read
    // write：x =, x +=, ++x, x++, x--, --x, x <<= 等
    // 注意：需要排除 == 和 === 比较操作符
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const writePatterns = [
      // =(?!=) 使用否定前瞻，确保 = 后面不是 =，从而排除 == 和 ===
      new RegExp(`\\b${escaped}\\b\\s*(=(?!=)|\\+=|-=|\\*=|/=|%=|\\|=|&=|\\^=|<<=|>>=)`),
      new RegExp(`(\\+\\+|--)\\s*\\b${escaped}\\b`),
      new RegExp(`\\b${escaped}\\b\\s*(\\+\\+|--)`)
    ];
    for (let i = 0; i < writePatterns.length; i++) {
      if (writePatterns[i].test(lineText)) {
        return 'write';
      }
    }
    return 'read';
  }

  private classifyMethodReferenceRole(lineText: string, symbol: string): 'call' | 'noncall' | undefined {
    if (!lineText || !symbol) {
      return undefined;
    }

    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const trimmed = lineText.trim();
    const lowered = trimmed.toLowerCase();
    const anyInvocationPattern = new RegExp(`\\b${escaped}\\s*(?:<[^>]+>\\s*)?\\(`);
    const invocationPattern = new RegExp(`\\b(?:base\\s*\\.\\s*|this\\s*\\.\\s*|[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*)?${escaped}\\s*(?:<[^>]+>\\s*)?\\(`);
    const declarationPattern = new RegExp(`\\b(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|unsafe|new|partial|abstract)\\b[^(){};=]*\\b${escaped}\\s*\\(`);

    if (!anyInvocationPattern.test(trimmed)) {
      return 'noncall';
    }
    if (/\boverride\b/.test(lowered) && anyInvocationPattern.test(trimmed)) {
      return 'noncall';
    }
    if (declarationPattern.test(trimmed)) {
      return 'noncall';
    }
    if (invocationPattern.test(trimmed)) {
      return 'call';
    }
    return 'noncall';
  }

  clearReferenceQueryCache(): void {
    this.referenceQueryCache.clear();
  }

  private buildReferenceQueryCacheKey(
    mode: ReferenceSearchMode,
    doc: vscode.TextDocument,
    pos: vscode.Position,
    symbolName: string
  ): string {
    return [
      mode,
      doc.uri.toString(),
      String(doc.version),
      String(pos.line),
      String(pos.character),
      symbolName || ''
    ].join('|');
  }

  private async buildReferenceResultsFast(
    locations: vscode.Location[],
    queryKind: 'field' | 'property' | 'method' | 'unknown',
    symbolName: string
  ): Promise<ReferenceResultItem[]> {
    const byUri: Record<string, vscode.Location[]> = {};
    locations.forEach(l => {
      const key = l.uri.toString();
      if (!byUri[key]) {
        byUri[key] = [];
      }
      byUri[key].push(l);
    });

    const uriKeys = Object.keys(byUri);
    const filePayloads = await Promise.all(uriKeys.map(async uriStr => {
      const fileUri = vscode.Uri.parse(uriStr);
      let fileDoc: vscode.TextDocument | null = null;
      try {
        fileDoc = await vscode.workspace.openTextDocument(fileUri);
      } catch {
        fileDoc = null;
      }
      const rel = vscode.workspace.asRelativePath(fileUri, false);
      const baseName = (rel || uriStr).replace(/\\/g, '/').split('/').pop() || (rel || uriStr);
      return { uriStr, rel, baseName, fileDoc };
    }));

    const results: ReferenceResultItem[] = [];
    filePayloads.forEach(payload => {
      const fileLocations = byUri[payload.uriStr] || [];
      fileLocations.forEach(l => {
        const line = l.range.start.line;
        const ch = l.range.start.character;
        let preview = '';
        if (payload.fileDoc && line >= 0 && line < payload.fileDoc.lineCount) {
          preview = (payload.fileDoc.lineAt(line).text || '').trim();
        }
        let access: 'read' | 'write' | undefined = undefined;
        let callRole: 'call' | 'noncall' | undefined = undefined;
        if ((queryKind === 'field' || queryKind === 'property') && symbolName) {
          access = this.classifyFieldAccess(preview, symbolName);
        }
        if (queryKind === 'method' && symbolName) {
          callRole = this.classifyMethodReferenceRole(preview, symbolName);
        }
        results.push({
          uri: payload.uriStr,
          file: payload.rel,
          line: line,
          character: ch,
          preview: preview,
          container: payload.baseName,
          access: access,
          callRole: callRole
        } as any);
      });
    });

    results.sort((a, b) => {
      const fa = (a.file || a.uri).toLowerCase();
      const fb = (b.file || b.uri).toLowerCase();
      if (fa < fb) return -1;
      if (fa > fb) return 1;
      if (a.line < b.line) return -1;
      if (a.line > b.line) return 1;
      return a.character - b.character;
    });

    return results;
  }

  private toLocationArray(raw: any): vscode.Location[] {
    // execute*Provider 可能返回 Location[] 或 LocationLink[]（甚至 undefined / 混合）
    const items: any[] = Array.isArray(raw) ? raw : [];
    const out: vscode.Location[] = [];
    for (let i = 0; i < items.length; i++) {
      const it: any = items[i];
      if (!it) continue;

      // Location: { uri, range }
      if (it.uri && it.range) {
        try {
          out.push(new vscode.Location(it.uri, it.range));
        } catch {
          // ignore
        }
        continue;
      }

      // LocationLink: { targetUri, targetRange, targetSelectionRange }
      if (it.targetUri && (it.targetSelectionRange || it.targetRange)) {
        try {
          out.push(new vscode.Location(it.targetUri, it.targetSelectionRange || it.targetRange));
        } catch {
          // ignore
        }
        continue;
      }
    }
    return out;
  }

  async findReferencesExFromActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const pos = editor.selection.active;
    const wordRange = doc.getWordRangeAtPosition(pos);
    const symbolName = wordRange ? doc.getText(wordRange) : '';
    const cacheKey = this.buildReferenceQueryCacheKey('references', doc, pos, symbolName);
    const cached = this.referenceQueryCache.get(cacheKey);
      if (cached && (Date.now() - cached.cachedAt) < 30000) {
      this.addOrReplaceReferenceSession({
        ...cached.session,
        id: 'ref_' + String(this.referenceSeq++) + '_' + String(Date.now()),
        createdAt: Date.now(),
        pinned: false
      });
      this.postReferenceSessions();
      if (cached.total > 500) {
        const suffix = cached.session.results.length < cached.total ? ` Loaded ${cached.session.results.length} for browsing.` : '';
        vscode.window.showInformationMessage(`Find References Ex: too many results. Showing first 500 (total ${cached.total}).${suffix}`);
      }
      return;
    }

    let queryKind: 'field' | 'property' | 'method' | 'unknown' = 'unknown';
    let queryContainer: string | null = null;
    let rootSymbols: vscode.DocumentSymbol[] | undefined = undefined;
    try {
      rootSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );
      queryContainer = this.getContainerNameFromSymbols(rootSymbols, pos);
      // 关键修正：光标通常在“使用处”，不在声明 range 内，用“同类成员名”推断字段/属性/方法
      if (symbolName) {
        queryKind = this.inferSymbolKindByNameInContainer(rootSymbols, pos, symbolName);
      } else {
        queryKind = this.getSymbolKindAtPosition(rootSymbols, pos);
      }
    } catch {
      queryKind = 'unknown';
      queryContainer = null;
      rootSymbols = undefined;
    }

    let locations: vscode.Location[] | undefined;
    try {
      locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        doc.uri,
        pos
      );
    } catch (e) {
      console.log('[CursorEx] FindReferencesEx error:', e);
      vscode.window.showWarningMessage('Find References Ex failed: the current language service may not support reference search.');
      return;
    }

    const locs = this.toLocationArray(locations);
    const displayMax = 500;
    const storeMax = 2000;
    const used = locs.length > storeMax ? locs.slice(0, storeMax) : locs;

    const results = await this.buildReferenceResultsFast(used, queryKind, symbolName);

    const id = 'ref_' + String(this.referenceSeq++) + '_' + String(Date.now());
    const titleSymbol = symbolName || 'Symbol';
    // 需求：搜索记录不显示文件，只显示类名/符号名
    const title = queryContainer ? `${queryContainer}.${titleSymbol}` : `${titleSymbol}`;

    const session: ReferenceSession = {
      id: id,
      title: title,
      mode: 'references',
      pinned: false,
      createdAt: Date.now(),
      totalCount: locs.length,
      query: {
        uri: doc.uri.toString(),
        line: pos.line,
        character: pos.character,
        symbol: titleSymbol,
        kind: queryKind
      },
      results: results
    };

    this.referenceQueryCache.set(cacheKey, {
      session: session,
      total: locs.length,
      cachedAt: Date.now()
    });

    this.addOrReplaceReferenceSession(session);
    this.postReferenceSessions();

    // 如果结果被截断，给个提示
    if (locs.length > displayMax) {
      const storedCount = used.length;
      const suffix = storedCount < locs.length ? ` Loaded ${storedCount} for browsing.` : '';
      vscode.window.showInformationMessage(`Find References Ex: too many results. Showing first ${displayMax} (total ${locs.length}).${suffix}`);
    }
  }

  async findImplementationsExFromActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const pos = editor.selection.active;
    const wordRange = doc.getWordRangeAtPosition(pos);
    const symbolName = wordRange ? doc.getText(wordRange) : '';
    const cacheKey = this.buildReferenceQueryCacheKey('implementations', doc, pos, symbolName);
    const cached = this.referenceQueryCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < 30000) {
      this.addOrReplaceReferenceSession({
        ...cached.session,
        id: 'impl_' + String(this.referenceSeq++) + '_' + String(Date.now()),
        createdAt: Date.now(),
        pinned: false
      });
      this.postReferenceSessions();
      if (cached.total > 500) {
        const suffix = cached.session.results.length < cached.total ? ` Loaded ${cached.session.results.length} for browsing.` : '';
        vscode.window.showInformationMessage(`Find Implementations Ex: too many results. Showing first 500 (total ${cached.total}).${suffix}`);
      }
      return;
    }

    let queryKind: 'field' | 'property' | 'method' | 'unknown' = 'unknown';
    let queryContainer: string | null = null;
    let rootSymbols: vscode.DocumentSymbol[] | undefined = undefined;
    try {
      rootSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );
      queryContainer = this.getContainerNameFromSymbols(rootSymbols, pos);
      // 光标通常在“使用处”，不在声明 range 内：用“同类成员名”推断字段/属性/方法
      if (symbolName) {
        queryKind = this.inferSymbolKindByNameInContainer(rootSymbols, pos, symbolName);
      } else {
        queryKind = this.getSymbolKindAtPosition(rootSymbols, pos);
      }
    } catch {
      queryKind = 'unknown';
      queryContainer = null;
      rootSymbols = undefined;
    }

    let raw: any;
    try {
      raw = await vscode.commands.executeCommand<any>(
        'vscode.executeImplementationProvider',
        doc.uri,
        pos
      );
    } catch (e) {
      console.log('[CursorEx] FindImplementationsEx error:', e);
      vscode.window.showWarningMessage('Find Implementations Ex failed: the current language service may not support implementation search.');
      return;
    }

    const locs = this.toLocationArray(raw);
    const displayMax = 500;
    const storeMax = 2000;
    const used = locs.length > storeMax ? locs.slice(0, storeMax) : locs;

    const results = await this.buildReferenceResultsFast(used, queryKind, symbolName);

    const id = 'impl_' + String(this.referenceSeq++) + '_' + String(Date.now());
    const titleSymbol = symbolName || 'Symbol';
    // 需求：搜索记录不显示文件，只显示类名/符号名（用上方模式标签区分引用/实现）
    const title = queryContainer ? `${queryContainer}.${titleSymbol}` : `${titleSymbol}`;

    const session: ReferenceSession = {
      id: id,
      title: title,
      mode: 'implementations',
      pinned: false,
      createdAt: Date.now(),
      totalCount: locs.length,
      query: {
        uri: doc.uri.toString(),
        line: pos.line,
        character: pos.character,
        symbol: titleSymbol,
        kind: queryKind
      },
      results: results
    };

    this.referenceQueryCache.set(cacheKey, {
      session: session,
      total: locs.length,
      cachedAt: Date.now()
    });

    this.addOrReplaceReferenceSession(session);
    this.postReferenceSessions();

    if (locs.length > displayMax) {
      const storedCount = used.length;
      const suffix = storedCount < locs.length ? ` Loaded ${storedCount} for browsing.` : '';
      vscode.window.showInformationMessage(`Find Implementations Ex: too many results. Showing first ${displayMax} (total ${locs.length}).${suffix}`);
    }
  }

  // 发送当前光标行号和文件 URI 到 webview，用于符号面板定位
  postCursorLine(line: number, uri?: vscode.Uri): void {
    if (!this.view) {
      console.log('[CursorEx] postCursorLine: no view');
      return;
    }
    const uriStr = uri?.toString() || '';
    console.log('[CursorEx] postCursorLine: line=' + line + ' uri=' + uriStr.substring(uriStr.length - 30));
    this.view.webview.postMessage({ type: 'cursorLine', line: line, uri: uriStr });
  }

  async postSymbols(): Promise<void> {
    console.log('[CursorEx] postSymbols called');
    if (!this.view) {
      console.log('[CursorEx] No view, returning');
      return;
  }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      console.log('[CursorEx] No active editor');
      this.view.webview.postMessage({ type: 'symbols', uri: null, classes: [], members: [] });
      return;
    }
    const doc = editor.document;
    const uri = doc.uri.toString();
    const ext = doc.fileName.split('.').pop()?.toLowerCase();
    console.log('[CursorEx] File extension:', ext);
    
    // 只解析 C# 文件
    if (ext !== 'cs') {
      console.log('[CursorEx] Not a C# file');
      this.view.webview.postMessage({ type: 'symbols', uri: uri, classes: [], members: [], notCs: true });
      return;
    }

    interface SymbolItem {
      name: string;
      kind: 'class' | 'struct' | 'interface' | 'enum' | 'field' | 'property' | 'method' | 'event' | 'constructor' | 'namespace';
      line: number;
      signature?: string;
      type?: string;  // 变量/属性的类型，或函数的参数
      parentClass?: string;
    }

    const classes: SymbolItem[] = [];
    const members: SymbolItem[] = [];

    // 使用 VS Code 内置的符号提供者
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );

      if (symbols && symbols.length > 0) {
        // 递归处理符号
        const processSymbols = (symbolList: vscode.DocumentSymbol[], parentName?: string) => {
          for (const sym of symbolList) {
            const line = sym.range.start.line;
            const name = sym.name;
            
            // 类型符号
            if (sym.kind === vscode.SymbolKind.Class) {
              classes.push({ name, kind: 'class', line, signature: name });
              if (sym.children) {
                processSymbols(sym.children, name);
              }
            } else if (sym.kind === vscode.SymbolKind.Struct) {
              classes.push({ name, kind: 'struct', line, signature: name });
              if (sym.children) {
                processSymbols(sym.children, name);
  }
            } else if (sym.kind === vscode.SymbolKind.Interface) {
              classes.push({ name, kind: 'interface', line, signature: name });
              if (sym.children) {
                processSymbols(sym.children, name);
  }
            } else if (sym.kind === vscode.SymbolKind.Enum) {
              classes.push({ name, kind: 'enum', line, signature: name });
              if (sym.children) {
                processSymbols(sym.children, name);
              }
            } else if (sym.kind === vscode.SymbolKind.Namespace || sym.kind === vscode.SymbolKind.Module) {
              // 命名空间，继续处理子符号
              if (sym.children) {
                processSymbols(sym.children, parentName);
    }
            } else if (parentName) {
              // 成员符号
              let kind: SymbolItem['kind'] = 'field';
              let memberName = name;
              let type = sym.detail || '';
              
              if (sym.kind === vscode.SymbolKind.Method || sym.kind === vscode.SymbolKind.Function) {
                kind = 'method';
                // name 可能已经包含参数如 "Method(int, string)"，直接使用
                type = ''; // 方法不需要额外的 type
              } else if (sym.kind === vscode.SymbolKind.Constructor) {
                kind = 'constructor';
                type = '';
              } else if (sym.kind === vscode.SymbolKind.Property) {
                kind = 'property';
                // detail 可能包含类型信息，但也可能和 name 相同
              } else if (sym.kind === vscode.SymbolKind.Field || sym.kind === vscode.SymbolKind.Variable) {
                kind = 'field';
              } else if (sym.kind === vscode.SymbolKind.Event) {
                kind = 'event';
              } else if (sym.kind === vscode.SymbolKind.EnumMember) {
                kind = 'field';
                type = ''; // 枚举成员不需要类型
              }
              
              members.push({
                name: memberName,
                kind,
                line,
                signature: memberName,
                type,
                parentClass: parentName
              });
    }
  }
        };

        processSymbols(symbols);
      }

      // 使用手动解析来获取正确的类型信息
      // VS Code 符号提供者的 detail 字段格式不一致，无法可靠地获取类型
      console.log('[CursorEx] Using manual parse for accurate type info');
      classes.length = 0;
      members.length = 0;
      this.parseSymbolsManually(doc, classes, members);
    } catch (e) {
      // 如果符号提供者失败，使用手动解析
      console.log('[CursorEx] Symbol parse error:', e);
      this.parseSymbolsManually(doc, classes, members);
    }

    this.view.webview.postMessage({
      type: 'symbols',
      uri: uri,
      fileName: doc.fileName.split(/[\\/]/).pop() || '',
      classes: classes,
      members: members
    });
  }

  private parseSymbolsManually(doc: vscode.TextDocument, classes: any[], members: any[]): void {
    console.log('[CursorEx] parseSymbolsManually called, file:', doc.fileName);
    const text = doc.getText();
    const lines = text.split('\n');
    console.log('[CursorEx] Total lines:', lines.length);

    /**
     * 移除同一行内的注释（// 与 /* *\/），尽量避免误伤字符串/字符字面量。
     * 说明：这里只处理“单行内”的块注释；跨行块注释仍由 inMultiLineComment 逻辑负责。
     */
    const stripInlineComments = (src: string): string => {
      let out = '';
      let inStr = false; // 普通字符串 "..."
      let inVerbatimStr = false; // 逐字字符串 @"..."
      let inChar = false; // 字符常量 'a'

      for (let idx = 0; idx < src.length; idx++) {
        const ch = src[idx];
        const next = idx + 1 < src.length ? src[idx + 1] : '';

        // 处理逐字字符串结束："" 表示转义引号，不结束
        if (inVerbatimStr) {
          out += ch;
          if (ch === '"') {
            if (next === '"') {
              // "" -> 转义引号，吞掉下一个
              out += next;
              idx++;
            } else {
              inVerbatimStr = false;
            }
          }
          continue;
        }

        // 处理普通字符串 / 字符常量
        if (inStr) {
          out += ch;
          if (ch === '"' && (idx === 0 || src[idx - 1] !== '\\')) {
            inStr = false;
          }
          continue;
        }
        if (inChar) {
          out += ch;
          if (ch === '\'' && (idx === 0 || src[idx - 1] !== '\\')) {
            inChar = false;
          }
          continue;
        }

        // 不在字符串/字符中：检测注释起始
        if (ch === '/' && next === '/') {
          break; // 行注释：忽略后续
        }
        if (ch === '/' && next === '*') {
          // 同行块注释：跳过直到 */
          const end = src.indexOf('*/', idx + 2);
          if (end < 0) {
            break; // 注释到行尾
          }
          idx = end + 1; // for-loop 会再 +1
          continue;
        }

        // 进入逐字字符串 @"..."
        if (ch === '@' && next === '"') {
          out += ch;
          out += next;
          idx++;
          inVerbatimStr = true;
          continue;
        }
        // 进入普通字符串 "..."
        if (ch === '"') {
          out += ch;
          inStr = true;
          continue;
        }
        // 进入字符常量 'a'
        if (ch === '\'') {
          out += ch;
          inChar = true;
          continue;
        }

        out += ch;
      }

      return out;
    };

    // 匹配类、结构体、接口、枚举
    const classRegex = /\b(class|struct|interface|enum)\s+(\w+)/;
    // 匹配方法（捕获返回类型、函数名和参数）
    // 格式：[修饰符] 返回类型 方法名(参数)
    const methodRegex = /^\s*(?:public|private|protected|internal|static|virtual|override|abstract|async|extern|new)\s+.*?(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*(\([^)]*\))/;
    // 匹配属性 - 格式：[修饰符] 类型 属性名 {
    const propertyRegex = /^\s*(?:public|private|protected|internal|static|virtual|override|abstract|new)\s+.*?(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*\{/;
    // 匹配字段 - 格式：[修饰符] 类型 字段名 [=|;]
    const fieldRegex = /^\s*(?:public|private|protected|internal|static|readonly|const|new)\s+.*?(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*[=;]/;

    let currentClass: string | undefined;
    let currentClassKind: 'class' | 'struct' | 'interface' | 'enum' | undefined;
    let braceDepth = 0;
    let classStartDepth = 0;
    let classBodyEntered = false;  // 是否已经进入类的大括号内部
    let inMultiLineComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const codeLine = stripInlineComments(line);
      const trimmedCodeLine = codeLine.trim();
      
      // 跳过空行
      if (trimmedCodeLine === '') {
        continue;
    }

      // 处理多行注释
      if (inMultiLineComment) {
        if (trimmedLine.includes('*/')) {
          inMultiLineComment = false;
        }
        continue;
  }
      if (trimmedLine.startsWith('/*')) {
        inMultiLineComment = !trimmedLine.includes('*/');
        continue;
      }
      // 跳过单行注释
      if (trimmedLine.startsWith('//')) {
        continue;
  }

      // 计算大括号深度（简单处理，忽略字符串中的大括号）
      let openBraces = 0;
      let closeBraces = 0;
      let inStr = false;
      for (let c = 0; c < codeLine.length; c++) {
        const ch = codeLine[c];
        if (ch === '"' && (c === 0 || codeLine[c-1] !== '\\')) {
          inStr = !inStr;
        }
        if (!inStr) {
          if (ch === '{') openBraces++;
          if (ch === '}') closeBraces++;
        }
      }

      // 记录本行更新大括号深度前的层级，用于判断是否处于“类型顶层”
      // 这样可以支持无访问修饰符的成员声明，同时避免误把方法体内的局部变量当成字段。
      const depthBefore = braceDepth;

      // 检测类定义
      const classMatch = codeLine.match(classRegex);
      if (classMatch && !currentClass) {
        const kind = classMatch[1] as 'class' | 'struct' | 'interface' | 'enum';
        const name = classMatch[2];
        classes.push({
          name: name,
          kind: kind,
          line: i,
          signature: trimmedCodeLine.replace(/\{.*$/, '').trim()
        });
        currentClass = name;
        currentClassKind = kind;  // 保存类型
        classStartDepth = braceDepth;
        classBodyEntered = false;  // 还没进入类的 { }
  }

      // 更新大括号深度
      braceDepth += openBraces - closeBraces;
      
      // 检测是否进入了类的大括号内部
      if (currentClass && !classBodyEntered && braceDepth > classStartDepth) {
        classBodyEntered = true;
    }
      
      // 枚举成员检测（不需要访问修饰符）
      if (currentClass && classBodyEntered && currentClassKind === 'enum' && !classMatch) {
        // 枚举成员格式：Name, 或 Name = value,
        const enumMemberMatch = trimmedCodeLine.match(/^(\w+)\s*(?:=\s*[^,]+)?[,]?$/);
        if (enumMemberMatch && !trimmedCodeLine.startsWith('//') && !trimmedCodeLine.startsWith('{') && !trimmedCodeLine.startsWith('}')) {
          members.push({
            name: enumMemberMatch[1],
            kind: 'field',
            line: i,
            signature: enumMemberMatch[1],
            type: '',
            parentClass: currentClass
          });
    }
  }
      
      // 在类内部检测成员
      const atTypeTopLevel = !!currentClass && classBodyEntered && depthBefore === classStartDepth + 1;
      
      // 检测成员：已进入类内部，且处于类型顶层（不在方法体/访问器内部），不是类定义，不是枚举（枚举已单独处理）
      if (currentClass && classBodyEntered && !classMatch && atTypeTopLevel && currentClassKind !== 'enum') {
          // 构造函数 - 类名后直接跟括号
          if (new RegExp(`\\b${currentClass}\\s*\\(`).test(codeLine)) {
            const ctorMatch = codeLine.match(new RegExp(`${currentClass}\\s*(\\([^)]*\\))`));
            if (ctorMatch) {
              members.push({
                name: currentClass,
                kind: 'constructor',
                line: i,
                signature: currentClass,
                type: ctorMatch[1],
                parentClass: currentClass
              });
            }
          }
          // 字段 - 有 = 或 以;结尾（优先检测，避免 new Xxx() 被误判为方法）
          // 匹配格式：修饰符 类型 变量名 = ... 或 修饰符 类型 变量名;
          else if (/\s+\w+\s*[=;]/.test(codeLine) && !/\)\s*$/.test(trimmedCodeLine) && !/\)\s*\{/.test(codeLine)) {
            const match = codeLine.match(/(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*[=;]/);
            if (match && !['return', 'if', 'else', 'for', 'while', 'var', 'using', 'throw', 'new', 'get', 'set', 'class', 'struct', 'interface', 'enum'].includes(match[2])) {
              members.push({
                name: match[2],
                kind: 'field',
                line: i,
                signature: match[2],
                type: match[1],
                parentClass: currentClass
              });
            }
          }
          // 属性 - 有 { 但没有 (
          else if (codeLine.includes('{') && !codeLine.includes('(')) {
            const match = codeLine.match(/(\S+)\s+(\w+)\s*\{/);
            if (match && !['if', 'for', 'while', 'switch', 'get', 'set', 'class', 'struct', 'interface', 'enum'].includes(match[2])) {
              members.push({
                name: match[2],
                kind: 'property',
                line: i,
                signature: match[2],
                type: match[1],
                parentClass: currentClass
              });
          }
          }
          // 方法 - 有括号但不是构造函数，且不是字段/属性
          else if (codeLine.includes('(') && codeLine.includes(')')) {
            // 排除带 = new 的字段初始化
            if (!/=\s*new\s+/.test(codeLine)) {
              const match = codeLine.match(/(\w+)\s*(\([^)]*\))/);
              if (match && !['if', 'for', 'while', 'switch', 'catch', 'using', 'lock', 'foreach', 'return', 'throw', 'new'].includes(match[1])) {
                console.log('[CursorEx] Found method:', match[1], 'at line', i);
                members.push({
                  name: match[1],
                  kind: 'method',
                  line: i,
                  signature: match[1],
                  type: match[2],
                  parentClass: currentClass
                });
          }
            }
      }
      }

      // 如果回到类开始的深度，说明类结束了（只有在已进入类内部后才检查）
      if (currentClass && classBodyEntered && braceDepth <= classStartDepth) {
        currentClass = undefined;
        currentClassKind = undefined;
        classBodyEntered = false;
      }
    }
    
    // 日志：解析结果
    console.log('[CursorEx] Manual parse done: classes=' + classes.length + ', members=' + members.length);
    if (members.length > 0) {
      console.log('[CursorEx] First member:', JSON.stringify(members[0]));
    }
  }

  postComments(): void {
    if (!this.view) {
      return;
    }
    const items = this.comments.getComments();
    const payload = items.map(c => ({
      uri: c.uri.toString(),
      file: vscode.workspace.asRelativePath(c.uri, false),
      line: c.line,
      text: c.text
    }));
    this.view.webview.postMessage({ type: 'comments', comments: payload });
  }

  postPinEx(): void {
    if (!this.view) {
      return;
    }
    const items = this.pinEx.getItemsSortedByRecent();
    const payload = items.map(i => ({
      uri: i.uri.toString(),
      file: vscode.workspace.asRelativePath(i.uri, false),
      isDirectory: i.isDirectory,
      pinnedAt: i.pinnedAt,
      lastUsedAt: i.lastUsedAt
    }));
    this.view.webview.postMessage({ type: 'pinExItems', items: payload });
  }

  private async listPinExDir(dir: vscode.Uri): Promise<void> {
    if (!this.view) {
      return;
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      const items = entries.map(entry => {
        const name = entry[0];
        const type = entry[1];
        const childUri = vscode.Uri.joinPath(dir, name);
        const isDirectory = (type & vscode.FileType.Directory) !== 0;
        return {
          uri: childUri.toString(),
          file: vscode.workspace.asRelativePath(childUri, false),
          isDirectory
        };
      });
      this.view.webview.postMessage({
        type: 'pinExDirChildren',
        uri: dir.toString(),
        items
      });
    } catch {
      // ignore
    }
  }

  highlightActiveComment(payload: { uri: vscode.Uri; line: number } | null): void {
    if (!this.view) {
      return;
    }
    if (!payload) {
      this.view.webview.postMessage({ type: 'activeComment', uri: null, line: null });
      return;
    }
    this.view.webview.postMessage({
      type: 'activeComment',
      uri: payload.uri.toString(),
      line: payload.line
    });
  }

  notifyPinExFsChanged(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'pinExFsChanged' });
  }
}

let sidebarProvider: CursorToolSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  context.globalState.setKeysForSync([VCS_PROVIDER_STATE_KEY]);
  const scanner = new TodoScanner(context);
  const commentManager = new CommentManager(context);
  const pinExManager = new PinExManager(context);
  const searchIndex = new WorkspaceSearchIndex(context);
  const updateService = new GithubReleaseUpdateService(context);
  const provider = new CursorToolSidebarProvider(context, scanner, commentManager, pinExManager);

  context.subscriptions.push(searchIndex);
  void searchIndex.initialize();
  workspaceSearchIndexRef = searchIndex;
  searchIndex.onDidChange(() => {
    settingsPanel?.webview.postMessage({
      type: 'searchIndexSnapshot',
      snapshot: searchIndex.getSnapshot()
    });
  });
  sidebarProvider = provider;
  updateServiceRef = updateService;

  const startupUpdateTimer = setTimeout(() => {
    void updateService.checkOnStartup();
  }, UPDATE_STARTUP_DELAY_MS);
  context.subscriptions.push({
    dispose: () => clearTimeout(startupUpdateTimer)
  });

  scanner.onDidChange(() => provider.postTodos());
  scanner.onScanningChange(isScanning => provider.postTodoScanning(isScanning));
  commentManager.onDidChange(() => provider.postComments());
  commentManager.onDidActiveLineComment(p => provider.highlightActiveComment(p));
  pinExManager.onDidChange(() => provider.postPinEx());
  provider.updateVcsContexts();
  void provider.refreshP4Snapshot();
  void provider.refreshSvnSnapshot();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cursorToolWindow.vcs')) {
        provider.refreshGlobalSettings();
      }
    }),
    vscode.workspace.onDidChangeTextDocument(() => {
      provider.clearReferenceQueryCache();
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      provider.clearReferenceQueryCache();
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      provider.clearAutoP4CheckoutTracking(doc.uri);
    })
  );

  // 监听活动编辑器变化，通知 PinEx 高亮当前文件
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      provider.noteOpenFileRecentlyUsed(editor?.document.uri);
      // 若该文件已 Pin，则更新 Pin 的最近使用时间
      pinExManager.touch(editor?.document.uri);
      provider.postActiveFile(editor?.document.uri);
      provider.schedulePostOpenFiles();
    })
  );

  // 监听编辑（文本变更）：把“最近编辑”的文件顶到最上面（节流刷新列表）
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges && e.contentChanges.length > 0) {
        void provider.autoCheckoutDocumentIfNeeded(e.document);
      }
      provider.noteOpenFileRecentlyUsed(e.document?.uri);
      pinExManager.touch(e.document?.uri);
      provider.schedulePostOpenFiles();
    })
  );

  // 监听光标位置变化，通知符号面板定位
  let lastCursorLine = -1;
  let lastCursorUri = '';
  console.log('[CursorEx] Registering onDidChangeTextEditorSelection listener');
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor === vscode.window.activeTextEditor) {
        const line = e.selections[0]?.active.line;
        const uri = e.textEditor.document.uri;
        const uriStr = uri.toString();
        if (typeof line === 'number' && (line !== lastCursorLine || uriStr !== lastCursorUri)) {
          lastCursorLine = line;
          lastCursorUri = uriStr;
          console.log('[CursorEx] Selection changed: line=' + line);
          provider.postCursorLine(line, uri);
        }
      }
    })
  );

  // 监听 Tab 变化，更新打开文件列表
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      provider.schedulePostOpenFiles();
    })
  );

  // Hover 提供者：在有 Comment 的行上返回對應內容，配合 editor.action.showHover 使用
  const hoverSelector: vscode.DocumentSelector = [
    { scheme: 'file' },
    { scheme: 'untitled' }
  ];
  const hoverProvider = vscode.languages.registerHoverProvider(hoverSelector, {
    provideHover(doc, position, _token) {
      const item = commentManager.getComment(doc.uri, position.line);
      if (!item) {
        return undefined;
      }
      const md = new vscode.MarkdownString();
      md.appendText(item.text || 'Comment');
      return new vscode.Hover(md);
    }
  });

  context.subscriptions.push(
    hoverProvider,
    vscode.window.onDidChangeActiveTextEditor(editor => {
      void provider.updatePinExContext(editor?.document?.uri);
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      void provider.updatePinExContext(event.textEditor?.document?.uri);
    }),
    vscode.window.registerWebviewViewProvider(
      CursorToolSidebarProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    ),
    vscode.commands.registerCommand('cursorToolWindow.open', () => {
      vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
    }),
    vscode.commands.registerCommand('cursorToolWindow.openSettings', () => {
      openSettingsPanel(context);
    }),
    vscode.commands.registerCommand('cursorToolWindow.checkForUpdates', async () => {
      await updateService.checkFromCommand();
    }),
    vscode.commands.registerCommand('cursorToolWindow.installUpdate', async () => {
      await updateService.installFromCommand();
    }),
    vscode.commands.registerCommand('cursorToolWindow.addComment', async (args?: any) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      let line = editor.selection.active.line;
      if (args && typeof args.lineNumber === 'number') {
        // VS Code 行号上下文通常是 1-based，这里做一下安全转换
        const fromCtx = args.lineNumber;
        if (fromCtx >= 1) {
          line = fromCtx - 1;
        } else if (fromCtx >= 0) {
          line = fromCtx;
        }
      }

      const uri = editor.document.uri;
      if (commentManager.hasComment(uri, line)) {
        // 已有注釋則刪除
        commentManager.removeComment(uri, line);
      } else {
        // 沒有則添加 / 編輯
        await commentManager.addOrEditComment(uri, line);
      }
    }),
    vscode.commands.registerCommand('cursorToolWindow.pinEx', async (resource?: any) => {
      let targetUri: vscode.Uri | null = null;

      if (resource instanceof vscode.Uri) {
        targetUri = resource;
      } else if (resource && resource.resourceUri instanceof vscode.Uri) {
        targetUri = resource.resourceUri;
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          targetUri = editor.document.uri;
        }
      }

      if (!targetUri) {
        return;
      }

      const already = pinExManager.isPinned(targetUri);
      await pinExManager.togglePin(targetUri);
      await provider.updatePinExContext(targetUri);

      const rel = vscode.workspace.asRelativePath(targetUri, false);
      const msg = already ? `Removed from PinEx: ${rel}` : `Added to PinEx: ${rel}`;
      vscode.window.setStatusBarMessage(msg, 2000);
    }),
    vscode.commands.registerCommand('cursorToolWindow.unpinEx', async (resource?: any) => {
      let targetUri: vscode.Uri | null = null;

      if (resource instanceof vscode.Uri) {
        targetUri = resource;
      } else if (resource && resource.resourceUri instanceof vscode.Uri) {
        targetUri = resource.resourceUri;
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          targetUri = editor.document.uri;
        }
      }

      if (!targetUri) {
        return;
      }

      pinExManager.remove(targetUri);
      await provider.updatePinExContext(targetUri);
      const rel = vscode.workspace.asRelativePath(targetUri, false);
      vscode.window.setStatusBarMessage(`Removed from PinEx: ${rel}`, 2000);
    }),
    vscode.commands.registerCommand('cursorToolWindow.pinExLocate', async (resource?: any) => {
      let targetUri: vscode.Uri | null = null;

      if (resource instanceof vscode.Uri) {
        targetUri = resource;
      } else if (resource && resource.resourceUri instanceof vscode.Uri) {
        targetUri = resource.resourceUri;
      } else {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          targetUri = editor.document.uri;
        }
      }

      if (!targetUri) {
        return;
      }

      // 跳转到“固定窗口”（侧边栏 Webview）后再定位
      try {
        await vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
      } catch {
        // ignore
      }

      // 确保切到 PinEx 固定 Tab
      provider.postSwitchPinExTab('pin');
      // 让 PinEx 面板展开并滚动到目标文件（若在已 PinEx 的目录中也会递归展开）
      provider.postPinExLocateToUri(targetUri);
    }),
    vscode.commands.registerCommand('cursorToolWindow.findReferencesEx', async () => {
      // 尽量把侧边栏展示出来，方便用户看到 References Tab
      try {
        await vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
      } catch {
        // ignore
      }
      // 自动跳转到 References Tab
      provider.postSwitchPinExTab('refs');
      provider.postReferenceSearching(true);
      try {
        await provider.findReferencesExFromActiveEditor();
      } finally {
        provider.postReferenceSearching(false);
      }
    }),
    vscode.commands.registerCommand('cursorToolWindow.findImplementationsEx', async () => {
      // 尽量把侧边栏展示出来，方便用户看到 References Tab
      try {
        await vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
      } catch {
        // ignore
      }
      // 自动跳转到 References Tab
      provider.postSwitchPinExTab('refs');
      provider.postReferenceSearching(true);
      try {
        await provider.findImplementationsExFromActiveEditor();
      } finally {
        provider.postReferenceSearching(false);
      }
    }),
    vscode.workspace.onDidRenameFiles(e => {
      pinExManager.handleRename(e);
      provider.notifyPinExFsChanged();
    }),
    vscode.workspace.onDidDeleteFiles(e => {
      pinExManager.handleDelete(e);
      provider.notifyPinExFsChanged();
    }),
    vscode.workspace.onDidCreateFiles(_e => {
      provider.notifyPinExFsChanged();
    }),
    vscode.commands.registerCommand('cursorToolWindow.quickOpen', async () => {
      await showQuickOpenWindow(context, provider, pinExManager, searchIndex);
    }),
    vscode.commands.registerCommand('cursorToolWindow.quickOpenFiles', async () => {
      await showQuickOpenWindow(context, provider, pinExManager, searchIndex, 'files');
    }),
    vscode.commands.registerCommand('cursorToolWindow.quickOpenClasses', async () => {
      await showQuickOpenWindow(context, provider, pinExManager, searchIndex, 'classes');
    }),
    vscode.commands.registerCommand('cursorToolWindow.p4Edit', async (resource?: any) => {
      await provider.p4EditFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.p4Revert', async (resource?: any) => {
      await provider.p4RevertFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.p4DiffDepot', async (resource?: any) => {
      await provider.p4DiffDepotFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.p4FileHistory', async (resource?: any) => {
      await provider.p4FileHistory(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.p4Sync', async (resource?: any) => {
      await provider.p4Sync(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.p4SubmitDirectory', async (resource?: any) => {
      await provider.p4SubmitDirectory(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnUpdate', async (resource?: any) => {
      await provider.svnUpdate(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnAdd', async (resource?: any) => {
      await provider.svnAddFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnRevert', async (resource?: any) => {
      await provider.svnRevertFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnDiffBase', async (resource?: any) => {
      await provider.svnDiffBaseFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnFileHistory', async (resource?: any) => {
      await provider.svnFileHistory(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnCommitWorkbench', async (resource?: any) => {
      await provider.svnCommitWorkbench(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.svnCommitDirectory', async (resource?: any) => {
      await provider.svnCommitDirectory(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.vcsUpdateDirectory', async (resource?: any) => {
      await provider.vcsUpdateDirectory(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.vcsCommitDirectory', async (resource?: any) => {
      await provider.vcsCommitDirectory(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.vcsDiffFile', async (resource?: any) => {
      await provider.vcsDiffFile(resource);
    }),
    vscode.commands.registerCommand('cursorToolWindow.openKeyboardShortcuts', async () => {
      // 打开快捷键设置页面
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
      // 提示用户搜索命令
      setTimeout(() => {
        vscode.window.showInformationMessage(
          '请在快捷键设置中搜索 "cursorToolWindow.quickOpen" 来配置 Quick Open 的快捷键',
          '知道了'
        );
      }, 500);
    })
  );
}

let quickOpenPick: vscode.QuickPick<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean }> | undefined;
let quickOpenContext: vscode.ExtensionContext | undefined;
let quickOpenPanel: vscode.WebviewPanel | undefined;

interface QuickSearchResultItem {
  kind: 'file' | 'class' | 'content';
  label: string;
  description: string;
  uri: vscode.Uri;
  line?: number;
  pinned?: boolean;
}

function normalizeSearchPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function getUriExtension(uri: vscode.Uri): string {
  const fileName = uri.fsPath.split(/[\\/]/).pop() || '';
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.substring(idx + 1).toLowerCase() : '';
}

function matchesSearchExtension(uri: vscode.Uri, searchFileExtensions: string[]): boolean {
  if (searchFileExtensions.length === 0) {
    return true;
  }
  const ext = getUriExtension(uri);
  return searchFileExtensions.some(e => e.toLowerCase() === ext);
}

function matchesSearchIncludeDirectories(uri: vscode.Uri, searchIncludeDirectories: string[]): boolean {
  if (searchIncludeDirectories.length === 0) {
    return true;
  }
  const normalizedPath = uri.fsPath.replace(/\\/g, '/').toLowerCase();
  return searchIncludeDirectories.some(dir => {
    const normalizedDir = normalizeSearchPath(dir).toLowerCase();
    return normalizedDir.length > 0 && (
      normalizedPath.includes('/' + normalizedDir + '/') ||
      normalizedPath.endsWith('/' + normalizedDir) ||
      normalizedPath.startsWith(normalizedDir + '/')
    );
  });
}

function buildSearchIncludePattern(searchIncludeDirectories: string[], searchFileExtensions: string[]): string {
  const normalizedDirs = searchIncludeDirectories
    .map(dir => normalizeSearchPath(dir))
    .filter(dir => dir.length > 0);
  const normalizedExts = searchFileExtensions
    .map(ext => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(ext => ext.length > 0);

  const suffix = normalizedExts.length > 0
    ? `*.{${normalizedExts.join(',')}}`
    : '*';

  if (normalizedDirs.length > 0) {
    return `{${normalizedDirs.map(dir => `${dir}/**/${suffix}`).join(',')}}`;
  }

  return `**/${suffix}`;
}

function buildFilenameSearchPattern(query: string, searchIncludeDirectories: string[], searchFileExtensions: string[]): string {
  const normalizedDirs = searchIncludeDirectories
    .map(dir => normalizeSearchPath(dir))
    .filter(dir => dir.length > 0);
  const normalizedExts = searchFileExtensions
    .map(ext => ext.trim().toLowerCase().replace(/^\./, ''))
    .filter(ext => ext.length > 0);
  const escapedQuery = query.replace(/\\/g, '/').trim();

  const suffix = normalizedExts.length > 0
    ? `*${escapedQuery}*.{${normalizedExts.join(',')}}`
    : `*${escapedQuery}*`;

  if (normalizedDirs.length > 0) {
    return `{${normalizedDirs.map(dir => `${dir}/**/${suffix}`).join(',')}}`;
  }

  return `**/${suffix}`;
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

function extractUppercasePattern(value: string): string {
  return value.replace(/[^A-Z]/g, '');
}

function computeFilenameFuzzyScore(query: string, fileName: string, fullPath: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  const normalizedName = fileName.toLowerCase();
  const normalizedPath = fullPath.toLowerCase().replace(/\\/g, '/');
  if (!normalizedQuery) {
    return 0;
  }

  let score = -1;

  if (normalizedName === normalizedQuery) {
    score = Math.max(score, 10000);
  }
  if (normalizedName.startsWith(normalizedQuery)) {
    score = Math.max(score, 8000 - Math.min(fileName.length, 200));
  }
  if (normalizedName.includes(normalizedQuery)) {
    score = Math.max(score, 6000 - normalizedName.indexOf(normalizedQuery) * 10 - Math.min(fileName.length, 200));
  }

  const compactQuery = normalizedQuery.replace(/[^a-z0-9]/g, '');
  const compactName = normalizedName.replace(/[^a-z0-9]/g, '');
  if (compactQuery && compactName.includes(compactQuery)) {
    score = Math.max(score, 5500 - compactName.indexOf(compactQuery) * 10);
  }

  const upperPattern = extractUppercasePattern(fileName);
  if (compactQuery && upperPattern && isSubsequenceMatch(compactQuery, upperPattern.toLowerCase())) {
    score = Math.max(score, 5000 - upperPattern.length * 5);
  }

  if (compactQuery && isSubsequenceMatch(compactQuery, compactName)) {
    score = Math.max(score, 3500 - compactName.length);
  }

  if (compactQuery && normalizedPath.includes(compactQuery)) {
    score = Math.max(score, 2500 - normalizedPath.indexOf(compactQuery));
  }

  return score;
}

function shouldSearchFiles(searchMode: string): boolean {
  return searchMode === 'filename' || searchMode === 'fileclass' || searchMode === 'all';
}

function shouldSearchClasses(searchMode: string): boolean {
  return searchMode === 'class' || searchMode === 'fileclass' || searchMode === 'all';
}

function shouldSearchContent(searchMode: string): boolean {
  return searchMode === 'content' || searchMode === 'all';
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const result: vscode.Uri[] = [];
  for (const uri of uris) {
    const key = uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(uri);
  }
  return result;
}

function logQuickOpenDebug(label: string, data?: any): void {
  if (typeof data === 'undefined') {
    console.log(`[CursorEx][QuickOpen] ${label}`);
    return;
  }
  try {
    console.log(`[CursorEx][QuickOpen] ${label}: ${JSON.stringify(data)}`);
  } catch {
    console.log(`[CursorEx][QuickOpen] ${label}:`, data);
  }
}

function getSearchResultLimit(maxFilesToSearch: number): number | undefined {
  return maxFilesToSearch > 0 ? maxFilesToSearch : undefined;
}

async function readFileText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

async function workspaceHasFile(glob: string): Promise<boolean> {
  const files = await vscode.workspace.findFiles(glob, undefined, 1);
  return files.length > 0;
}

async function detectSearchProfile(): Promise<SearchProfile> {
  try {
    const hasUnityAssets = await workspaceHasFile('Assets/**');
    const hasUnitySettings = await workspaceHasFile('ProjectSettings/**');
    if (hasUnityAssets && hasUnitySettings) {
      return {
        type: 'Unity',
        searchFileExtensions: [],
        searchIncludeDirectories: ['Assets', 'Packages'],
        searchExcludeDirectories: ['**/Library/**', '**/Temp/**', '**/Logs/**', '**/obj/**', '**/bin/**', '**/.git/**'],
        todoExtensions: ['cs', 'shader', 'compute'],
        todoIncludeGlobs: ['Assets', 'Packages'],
        todoExcludeGlobs: ['**/Library/**', '**/Temp/**', '**/Logs/**', '**/obj/**', '**/bin/**'],
        pinexFileExtensions: ['cs', 'shader', 'compute', 'uxml', 'uss', 'prefab', 'unity']
      };
    }

    if (await workspaceHasFile('*.sln') || await workspaceHasFile('**/*.csproj')) {
      return {
        type: '.NET',
        searchFileExtensions: [],
        searchIncludeDirectories: [],
        searchExcludeDirectories: ['**/bin/**', '**/obj/**', '**/.vs/**', '**/packages/**', '**/.git/**'],
        todoExtensions: ['cs', 'csx'],
        todoIncludeGlobs: [],
        todoExcludeGlobs: ['**/bin/**', '**/obj/**', '**/.vs/**'],
        pinexFileExtensions: ['cs', 'csproj', 'sln', 'json', 'xaml']
      };
    }

    if (await workspaceHasFile('go.mod')) {
      return {
        type: 'Go',
        searchFileExtensions: [],
        searchIncludeDirectories: [],
        searchExcludeDirectories: ['**/vendor/**', '**/.git/**', '**/bin/**', '**/dist/**'],
        todoExtensions: ['go'],
        todoIncludeGlobs: [],
        todoExcludeGlobs: ['**/vendor/**', '**/bin/**'],
        pinexFileExtensions: ['go', 'mod', 'sum', 'yaml', 'yml', 'json']
      };
    }

    if (await workspaceHasFile('package.json')) {
      return {
        type: 'Node / Frontend',
        searchFileExtensions: [],
        searchIncludeDirectories: [],
        searchExcludeDirectories: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**', '**/.git/**'],
        todoExtensions: ['ts', 'tsx', 'js', 'jsx', 'vue'],
        todoIncludeGlobs: [],
        todoExcludeGlobs: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/build/**'],
        pinexFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'vue', 'json', 'css', 'scss']
      };
    }

    if (await workspaceHasFile('Cargo.toml')) {
      return {
        type: 'Rust',
        searchFileExtensions: [],
        searchIncludeDirectories: [],
        searchExcludeDirectories: ['**/target/**', '**/.git/**'],
        todoExtensions: ['rs'],
        todoIncludeGlobs: [],
        todoExcludeGlobs: ['**/target/**'],
        pinexFileExtensions: ['rs', 'toml', 'md']
      };
    }

    if (await workspaceHasFile('pom.xml') || await workspaceHasFile('build.gradle') || await workspaceHasFile('build.gradle.kts')) {
      return {
        type: 'Java',
        searchFileExtensions: [],
        searchIncludeDirectories: [],
        searchExcludeDirectories: ['**/target/**', '**/build/**', '**/.gradle/**', '**/.git/**'],
        todoExtensions: ['java', 'kt', 'kts'],
        todoIncludeGlobs: [],
        todoExcludeGlobs: ['**/target/**', '**/build/**', '**/.gradle/**'],
        pinexFileExtensions: ['java', 'kt', 'kts', 'xml', 'properties']
      };
    }
  } catch {
    // fall through to default
  }

  return DEFAULT_SEARCH_PROFILE;
}

function getPreviewTextFromSearchResult(result: any, fallbackLineText: string): string {
  const previewText = typeof result?.preview?.text === 'string' ? result.preview.text : fallbackLineText;
  const trimmed = previewText.trim();
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return trimmed.substring(0, 77) + '...';
}

function getLineNumberFromSearchResult(result: any): number {
  const ranges = result?.ranges;
  const range = Array.isArray(ranges) ? ranges[0] : ranges;
  const startLine = typeof range?.start?.line === 'number' ? range.start.line : 0;
  return startLine + 1;
}

async function searchWorkspaceText(
  query: string,
  caseSensitive: boolean,
  includePattern: string,
  excludePattern: string | undefined,
  maxContentMatches: number,
  token: vscode.CancellationToken,
  pinExManager: PinExManager
): Promise<Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }>> {
  const results: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }> = [];
  const candidateFiles = await vscode.workspace.findFiles(
    includePattern,
    excludePattern,
    getSearchResultLimit(0),
    token
  );
  const queryToSearch = caseSensitive ? query : query.toLowerCase();

  for (const uri of candidateFiles) {
    if (token.isCancellationRequested || results.length >= maxContentMatches) {
      break;
    }

    try {
      const text = await readFileText(uri);
      const lines = text.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length && results.length < maxContentMatches; lineIndex++) {
        const line = lines[lineIndex];
        const lineToSearch = caseSensitive ? line : line.toLowerCase();
        if (!lineToSearch.includes(queryToSearch)) {
          continue;
        }

        const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
        const isPinned = pinExManager.isPinned(uri);
        let previewText = line.trim();
        if (previewText.length > 80) {
          previewText = previewText.substring(0, 77) + '...';
        }

        results.push({
          label: `$(search) ${previewText}`,
          description: `${fileName}:${lineIndex + 1}${isPinned ? ' 📌' : ''}`,
          detail: `Line ${lineIndex + 1}`,
          uri: uri,
          isClass: false,
          isContent: true,
          line: lineIndex + 1,
          buttons: [
            {
              iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
              tooltip: isPinned ? 'Unpin' : 'Pin'
            }
          ]
        } as any);
      }
    } catch {
      // ignore unreadable files
    }
  }

  return results;
}

async function searchWorkspaceClasses(
  query: string,
  caseSensitive: boolean,
  searchFileExtensions: string[],
  searchIncludeDirectories: string[],
  maxItems: number,
  pinExManager: PinExManager
): Promise<Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number }>> {
  const queryToSearch = caseSensitive ? query : query.toLowerCase();
  const results: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number }> = [];
  const seen = new Set<string>();
  const pushResult = (name: string, uri: vscode.Uri, line: number) => {
    const key = `${uri.toString()}:${name}:${line}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
    const isPinned = pinExManager.isPinned(uri);
    results.push({
      label: `$(symbol-class) ${name}`,
      description: `in ${fileName}${isPinned ? ' 馃搶 pinned' : ''}`,
      uri: uri,
      isClass: true,
      line: line,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
          tooltip: isPinned ? 'Unpin' : 'Pin'
        }
      ]
    } as any);
  };
  const rawSymbols = await vscode.commands.executeCommand<any[]>('vscode.executeWorkspaceSymbolProvider', query);

  for (const symbol of (Array.isArray(rawSymbols) ? rawSymbols : [])) {
    const kind = symbol?.kind;
    const name = typeof symbol?.name === 'string' ? symbol.name : '';
    const uri: vscode.Uri | undefined = symbol?.location?.uri;
    if (!uri || !name) {
      continue;
    }
    if (kind !== vscode.SymbolKind.Class && kind !== vscode.SymbolKind.Struct && kind !== vscode.SymbolKind.Interface && kind !== vscode.SymbolKind.Enum) {
      continue;
    }
    if (!matchesSearchExtension(uri, searchFileExtensions) || !matchesSearchIncludeDirectories(uri, searchIncludeDirectories)) {
      continue;
    }

    const symbolNameToSearch = caseSensitive ? name : name.toLowerCase();
    const fuzzyScore = computeFilenameFuzzyScore(query, name, uri.fsPath);
    if (!symbolNameToSearch.includes(queryToSearch) && fuzzyScore < 0) {
      continue;
    }

    const line = (symbol.location?.range?.start?.line ?? 0) + 1;
    const key = `${uri.toString()}:${name}:${line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
    const isPinned = pinExManager.isPinned(uri);
    results.push({
      label: `$(symbol-class) ${name}`,
      description: `in ${fileName}${isPinned ? ' 📌 pinned' : ''}`,
      uri: uri,
      isClass: true,
      line: line,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
          tooltip: isPinned ? 'Unpin' : 'Pin'
        }
      ]
    } as any);

    if (results.length >= maxItems) {
      break;
    }
  }

  if (results.length < maxItems) {
    const includePattern = buildSearchIncludePattern(searchIncludeDirectories, searchFileExtensions);
    const candidateFiles = await vscode.workspace.findFiles(includePattern, null, 1000);
    const typeRegex = /\b(class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const uri of candidateFiles) {
      if (results.length >= maxItems) {
        break;
      }
      try {
        const text = await readFileText(uri);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < maxItems; i++) {
          typeRegex.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = typeRegex.exec(lines[i])) !== null) {
            const name = match[2];
            const symbolNameToSearch = caseSensitive ? name : name.toLowerCase();
            const fuzzyScore = computeFilenameFuzzyScore(query, name, uri.fsPath);
            if (!symbolNameToSearch.includes(queryToSearch) && fuzzyScore < 0) {
              continue;
            }
            const key = `${uri.toString()}:${name}:${i + 1}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
            const isPinned = pinExManager.isPinned(uri);
            results.push({
              label: `$(symbol-class) ${name}`,
              description: `in ${fileName}${isPinned ? ' 馃搶 pinned' : ''}`,
              uri: uri,
              isClass: true,
              line: i + 1,
              buttons: [
                {
                  iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                  tooltip: isPinned ? 'Unpin' : 'Pin'
                }
              ]
            } as any);
          }
        }
      } catch {
        // ignore unreadable files
      }
    }
  }

  return results;
}

async function performQuickOpenSearch(
  query: string,
  provider: CursorToolSidebarProvider,
  pinExManager: PinExManager,
  searchIndex: WorkspaceSearchIndex
): Promise<QuickSearchResultItem[]> {
  const config = vscode.workspace.getConfiguration('cursorToolWindow');
  const searchMode = config.get<string>('search.mode', 'all');
  const searchFileExtensions = config.get<string[]>('search.fileExtensions', []);
  const searchIncludeDirectories = config.get<string[]>('search.includeDirectories', []);
  const searchExcludeDirectories = config.get<string[]>('search.excludeDirectories', ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.git/**']);
  const caseSensitive = config.get<boolean>('search.caseSensitive', false);
  const maxFilesToSearch = config.get<number>('search.maxFilesToSearch', 0);
  const maxContentMatches = config.get<number>('search.maxContentMatches', 100);
  const maxItems = config.get<number>('quickOpen.maxItems', 50);

  const includePattern = buildSearchIncludePattern(searchIncludeDirectories, searchFileExtensions);
  const excludePattern = searchExcludeDirectories.length > 0
    ? `{${searchExcludeDirectories.join(',')}}`
    : '**/node_modules/**';

  const openFiles = provider.getOpenFilesSorted();
  const indexSnapshot = searchIndex.getSnapshot();
  const fileResults: QuickSearchResultItem[] = [];
  const classResults: QuickSearchResultItem[] = [];
  const contentResults: QuickSearchResultItem[] = [];

  let candidateFiles: vscode.Uri[] = [];
  if (!indexSnapshot.ready || indexSnapshot.fileCount === 0 || shouldSearchContent(searchMode)) {
    candidateFiles = dedupeUris(await vscode.workspace.findFiles(
      includePattern,
      excludePattern,
      getSearchResultLimit(maxFilesToSearch)
    ));
  }

  if (shouldSearchContent(searchMode)) {
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const contentItems = await searchWorkspaceText(
        query,
        caseSensitive,
        includePattern,
        excludePattern,
        maxContentMatches,
        tokenSource.token,
        pinExManager
      );
      for (const item of contentItems) {
        if (!item.uri) {
          continue;
        }
        contentResults.push({
          kind: 'content',
          label: item.label.replace(/^\$\([^)]+\)\s*/, ''),
          description: item.description || '',
          uri: item.uri,
          line: (item as any).line,
          pinned: pinExManager.isPinned(item.uri)
        });
      }
    } finally {
      tokenSource.dispose();
    }
  }

  if (shouldSearchClasses(searchMode)) {
    if (indexSnapshot.ready && indexSnapshot.symbolCount > 0) {
      const indexedSymbols = await searchIndex.querySymbols(query, {
        limit: maxItems,
        includeExtensions: searchFileExtensions,
        includeDirectories: searchIncludeDirectories,
        caseSensitive
      });
      for (const symbol of indexedSymbols) {
        classResults.push({
          kind: 'class',
          label: symbol.name,
          description: symbol.fileName,
          uri: symbol.uri,
          line: symbol.line,
          pinned: pinExManager.isPinned(symbol.uri)
        });
      }
    }

    if (classResults.length === 0) {
      const fallbackClassResults = await searchWorkspaceClasses(
        query,
        caseSensitive,
        searchFileExtensions,
        searchIncludeDirectories,
        maxItems,
        pinExManager
      );
      for (const item of fallbackClassResults) {
        if (!item.uri) {
          continue;
        }
        classResults.push({
          kind: 'class',
          label: item.label.replace(/^\$\([^)]+\)\s*/, ''),
          description: (item.description || '').replace(/^in\s+/, ''),
          uri: item.uri,
          line: (item as any).line,
          pinned: pinExManager.isPinned(item.uri)
        });
      }
    }
  }

  if (shouldSearchFiles(searchMode)) {
    const fuzzyMatches = indexSnapshot.ready && indexSnapshot.fileCount > 0
      ? (await searchIndex.queryFiles(query, {
          limit: getSearchResultLimit(maxFilesToSearch) ?? maxItems * 10,
          includeExtensions: searchFileExtensions,
          includeDirectories: searchIncludeDirectories,
          caseSensitive
        })).map(entry => ({
          uri: entry.uri,
          name: entry.fileName,
          score: computeFilenameFuzzyScore(query, entry.fileName, entry.relativePath)
        }))
      : candidateFiles
          .map(uri => {
            const name = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
            return {
              uri,
              name,
              score: computeFilenameFuzzyScore(query, name, uri.fsPath)
            };
          })
          .filter(item => item.score >= 0)
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.name.length !== b.name.length) return a.name.length - b.name.length;
            return a.uri.fsPath.localeCompare(b.uri.fsPath);
          });

    for (const match of fuzzyMatches) {
      const isOpen = openFiles.some(f => f.uri.toString() === match.uri.toString());
      fileResults.push({
        kind: 'file',
        label: match.name,
        description: isOpen ? 'recently opened' : vscode.workspace.asRelativePath(match.uri, false),
        uri: match.uri,
        pinned: pinExManager.isPinned(match.uri)
      });
    }
  }

  const merged = searchMode === 'fileclass'
    ? [...fileResults, ...classResults, ...contentResults]
    : [...classResults, ...fileResults, ...contentResults];

  const seen = new Set<string>();
  return merged.filter(item => {
    const key = `${item.kind}:${item.uri.toString()}:${item.line || 0}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, maxItems * 3);
}

async function revealQuickSearchResult(item: QuickSearchResultItem, provider: CursorToolSidebarProvider): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(item.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  provider.noteOpenFileRecentlyUsed(item.uri);
  if (typeof item.line === 'number' && item.line > 0) {
    const position = new vscode.Position(item.line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

function getQuickOpenPanelHtml(): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #1e1e1e;
      --panel: #252526;
      --panel-2: #2d2d30;
      --text: #d4d4d4;
      --muted: #9da1a6;
      --border: #3a3a3d;
      --accent: #0e639c;
      --accent-2: #1177bb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.4 "Segoe UI", sans-serif;
    }
    .shell {
      display: grid;
      grid-template-columns: 140px 1fr;
      height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--border);
      background: linear-gradient(180deg, #232325, #1f1f21);
      padding: 12px;
    }
    .sidebar h3 {
      margin: 0 0 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .filter-btn {
      width: 100%;
      margin: 0 0 8px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: transparent;
      color: var(--text);
      text-align: left;
      cursor: pointer;
    }
    .filter-btn.active {
      background: rgba(14,99,156,.22);
      border-color: var(--accent);
      color: #fff;
    }
    .main {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .toolbar {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .search-input {
      flex: 1;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
      outline: none;
    }
    .status {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }
    .results {
      overflow: auto;
      padding: 8px;
    }
    .result-item {
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 6px;
      cursor: pointer;
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 10px;
      align-items: start;
    }
    .result-item.active {
      background: rgba(14,99,156,.3);
      border-color: rgba(14,99,156,.6);
    }
    .result-item:hover {
      background: rgba(255,255,255,.04);
    }
    .result-icon {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: #2d2d30;
      color: var(--muted);
      font-size: 12px;
    }
    .result-item.active .result-icon {
      background: var(--accent);
      color: #fff;
    }
    .result-title {
      font-size: 14px;
      color: #fff;
      word-break: break-word;
    }
    .result-meta {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
      word-break: break-word;
    }
    .empty {
      padding: 24px 16px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <h3>Display</h3>
      <button class="filter-btn active" data-filter="all">All</button>
      <button class="filter-btn" data-filter="files">Files</button>
      <button class="filter-btn" data-filter="classes">Classes</button>
    </aside>
    <main class="main">
      <div class="toolbar">
        <input id="searchInput" class="search-input" type="text" placeholder="Search files, classes, and content" />
        <div id="status" class="status">Ready</div>
      </div>
      <div id="results" class="results"></div>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const resultsEl = document.getElementById('results');
    const statusEl = document.getElementById('status');
    const buttons = Array.from(document.querySelectorAll('.filter-btn'));
    let filter = 'all';
    let items = [];
    let activeIndex = 0;
    let debounceTimer = null;

    function iconFor(kind) {
      if (kind === 'class') return 'C';
      if (kind === 'content') return 'T';
      return 'F';
    }

    function render() {
      const filtered = items.filter(item => {
        if (filter === 'files') return item.kind === 'file';
        if (filter === 'classes') return item.kind === 'class';
        return true;
      });
      if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1);
      if (!filtered.length) {
        resultsEl.innerHTML = '<div class="empty">No results yet. Start typing to search.</div>';
        return;
      }
      resultsEl.innerHTML = filtered.map((item, index) => {
        const activeClass = index === activeIndex ? ' active' : '';
        const meta = item.line ? item.description + '  Line ' + item.line : item.description;
        return '<div class="result-item' + activeClass + '" data-index="' + index + '">' +
          '<div class="result-icon">' + iconFor(item.kind) + '</div>' +
          '<div><div class="result-title">' + escapeHtml(item.label) + '</div><div class="result-meta">' + escapeHtml(meta || '') + '</div></div>' +
          '</div>';
      }).join('');
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function requestSearch() {
      clearTimeout(debounceTimer);
      const query = searchInput.value || '';
      debounceTimer = setTimeout(() => {
        statusEl.textContent = query.trim() ? 'Searching...' : 'Ready';
        vscode.postMessage({ type: 'search', query: query });
      }, 160);
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        filter = btn.getAttribute('data-filter') || 'all';
        buttons.forEach(b => b.classList.toggle('active', b === btn));
        render();
      });
    });

    searchInput.addEventListener('input', requestSearch);
    searchInput.addEventListener('keydown', event => {
      const filtered = items.filter(item => filter === 'all' ? true : filter === 'files' ? item.kind === 'file' : item.kind === 'class');
      if (event.key === 'ArrowDown') {
        activeIndex = Math.min(activeIndex + 1, Math.max(0, filtered.length - 1));
        render();
        event.preventDefault();
      } else if (event.key === 'ArrowUp') {
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
        event.preventDefault();
      } else if (event.key === 'Enter' && filtered[activeIndex]) {
        vscode.postMessage({ type: 'openResult', item: filtered[activeIndex] });
        event.preventDefault();
      }
    });

    resultsEl.addEventListener('click', event => {
      const row = event.target.closest('.result-item');
      if (!row) return;
      const index = Number(row.getAttribute('data-index'));
      const filtered = items.filter(item => filter === 'all' ? true : filter === 'files' ? item.kind === 'file' : item.kind === 'class');
      if (filtered[index]) {
        activeIndex = index;
        render();
        vscode.postMessage({ type: 'openResult', item: filtered[index] });
      }
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'results') {
        items = Array.isArray(msg.items) ? msg.items : [];
        activeIndex = 0;
        statusEl.textContent = items.length ? (items.length + ' results') : 'No results';
        render();
      }
    });

    searchInput.focus();
    render();
  </script>
</body>
</html>`;
}

async function showQuickOpenPanel(
  context: vscode.ExtensionContext,
  provider: CursorToolSidebarProvider,
  pinExManager: PinExManager,
  searchIndex: WorkspaceSearchIndex
): Promise<void> {
  if (quickOpenPanel) {
    quickOpenPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  quickOpenPanel = vscode.window.createWebviewPanel(
    'cursorToolQuickOpen',
    'Cursor Tools Search',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  quickOpenPanel.webview.html = getQuickOpenPanelHtml();
  quickOpenPanel.onDidDispose(() => {
    quickOpenPanel = undefined;
  });

  quickOpenPanel.webview.onDidReceiveMessage(async msg => {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'search') {
      const query = typeof msg.query === 'string' ? msg.query.trim() : '';
      if (!query) {
        quickOpenPanel?.webview.postMessage({ type: 'results', items: [] });
        return;
      }
      const items = await performQuickOpenSearch(query, provider, pinExManager, searchIndex);
      quickOpenPanel?.webview.postMessage({
        type: 'results',
        items: items.map(item => ({
          ...item,
          uri: item.uri.toString()
        }))
      });
    } else if (msg.type === 'openResult' && msg.item && typeof msg.item.uri === 'string') {
      await revealQuickSearchResult({
        kind: msg.item.kind,
        label: msg.item.label,
        description: msg.item.description,
        uri: vscode.Uri.parse(msg.item.uri),
        line: typeof msg.item.line === 'number' ? msg.item.line : undefined,
        pinned: !!msg.item.pinned
      }, provider);
    }
  });
}

async function showQuickOpenWindow(
  context: vscode.ExtensionContext,
  provider: CursorToolSidebarProvider,
  pinExManager: PinExManager,
  searchIndex: WorkspaceSearchIndex,
  initialFilterMode: 'all' | 'files' | 'classes' = 'all'
): Promise<void> {
  const FILTER_ALL = 'all';
  const FILTER_FILES = 'files';
  const FILTER_CLASSES = 'classes';

  quickOpenContext = context;
  // 如果窗口已存在，直接显示
  if (quickOpenPick) {
    quickOpenPick.show();
    return;
  }

  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean }>();
  quickOpenPick = quickPick;
  let resultFilterMode: 'all' | 'files' | 'classes' = initialFilterMode;
  const filterButtons: vscode.QuickInputButton[] = [
    { iconPath: new vscode.ThemeIcon('list-filter'), tooltip: 'Show all results' },
    { iconPath: new vscode.ThemeIcon('file'), tooltip: 'Show file results only' },
    { iconPath: new vscode.ThemeIcon('symbol-class'), tooltip: 'Show class results only' }
  ];
  
  quickPick.placeholder = 'Search files, content, and symbols. Shortcuts: /f files, /c classes, /a all';
  quickPick.matchOnDescription = true;
  quickPick.buttons = filterButtons;

  const updateQuickPickTitle = () => {
    const suffix = resultFilterMode === FILTER_FILES
      ? 'Files'
      : resultFilterMode === FILTER_CLASSES
        ? 'Classes'
        : 'All';
    quickPick.title = `Cursor Tools Search [${suffix}]`;
  };

  updateQuickPickTitle();
  
  // 从 workspaceState 读取保存的窗口尺寸偏好（用于未来可能的自定义窗口）
  const savedSize = context.workspaceState.get<{ width: number; height: number }>('cursorToolWindow.quickOpen.size', { width: 800, height: 600 });
  
  // 注意：VS Code 的 QuickPick 高度是自动计算的，无法直接控制
  // 但我们可以通过设置更多的 items 来让窗口自动变高

  // 获取打开的文件（按 MRU 排序）
  const openFiles = provider.getOpenFilesSorted();
  
  // 获取所有 PinEx 的文件（排除目录，只显示文件）
  const pinnedItems = pinExManager.getItemsSortedByRecent();
  const pinnedFiles = pinnedItems.filter(item => !item.isDirectory);

  // 创建 URI 集合，用于去重
  const openFileUris = new Set<string>();
  openFiles.forEach(f => openFileUris.add(f.uri.toString()));

  // 转换为 QuickPickItem，并附加 URI（不显示路径）
  const items: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean }> = [];
  
  // 1. 先添加打开的文件
  openFiles.forEach(file => {
    const isPinned = pinExManager.isPinned(file.uri);
    const item: vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean } = {
      label: `$(file) ${file.name}`,
      description: file.isActive ? 'recently opened' : (isPinned ? '📌 pinned' : ''),
      uri: file.uri,
      isClass: false,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
          tooltip: isPinned ? 'Unpin' : 'Pin'
        }
      ]
    };
    items.push(item);
  });
  
  // 2. 再添加未打开的 PinEx 文件
  pinnedFiles.forEach(pinnedItem => {
    const uriStr = pinnedItem.uri.toString();
    if (!openFileUris.has(uriStr)) {
      const name = pinnedItem.uri.fsPath.split(/[\\/]/).pop() || uriStr;
      const item: vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean } = {
        label: `$(file) ${name}`,
        description: '📌 pinned',
        uri: pinnedItem.uri,
        isClass: false,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon('pinned'),
            tooltip: 'Unpin'
          }
        ]
      };
      items.push(item);
    }
  });

  // 读取配置的最大显示项目数
  const config = vscode.workspace.getConfiguration('cursorToolWindow');
  const maxItems = config.get<number>('quickOpen.maxItems', 50);
  
  // 限制默认显示的项目数量（但保持所有项目用于搜索）
  const displayItems = items.slice(0, Math.min(maxItems, items.length));
  
  quickPick.items = displayItems;
  if (displayItems.length > 0) {
    quickPick.activeItems = [displayItems[0]]; // 默认选中第一个
  }

  let searchCancellationToken: vscode.CancellationTokenSource | null = null;
  let searchDebounceTimer: NodeJS.Timeout | null = null;

  // 监听输入变化，搜索工作区文件和类
  quickPick.onDidChangeValue(async (value) => {
    // 取消之前的搜索
    if (searchCancellationToken) {
      searchCancellationToken.cancel();
      searchCancellationToken.dispose();
      searchCancellationToken = null;
    }
    
    // 清除之前的防抖计时器
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }

    let query = value.trim();
    if (query.startsWith('/f ')) {
      resultFilterMode = FILTER_FILES;
      query = query.substring(3).trim();
      updateQuickPickTitle();
    } else if (query === '/f') {
      resultFilterMode = FILTER_FILES;
      query = '';
      updateQuickPickTitle();
    } else if (query.startsWith('/c ')) {
      resultFilterMode = FILTER_CLASSES;
      query = query.substring(3).trim();
      updateQuickPickTitle();
    } else if (query === '/c') {
      resultFilterMode = FILTER_CLASSES;
      query = '';
      updateQuickPickTitle();
    } else if (query.startsWith('/a ')) {
      resultFilterMode = FILTER_ALL;
      query = query.substring(3).trim();
      updateQuickPickTitle();
    } else if (query === '/a') {
      resultFilterMode = FILTER_ALL;
      query = '';
      updateQuickPickTitle();
    }
    
    if (!query) {
      // 无输入时显示打开的文件（限制数量）
      const config = vscode.workspace.getConfiguration('cursorToolWindow');
      const maxItems = config.get<number>('quickOpen.maxItems', 50);
      const displayItems = items.slice(0, Math.min(maxItems, items.length));
      quickPick.items = displayItems;
      if (displayItems.length > 0) {
        quickPick.activeItems = [displayItems[0]];
      }
      return;
    }

    // 读取搜索配置
    const config = vscode.workspace.getConfiguration('cursorToolWindow');
    const searchMode = config.get<string>('search.mode', 'all');
    const searchFileExtensions = config.get<string[]>('search.fileExtensions', []);
    const searchIncludeDirectories = config.get<string[]>('search.includeDirectories', []);
    const searchExcludeDirectories = config.get<string[]>('search.excludeDirectories', ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.git/**']);
    const caseSensitive = config.get<boolean>('search.caseSensitive', false);
    const debounceDelay = config.get<number>('search.debounceDelay', 300);
    const maxFilesToSearch = config.get<number>('search.maxFilesToSearch', 0);
    const maxContentMatches = config.get<number>('search.maxContentMatches', 100);
    const maxItems = config.get<number>('quickOpen.maxItems', 50);
    const previewLines = config.get<number>('search.previewLines', 1);

    logQuickOpenDebug('search-start', {
      query,
      searchMode,
      searchFileExtensions,
      searchIncludeDirectories,
      searchExcludeDirectories,
      caseSensitive,
      debounceDelay,
      maxFilesToSearch,
      maxContentMatches,
      maxItems,
      previewLines
    });

    // 使用防抖延迟搜索
    searchDebounceTimer = setTimeout(async () => {
      searchCancellationToken = new vscode.CancellationTokenSource();
      const token = searchCancellationToken.token;
      
      try {
        quickPick.busy = true;
        
        const allResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }> = [];
        const fileResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean }> = [];
        const contentResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }> = [];
        const classResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number }> = [];

        // 构建文件搜索模式
        const includePattern = buildSearchIncludePattern(searchIncludeDirectories, searchFileExtensions);

        // 构建排除模式
        const excludePattern = searchExcludeDirectories.length > 0 
          ? `{${searchExcludeDirectories.join(',')}}` 
          : '**/node_modules/**';

        logQuickOpenDebug('patterns', { includePattern, excludePattern });

        const indexSnapshot = searchIndex.getSnapshot();
        let candidateFiles: vscode.Uri[] = [];
        if (!indexSnapshot.ready || indexSnapshot.fileCount === 0) {
          candidateFiles = dedupeUris(await vscode.workspace.findFiles(
            includePattern,
            excludePattern,
            getSearchResultLimit(maxFilesToSearch),
            token
          ));
        }

        logQuickOpenDebug('search-index', indexSnapshot);
        logQuickOpenDebug('candidate-files', {
          source: candidateFiles.length > 0 ? 'workspace.findFiles' : 'search-index',
          count: candidateFiles.length,
          sample: candidateFiles.slice(0, 5).map(u => u.fsPath)
        });

        if (shouldSearchContent(searchMode)) {
          try {
            const workspaceContentResults = await searchWorkspaceText(
              query,
              caseSensitive,
              includePattern,
              excludePattern,
              maxContentMatches,
              token,
              pinExManager
            );
            contentResults.push(...workspaceContentResults);
            logQuickOpenDebug('content-results', {
              count: contentResults.length,
              sample: contentResults.slice(0, 5).map(i => ({ label: i.label, file: i.uri?.fsPath, line: (i as any).line }))
            });
          } catch (contentErr) {
            console.error('[CursorEx] QuickOpen content search error:', contentErr);
            logQuickOpenDebug('content-results-error', {
              message: contentErr instanceof Error ? contentErr.message : String(contentErr)
            });
          }
        }

        if (shouldSearchClasses(searchMode) && !token.isCancellationRequested) {
          if (indexSnapshot.ready && indexSnapshot.symbolCount > 0) {
            const indexedSymbols = await searchIndex.querySymbols(query, {
              limit: maxItems,
              includeExtensions: searchFileExtensions,
              includeDirectories: searchIncludeDirectories,
              caseSensitive
            });

            for (const symbol of indexedSymbols) {
              const isPinned = pinExManager.isPinned(symbol.uri);
              classResults.push({
                label: `$(symbol-class) ${symbol.name}`,
                description: `in ${symbol.fileName}${isPinned ? ' pinned' : ''}`,
                uri: symbol.uri,
                isClass: true,
                line: symbol.line,
                buttons: [
                  {
                    iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                    tooltip: isPinned ? 'Unpin' : 'Pin'
                  }
                ]
              } as any);
            }
          }

          if (classResults.length === 0) {
            const workspaceClassResults = await searchWorkspaceClasses(
              query,
              caseSensitive,
              searchFileExtensions,
              searchIncludeDirectories,
              maxItems,
              pinExManager
            );
            classResults.push(...workspaceClassResults);
          }
          logQuickOpenDebug('class-results', {
            count: classResults.length,
            sample: classResults.slice(0, 5).map(i => ({ label: i.label, file: i.uri?.fsPath, line: (i as any).line }))
          });
        }

        if (token.isCancellationRequested) return;

        // 1. 搜索文件名（如果搜索模式包含文件名）
        if (shouldSearchFiles(searchMode)) {
          const fuzzyMatches = indexSnapshot.ready && indexSnapshot.fileCount > 0
            ? (await searchIndex.queryFiles(query, {
                limit: getSearchResultLimit(maxFilesToSearch) ?? maxItems * 10,
                includeExtensions: searchFileExtensions,
                includeDirectories: searchIncludeDirectories,
                caseSensitive
              })).map(entry => ({
                uri: entry.uri,
                name: entry.fileName,
                score: computeFilenameFuzzyScore(query, entry.fileName, entry.relativePath)
              }))
            : candidateFiles
                .map(uri => {
                  const name = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
                  return {
                    uri,
                    name,
                    score: computeFilenameFuzzyScore(query, name, uri.fsPath)
                  };
                })
                .filter(item => item.score >= 0)
                .sort((a, b) => {
                  if (b.score !== a.score) {
                    return b.score - a.score;
                  }
                  if (a.name.length !== b.name.length) {
                    return a.name.length - b.name.length;
                  }
                  return a.uri.fsPath.localeCompare(b.uri.fsPath);
                });

          logQuickOpenDebug('filename-fuzzy-matches', {
            count: fuzzyMatches.length,
            sample: fuzzyMatches.slice(0, 10).map(m => ({ score: m.score, file: m.uri.fsPath }))
          });

          for (const match of fuzzyMatches) {
            const uri = match.uri;
            const name = match.name;
            const isOpen = openFiles.some(f => f.uri.toString() === uri.toString());
            const isPinned = pinExManager.isPinned(uri);
            
            fileResults.push({
              label: `$(file) ${name}`,
              description: isOpen ? 'recently opened' : (isPinned ? '📌 pinned' : ''),
              uri: uri,
              isClass: false,
              buttons: [
                {
                  iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                  tooltip: isPinned ? 'Unpin' : 'Pin'
                }
              ]
            });
          }

          logQuickOpenDebug('filename-results', {
            count: fileResults.length,
            sample: fileResults.slice(0, 10).map(i => ({ label: i.label, file: i.uri?.fsPath }))
          });
        }

        // 2. 搜索文件内容（如果搜索模式包含内容）
        if (false && (searchMode === 'content' || searchMode === 'all')) {
          const filesToSearch = candidateFiles.filter(uri =>
            matchesSearchExtension(uri, searchFileExtensions) &&
            matchesSearchIncludeDirectories(uri, searchIncludeDirectories)
          );

          // 在文件中搜索内容
          let contentMatchCount = 0;
          const queryToSearch = caseSensitive ? query : query.toLowerCase();
          
          for (const uri of filesToSearch) {
            if (token.isCancellationRequested || contentMatchCount >= maxContentMatches) break;
            
            try {
              const text = await readFileText(uri);
              
              // 查找所有匹配
              const lines = text.split('\n');
              
              for (let lineIndex = 0; lineIndex < lines.length && contentMatchCount < maxContentMatches; lineIndex++) {
                const line = lines[lineIndex];
                const lineToSearch = caseSensitive ? line : line.toLowerCase();
                
                if (lineToSearch.includes(queryToSearch)) {
                  const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
                  const isPinned = pinExManager.isPinned(uri);
                  
                  // 获取预览行
                  let previewText = line.trim();
                  if (previewText.length > 80) {
                    previewText = previewText.substring(0, 77) + '...';
                  }
                  
                  // 检查是否已经有相同文件的相同行
                  const existingIndex = contentResults.findIndex(r => 
                    r.uri?.toString() === uri.toString() && (r as any).line === lineIndex + 1
                  );
                  
                  if (existingIndex === -1) {
                    contentResults.push({
                      label: `$(search) ${previewText}`,
                      description: `${fileName}:${lineIndex + 1}${isPinned ? ' 📌' : ''}`,
                      detail: `Line ${lineIndex + 1}`,
                      uri: uri,
                      isClass: false,
                      isContent: true,
                      line: lineIndex + 1,
                      buttons: [
                        {
                          iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                          tooltip: isPinned ? 'Unpin' : 'Pin'
                        }
                      ]
                    } as any);
                    contentMatchCount++;
                  }
                }
              }
              
              // 同时搜索类（符号）
              if (searchMode === 'all') {
                const doc = await vscode.workspace.openTextDocument(uri);
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                  'vscode.executeDocumentSymbolProvider',
                  doc.uri
                );
                
                if (symbols && Array.isArray(symbols)) {
                  for (const symbol of symbols) {
                    const symbolNameToSearch = caseSensitive ? symbol.name : symbol.name.toLowerCase();
                    if (symbol.kind === vscode.SymbolKind.Class && symbolNameToSearch.includes(queryToSearch)) {
                      const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
                      const isPinned = pinExManager.isPinned(uri);
                      
                      // 检查是否已经存在
                      const existingClass = classResults.find(r => 
                        r.uri?.toString() === uri.toString() && r.label.includes(symbol.name)
                      );
                      
                      if (!existingClass) {
                        classResults.push({
                          label: `$(symbol-class) ${symbol.name}`,
                          description: `in ${fileName}${isPinned ? ' 📌 pinned' : ''}`,
                          uri: uri,
                          isClass: true,
                          line: symbol.range.start.line + 1,
                          buttons: [
                            {
                              iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                              tooltip: isPinned ? 'Unpin' : 'Pin'
                            }
                          ]
                        } as any);
                      }
                    }
                  }
                }
              }
            } catch {
              // 忽略无法读取的文件
            }
          }
        }

        if (token.isCancellationRequested) return;

        // 按搜索模式合并结果，避免 Class Only 仍然混入文件结果
        const finalResults = searchMode === 'fileclass'
          ? [
              ...(shouldSearchFiles(searchMode) ? fileResults : []),
              ...(shouldSearchClasses(searchMode) ? classResults : []),
              ...(shouldSearchContent(searchMode) ? contentResults : [])
            ]
          : [
              ...(shouldSearchClasses(searchMode) ? classResults : []),
              ...(shouldSearchFiles(searchMode) ? fileResults : []),
              ...(shouldSearchContent(searchMode) ? contentResults : [])
            ];
        
        // 去重（基于 URI + line）
        const seen = new Set<string>();
        const uniqueResults = finalResults.filter(item => {
          const key = `${item.uri?.toString() || ''}:${(item as any).line || 0}:${item.isClass || false}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        
        const filteredResults = uniqueResults.filter(item => {
          if (resultFilterMode === FILTER_FILES) {
            return !item.isClass && !(item as any).isContent;
          }
          if (resultFilterMode === FILTER_CLASSES) {
            return !!item.isClass;
          }
          return true;
        });

        // 限制结果数量
        const limitedResults = filteredResults.slice(0, maxItems);
        const limitedDefaultItems = items.slice(0, Math.min(maxItems, items.length));

        logQuickOpenDebug('final-results', {
          total: finalResults.length,
          unique: uniqueResults.length,
          filtered: filteredResults.length,
          limited: limitedResults.length,
          sample: limitedResults.slice(0, 10).map(i => ({ label: i.label, file: i.uri?.fsPath, line: (i as any).line }))
        });

        quickPick.items = limitedResults.length > 0 ? limitedResults : limitedDefaultItems;
        quickPick.busy = false;
        
        if (limitedResults.length > 0) {
          quickPick.activeItems = [limitedResults[0]];
        } else if (limitedDefaultItems.length > 0) {
          quickPick.activeItems = [limitedDefaultItems[0]];
        }
      } catch (err) {
        quickPick.busy = false;
        if (err instanceof Error && err.name !== 'Canceled') {
          console.error('[CursorEx] QuickOpen search error:', err);
        }
      }
    }, debounceDelay);
  });

  // 处理按钮点击（Pin/Unpin）
  quickPick.onDidTriggerButton(button => {
    if (button === filterButtons[0]) {
      resultFilterMode = FILTER_ALL;
    } else if (button === filterButtons[1]) {
      resultFilterMode = FILTER_FILES;
    } else if (button === filterButtons[2]) {
      resultFilterMode = FILTER_CLASSES;
    }

    updateQuickPickTitle();

    const currentValue = quickPick.value;
    if (currentValue.trim()) {
      quickPick.value = currentValue + ' ';
      setTimeout(() => {
        quickPick.value = currentValue;
      }, 10);
    }
  });

  // 处理按钮点击（Pin/Unpin）
  quickPick.onDidTriggerItemButton(async (e) => {
    const item = e.item;
    const itemUri = item.uri;
    if (!itemUri || !quickOpenContext) {
      return;
    }
    
    await pinExManager.togglePin(itemUri);
    
    // 直接更新当前列表，不关闭窗口
    const currentValue = quickPick.value;
    const isPinned = pinExManager.isPinned(itemUri);
    const itemUriStr = itemUri.toString();
    
    // 更新当前项的按钮状态
    const currentItems = quickPick.items;
    const updatedItems = currentItems.map(i => {
      const iUri = i.uri;
      if (iUri && iUri.toString() === itemUriStr) {
        const isClass = (i as any).isClass;
        const isActive = i.label.includes('$(circle-filled)');
        let newDescription = '';
        if (isClass) {
          newDescription = (i.description || '').replace(/📌 pinned/g, '').trim();
          if (isPinned) {
            newDescription += ' 📌 pinned';
          }
        } else {
          if (isActive) {
            newDescription = 'recently opened';
          }
          if (isPinned) {
            newDescription += (newDescription ? ' ' : '') + '📌 pinned';
          }
        }
        
        return {
          ...i,
          description: newDescription,
          buttons: [
            {
              iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
              tooltip: isPinned ? 'Unpin' : 'Pin'
            }
          ]
        };
      }
      return i;
    });
    
    quickPick.items = updatedItems;
    
    // 如果有搜索值，重新触发搜索以更新列表
    if (currentValue.trim()) {
      // 触发搜索更新
      quickPick.value = currentValue + ' '; // 添加空格触发更新
      setTimeout(() => {
        quickPick.value = currentValue; // 恢复原值
      }, 10);
    } else {
      // 无搜索时，重新构建默认列表
      const openFiles = provider.getOpenFilesSorted();
      const pinnedItems = pinExManager.getItemsSortedByRecent();
      const pinnedFiles = pinnedItems.filter(pItem => !pItem.isDirectory);
      const openFileUris = new Set<string>();
      openFiles.forEach(f => openFileUris.add(f.uri.toString()));
      
      const newItems: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean }> = [];
      
      openFiles.forEach(file => {
        const isPinnedFile = pinExManager.isPinned(file.uri);
        newItems.push({
          label: `$(file) ${file.name}`,
          description: file.isActive ? 'recently opened' : (isPinnedFile ? '📌 pinned' : ''),
          uri: file.uri,
          isClass: false,
          buttons: [
            {
              iconPath: new vscode.ThemeIcon(isPinnedFile ? 'pinned' : 'pin'),
              tooltip: isPinnedFile ? 'Unpin' : 'Pin'
            }
          ]
        });
      });
      
      pinnedFiles.forEach(pinnedItem => {
        const uriStr = pinnedItem.uri.toString();
        if (!openFileUris.has(uriStr)) {
          const name = pinnedItem.uri.fsPath.split(/[\\/]/).pop() || uriStr;
          newItems.push({
            label: `$(file) ${name}`,
            description: '📌 pinned',
            uri: pinnedItem.uri,
            isClass: false,
            buttons: [
              {
                iconPath: new vscode.ThemeIcon('pinned'),
                tooltip: 'Unpin'
              }
            ]
          });
        }
      });
      
      const config = vscode.workspace.getConfiguration('cursorToolWindow');
      const maxItems = config.get<number>('quickOpen.maxItems', 50);
      const displayItems = newItems.slice(0, Math.min(maxItems, newItems.length));
      
      quickPick.items = displayItems;
      if (displayItems.length > 0) {
        quickPick.activeItems = [displayItems[0]];
      }
    }
  });

  // 处理选择
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected || !selected.uri) {
      return;
    }

    const targetUri = selected.uri;

    // 更新 MRU
    provider.noteOpenFileRecentlyUsed(targetUri);
    
    // 打开文件
    try {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      
      // 获取行号（类、内容搜索结果都可能有行号）
      let targetLine: number | undefined;
      
      // 优先使用直接存储的 line 属性
      if (typeof (selected as any).line === 'number') {
        targetLine = (selected as any).line - 1; // 转换为 0-based
      } else if ((selected as any).detail) {
        // 从 detail 中解析行号
        const lineMatch = (selected as any).detail.match(/Line (\d+)/);
        if (lineMatch) {
          targetLine = parseInt(lineMatch[1], 10) - 1;
        }
      }
      
      // 跳转到指定行
      if (typeof targetLine === 'number' && targetLine >= 0) {
        const position = new vscode.Position(targetLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      // ignore
    }

    quickPick.dispose();
  });

  quickPick.onDidHide(() => {
    if (searchCancellationToken) {
      searchCancellationToken.cancel();
      searchCancellationToken.dispose();
    }
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
    }
    quickPick.dispose();
    quickOpenPick = undefined;
    quickOpenContext = undefined;
  });

  // 尝试通过设置更多项目来增加默认高度
  // VS Code 的 QuickPick 会根据项目数量自动调整高度
  // 我们可以通过增加默认显示的项目数量来让窗口更高
  // 但 QuickPick 本身不支持自定义高度，所以这里我们保持原有逻辑
  // 如果用户需要更大的窗口，可以通过搜索来显示更多结果

  quickPick.show();
}

export function deactivate() {
  // 無需特殊清理
}

async function revealTodoLocation(uri: vscode.Uri, line: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  } catch {
    // ignore
  }
}

async function revealReferenceLocation(uri: vscode.Uri, line: number, character: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const safeLine = Math.max(0, Math.min(line, Math.max(0, doc.lineCount - 1)));
    const safeChar = Math.max(0, character);
    const position = new vscode.Position(safeLine, safeChar);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  } catch {
    // ignore
  }
}

async function revealPinExFile(uri: vscode.Uri): Promise<void> {
  try {
    // 检查文件是否是目录
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      // 如果是目录，在资源管理器中显示
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    // 打开文件，不改变光标位置（VS Code 会自动恢复上次位置）
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch {
    // ignore
  }
}

function getWebviewContent(version: string): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cursor Tool Window</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #1e1e1e;
      --border: #2d2d2d;
      --bg-input: #1e1e1e;
      --fg: #f3f3f3;
      --fg-muted: #c5c5c5;
      --accent: #0e639c;
      --font-size-base: 13px;
      --todo-hover: rgba(14,99,156,0.45);
      --comment-active: rgba(14,99,156,0.6);
      --comment-hover: rgba(14,99,156,0.45);
      --pinex-active: rgba(14,99,156,0.6);
      --pinex-hover: rgba(14,99,156,0.45);
      --todo-font-size: var(--font-size-base);
      --comment-font-size: var(--font-size-base);
      --pinex-font-size: var(--font-size-base);
      --scrollbar-size: 10px;
      --panel-text: rgba(243,243,243,0.92);
      --panel-text-strong: rgba(255,255,255,0.98);
      --panel-text-muted: rgba(243,243,243,0.72);
      --panel-text-subtle: rgba(243,243,243,0.60);
      --panel-row-odd: rgba(255,255,255,0.024);
      --panel-row-even: rgba(255,255,255,0.055);
      --panel-group-bg: rgba(255,255,255,0.035);
      --panel-group-border: rgba(255,255,255,0.09);
      --scrollbar-thumb: rgba(255,255,255,0.22);
      --scrollbar-thumb-hover: rgba(255,255,255,0.32);
      --pinex-tabs-sticky-top: 0px;
      --pinex-tabs-height: 29px;
      --pinex-toolbar-height: 31px;
    }
    body {
      margin: 0;
      padding: 0;
      height: 100vh;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', sans-serif;
      font-size: var(--font-size-base);
      background-color: var(--bg);
      color: var(--fg);
      box-sizing: border-box;
    }
    /* 滚动条：默认隐藏；仅当前滚动区域(容器)激活时显示 */
    .scroll-area {
      scrollbar-width: none; /* Firefox */
    }
    .scroll-area::-webkit-scrollbar {
      width: var(--scrollbar-size);
      height: var(--scrollbar-size);
    }
    .scroll-area::-webkit-scrollbar-thumb {
      background-color: transparent;
    }
    .scroll-area::-webkit-scrollbar-track {
      background-color: transparent;
    }
    .scroll-area.scrollbar-visible {
      scrollbar-width: thin; /* Firefox */
    }
    .scroll-area.scrollbar-visible::-webkit-scrollbar-thumb {
      background-color: var(--scrollbar-thumb);
      border-radius: 8px;
      border: 2px solid transparent;
      background-clip: content-box;
    }
    .scroll-area.scrollbar-visible::-webkit-scrollbar-thumb:hover {
      background-color: var(--scrollbar-thumb-hover);
    }
    .container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      border-bottom: 1px solid var(--border);
      gap: 6px;
    }
    .title {
      font-size: calc(var(--font-size-base) * 0.85);
      font-weight: 600;
      text-transform: uppercase;
      color: var(--fg-muted);
    }
    .version {
      font-size: calc(var(--font-size-base) * 0.77);
      padding: 0 4px;
      border-radius: 999px;
      border: 1px solid var(--border);
      margin-left: 4px;
    }
    .spacer {
      flex: 1;
    }
    .toolbar-button {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-muted);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: calc(var(--font-size-base) * 0.85);
      cursor: pointer;
    }
    .toolbar-button:hover {
      border-color: var(--accent);
      color: var(--fg);
    }
    .search-wrapper {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .search-wrapper .search-input {
      padding-right: 18px;
    }
    .search-clear {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      font-size: calc(var(--font-size-base) * 0.92);
      color: rgba(243,243,243,0.82);
      cursor: pointer;
      opacity: 0.6;
      line-height: 1;
    }
    .search-clear:hover {
      opacity: 1;
      color: #f48771;
    }
    .search-input {
      min-width: 0;
      width: 100%;
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid var(--border);
      background-color: var(--bg-input);
      color: var(--fg);
      font-size: calc(var(--font-size-base) * 0.85);
      box-sizing: border-box;
    }
    .body {
      flex: 1;
      display: block;
      overflow: hidden;
      padding: 4px 4px 6px 4px;
      box-sizing: border-box;
      position: relative;
      min-height: 0;
    }
    .section {
      position: absolute;
      left: 4px;
      right: 4px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background-color: #1b1b1b;
      box-shadow: 0 6px 18px rgba(0,0,0,0.55);
      display: flex;
      flex-direction: column;
      min-height: 40px;
    }
    .section-header {
      display: flex;
      align-items: center;
      padding: 2px 6px;
      cursor: pointer;
      user-select: none;
      font-size: calc(var(--font-size-base) * 0.85);
      font-weight: 600;
      text-transform: uppercase;
      color: var(--fg-muted);
      gap: 4px;
    }
    .section-chevron {
      width: 10px;
      text-align: center;
      margin-right: 4px;
      font-size: calc(var(--font-size-base) * 0.77);
    }
    .section-title {
      flex: 1;
    }
    .scanning-indicator {
      font-size: calc(var(--font-size-base) * 0.85);
      color: var(--fg-muted);
      margin-left: 8px;
      animation: scanning-pulse 1.5s infinite;
    }
    @keyframes scanning-pulse {
      0%, 100% { opacity: 0.5; }
      50% { opacity: 1; }
    }
    .section-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-left: 4px;
    }
    .section-move-btn {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-muted);
      border-radius: 3px;
      padding: 0 4px;
      font-size: 9px;
      cursor: pointer;
    }
    .section-move-btn:hover {
      border-color: var(--accent);
      color: var(--fg);
    }
    .section-body {
      padding: 2px 0 4px 0;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .section.collapsed .section-body {
      display: none;
    }
    .todo-header-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 4px;
    }
    .todo-header-toolbar .search-input {
      width: 140px;
    }
    .comment-header-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 4px;
    }
    .comment-header-toolbar .search-input {
      width: 140px;
    }
    .pinex-header-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 4px;
    }
    .pinex-header-toolbar .search-input {
      width: 130px;
    }
    .todo-toggle-files {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--fg-muted);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: calc(var(--font-size-base) * 0.77);
      cursor: pointer;
      white-space: nowrap;
    }
    .todo-toggle-files:hover {
      border-color: var(--accent);
      color: var(--fg);
    }
    .todo-list {
      flex: 1;
      overflow: auto;
      padding: 4px 6px 4px 10px;
      font-size: var(--todo-font-size);
      color: var(--panel-text);
    }
    .file-group {
      margin-bottom: 6px;
    }
    .file-title {
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      font-weight: 600;
      margin: 6px 0 3px 0;
      padding: 2px 8px;
      color: var(--panel-text-muted);
      background: var(--panel-group-bg);
      border-left: 2px solid var(--panel-group-border);
      border-radius: 3px;
    }
     .todo-item {
       padding: 3px 8px;
       margin-bottom: 2px;
       cursor: pointer;
       white-space: nowrap;
       text-overflow: ellipsis;
       overflow: hidden;
       font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
       color: var(--panel-text);
       background-color: rgba(255,255,255,0.05);
       border: 1px solid rgba(255,255,255,0.035);
       border-radius: 4px;
     }
    .file-group .todo-item:nth-child(odd) {
      background-color: rgba(255,255,255,0.05);
    }
    .file-group .todo-item:nth-child(even) {
      background-color: rgba(255,255,255,0.085);
    }
     .todo-item:hover {
       background-color: var(--todo-hover);
       color: var(--fg);
     }
    .todo-line {
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.77);
      color: var(--panel-text-subtle);
      margin-right: 8px;
    }
    .empty-tip {
      font-size: calc(var(--font-size-base) * 0.85);
      color: var(--fg-muted);
      padding: 6px;
    }
    .comment-list {
      padding: 4px 6px 4px 10px;
      font-size: var(--comment-font-size);
      flex: 1;
      min-height: 0;
      overflow: auto;
      border-bottom: 1px solid var(--border);
      color: var(--panel-text);
    }
    .pinex-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px 2px 10px;
      font-size: calc(var(--font-size-base) * 0.85);
      color: var(--fg-muted);
      border-top: 1px solid var(--border);
    }
    .pinex-title {
      font-weight: 600;
      text-transform: uppercase;
    }
    .pinex-tabs {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      overflow: hidden;
      border-bottom: 1px solid var(--border);
      padding: 0 6px;
      background: rgba(0,0,0,0.1);
      position: sticky;
      top: var(--pinex-tabs-sticky-top);
      z-index: 12;
      flex-shrink: 0;
      pointer-events: auto;
      min-height: var(--pinex-tabs-height);
    }
    .pinex-tab {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      min-width: 0;
      padding: 4px 12px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--panel-text);
      cursor: pointer;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      user-select: none;
      opacity: 0.9;
      transition: color 0.15s, border-color 0.15s, background-color 0.15s, opacity 0.15s;
      position: relative;
      z-index: 3;
      pointer-events: auto;
    }
    .pinex-tab .tab-icon {
      flex-shrink: 0;
      pointer-events: none;
    }
    .pinex-tab .tab-text {
      margin-left: 6px;
      pointer-events: none;
    }
    .pinex-tabs.compact .pinex-tab .tab-text {
      display: none;
    }
    .pinex-tabs.compact .pinex-tab .tab-text + .tab-icon,
    .pinex-tabs.compact .pinex-tab .tab-icon + .tab-text {
      margin-left: 0;
    }
    .pinex-tabs.compact .pinex-tab .tab-icon {
      margin: 0;
    }
    .pinex-tabs.compact .pinex-tab {
      padding: 4px 8px;
    }
    .pinex-tab:hover {
      color: var(--fg);
      opacity: 1;
    }
    .pinex-tab.active {
      color: var(--panel-text-strong);
      border-bottom-color: var(--accent);
      opacity: 1;
    }
    .pinex-tab.dragging {
      opacity: 0.45;
    }
    .pinex-tab.drop-target {
      background: rgba(255,255,255,0.07);
      border-radius: 4px 4px 0 0;
    }
    .pinex-tab-content {
      display: none;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      position: relative;
      z-index: 1;
    }
    .pinex-tab-content.active {
      display: flex;
      flex-direction: column;
    }
    .pinex-inline-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border-bottom: 1px solid var(--border);
      background: rgba(0,0,0,0.08);
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 11;
      min-height: var(--pinex-toolbar-height);
      box-sizing: border-box;
    }
    .pinex-debug-bar {
      display: none !important;
      padding: 3px 8px;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.72);
      color: #d7ba7d;
      border-bottom: 1px solid rgba(215,186,125,0.25);
      background: rgba(215,186,125,0.08);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex-shrink: 0;
    }
    .pinex-debug-bar.visible { display: none !important; }
    .pinex-inline-toolbar .search-wrapper {
      flex: 1;
      min-width: 0;
    }
    #todo-section,
    #note-section {
      display: none !important;
    }
    #pinex-section {
      top: 0 !important;
      left: 4px;
      right: 4px;
      bottom: 0 !important;
      height: auto !important;
    }
    #pinex-section > .section-header,
    #pinex-section > .card-resizer {
      display: none !important;
    }
    #pinex-section > .section-body {
      display: flex;
      flex-direction: column;
      height: 100%;
      padding-top: 0;
      min-height: 0;
      overflow: hidden;
    }
    .pinex-list {
      padding: 2px 6px 4px 10px;
      font-size: var(--pinex-font-size);
      flex: 1;
      min-height: 0;
      overflow: auto;
      border-bottom: 1px solid var(--border);
      color: rgba(243,243,243,0.94);
    }
    /* 引用（References）面板样式 */
    .refs-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-size: var(--pinex-font-size);
    }
    .refs-session-list {
      flex: 0 0 auto;
      min-height: 40px;
      overflow: auto;
      padding: 4px 6px;
      color: var(--panel-text);
    }
    .refs-resizer {
      height: 4px;
      background: var(--border);
      cursor: ns-resize;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .refs-resizer:hover {
      background: var(--accent);
    }
    /* 搜索中：在中间分隔条显示蓝色进度动画 */
    .refs-resizer.searching {
      position: relative;
      background: var(--border);
    }
    .refs-resizer.searching::after {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 35%;
      background: var(--vscode-progressBar-background, var(--accent));
      opacity: 0.95;
      animation: refs-progress 1.1s ease-in-out infinite;
      border-radius: 3px;
    }
    @keyframes refs-progress {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    .refs-result-list {
      flex: 1;
      min-height: 40px;
      overflow: auto;
      padding: 4px 6px;
      color: var(--panel-text);
    }
    .refs-empty {
      color: var(--panel-text-muted);
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      padding: 12px;
      text-align: center;
      opacity: 0.7;
    }
    .refs-session-item {
      padding: 3px 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      color: var(--panel-text);
      border-radius: 3px;
    }
    .refs-session-item:hover {
      background: var(--pinex-hover);
      color: var(--fg);
    }
    .refs-session-item.active {
      background: var(--pinex-active);
      color: var(--fg);
    }
    .refs-session-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .refs-session-mode {
      flex-shrink: 0;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.70);
      font-weight: 700;
      padding: 1px 0;
      min-width: 18px;
      text-align: center;
      border-radius: 999px;
      border: 1px solid var(--border);
      opacity: 1;
      user-select: none;
    }
    .refs-session-mode.ref {
      border-color: rgba(14,99,156,0.95);
      background: rgba(14,99,156,0.55);
      color: var(--fg);
    }
    .refs-session-mode.impl {
      border-color: rgba(197,134,192,0.95);
      background: rgba(197,134,192,0.55);
      color: var(--fg);
    }
    .refs-session-meta {
      flex-shrink: 0;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.72);
      opacity: 0.8;
    }
    .refs-session-action {
      flex-shrink: 0;
      margin-left: 4px;
      font-size: calc(var(--font-size-base) * 0.85);
      color: var(--panel-text-muted);
      cursor: pointer;
      user-select: none;
    }
    .refs-session-action:hover {
      color: #f48771;
    }
    .refs-session-pin {
      /* 默认半透明（未固定） */
      opacity: 0.5;
      transition: opacity 0.15s, transform 0.15s, color 0.15s;
      transform: none;
    }
    .refs-session-pin:hover {
      opacity: 1;
      color: var(--accent);
    }
    .refs-session-pin.pinned {
      /* 固定后：不透明 + 旋转角度参考 PinEx 固定图标 */
      opacity: 1;
      color: var(--accent);
      transform: rotate(-45deg);
    }
    .refs-file-title {
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.78);
      font-weight: 600;
      margin: 6px 0 2px 0;
      color: var(--panel-text-muted);
      opacity: 0.9;
    }
    .refs-item {
      padding: 2px 4px 2px 8px;
      cursor: pointer;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      color: var(--panel-text);
      border-radius: 3px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .refs-item:nth-child(odd) {
      background-color: var(--panel-row-odd);
    }
    .refs-item:nth-child(even) {
      background-color: var(--panel-row-even);
    }
    .refs-item:hover {
      background-color: var(--pinex-hover);
      color: var(--fg);
    }
    .refs-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground, rgba(14,99,156,0.35));
      color: var(--vscode-list-activeSelectionForeground, var(--fg));
      outline: 1px solid var(--vscode-focusBorder, var(--accent));
    }
    .refs-item.selected .refs-loc,
    .refs-item.selected .refs-preview {
      color: var(--vscode-list-activeSelectionForeground, var(--fg));
      opacity: 0.95;
    }
    .refs-group-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 6px;
      border-radius: 3px;
      cursor: pointer;
      color: var(--panel-text-muted);
      user-select: none;
    }
    .refs-group-header:hover {
      background: rgba(255,255,255,0.03);
      color: var(--fg);
    }
    .refs-chevron {
      width: 12px;
      text-align: center;
      flex-shrink: 0;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.78);
      opacity: 0.9;
    }
    .refs-group-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
    }
    .refs-group-count {
      flex-shrink: 0;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.75);
      opacity: 0.85;
    }
    .refs-toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding: 4px 6px;
      margin: -4px -6px 6px -6px;
      background: #1b1b1b;
      border-bottom: 1px solid var(--border);
    }
    .refs-searching {
      margin-right: auto;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.78);
      color: var(--panel-text-muted);
      opacity: 0.9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .refs-status {
      margin-right: auto;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.78);
      color: var(--panel-text-muted);
      opacity: 0.95;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* 预览改为 VS Code 原生 Peek（不再用 Webview 浮层） */
    .refs-toolbar-btn {
      width: 22px;
      height: 22px;
      border: 1px solid var(--border);
      background: rgba(0,0,0,0.12);
      color: var(--panel-text-muted);
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      user-select: none;
      line-height: 1;
      padding: 0;
    }
    .refs-toolbar-btn:hover {
      border-color: var(--accent);
      color: var(--fg);
    }
    .refs-toolbar-btn.active {
      border-color: var(--accent);
      background: rgba(14,99,156,0.22);
      color: var(--fg);
    }
    .refs-load-more {
      margin: 10px 6px 6px;
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: rgba(255,255,255,0.04);
      color: var(--panel-text);
      cursor: pointer;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.84);
    }
    .refs-load-more:hover {
      border-color: var(--accent);
      background: rgba(14,99,156,0.16);
      color: var(--panel-text-strong);
    }
    .refs-load-more-meta {
      margin: 4px 6px 8px;
      color: var(--panel-text-muted);
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.76);
    }
    .refs-toolbar-btn.filter-read.active {
      border-color: #9cdcfe;
      background: #9cdcfe;
      color: #333;
    }
    .refs-toolbar-btn.filter-write.active {
      border-color: #f48771;
      background: #f48771;
      color: #fff;
    }
    .refs-toolbar-btn.filter-all.active {
      border-color: var(--accent);
      background: rgba(14,99,156,0.22);
      color: var(--fg);
    }
    .refs-toolbar-btn.filter-calls.active {
      border-color: #d7ba7d;
      background: #d7ba7d;
      color: #333;
    }
    .refs-access-badge {
      width: 14px;
      height: 14px;
      border-radius: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      flex-shrink: 0;
      opacity: 0.9;
    }
    .refs-access-badge.read {
      background: #9cdcfe;
      color: #333;
    }
    .refs-access-badge.write {
      background: #f48771;
      color: #fff;
    }
    .refs-loc {
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.75);
      color: var(--panel-text-subtle);
      opacity: 0.9;
      flex-shrink: 0;
    }
    .refs-preview {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: Consolas, 'Courier New', monospace;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.82);
    }
    /* 符号面板样式 */
    .symbol-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-size: var(--pinex-font-size);
    }
    .symbol-class-list {
      flex: 0 0 auto;
      min-height: 40px;
      overflow: auto;
      padding: 4px 6px;
      color: var(--panel-text);
    }
    .symbol-resizer {
      height: 4px;
      background: var(--border);
      cursor: ns-resize;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .symbol-resizer:hover {
      background: var(--accent);
    }
    .symbol-member-list {
      flex: 1;
      min-height: 40px;
      overflow: auto;
      padding: 4px 6px;
      color: var(--panel-text);
    }
    .symbol-member-toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 4px 6px;
      margin: -4px -6px 2px -6px;
      background: #1b1b1b; /* 与 section 背景一致，避免半透明造成“颜色不一致” */
      border-bottom: 1px solid var(--border);
    }
    .symbol-member-toolbar-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.75);
      color: var(--panel-text-muted);
      user-select: none;
    }
    .symbol-member-toolbar-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .symbol-filter-btn {
      width: 22px;
      height: 22px;
      border: 1px solid var(--border);
      background: rgba(0,0,0,0.12);
      color: var(--panel-text-muted);
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      user-select: none;
      line-height: 1;
      padding: 0;
    }
    .symbol-filter-btn:hover {
      border-color: var(--accent);
      color: var(--fg);
    }
    .symbol-filter-btn.active {
      border-color: var(--accent);
      background: rgba(14,99,156,0.22);
      color: var(--fg);
    }
    /* 成员筛选按钮：激活态按类型配色（与图标一致） */
    .symbol-filter-btn.filter-field.active {
      border-color: #c586c0;
      background: #c586c0;
      color: #fff;
    }
    .symbol-filter-btn.filter-property.active {
      border-color: #9cdcfe;
      background: #9cdcfe;
      color: #333;
    }
    .symbol-filter-btn.filter-method.active {
      border-color: #dcdcaa;
      background: #dcdcaa;
      color: #333;
    }
    .symbol-item {
      padding: 3px 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      color: var(--panel-text);
      border-radius: 3px;
    }
    .symbol-item:hover {
      background: var(--pinex-hover);
      color: var(--fg);
    }
    .symbol-item.active {
      background: var(--pinex-active);
      color: var(--fg);
    }
    .symbol-icon {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      border-radius: 2px;
      font-weight: bold;
      flex-shrink: 0;
    }
    .symbol-icon.class { background: #3e9cd6; color: #fff; }
    .symbol-icon.struct { background: #4ec9b0; color: #fff; }
    .symbol-icon.interface { background: #b8d7a3; color: #333; }
    .symbol-icon.enum { background: #d4a656; color: #fff; }
    .symbol-icon.method { background: #dcdcaa; color: #333; }
    .symbol-icon.property { background: #9cdcfe; color: #333; }
    .symbol-icon.field { background: #c586c0; color: #fff; }
    .symbol-icon.event { background: #ce9178; color: #fff; }
    .symbol-icon.constructor { background: #b5cea8; color: #333; }
    .symbol-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .symbol-signature {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: Consolas, 'Courier New', monospace;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.8);
    }
    .symbol-content {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: Consolas, 'Courier New', monospace;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
    }
    .symbol-type-prefix {
      color: var(--accent);
      opacity: 0.9;
    }
    .symbol-section-title {
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.75);
      color: var(--panel-text-muted);
      padding: 4px 6px 2px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
    }
    .symbol-empty {
      color: var(--panel-text-muted);
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      padding: 12px;
      text-align: center;
      opacity: 0.7;
    }
    .pinex-dir {
      margin-bottom: 2px;
    }
    .pinex-dir-header {
      display: flex;
      align-items: center;
      cursor: pointer;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      color: var(--panel-text);
      padding: 2px 2px;
      border-radius: 3px;
    }
    .pinex-dir-header:hover {
      background-color: rgba(255,255,255,0.03);
    }
    .pinex-dir-chevron {
      width: 10px;
      text-align: center;
      margin-right: 4px;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.77);
    }
    .pinex-dir-label {
      flex: 1;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .pinex-dir-children {
      margin-left: 14px;
      margin-top: 2px;
    }
    .pinex-item {
      padding: 2px 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      color: var(--panel-text);
      border-radius: 3px;
    }
    .pinex-item:nth-child(odd) {
      background-color: var(--panel-row-odd);
    }
    .pinex-item:nth-child(even) {
      background-color: var(--panel-row-even);
    }
    .pinex-item:hover {
      background-color: var(--pinex-hover);
      color: var(--fg);
    }
    .pinex-item.active {
      background-color: var(--pinex-active);
      color: var(--fg);
    }
    .p4-file-row {
      gap: 6px;
    }
    .p4-action-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      border-radius: 4px;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.72);
      font-weight: 700;
      line-height: 1;
      flex-shrink: 0;
      text-transform: uppercase;
    }
    .p4-action-badge.add {
      background: rgba(78, 201, 176, 0.22);
      color: #4ec9b0;
      border: 1px solid rgba(78, 201, 176, 0.35);
    }
    .p4-action-badge.edit {
      background: rgba(156, 220, 254, 0.22);
      color: #9cdcfe;
      border: 1px solid rgba(156, 220, 254, 0.35);
    }
    .p4-action-badge.delete {
      background: rgba(244, 135, 113, 0.22);
      color: #f48771;
      border: 1px solid rgba(244, 135, 113, 0.35);
    }
    .p4-action-badge.branch,
    .p4-action-badge.move {
      background: rgba(215, 186, 125, 0.22);
      color: #d7ba7d;
      border: 1px solid rgba(215, 186, 125, 0.35);
    }
    .p4-action-badge.integrate {
      background: rgba(197, 134, 192, 0.22);
      color: #c586c0;
      border: 1px solid rgba(197, 134, 192, 0.35);
    }
    .p4-action-badge.default {
      background: rgba(255,255,255,0.10);
      color: var(--panel-text-muted);
      border: 1px solid rgba(255,255,255,0.12);
    }
    .p4-file-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .p4-file-meta {
      color: var(--panel-text-subtle);
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.74);
      flex-shrink: 0;
      white-space: nowrap;
    }
    .vcs-tree {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .vcs-tree-dir {
      margin-bottom: 1px;
    }
    .vcs-tree-dir-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px;
      border-radius: 3px;
      color: var(--panel-text);
      cursor: pointer;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      overflow: hidden;
      white-space: nowrap;
    }
    .vcs-tree-dir-row:hover {
      background: var(--pinex-hover);
      color: var(--fg);
    }
    .vcs-tree-chevron {
      width: 12px;
      flex-shrink: 0;
      color: var(--panel-text-muted);
      text-align: center;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.72);
    }
    .vcs-tree-folder {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .vcs-tree-children {
      margin-left: 14px;
    }
    .p4-panel {
      flex: 1;
      padding: 6px;
      min-height: 0;
      overflow: auto;
      color: var(--panel-text);
    }
    .vcs-context-menu {
      position: fixed;
      z-index: 9999;
      min-width: 168px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--vscode-menu-background, #252526);
      color: var(--vscode-menu-foreground, var(--panel-text));
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      display: none;
    }
    .vcs-context-menu.visible {
      display: block;
    }
    .vcs-context-item {
      padding: 5px 10px;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
    }
    .vcs-context-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--pinex-hover));
      color: var(--vscode-menu-selectionForeground, var(--fg));
    }
    .vcs-context-item.disabled {
      opacity: 0.45;
      cursor: default;
    }
    .vcs-context-item.disabled:hover {
      background: transparent;
      color: inherit;
    }
    .vcs-context-separator {
      height: 1px;
      margin: 4px 2px;
      background: var(--border);
    }
    .pinex-dir-header.active {
      background-color: var(--pinex-active);
      color: var(--fg);
    }
    .comment-item {
      padding: 3px 8px;
      margin-bottom: 2px;
      cursor: pointer;
      display: flex;
      align-items: center;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.85);
      color: var(--panel-text);
      background-color: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.035);
      border-radius: 4px;
    }
    .comment-item:nth-child(odd) {
      background-color: rgba(255,255,255,0.05);
    }
    .comment-item:nth-child(even) {
      background-color: rgba(255,255,255,0.085);
    }
    .comment-item:hover {
      background-color: var(--comment-hover);
      color: var(--fg);
    }
    .comment-item.active {
      outline: 1px solid var(--accent);
      background-color: var(--comment-active);
      color: var(--fg);
    }
    .comment-line {
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.77);
      color: var(--panel-text-subtle);
      margin-right: 8px;
    }
    .comment-delete {
      margin-left: auto;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.82);
      color: var(--panel-text-muted);
      cursor: pointer;
    }
    .comment-delete:hover {
      color: #f48771;
    }
    .pinex-unpin {
      position: relative;
      font-size: calc(var(--font-size-base) * 0.92);
      display: inline-block;
      transform: rotate(-45deg);
    }
    .pinex-unpin::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 1px;
      background: var(--fg-muted);
      transform: rotate(-45deg);
      opacity: 0;
    }
    .pinex-unpin:hover::after {
      opacity: 1;
      background: #f48771;
    }
    .pinex-pin-action {
      font-size: calc(var(--font-size-base) * 0.92);
      opacity: 0.5;
      transition: opacity 0.15s, transform 0.15s;
      display: inline-block;
    }
    .pinex-pin-action:hover {
      opacity: 1;
    }
    .pinex-pin-action.pinned {
      opacity: 1;
      color: var(--accent);
      transform: rotate(-45deg);
    }
    .pinex-toolbar-icon {
      border: 1px solid var(--border);
      background: transparent;
      color: rgba(243,243,243,0.88);
      border-radius: 3px;
      padding: 0 4px;
      font-size: calc(var(--font-size-base) * 0.85);
      cursor: pointer;
    }
	    .pinex-toolbar-icon:hover {
	      border-color: var(--accent);
	      color: var(--fg);
	    }
	    .pinex-toolbar-icon.active {
	      border-color: var(--accent);
	      background: rgba(14,99,156,0.24);
	      color: var(--fg);
	    }
    .card-resizer {
      position: absolute;
      left: 2px;
      right: 2px;
      bottom: 0;
      height: 6px;
      cursor: row-resize;
      background-color: transparent;
      border-bottom-left-radius: 4px;
      border-bottom-right-radius: 4px;
    }
    .card-resizer:hover {
      background-color: rgba(255,255,255,0.06);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="body scroll-area" id="body-root">
      <div class="section" id="todo-section">
        <div class="section-header" data-section="todo">
          <span class="section-chevron">▼</span>
          <span class="section-title">TODO</span>
          <span class="scanning-indicator" id="todo-scanning" style="display:none;">⏳ Scanning...</span>
          <div class="todo-header-toolbar">
            <span class="search-wrapper">
            <input class="search-input" id="search-input" type="text" placeholder="Search TODO..." />
              <span class="search-clear" id="search-clear-btn" title="Clear">×</span>
            </span>
            <button class="todo-toggle-files" id="toggle-files-btn">Hide</button>
          </div>
          <span class="section-actions">
            <button class="section-move-btn" data-card="todo" data-move="up">↑</button>
            <button class="section-move-btn" data-card="todo" data-move="down">↓</button>
          </span>
        </div>
        <div class="section-body">
          <div class="todo-list scroll-area" id="todo-list"></div>
        </div>
        <div class="card-resizer" data-card="todo"></div>
      </div>
      <div class="section" id="note-section">
        <div class="section-header" data-section="note">
          <span class="section-chevron">&#9654;</span>
          <span class="section-title">COMMENT</span>
          <div class="comment-header-toolbar">
            <span class="search-wrapper">
              <input class="search-input" id="comment-search-input" type="text" placeholder="Search comments..." />
              <span class="search-clear" id="comment-search-clear-btn" title="Clear">&times;</span>
            </span>
          </div>
          <span class="section-actions">
            <button class="section-move-btn" id="comment-clear-all-btn">Clear</button>
            <button class="section-move-btn" data-card="note" data-move="up">&#8593;</button>
            <button class="section-move-btn" data-card="note" data-move="down">&#8595;</button>
          </span>
        </div>
        <div class="section-body">
          <div class="comment-list scroll-area" id="comment-list"></div>
        </div>
        <div class="card-resizer" data-card="note"></div>
      </div>
      <div class="section" id="pinex-section">
        <div class="section-header" data-section="pinex">
          <span class="section-chevron">&#9654;</span>
          <span class="section-title">PinEx</span>
          <div class="pinex-header-toolbar">
            <span class="search-wrapper">
              <input class="search-input" id="pinex-search-input" type="text" placeholder="Search..." />
              <span class="search-clear" id="pinex-search-clear-btn" title="Clear">&times;</span>
            </span>
            <button class="pinex-toolbar-icon" id="pinex-expand-all-btn" title="Expand all">+</button>
            <button class="pinex-toolbar-icon" id="pinex-collapse-all-btn" title="Collapse all">-</button>
            <button class="pinex-toolbar-icon" id="pinex-locate-btn" title="Locate current file">o</button>
          </div>
          <span class="section-actions">
            <button class="section-move-btn" id="pinex-clear-all-btn">Clear</button>
            <button class="section-move-btn" data-card="pinex" data-move="up">&#8593;</button>
            <button class="section-move-btn" data-card="pinex" data-move="down">&#8595;</button>
          </span>
        </div>
        <div class="section-body">
          <div class="pinex-tabs">
            <button class="pinex-tab active" data-tab="todo" draggable="false" title="TODO"><span class="tab-icon">&#10003;</span><span class="tab-text">TODO</span></button>
            <button class="pinex-tab" data-tab="comment" draggable="false" title="Comment"><span class="tab-icon">&#9998;</span><span class="tab-text">Comment</span></button>
            <button class="pinex-tab" data-tab="pin" draggable="false" title="Pinned"><span class="tab-icon">&#128204;</span><span class="tab-text">Pinned</span></button>
            <button class="pinex-tab" data-tab="open" draggable="false" title="Open"><span class="tab-icon">&#128193;</span><span class="tab-text">Open</span></button>
            <button class="pinex-tab" data-tab="p4" draggable="false" title="P4"><span class="tab-icon">P</span><span class="tab-text">P4</span></button>
            <button class="pinex-tab" data-tab="svn" draggable="false" title="SVN"><span class="tab-icon">S</span><span class="tab-text">SVN</span></button>
            <button class="pinex-tab" data-tab="symbol" draggable="false" title="Symbols"><span class="tab-icon">&#9670;</span><span class="tab-text">Symbols</span></button>
            <button class="pinex-tab" data-tab="refs" draggable="false" title="References"><span class="tab-icon">&#128279;</span><span class="tab-text">References</span></button>
          </div>
          <div class="pinex-debug-bar" id="pinex-debug-bar"></div>
          <div class="pinex-tab-content active" id="pinex-todo-content">
            <div class="pinex-inline-toolbar">
              <span class="scanning-indicator" id="todo-scanning-inline" style="display:none;">Scanning...</span>
              <span class="search-wrapper">
                <input class="search-input" id="search-input-inline" type="text" placeholder="Search TODO..." />
                <span class="search-clear" id="search-clear-btn-inline" title="Clear">&times;</span>
              </span>
              <button class="pinex-toolbar-icon" id="toggle-files-btn-inline" title="Toggle file grouping">Files</button>
              <button class="pinex-toolbar-icon" id="todo-refresh-btn-inline" title="Refresh TODO list">&#8635;</button>
            </div>
            <div class="todo-list scroll-area" id="todo-list-inline"></div>
          </div>
          <div class="pinex-tab-content" id="pinex-comment-content">
            <div class="pinex-inline-toolbar">
              <span class="search-wrapper">
                <input class="search-input" id="comment-search-input-inline" type="text" placeholder="Search comments..." />
                <span class="search-clear" id="comment-search-clear-btn-inline" title="Clear">&times;</span>
              </span>
              <button class="pinex-toolbar-icon" id="comment-clear-all-btn-inline" title="Clear all comments">Clear</button>
            </div>
            <div class="comment-list scroll-area" id="comment-list-inline"></div>
          </div>
          <div class="pinex-tab-content" id="pinex-pin-content">
            <div class="pinex-inline-toolbar">
              <span class="search-wrapper">
                <input class="search-input" id="pinex-search-input-inline" type="text" placeholder="Search pinned..." />
                <span class="search-clear" id="pinex-search-clear-btn-inline" title="Clear">&times;</span>
              </span>
              <button class="pinex-toolbar-icon" id="pinex-expand-all-btn-inline" title="Expand all">+</button>
              <button class="pinex-toolbar-icon" id="pinex-collapse-all-btn-inline" title="Collapse all">-</button>
              <button class="pinex-toolbar-icon" id="pinex-locate-btn-inline" title="Locate current file">o</button>
              <button class="pinex-toolbar-icon" id="pinex-clear-all-btn-inline" title="Clear all pinned items">Clear</button>
            </div>
            <div class="pinex-list scroll-area" id="pinex-list"></div>
          </div>
          <div class="pinex-tab-content" id="pinex-open-content">
            <div class="pinex-inline-toolbar">
              <span class="search-wrapper">
                <input class="search-input" id="pinex-open-search-input-inline" type="text" placeholder="Search open files..." />
                <span class="search-clear" id="pinex-open-search-clear-btn-inline" title="Clear">&times;</span>
              </span>
            </div>
            <div class="pinex-list scroll-area" id="pinex-open-list"></div>
          </div>
          <div class="pinex-tab-content" id="pinex-p4-content">
            <div class="pinex-inline-toolbar">
              <button class="pinex-toolbar-icon" id="p4-refresh-btn-inline" title="Refresh P4">&#8635;</button>
              <button class="pinex-toolbar-icon" id="p4-sync-dir-btn-inline" title="Sync current directory">Sync</button>
              <button class="pinex-toolbar-icon" id="p4-submit-dir-btn-inline" title="Submit current directory">Submit</button>
              <button class="pinex-toolbar-icon" id="p4-edit-current-btn-inline" title="Open current file for edit">Edit</button>
              <button class="pinex-toolbar-icon" id="p4-diff-current-btn-inline" title="Diff current file">Diff</button>
              <button class="pinex-toolbar-icon" id="p4-revert-current-btn-inline" title="Revert current file">Revert</button>
            </div>
            <div class="p4-panel scroll-area" id="p4-panel"></div>
          </div>
          <div class="pinex-tab-content" id="pinex-svn-content">
            <div class="pinex-inline-toolbar">
              <button class="pinex-toolbar-icon" id="svn-refresh-btn-inline" title="Refresh SVN">&#8635;</button>
              <button class="pinex-toolbar-icon" id="svn-update-btn-inline" title="Update working copy">Update</button>
              <button class="pinex-toolbar-icon" id="svn-commit-dir-btn-inline" title="Open SVN Commit window">Commit...</button>
              <button class="pinex-toolbar-icon" id="svn-add-current-btn-inline" title="Add current file">Add</button>
              <button class="pinex-toolbar-icon" id="svn-diff-current-btn-inline" title="Diff current file">Diff</button>
              <button class="pinex-toolbar-icon" id="svn-history-current-btn-inline" title="Show current file history">History</button>
              <button class="pinex-toolbar-icon" id="svn-revert-current-btn-inline" title="Revert current file">Revert</button>
              <button class="pinex-toolbar-icon" id="svn-expand-tree-btn-inline" title="Expand SVN tree">+</button>
              <button class="pinex-toolbar-icon" id="svn-collapse-tree-btn-inline" title="Collapse SVN tree">-</button>
              <button class="pinex-toolbar-icon" id="svn-toggle-unversioned-btn-inline" title="Hide unversioned files">?</button>
            </div>
            <div class="p4-panel scroll-area" id="svn-panel"></div>
          </div>
          <div class="vcs-context-menu" id="svn-context-menu"></div>
          <div class="pinex-tab-content" id="pinex-symbol-content">
            <div class="symbol-panel">
              <div class="symbol-class-list scroll-area" id="symbol-class-list"></div>
              <div class="symbol-resizer" id="symbol-resizer"></div>
              <div class="symbol-member-list scroll-area" id="symbol-member-list"></div>
            </div>
          </div>
          <div class="pinex-tab-content" id="pinex-refs-content">
            <div class="refs-panel">
              <div class="refs-session-list scroll-area" id="refs-session-list"></div>
              <div class="refs-resizer" id="refs-resizer"></div>
              <div class="refs-result-list scroll-area" id="refs-result-list"></div>
            </div>
          </div>
        </div>
        <div class="card-resizer" data-card="pinex"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      var vscode;
      try {
        vscode = acquireVsCodeApi();
      } catch (e) {
        console.error('Failed to acquire VS Code API:', e);
        try {
          var earlyDebugBar = document.getElementById('pinex-debug-bar');
          if (earlyDebugBar) {
            earlyDebugBar.textContent = 'acquireVsCodeApi failed: ' + (e && e.message ? e.message : String(e));
            earlyDebugBar.classList.add('visible');
          }
        } catch (_) {
          // ignore
        }
        return;
      }

      function setAreaScrollbarVisible(el, visible) {
        if (!el || !el.classList) return;
        if (visible) {
          el.classList.add('scrollbar-visible');
        } else {
          el.classList.remove('scrollbar-visible');
        }
      }

      function scheduleHideArea(el) {
        if (!el) return;
        if (el.__cursorExScrollbarTimer) {
          clearTimeout(el.__cursorExScrollbarTimer);
          el.__cursorExScrollbarTimer = null;
        }
        el.__cursorExScrollbarTimer = setTimeout(function () {
          try {
            var active = document.activeElement;
            if (el.matches && el.matches(':hover')) return;
            if (active && el.contains && el.contains(active)) return;
          } catch (e) {
            // ignore
          }
          setAreaScrollbarVisible(el, false);
        }, 220);
      }

      // 默认隐藏：只在当前滚动区域被 hover/点击/聚焦时显示
      var scrollAreas = [];
      try {
        scrollAreas = Array.prototype.slice.call(document.querySelectorAll('.scroll-area'));
      } catch (e) {
        scrollAreas = [];
      }
      scrollAreas.forEach(function (el) {
        setAreaScrollbarVisible(el, false);
        el.addEventListener('mouseenter', function () { setAreaScrollbarVisible(el, true); });
        el.addEventListener('mouseleave', function () { scheduleHideArea(el); });
        el.addEventListener('focusin', function () { setAreaScrollbarVisible(el, true); });
        el.addEventListener('focusout', function () { scheduleHideArea(el); });
        el.addEventListener('wheel', function () {
          setAreaScrollbarVisible(el, true);
          scheduleHideArea(el);
        }, { passive: true });
      });

      // 点击时仅点亮“目标所在”的滚动区域（而不是全局都显示）
      document.addEventListener('mousedown', function (e) {
        var t = e && e.target ? e.target : null;
        while (t && t !== document.body) {
          if (t.classList && t.classList.contains('scroll-area')) {
            setAreaScrollbarVisible(t, true);
            scheduleHideArea(t);
            break;
          }
          t = t.parentElement;
        }
      }, true);

      // Webview 失焦时全部隐藏
      window.addEventListener('blur', function () {
        scrollAreas.forEach(function (el) { setAreaScrollbarVisible(el, false); });
      });

      function hideSvnContextMenu() {
        if (!svnContextMenuEl) return;
        svnContextMenuEl.classList.remove('visible');
        svnContextMenuEl.innerHTML = '';
      }

      document.addEventListener('click', function (ev) {
        if (svnContextMenuEl && ev && svnContextMenuEl.contains(ev.target)) {
          return;
        }
        hideSvnContextMenu();
      }, true);

      document.addEventListener('keydown', function (ev) {
        if (ev && ev.key === 'Escape') {
          hideSvnContextMenu();
        }
      }, true);

      var bodyRoot = document.getElementById('body-root');
      var todoListEl = document.getElementById('todo-list-inline') || document.getElementById('todo-list');
      var searchInput = document.getElementById('search-input-inline') || document.getElementById('search-input');
      var searchClearBtn = document.getElementById('search-clear-btn-inline') || document.getElementById('search-clear-btn');
      var commentSearchInput = document.getElementById('comment-search-input-inline') || document.getElementById('comment-search-input');
      var commentSearchClearBtn = document.getElementById('comment-search-clear-btn-inline') || document.getElementById('comment-search-clear-btn');
      var toggleFilesBtn = document.getElementById('toggle-files-btn-inline') || document.getElementById('toggle-files-btn');
      var commentListEl = document.getElementById('comment-list-inline') || document.getElementById('comment-list');
      var commentClearAllBtn = document.getElementById('comment-clear-all-btn-inline') || document.getElementById('comment-clear-all-btn');
      var pinExListEl = document.getElementById('pinex-list');
      var pinExOpenListEl = document.getElementById('pinex-open-list');
      var p4PanelEl = document.getElementById('p4-panel');
      var svnPanelEl = document.getElementById('svn-panel');
      var svnContextMenuEl = document.getElementById('svn-context-menu');
      var svnExpandTreeBtn = document.getElementById('svn-expand-tree-btn-inline');
      var svnCollapseTreeBtn = document.getElementById('svn-collapse-tree-btn-inline');
      var svnToggleUnversionedBtn = document.getElementById('svn-toggle-unversioned-btn-inline');
      var refsSessionListEl = document.getElementById('refs-session-list');
      var refsResultListEl = document.getElementById('refs-result-list');
      var refsResizer = document.getElementById('refs-resizer');
      var symbolClassListEl = document.getElementById('symbol-class-list');
      var symbolMemberListEl = document.getElementById('symbol-member-list');
      var symbolResizer = document.getElementById('symbol-resizer');
      var pinExClearAllBtn = document.getElementById('pinex-clear-all-btn-inline') || document.getElementById('pinex-clear-all-btn');
      var pinExSearchClearBtn = document.getElementById('pinex-search-clear-btn-inline') || document.getElementById('pinex-search-clear-btn');
      var pinExSearchInput = document.getElementById('pinex-search-input-inline') || document.getElementById('pinex-search-input');
      var pinExExpandAllBtn = document.getElementById('pinex-expand-all-btn-inline') || document.getElementById('pinex-expand-all-btn');
      var pinExCollapseAllBtn = document.getElementById('pinex-collapse-all-btn-inline') || document.getElementById('pinex-collapse-all-btn');
      var pinExLocateBtn = document.getElementById('pinex-locate-btn-inline') || document.getElementById('pinex-locate-btn');
      var pinExOpenSearchInput = document.getElementById('pinex-open-search-input-inline');
      var pinExOpenSearchClearBtn = document.getElementById('pinex-open-search-clear-btn-inline');
      var pinExTabBar = document.querySelector('.pinex-tabs');
      var pinExDebugBar = document.getElementById('pinex-debug-bar');
      var pinExTabs = document.querySelectorAll('.pinex-tab');
      var pinExTabContents = document.querySelectorAll('.pinex-tab-content');
      var todoSection = document.getElementById('todo-section');
      var noteSection = document.getElementById('note-section');
      var pinExSection = document.getElementById('pinex-section');
      var sectionHeaders = document.querySelectorAll('.section-header');
      var moveButtons = document.querySelectorAll('.section-move-btn');
      var resizers = document.querySelectorAll('.card-resizer');

      function setPinExBootStatus(message) {
        return;
      }

      window.addEventListener('error', function (event) {
        var message = event && event.error && event.error.stack
          ? String(event.error.stack)
          : String((event && event.message) || 'unknown error');
        setPinExBootStatus('window error: ' + message);
      });

      window.addEventListener('unhandledrejection', function (event) {
        var reason = event && event.reason && event.reason.stack
          ? String(event.reason.stack)
          : String((event && event.reason) || 'unknown rejection');
        setPinExBootStatus('promise rejection: ' + reason);
      });

      setPinExBootStatus('boot: dom refs acquired');

      /** 卡片定義表，用於描述所有通用卡片 */
      var cardDefs = {
        pinex: { id: 'pinex', sectionId: 'pinex-section' }
      };

      var cardIds = ['pinex'];

      var allTodos = [];
      var allComments = [];
      var allPinEx = [];
      var pinExDirChildren = {};
      var pinExDirExpanded = {};
      var filterText = '';
      var commentFilterText = '';
      var pinExFilterText = '';
      var pinExExpandAllRequested = false;
      var todoContentFilter = '';
      var pinExLocatePending = false;
      var pinExLocateTargetUri = null;
      var pinExItemsInitialized = false;
      var todosInitialized = false;
      var commentsInitialized = false;
      var openFilesInitialized = false;
      var pinExFileExtensions = [];
      var activePinExUri = null;
      var allOpenFiles = [];
      var allReferenceSessions = [];
      var activeReferenceSessionId = null;
      var allSymbolClasses = [];
      var allSymbolMembers = [];
      var symbolFileUri = null;
      var symbolFileName = '';
      var symbolNotCs = false;
      var selectedSymbolClass = null;
      var pinExActiveTab = 'todo';
      var defaultPinExTabOrder = ['todo', 'comment', 'pin', 'open', 'p4', 'svn', 'symbol', 'refs'];
      var pinExTabOrder = defaultPinExTabOrder.slice();
      var cardCollapsed = {};
      var cardHeights = {};
      var cardOrder = cardIds.slice();
      var showFiles = true;
      var activeCommentKey = null;
      var symbolMemberFilters = { field: true, property: true, method: true };
      var refsSessionHeight = 140; // References 顶部“会话列表”默认高度
      var refsAccessFilter = 'all'; // all | read | write （仅字段查询时生效）
      var refsMethodFilter = 'all'; // all | calls （仅方法引用时生效）
      var refsSearching = false;
      var refsSelectedBySession = {};
      var refsVisibleCountBySession = {};
      var p4Snapshot = { available: false, status: 'Loading P4...', clientName: '', clientRoot: '', opened: [], pendingChanges: [], updatedAt: 0 };
      var svnSnapshot = { available: false, status: 'Loading SVN...', workingCopyRoot: '', url: '', revision: '', items: [], updatedAt: 0 };
      var vcsProvider = 'auto';
      var showP4Tab = true;
      var showSvnTab = true;
      var showSvnUnversioned = true;

      setPinExBootStatus('boot: state vars ready');

      if (pinExDebugBar) {
        pinExDebugBar.textContent = 'debug bootstrapped';
      }

      // 安全地恢復狀態，如果出錯則使用默認值
      try {
        var state = (vscode.getState && vscode.getState()) || {};
        if (state && typeof state === 'object') {
          // 通用結構優先
          if (state.cardCollapsed && typeof state.cardCollapsed === 'object') {
            for (var id in state.cardCollapsed) {
              if (typeof state.cardCollapsed[id] === 'boolean') {
                cardCollapsed[id] = state.cardCollapsed[id];
              }
            }
          }
          if (state.cardHeights && typeof state.cardHeights === 'object') {
            for (var id in state.cardHeights) {
              if (typeof state.cardHeights[id] === 'number') {
                cardHeights[id] = state.cardHeights[id];
              }
            }
          }
          if (Array.isArray(state.cardOrder)) {
            var nextOrder = [];
            state.cardOrder.forEach(function (id) {
              if (cardIds.indexOf(id) >= 0 && nextOrder.indexOf(id) < 0) {
                nextOrder.push(id);
              }
            });
            cardIds.forEach(function (id) {
              if (nextOrder.indexOf(id) < 0) {
                nextOrder.push(id);
              }
            });
            cardOrder = nextOrder;
          } else if (typeof state.todoOnTop === 'boolean') {
            // 舊版本狀態遷移：todoOnTop + 固定 COMMENT + 新增 PinEx 卡片
            cardOrder = state.todoOnTop
              ? ['todo', 'note', 'pinex']
              : ['note', 'todo', 'pinex'];
          }
          // 舊字段遷移：折疊狀態與高度
      if (typeof state.collapsedTodo === 'boolean') {
            cardCollapsed.todo = state.collapsedTodo;
      }
      if (typeof state.collapsedNote === 'boolean') {
            cardCollapsed.note = state.collapsedNote;
      }
      if (typeof state.todoHeight === 'number') {
            cardHeights.todo = state.todoHeight;
      }
      if (typeof state.noteHeight === 'number') {
            cardHeights.note = state.noteHeight;
      }
	      if (typeof state.showFiles === 'boolean') {
	        showFiles = state.showFiles;
	      }
	      if (typeof state.showSvnUnversioned === 'boolean') {
	        showSvnUnversioned = state.showSvnUnversioned;
	      }
      if (typeof state.refsSessionHeight === 'number') {
        refsSessionHeight = state.refsSessionHeight;
      }
      if (typeof state.activeReferenceSessionId === 'string') {
        activeReferenceSessionId = state.activeReferenceSessionId;
      }
      if (typeof state.refsAccessFilter === 'string') {
        refsAccessFilter = state.refsAccessFilter;
      }
      if (typeof state.refsMethodFilter === 'string') {
        refsMethodFilter = state.refsMethodFilter;
      }
      if (state.refsVisibleCountBySession && typeof state.refsVisibleCountBySession === 'object') {
        refsVisibleCountBySession = state.refsVisibleCountBySession;
      }
      if (Array.isArray(state.pinExTabOrder)) {
        var nextTabOrder = [];
        state.pinExTabOrder.forEach(function (id) {
          if (defaultPinExTabOrder.indexOf(id) >= 0 && nextTabOrder.indexOf(id) < 0) {
            nextTabOrder.push(id);
          }
        });
        defaultPinExTabOrder.forEach(function (id) {
          if (nextTabOrder.indexOf(id) < 0) {
            nextTabOrder.push(id);
          }
        });
        pinExTabOrder = nextTabOrder;
      }
      if (state.refsSelectedBySession && typeof state.refsSelectedBySession === 'object') {
        refsSelectedBySession = state.refsSelectedBySession;
      }
      if (state.symbolMemberFilters && typeof state.symbolMemberFilters === 'object') {
        if (typeof state.symbolMemberFilters.field === 'boolean') {
          symbolMemberFilters.field = state.symbolMemberFilters.field;
        }
        if (typeof state.symbolMemberFilters.property === 'boolean') {
          symbolMemberFilters.property = state.symbolMemberFilters.property;
        }
        if (typeof state.symbolMemberFilters.method === 'boolean') {
          symbolMemberFilters.method = state.symbolMemberFilters.method;
        }
      }
        }
      } catch (e) {
        console.error('Failed to restore state, using defaults:', e);
        setPinExBootStatus('boot: restore state failed - ' + (e && e.message ? e.message : String(e)));
        cardCollapsed = {};
        cardHeights = {};
        cardOrder = cardIds.slice();
	        showFiles = true;
	        showSvnUnversioned = true;
	        symbolMemberFilters = { field: true, property: true, method: true };
	      }

      setPinExBootStatus('boot: state restored');

      // 為所有已知卡片補齊默認折疊狀態與高度，避免新增卡片時到處改初始化代碼
      cardIds.forEach(function (id) {
        if (typeof cardCollapsed[id] !== 'boolean') {
          cardCollapsed[id] = false;
        }
        if (typeof cardHeights[id] !== 'number') {
          cardHeights[id] = 220;
        }
      });

      // 確保 cardOrder 是有效的數組且包含所有卡片
      if (!Array.isArray(cardOrder) || cardOrder.length !== cardIds.length) {
        cardOrder = cardIds.slice();
      }

      function persistState() {
        vscode.setState({
          cardCollapsed: cardCollapsed,
          cardHeights: cardHeights,
          cardOrder: cardOrder,
	          pinExTabOrder: pinExTabOrder,
	          showFiles: showFiles,
	          showSvnUnversioned: showSvnUnversioned,
	          symbolMemberFilters: symbolMemberFilters,
          refsSessionHeight: refsSessionHeight,
          activeReferenceSessionId: activeReferenceSessionId,
          refsAccessFilter: refsAccessFilter,
          refsMethodFilter: refsMethodFilter,
          refsSelectedBySession: refsSelectedBySession,
          refsVisibleCountBySession: refsVisibleCountBySession
        });
      }

      function maybeAutoLoadMoreReferences() {
        if (!refsResultListEl || !activeReferenceSessionId) return;
        var active = null;
        for (var i = 0; i < allReferenceSessions.length; i++) {
          if (allReferenceSessions[i] && allReferenceSessions[i].id === activeReferenceSessionId) {
            active = allReferenceSessions[i];
            break;
          }
        }
        if (!active || !Array.isArray(active.results)) return;
        var storedResults = active.results.length;
        var currentVisible = Math.min(refsVisibleCountBySession[active.id] || 500, storedResults);
        if (storedResults <= currentVisible) return;
        refsVisibleCountBySession[active.id] = Math.min(storedResults, currentVisible + 500);
        persistState();
        renderReferences();
      }

      function normalizePinExToolbarText() {
        if (searchClearBtn) searchClearBtn.innerHTML = '&times;';
        if (commentSearchClearBtn) commentSearchClearBtn.innerHTML = '&times;';
        if (pinExSearchClearBtn) pinExSearchClearBtn.innerHTML = '&times;';
        if (pinExOpenSearchClearBtn) pinExOpenSearchClearBtn.innerHTML = '&times;';
        if (pinExExpandAllBtn) pinExExpandAllBtn.textContent = '+';
        if (pinExCollapseAllBtn) pinExCollapseAllBtn.textContent = '-';
        if (pinExLocateBtn) pinExLocateBtn.textContent = 'o';
      }

      function syncSvnUnversionedToggle() {
        if (!svnToggleUnversionedBtn) return;
        svnToggleUnversionedBtn.classList.toggle('active', showSvnUnversioned);
        svnToggleUnversionedBtn.textContent = showSvnUnversioned ? '?' : '-?';
        svnToggleUnversionedBtn.title = showSvnUnversioned ? 'Hide unversioned files' : 'Show unversioned files';
      }

      function setSvnTreeExpandedState(expanded) {
        if (!window.__svnTreeExpanded) window.__svnTreeExpanded = {};
        window.__svnTreeDefaultExpanded = expanded;
        Object.keys(window.__svnTreeExpanded).forEach(function (key) {
          window.__svnTreeExpanded[key] = expanded;
        });
        renderSvn();
      }

      function debugPinExTabs(message) {
        return;
      }

      function isPinExTabVisible(tabName) {
        if (tabName === 'p4') return showP4Tab;
        if (tabName === 'svn') return showSvnTab;
        return true;
      }

      function firstVisiblePinExTab() {
        for (var i = 0; i < defaultPinExTabOrder.length; i++) {
          if (isPinExTabVisible(defaultPinExTabOrder[i])) {
            return defaultPinExTabOrder[i];
          }
        }
        return 'todo';
      }

      function applyVcsVisibility() {
        var p4Tab = pinExTabBar ? pinExTabBar.querySelector('.pinex-tab[data-tab="p4"]') : null;
        var svnTab = pinExTabBar ? pinExTabBar.querySelector('.pinex-tab[data-tab="svn"]') : null;
        var p4Content = document.getElementById('pinex-p4-content');
        var svnContent = document.getElementById('pinex-svn-content');

        if (p4Tab) p4Tab.style.display = showP4Tab ? '' : 'none';
        if (svnTab) svnTab.style.display = showSvnTab ? '' : 'none';
        if (p4Content && !showP4Tab) p4Content.classList.remove('active');
        if (svnContent && !showSvnTab) svnContent.classList.remove('active');

        if (!isPinExTabVisible(pinExActiveTab)) {
          switchPinExTab(firstVisiblePinExTab());
        } else if (typeof window.__updatePinExTabLayout === 'function') {
          window.__updatePinExTabLayout();
        }
      }

      function applyPinExTabOrder() {
        if (!pinExTabBar) return;
        var orderedTabs = [];
        pinExTabOrder.forEach(function (id) {
          var tab = pinExTabBar.querySelector('.pinex-tab[data-tab="' + id + '"]');
          if (tab) {
            orderedTabs.push(tab);
          }
        });
        defaultPinExTabOrder.forEach(function (id) {
          var tab = pinExTabBar.querySelector('.pinex-tab[data-tab="' + id + '"]');
          if (tab && orderedTabs.indexOf(tab) < 0) {
            orderedTabs.push(tab);
          }
        });
        orderedTabs.forEach(function (tab) {
          pinExTabBar.appendChild(tab);
        });
        if (typeof window.__updatePinExTabLayout === 'function') {
          window.__updatePinExTabLayout();
        }
      }

      function renderTodos() {
        if (!todoListEl) return;
        todoListEl.innerHTML = '';

        if (!todosInitialized) {
          var initDiv = document.createElement('div');
          initDiv.className = 'empty-tip';
          initDiv.textContent = 'Cursor Tools is initializing TODO data...';
          todoListEl.appendChild(initDiv);
          return;
        }

        var keyword = filterText.trim().toLowerCase();
        var cfKeyword = (todoContentFilter || '').trim().toLowerCase();
        
        // 先應用配置的內容過濾器
        var baseList = cfKeyword
          ? allTodos.filter(function(t) { return t.text.toLowerCase().indexOf(cfKeyword) >= 0; })
          : allTodos.slice();
        
        // 再應用搜索框的過濾
        var visible = keyword
          ? baseList.filter(function(t) { return t.text.toLowerCase().indexOf(keyword) >= 0 || t.file.toLowerCase().indexOf(keyword) >= 0; })
          : baseList;

        if (!visible.length) {
          var div = document.createElement('div');
          div.className = 'empty-tip';
          div.textContent = keyword ? 'No matching TODOs.' : 'No //todo comments found.';
          todoListEl.appendChild(div);
          return;
        }

        if (showFiles) {
          var byFile = {};
          visible.forEach(function(t) {
            var key = t.file || t.uri;
            if (!byFile[key]) {
              byFile[key] = [];
            }
            byFile[key].push(t);
          });

          Object.keys(byFile).sort().forEach(function(file) {
            var group = document.createElement('div');
            group.className = 'file-group';

            var title = document.createElement('div');
            title.className = 'file-title';
            title.textContent = file;
            group.appendChild(title);

            byFile[file].sort(function(a, b) { return a.line - b.line; }).forEach(function(t) {
              var item = document.createElement('div');
              item.className = 'todo-item';

              var lineSpan = document.createElement('span');
              lineSpan.className = 'todo-line';
              lineSpan.textContent = 'Ln ' + (t.line + 1);

              var textSpan = document.createElement('span');
              textSpan.textContent = t.text;

              item.title = (t.file || t.uri) + '  Ln ' + (t.line + 1) + '  ' + t.text;

              item.appendChild(lineSpan);
              item.appendChild(textSpan);
              item.addEventListener('click', function () {
                vscode.postMessage({ type: 'revealTodo', uri: t.uri, line: t.line });
              });

              group.appendChild(item);
            });

            todoListEl.appendChild(group);
          });
        } else {
          var flat = visible.slice().sort(function(a, b) {
            var fa = (a.file || a.uri).toLowerCase();
            var fb = (b.file || b.uri).toLowerCase();
            if (fa < fb) return -1;
            if (fa > fb) return 1;
            return a.line - b.line;
          });

          flat.forEach(function(t) {
            var item = document.createElement('div');
            item.className = 'todo-item';

            var lineSpan = document.createElement('span');
            lineSpan.className = 'todo-line';
            lineSpan.textContent = 'Ln ' + (t.line + 1);

            var textSpan = document.createElement('span');
            textSpan.textContent = t.text;

            item.title = (t.file || t.uri) + '  Ln ' + (t.line + 1) + '  ' + t.text;

            item.appendChild(lineSpan);
            item.appendChild(textSpan);
            item.addEventListener('click', function () {
              vscode.postMessage({ type: 'revealTodo', uri: t.uri, line: t.line });
            });

            todoListEl.appendChild(item);
          });
        }

        // TODO 內容變更後，根據實際內容高度自動調整卡片高度與佈局
        syncHeightsFromContent();
      }

      function renderComments() {
        if (!commentListEl) return;
        commentListEl.innerHTML = '';

        if (!commentsInitialized) {
          var initDiv = document.createElement('div');
          initDiv.className = 'empty-tip';
          initDiv.textContent = 'Cursor Tools is initializing comments...';
          commentListEl.appendChild(initDiv);
          return;
        }

        var keyword = (commentFilterText || '').trim().toLowerCase();
        var source = keyword
          ? allComments.filter(function (c) {
              return (c.text || '').toLowerCase().indexOf(keyword) >= 0
                || (c.file || '').toLowerCase().indexOf(keyword) >= 0;
            })
          : allComments.slice();

        var items = source.sort(function (a, b) {
          var fa = (a.file || a.uri).toLowerCase();
          var fb = (b.file || b.uri).toLowerCase();
          if (fa < fb) return -1;
          if (fa > fb) return 1;
          if (a.line < b.line) return -1;
          if (a.line > b.line) return 1;
          return 0;
        });

        if (!items.length) {
          var div = document.createElement('div');
          div.className = 'empty-tip';
          div.textContent = keyword
            ? 'No matching comments.'
            : 'No line comments yet. Right-click the editor gutter and choose "Toggle Comment" to add one.';
          commentListEl.appendChild(div);
          return;
        }

        var activeEl = null;

        items.forEach(function (c) {
          var key = (c.uri || '') + '#' + String(c.line);
          var item = document.createElement('div');
          item.className = 'comment-item';

          if (activeCommentKey && key === activeCommentKey) {
            item.classList.add('active');
            activeEl = item;
          }

          var lineSpan = document.createElement('span');
          lineSpan.className = 'comment-line';
          lineSpan.textContent = 'Ln ' + (c.line + 1);

          var textSpan = document.createElement('span');
          // 只顯示文件名，不顯示完整路徑
          var fileName = c.file || '';
          var normalizedPath = fileName.replace(/\\\\/g, '/');
          var lastSlash = normalizedPath.lastIndexOf('/');
          var baseName = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : fileName;
          textSpan.textContent = (baseName ? '[' + baseName + '] ' : '') + c.text;

          var delSpan = document.createElement('span');
          delSpan.className = 'comment-delete';
          delSpan.textContent = '×';
          delSpan.title = 'Delete this comment';

          item.title = (c.file || c.uri) + '  Ln ' + (c.line + 1) + '  ' + c.text;

          item.appendChild(lineSpan);
          item.appendChild(textSpan);
          item.appendChild(delSpan);

          item.addEventListener('click', function () {
            vscode.postMessage({ type: 'revealComment', uri: c.uri, line: c.line });
          });

          delSpan.addEventListener('click', function (ev) {
            ev.stopPropagation();
            vscode.postMessage({ type: 'deleteComment', uri: c.uri, line: c.line });
          });

          commentListEl.appendChild(item);
        });

        // 列表內容變更後，同步卡片高度
        syncHeightsFromContent();

        if (activeEl && typeof activeEl.scrollIntoView === 'function') {
          activeEl.scrollIntoView({ block: 'nearest' });
        }
      }

      function applySectionCollapse() {
        /** @param {HTMLElement|null} sectionEl */
        function setSection(sectionEl, collapsed) {
          if (!sectionEl) return;
          if (collapsed) {
            sectionEl.classList.add('collapsed');
          } else {
            sectionEl.classList.remove('collapsed');
          }
        }

        function getSectionElement(id) {
          if (id === 'pinex') return pinExSection;
          return null;
        }

        cardIds.forEach(function (id) {
          var el = getSectionElement(id);
          setSection(el, !!cardCollapsed[id]);
        });

        sectionHeaders.forEach(function (header) {
          var chevron = header.querySelector('.section-chevron');
          if (!chevron) return;
          var key = header.getAttribute('data-section');
          if (!key || !Object.prototype.hasOwnProperty.call(cardCollapsed, key)) {
            return;
          }
          chevron.textContent = cardCollapsed[key] ? '▶' : '▼';
        });

        // 折疊 / 展開 之後，同步重新計算懸浮卡片高度與位置
        applyHeights();
      }

      window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || typeof message.type !== 'string') return;
        // 通用消息日志
        if (message.type !== 'todos' && message.type !== 'comments' && message.type !== 'pinExItems' && message.type !== 'openFiles') {
          console.log('[CursorEx-WV] Received message type:', message.type);
        }
        if (message.type === 'todos' && Array.isArray(message.todos)) {
          todosInitialized = true;
          allTodos = message.todos;
          renderTodos();
        } else if (message.type === 'todoContentFilter' && typeof message.filter === 'string') {
          todoContentFilter = message.filter;
          renderTodos();
        } else if (message.type === 'todoScanning' && typeof message.isScanning === 'boolean') {
          var indicator = document.getElementById('todo-scanning-inline') || document.getElementById('todo-scanning');
          if (indicator) {
            indicator.style.display = message.isScanning ? 'inline' : 'none';
          }
        } else if (message.type === 'comments' && Array.isArray(message.comments)) {
          commentsInitialized = true;
          allComments = message.comments;
          renderComments();
        } else if (message.type === 'pinExItems' && Array.isArray(message.items)) {
          allPinEx = message.items;
          pinExItemsInitialized = true;
          renderPinEx();
          renderOpenFiles(); // 更新打開文件列表的固定狀態
          // 如果有待处理的定位请求，PinEx 数据到达后再尝试一次
          if (pinExLocatePending) {
            setTimeout(function () { tryLocateActivePinEx(); }, 60);
          }
        } else if (message.type === 'globalSettings') {
          if (typeof message.fontSize === 'number') {
            document.documentElement.style.setProperty('--font-size-base', message.fontSize + 'px');
          }
          if (message.accentColor) {
            document.documentElement.style.setProperty('--accent', message.accentColor);
          }
          if (message.textColor) {
            document.documentElement.style.setProperty('--fg', message.textColor);
          }
          if (message.mutedColor) {
            document.documentElement.style.setProperty('--fg-muted', message.mutedColor);
          }
          if (message.bgColor) {
            document.documentElement.style.setProperty('--bg', message.bgColor);
          }
          if (message.borderColor) {
            document.documentElement.style.setProperty('--border', message.borderColor);
          }
          if (message.todoHoverColor) {
            document.documentElement.style.setProperty('--todo-hover', message.todoHoverColor);
          }
          if (message.commentActiveColor) {
            document.documentElement.style.setProperty('--comment-active', message.commentActiveColor);
          }
          if (message.commentHoverColor) {
            document.documentElement.style.setProperty('--comment-hover', message.commentHoverColor);
          }
          if (message.pinexActiveColor) {
            document.documentElement.style.setProperty('--pinex-active', message.pinexActiveColor);
          }
          if (message.pinexHoverColor) {
            document.documentElement.style.setProperty('--pinex-hover', message.pinexHoverColor);
          }
          // 面板独立字体大小（0 表示使用全局设置）
          if (typeof message.todoFontSize === 'number' && message.todoFontSize > 0) {
            document.documentElement.style.setProperty('--todo-font-size', message.todoFontSize + 'px');
          } else {
            document.documentElement.style.setProperty('--todo-font-size', 'var(--font-size-base)');
          }
          if (typeof message.commentFontSize === 'number' && message.commentFontSize > 0) {
            document.documentElement.style.setProperty('--comment-font-size', message.commentFontSize + 'px');
          } else {
            document.documentElement.style.setProperty('--comment-font-size', 'var(--font-size-base)');
          }
          if (typeof message.pinexFontSize === 'number' && message.pinexFontSize > 0) {
            document.documentElement.style.setProperty('--pinex-font-size', message.pinexFontSize + 'px');
          } else {
            document.documentElement.style.setProperty('--pinex-font-size', 'var(--font-size-base)');
          }
          if (typeof message.vcsProvider === 'string') {
            vcsProvider = message.vcsProvider;
          }
          if (typeof message.showP4 === 'boolean') {
            showP4Tab = message.showP4;
          }
          if (typeof message.showSvn === 'boolean') {
            showSvnTab = message.showSvn;
          }
          applyVcsVisibility();
        } else if (message.type === 'activeFileChanged') {
          activePinExUri = message.uri || null;
          highlightActivePinEx();
          // 如果当前是符号 Tab，自动刷新符号数据
          if (pinExActiveTab === 'symbol') {
            vscode.postMessage({ type: 'getSymbols' });
          }
        } else if (message.type === 'pinExFileExtensions' && Array.isArray(message.extensions)) {
          pinExFileExtensions = message.extensions;
          renderPinEx();
        } else if (message.type === 'pinExDirChildren'
          && typeof message.uri === 'string'
          && Array.isArray(message.items)) {
          pinExDirChildren[message.uri] = message.items;
          pinExDirExpanded[message.uri] = true;
          // 若處於「全部展開」模式，對新獲取的子目錄繼續遞歸展開
          if (pinExExpandAllRequested) {
            message.items.forEach(function (c) {
              if (c && c.isDirectory) {
                expandPinExDirRecursive(c.uri);
              }
            });
          }
          renderPinEx();
          // 如果正在進行定位操作，繼續嘗試定位
          if (pinExLocatePending) {
            setTimeout(function() { tryLocateActivePinEx(); }, 50);
          }
        } else if (message.type === 'pinExFsChanged') {
          // 工程文件系統變更時，對所有已展開的目錄重新請求子項
          Object.keys(pinExDirExpanded).forEach(function (uri) {
            if (pinExDirExpanded[uri]) {
              vscode.postMessage({ type: 'listPinExDir', uri: uri });
            }
          });
        } else if (message.type === 'openFilesChanged' && Array.isArray(message.files)) {
          openFilesInitialized = true;
          allOpenFiles = message.files;
          renderOpenFiles();
        } else if (message.type === 'referenceSessions' && Array.isArray(message.sessions)) {
          allReferenceSessions = message.sessions || [];
          if (typeof message.activeId === 'string') {
            activeReferenceSessionId = message.activeId;
            persistState();
          }
          renderReferences();
        } else if (message.type === 'referenceSearching' && typeof message.isSearching === 'boolean') {
          refsSearching = message.isSearching;
          if (refsResizer) {
            if (refsSearching) {
              refsResizer.classList.add('searching');
            } else {
              refsResizer.classList.remove('searching');
            }
          }
          renderReferences();
        } else if (message.type === 'p4Snapshot' && message.snapshot) {
          p4Snapshot = message.snapshot;
          renderP4();
        } else if (message.type === 'svnSnapshot' && message.snapshot) {
          svnSnapshot = message.snapshot;
          renderSvn();
        } else if (message.type === 'switchPinExTab' && typeof message.tab === 'string') {
          switchPinExTab(message.tab);
        } else if (message.type === 'pinExLocateToUri' && typeof message.uri === 'string') {
          // 外部命令：跳转到固定窗口后，让 PinEx 面板定位到指定文件
          pinExLocatePending = true;
          pinExLocateTargetUri = message.uri;
          // 统一在“固定”Tab 内定位
          if (pinExActiveTab !== 'pin') {
            switchPinExTab('pin');
          }
          // 等待首次 PinEx 数据到达后再执行（避免初始化阶段直接清空 pending）
          if (!pinExItemsInitialized) {
            return;
          }
          setTimeout(function () { tryLocateActivePinEx(); }, 80);
        } else if (message.type === 'symbols') {
          console.log('[CursorEx-Webview] Received symbols:', message);
          console.log('[CursorEx-Webview] Classes:', message.classes ? message.classes.length : 0);
          console.log('[CursorEx-Webview] Members:', message.members ? message.members.length : 0);
          symbolFileUri = message.uri;
          symbolFileName = message.fileName || '';
          symbolNotCs = message.notCs || false;
          allSymbolClasses = message.classes || [];
          allSymbolMembers = message.members || [];
          // 如果之前选中的类不在新列表中，重置
          if (selectedSymbolClass) {
            var found = false;
            for (var i = 0; i < allSymbolClasses.length; i++) {
              if (allSymbolClasses[i].name === selectedSymbolClass) {
                found = true;
                break;
              }
            }
            if (!found) {
              selectedSymbolClass = null;
            }
          }
          // 默认选中第一个类
          if (!selectedSymbolClass && allSymbolClasses.length > 0) {
            selectedSymbolClass = allSymbolClasses[0].name;
          }
          renderSymbols();
        } else if (message.type === 'cursorLine') {
          try {
            var cursorLine = message.line;
            var cursorUri = message.uri;
            var uriMatch = cursorUri === symbolFileUri;
            console.log('[CursorEx-WV] cursorLine: L=' + cursorLine + ' match=' + uriMatch + ' tab=' + pinExActiveTab + ' cls=' + allSymbolClasses.length);
            // 只有当前文件与符号数据文件匹配时才定位
            if (typeof cursorLine === 'number' && uriMatch && pinExActiveTab === 'symbol' && allSymbolClasses.length > 0) {
              console.log('[CursorEx-WV] Locating...');
              locateSymbolByLine(cursorLine);
            }
          } catch (err) {
            console.log('[CursorEx-WV] cursorLine error:', err);
          }
        } else if (message.type === 'activeComment') {
          if (message && typeof message.uri === 'string' && typeof message.line === 'number') {
            activeCommentKey = message.uri + '#' + String(message.line);
          } else {
            activeCommentKey = null;
          }
          // 若 COMMENT 區塊處於收起狀態，為了能看到高亮項，自動展開
          if (cardCollapsed.note) {
            cardCollapsed.note = false;
            applySectionCollapse();
            persistState();
          } else {
            renderComments();
          }
        }
      });

      if (toggleFilesBtn) {
        function syncToggleLabel() {
          toggleFilesBtn.textContent = showFiles ? 'Hide' : 'Show';
        }
        syncToggleLabel();
        toggleFilesBtn.addEventListener('click', function () {
          showFiles = !showFiles;
          syncToggleLabel();
          renderTodos();
          persistState();
        });
      }

      var todoRefreshBtn = document.getElementById('todo-refresh-btn-inline');
      if (todoRefreshBtn) {
        todoRefreshBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'refreshTodos' });
        });
      }

      var p4RefreshBtn = document.getElementById('p4-refresh-btn-inline');
      if (p4RefreshBtn) {
        p4RefreshBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'refreshP4' });
        });
      }
      var p4SyncDirBtn = document.getElementById('p4-sync-dir-btn-inline');
      if (p4SyncDirBtn) {
        p4SyncDirBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'p4SyncDirectory' });
        });
      }
      var p4SubmitDirBtn = document.getElementById('p4-submit-dir-btn-inline');
      if (p4SubmitDirBtn) {
        p4SubmitDirBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'p4SubmitDirectory' });
        });
      }
      var p4EditCurrentBtn = document.getElementById('p4-edit-current-btn-inline');
      if (p4EditCurrentBtn) {
        p4EditCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'p4EditCurrent' });
        });
      }
      var p4DiffCurrentBtn = document.getElementById('p4-diff-current-btn-inline');
      if (p4DiffCurrentBtn) {
        p4DiffCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'p4DiffCurrent' });
        });
      }
      var p4RevertCurrentBtn = document.getElementById('p4-revert-current-btn-inline');
      if (p4RevertCurrentBtn) {
        p4RevertCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'p4RevertCurrent' });
        });
      }

      var svnRefreshBtn = document.getElementById('svn-refresh-btn-inline');
      if (svnRefreshBtn) {
        svnRefreshBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'refreshSvn' });
        });
      }
      var svnUpdateBtn = document.getElementById('svn-update-btn-inline');
      if (svnUpdateBtn) {
        svnUpdateBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'svnUpdate' });
        });
      }
      var svnCommitDirBtn = document.getElementById('svn-commit-dir-btn-inline');
      if (svnCommitDirBtn) {
        svnCommitDirBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'svnCommitDirectory' });
        });
      }
      var svnAddCurrentBtn = document.getElementById('svn-add-current-btn-inline');
      if (svnAddCurrentBtn) {
        svnAddCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'svnAddCurrent' });
        });
      }
      var svnDiffCurrentBtn = document.getElementById('svn-diff-current-btn-inline');
      if (svnDiffCurrentBtn) {
        svnDiffCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'svnDiffCurrent' });
        });
      }
      var svnHistoryCurrentBtn = document.getElementById('svn-history-current-btn-inline');
      if (svnHistoryCurrentBtn) {
        svnHistoryCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'svnHistoryCurrent' });
        });
      }
      var svnRevertCurrentBtn = document.getElementById('svn-revert-current-btn-inline');
      if (svnRevertCurrentBtn) {
        svnRevertCurrentBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          vscode.postMessage({ type: 'svnRevertCurrent' });
        });
      }
      if (svnExpandTreeBtn) {
        svnExpandTreeBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setSvnTreeExpandedState(true);
        });
      }
      if (svnCollapseTreeBtn) {
        svnCollapseTreeBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setSvnTreeExpandedState(false);
        });
      }
      if (svnToggleUnversionedBtn) {
        syncSvnUnversionedToggle();
        svnToggleUnversionedBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          showSvnUnversioned = !showSvnUnversioned;
          syncSvnUnversionedToggle();
          persistState();
          renderSvn();
        });
      }

      if (searchInput) {
        searchInput.addEventListener('input', function () {
          filterText = searchInput.value || '';
          renderTodos();
        });
      }

      if (commentSearchInput) {
        commentSearchInput.addEventListener('input', function () {
          commentFilterText = commentSearchInput.value || '';
          renderComments();
        });
      }

      if (pinExSearchInput) {
        pinExSearchInput.addEventListener('input', function () {
          pinExFilterText = (pinExSearchInput.value || '').trim();
          // 如果在固定 Tab 且有搜索关键字，自动加载所有目录的子项
          if (pinExFilterText && pinExActiveTab === 'pin') {
            var dirs = allPinEx.filter(function (x) { return !!x.isDirectory; });
            dirs.forEach(function (d) {
              expandPinExDirRecursive(d.uri);
            });
          }
          // 根據當前 Tab 渲染
          if (pinExActiveTab === 'pin') {
            renderPinEx();
          } else {
            renderOpenFiles();
          }
        });
      }

      if (pinExOpenSearchInput) {
        pinExOpenSearchInput.addEventListener('input', function () {
          pinExFilterText = (pinExOpenSearchInput.value || '').trim();
          renderOpenFiles();
        });
      }

      // 清空搜索按钮事件
      if (searchClearBtn && searchInput) {
        searchClearBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          searchInput.value = '';
          filterText = '';
          renderTodos();
        });
      }

      if (commentSearchClearBtn && commentSearchInput) {
        commentSearchClearBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          commentSearchInput.value = '';
          commentFilterText = '';
          renderComments();
        });
      }

      if (pinExSearchClearBtn && pinExSearchInput) {
        pinExSearchClearBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          pinExSearchInput.value = '';
          pinExFilterText = '';
          if (pinExActiveTab === 'pin') {
            renderPinEx();
          } else {
            renderOpenFiles();
          }
        });
      }

      if (pinExOpenSearchClearBtn && pinExOpenSearchInput) {
        pinExOpenSearchClearBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          pinExOpenSearchInput.value = '';
          pinExFilterText = '';
          renderOpenFiles();
        });
      }

      if (commentClearAllBtn) {
        commentClearAllBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!allComments.length) {
            return;
          }
          // 直接清空所有行級注釋（不再使用瀏覽器 confirm，避免在部分環境中被攔截）
          // 通知擴展端清理所有注釋
          vscode.postMessage({ type: 'deleteAllComments' });
          // 同步更新前端狀態，立即反映到 UI
          allComments = [];
          activeCommentKey = null;
          renderComments();
        });
      }

      function highlightActivePinEx() {
        // 高亮固定列表中的活動文件
        if (pinExListEl) {
          var allItems = pinExListEl.querySelectorAll('.pinex-item, .pinex-dir-header');
          for (var i = 0; i < allItems.length; i++) {
            allItems[i].classList.remove('active');
          }
          if (activePinExUri) {
            for (var j = 0; j < allItems.length; j++) {
              var item = allItems[j];
              var itemUri = item.getAttribute('data-uri');
              if (itemUri === activePinExUri) {
                item.classList.add('active');
                break;
              }
            }
          }
        }
        // 高亮打開文件列表中的活動文件
        if (pinExOpenListEl) {
          var openItems = pinExOpenListEl.querySelectorAll('.pinex-item');
          for (var k = 0; k < openItems.length; k++) {
            openItems[k].classList.remove('active');
          }
          if (activePinExUri) {
            for (var l = 0; l < openItems.length; l++) {
              var openItem = openItems[l];
              var openItemUri = openItem.getAttribute('data-uri');
              if (openItemUri === activePinExUri) {
                openItem.classList.add('active');
                break;
              }
            }
          }
        }
      }

      function renderPinEx() {
        if (!pinExListEl) return;
        pinExListEl.innerHTML = '';

        if (!pinExItemsInitialized) {
          var initDiv = document.createElement('div');
          initDiv.className = 'empty-tip';
          initDiv.textContent = 'Cursor Tools is initializing pinned items...';
          pinExListEl.appendChild(initDiv);
          return;
        }

        // 檢查文件是否匹配後綴筛选（提前定義，供後續使用）
        function matchesExtFilter(node) {
          if (!pinExFileExtensions || pinExFileExtensions.length === 0) {
            return true; // 沒有筛选，顯示全部
          }
          if (node.isDirectory) {
            return true; // 目錄總是顯示
          }
          var filePath = (node.file || node.uri || '').toLowerCase();
          for (var i = 0; i < pinExFileExtensions.length; i++) {
            var ext = pinExFileExtensions[i].toLowerCase();
            if (!ext.startsWith('.')) {
              ext = '.' + ext;
            }
            if (filePath.endsWith(ext)) {
              return true;
            }
          }
          return false;
        }

        // items 已在扩展端按“最近打开/编辑”排序，这里保持顺序
        var items = allPinEx.slice();

        var keyword = (pinExFilterText || '').trim().toLowerCase();

        if (!items.length) {
          var div = document.createElement('div');
          div.className = 'empty-tip';
          div.textContent = 'No PinEx items yet.';
          pinExListEl.appendChild(div);
          syncHeightsFromContent();
          return;
        }

        // 若有搜索關鍵字，搜索所有項目（包括目錄中的子文件）
        if (keyword) {
          // 收集所有可搜索的項目：顶层项目 + 已加载的目录子项
          var allSearchable = items.slice();
          // 遞歸收集所有已加載的子項
          function collectChildren(parentUri) {
            var children = pinExDirChildren[parentUri];
            if (Array.isArray(children)) {
              children.forEach(function (c) {
                allSearchable.push(c);
                if (c.isDirectory) {
                  collectChildren(c.uri);
                }
              });
            }
          }
          items.forEach(function (item) {
            if (item.isDirectory) {
              collectChildren(item.uri);
            }
          });

          var matched = allSearchable.filter(function (x) {
            var label = (x.file || x.uri || '').toLowerCase();
            return label.indexOf(keyword) >= 0 && matchesExtFilter(x);
          });

          if (!matched.length) {
            var div2 = document.createElement('div');
            div2.className = 'empty-tip';
            div2.textContent = 'No matching PinEx items.';
            pinExListEl.appendChild(div2);
            syncHeightsFromContent();
            return;
          }

          matched.forEach(function (node) {
            renderFileItem(node, pinExListEl, true);
          });
          syncHeightsFromContent();
          return;
        }

        var dirs = items.filter(function (x) { return !!x.isDirectory; });
        var files = items.filter(function (x) { return !x.isDirectory; });

        function renderFileItem(node, parent, canDelete) {
          var item = document.createElement('div');
          item.className = 'pinex-item';
          item.setAttribute('data-uri', node.uri);

          // 检查是否是当前活动文件
          if (activePinExUri && node.uri === activePinExUri) {
            item.classList.add('active');
          }

          var textSpan = document.createElement('span');
          // 統一只顯示文件名，不顯示完整路徑
          var fullPath = node.file || node.uri;
          var normalizedPath = String(fullPath).replace(/\\\\/g, '/');
          var lastSlash = normalizedPath.lastIndexOf('/');
          textSpan.textContent = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : fullPath;

          item.title = fullPath;

          item.appendChild(textSpan);

          if (canDelete) {
            var delSpan = document.createElement('span');
            delSpan.className = 'comment-delete pinex-unpin';
            delSpan.textContent = '📌';
            delSpan.title = 'Unpin';
            item.appendChild(delSpan);

            delSpan.addEventListener('click', function (ev) {
              ev.stopPropagation();
              vscode.postMessage({ type: 'deletePinEx', uri: node.uri });
            });
          }

          item.addEventListener('click', function () {
            vscode.postMessage({ type: 'revealPinEx', uri: node.uri });
          });

          parent.appendChild(item);
        }

        // 獲取目錄的最後一段名稱（basename）
        function getDirBasename(node) {
          var full = (node && (node.file || node.uri)) || '';
          full = String(full).replace(/\\\\/g, '/');
          var idx = full.lastIndexOf('/');
          return idx >= 0 ? full.substring(idx + 1) : full;
        }

        // Compact Folders: 如果目錄下只有一個子目錄（沒有文件），合併顯示
        // 返回 { label, finalNode, chainUris }
        function getCompactedDir(node) {
          var label = getDirBasename(node);
          var chainUris = [node.uri];
          var current = node;

          while (true) {
            var children = pinExDirChildren[current.uri];
            if (!children || !Array.isArray(children)) {
              // 子項尚未載入，無法壓縮
              break;
            }
            var childDirs = children.filter(function (c) { return !!c.isDirectory; });
            var childFiles = children.filter(function (c) { return !c.isDirectory; });
            if (childDirs.length === 1 && childFiles.length === 0) {
              // 只有一個子目錄，合併
              var onlyChild = childDirs[0];
              label = label + ' / ' + getDirBasename(onlyChild);
              chainUris.push(onlyChild.uri);
              current = onlyChild;
            } else {
              break;
            }
          }

          return { label: label, finalNode: current, chainUris: chainUris };
        }

        function renderDirChildren(parentUri, parentEl) {
          var children = (pinExDirChildren[parentUri] || []).slice().sort(function (a, b) {
            var fa = (a.file || a.uri).toLowerCase();
            var fb = (b.file || b.uri).toLowerCase();
            if (fa < fb) return -1;
            if (fa > fb) return 1;
            return 0;
          });

          children.forEach(function (c) {
            if (c.isDirectory) {
              renderDirNode(c, parentEl, false);
            } else if (matchesExtFilter(c)) {
              renderFileItem(c, parentEl, false);
            }
          });
        }

        function renderDirNode(node, parent, canDelete) {
          // 計算壓縮後的目錄信息
          var compacted = getCompactedDir(node);
          var displayLabel = compacted.label;
          var finalNode = compacted.finalNode;
          var chainUris = compacted.chainUris;

          var container = document.createElement('div');
          container.className = 'pinex-dir';

          var header = document.createElement('div');
          header.className = 'pinex-dir-header';

          var chevron = document.createElement('span');
          chevron.className = 'pinex-dir-chevron';
          // 以最終節點的展開狀態為準
          chevron.textContent = pinExDirExpanded[finalNode.uri] ? '▼' : '▶';

          var textSpan = document.createElement('span');
          textSpan.className = 'pinex-dir-label';
          textSpan.textContent = displayLabel;

          header.title = finalNode.file || finalNode.uri;

          header.appendChild(chevron);
          header.appendChild(textSpan);

          var delSpan = null;
          if (canDelete) {
            delSpan = document.createElement('span');
            delSpan.className = 'comment-delete pinex-unpin';
            delSpan.textContent = '📌';
            delSpan.title = 'Unpin';
            header.appendChild(delSpan);

            delSpan.addEventListener('click', function (ev) {
              ev.stopPropagation();
              // 刪除時用原始節點的 uri
              vscode.postMessage({ type: 'deletePinEx', uri: node.uri });
            });
          }

          var childrenWrap = document.createElement('div');
          childrenWrap.className = 'pinex-dir-children';

          // 以最終節點的展開狀態渲染子項
          if (pinExDirExpanded[finalNode.uri]) {
            renderDirChildren(finalNode.uri, childrenWrap);
          } else {
            childrenWrap.style.display = 'none';
          }

          header.addEventListener('click', function (ev) {
            if (delSpan && ev.target === delSpan) {
              return;
            }
            var expanded = !!pinExDirExpanded[finalNode.uri];
            if (!expanded) {
              // 展開時，把鏈上所有目錄都標記為展開，並請求最終節點的子項
              chainUris.forEach(function (uri) {
                pinExDirExpanded[uri] = true;
              });
              vscode.postMessage({ type: 'listPinExDir', uri: finalNode.uri });
            } else {
              // 收起時，把鏈上所有目錄都標記為收起
              chainUris.forEach(function (uri) {
                pinExDirExpanded[uri] = false;
              });
            }
            renderPinEx();
          });

          container.appendChild(header);
          container.appendChild(childrenWrap);
          parent.appendChild(container);
        }

        // 先渲染目錄（可多層展開）
        dirs.forEach(function (d) {
          renderDirNode(d, pinExListEl, true);
        });

        // 再渲染直接 PinEx 的文件
        files.forEach(function (p) {
          renderFileItem(p, pinExListEl, true);
        });

        syncHeightsFromContent();
      }

      function renderOpenFiles() {
        if (!pinExOpenListEl) return;
        pinExOpenListEl.innerHTML = '';

        if (!openFilesInitialized) {
          var initDiv = document.createElement('div');
          initDiv.className = 'empty-tip';
          initDiv.textContent = 'Cursor Tools is initializing open files...';
          pinExOpenListEl.appendChild(initDiv);
          return;
        }

        var keyword = (pinExFilterText || '').trim().toLowerCase();
        var items = allOpenFiles.slice();

        // 如果有搜索關鍵字，過濾
        if (keyword) {
          items = items.filter(function (f) {
            return f.name.toLowerCase().indexOf(keyword) >= 0 ||
                   f.uri.toLowerCase().indexOf(keyword) >= 0;
          });
        }

        // 檢查文件是否已被固定
        function isPinned(uri) {
          for (var i = 0; i < allPinEx.length; i++) {
            if (allPinEx[i].uri === uri) {
              return true;
            }
          }
          return false;
        }

        // 排序：已固定的文件排在最上面
        items.sort(function (a, b) {
          var aPinned = isPinned(a.uri);
          var bPinned = isPinned(b.uri);
          if (aPinned && !bPinned) return -1;
          if (!aPinned && bPinned) return 1;
          return 0;
        });

        if (!items.length) {
          var div = document.createElement('div');
          div.className = 'empty-tip';
          div.textContent = keyword ? 'No matching open files.' : 'No open files.';
          pinExOpenListEl.appendChild(div);
          return;
        }

        items.forEach(function (file) {
          var item = document.createElement('div');
          item.className = 'pinex-item';
          item.setAttribute('data-uri', file.uri);

          // 如果是活動文件，添加高亮
          if (file.isActive) {
            item.classList.add('active');
          }

          var textSpan = document.createElement('span');
          textSpan.textContent = file.name;
          item.title = file.uri;
          item.appendChild(textSpan);

          // 添加固定按鈕（Pin 按鈕）
          var pinSpan = document.createElement('span');
          var filePinned = isPinned(file.uri);
          pinSpan.className = 'comment-delete pinex-pin-action' + (filePinned ? ' pinned' : '');
          pinSpan.textContent = '📌';
          pinSpan.title = filePinned ? 'Pinned (click to unpin)' : 'Pin this file';
          item.appendChild(pinSpan);

          pinSpan.addEventListener('click', function (ev) {
            ev.stopPropagation();
            vscode.postMessage({ type: 'togglePinEx', uri: file.uri });
          });

          item.addEventListener('click', function () {
            vscode.postMessage({ type: 'revealPinEx', uri: file.uri });
          });

          pinExOpenListEl.appendChild(item);
        });
      }

      function renderP4() {
        if (!p4PanelEl) return;
        p4PanelEl.innerHTML = '';

        function getP4ActionInfo(action) {
          var raw = String(action || '').trim().toLowerCase();
          if (raw === 'add') return { key: 'add', label: 'A' };
          if (raw === 'edit') return { key: 'edit', label: 'M' };
          if (raw === 'delete') return { key: 'delete', label: 'D' };
          if (raw === 'branch') return { key: 'branch', label: 'B' };
          if (raw === 'move/add' || raw === 'move/delete' || raw === 'move') return { key: 'move', label: 'MV' };
          if (raw === 'integrate') return { key: 'integrate', label: 'I' };
          return { key: 'default', label: (raw || '?').slice(0, 2).toUpperCase() };
        }

        var summary = document.createElement('div');
        summary.className = 'refs-toolbar';

        var status = document.createElement('div');
        status.className = 'refs-status';
        status.textContent = p4Snapshot.status || 'P4';
        summary.appendChild(status);
        p4PanelEl.appendChild(summary);

        if (!p4Snapshot.available) {
          var empty = document.createElement('div');
          empty.className = 'refs-empty';
          empty.textContent = 'P4 is not available for the current workspace.';
          p4PanelEl.appendChild(empty);
          return;
        }

        var meta = document.createElement('div');
        meta.className = 'refs-load-more-meta';
        meta.textContent = 'Opened: ' + (p4Snapshot.opened || []).length + ' · Pending CLs: ' + (p4Snapshot.pendingChanges || []).length;
        p4PanelEl.appendChild(meta);

        var openedByChange = {};
        (p4Snapshot.opened || []).forEach(function (item) {
          var changeKey = item.change || 'default';
          if (!openedByChange[changeKey]) {
            openedByChange[changeKey] = [];
          }
          openedByChange[changeKey].push(item);
        });

        if (p4Snapshot.pendingChanges && p4Snapshot.pendingChanges.length) {
          var clHeader = document.createElement('div');
          clHeader.className = 'refs-file-title';
          clHeader.textContent = 'Pending Changelists';
          p4PanelEl.appendChild(clHeader);

          if (!window.__p4Expanded) window.__p4Expanded = {};
          p4Snapshot.pendingChanges.forEach(function (cl) {
            var groupKey = 'cl:' + cl.id;
            if (typeof window.__p4Expanded[groupKey] !== 'boolean') {
              window.__p4Expanded[groupKey] = false;
            }

            var row = document.createElement('div');
            row.className = 'refs-group-header';

            var chevron = document.createElement('span');
            chevron.className = 'refs-chevron';
            chevron.textContent = window.__p4Expanded[groupKey] ? '▼' : '▶';

            var title = document.createElement('span');
            title.className = 'refs-group-title';
            if (String(cl.id).toLowerCase() === 'default') {
              title.textContent = cl.description || 'Default Changelist';
            } else {
              title.textContent = cl.id + ' · ' + cl.date + ' · ' + (cl.description || '');
            }

            var count = document.createElement('span');
            count.className = 'refs-group-count';
            count.textContent = String((openedByChange[cl.id] || []).length);

            row.appendChild(chevron);
            row.appendChild(title);
            row.appendChild(count);
            row.addEventListener('click', function () {
              window.__p4Expanded[groupKey] = !window.__p4Expanded[groupKey];
              renderP4();
            });
            p4PanelEl.appendChild(row);

            if (window.__p4Expanded[groupKey]) {
              (openedByChange[cl.id] || []).forEach(function (item) {
                var child = document.createElement('div');
                child.className = 'pinex-item p4-file-row';
                child.style.marginLeft = '18px';
                child.title = item.depotPath || item.localPath || '';

                var actionInfo = getP4ActionInfo(item.action);
                var badge = document.createElement('span');
                badge.className = 'p4-action-badge ' + actionInfo.key;
                badge.textContent = actionInfo.label;
                badge.title = item.action || 'unknown';

                var name = document.createElement('span');
                name.className = 'p4-file-name';
                var displayName = (item.localPath || item.depotPath || '').replace(/\\\\/g, '/').split('/').pop();
                name.textContent = displayName || item.localPath || item.depotPath || '';

                var metaSpan = document.createElement('span');
                metaSpan.className = 'p4-file-meta';
                metaSpan.textContent = String(item.action || '').toLowerCase();

                child.appendChild(badge);
                child.appendChild(name);
                child.appendChild(metaSpan);
                if (item.localFsPath) {
                  child.addEventListener('dblclick', function (ev) {
                    ev.stopPropagation();
                    vscode.postMessage({ type: 'openP4File', path: item.localFsPath });
                  });
                }
                p4PanelEl.appendChild(child);
              });
            }
          });
        }

        if (p4Snapshot.opened && p4Snapshot.opened.length) {
          var openedHeader = document.createElement('div');
          openedHeader.className = 'refs-file-title';
          openedHeader.textContent = 'Opened Files';
          p4PanelEl.appendChild(openedHeader);

          p4Snapshot.opened.forEach(function (item) {
            var row = document.createElement('div');
            row.className = 'pinex-item p4-file-row';
            row.title = item.depotPath || item.localPath || '';

            var actionInfo = getP4ActionInfo(item.action);
            var badge = document.createElement('span');
            badge.className = 'p4-action-badge ' + actionInfo.key;
            badge.textContent = actionInfo.label;
            badge.title = item.action || 'unknown';

            var name = document.createElement('span');
            name.className = 'p4-file-name';
            var openedDisplayName = (item.localPath || item.depotPath || '').replace(/\\\\/g, '/').split('/').pop();
            name.textContent = (openedDisplayName || item.localPath || item.depotPath || '') + ' ';

            var metaSpan = document.createElement('span');
            metaSpan.className = 'p4-file-meta';
            metaSpan.textContent = String(item.action || '').toLowerCase() + (item.change ? ' · ' + item.change : '');

            row.appendChild(badge);
            row.appendChild(name);
            row.appendChild(metaSpan);
            p4PanelEl.appendChild(row);
          });
        } else {
          var noneOpened = document.createElement('div');
          noneOpened.className = 'refs-empty';
          noneOpened.textContent = 'No opened files.';
          p4PanelEl.appendChild(noneOpened);
        }
      }

      function renderSvn() {
        if (!svnPanelEl) return;
        svnPanelEl.innerHTML = '';
        syncSvnUnversionedToggle();

        function getSvnActionInfo(item) {
          var raw = String((item && item.status) || '').trim();
          if (raw === 'M') return { key: 'edit', label: 'M', text: 'modified' };
          if (raw === 'A') return { key: 'add', label: 'A', text: 'added' };
          if (raw === 'D') return { key: 'delete', label: 'D', text: 'deleted' };
          if (raw === 'R') return { key: 'branch', label: 'R', text: 'replaced' };
          if (raw === 'C') return { key: 'delete', label: 'C', text: 'conflict' };
          if (raw === '?') return { key: 'default', label: '?', text: 'unversioned' };
          if (raw === '!') return { key: 'delete', label: '!', text: 'missing' };
          if (raw === '~') return { key: 'default', label: '~', text: 'obstructed' };
          if (raw === 'I') return { key: 'default', label: 'I', text: 'ignored' };
          if (raw === 'X') return { key: 'integrate', label: 'X', text: 'external' };
          return { key: 'default', label: (raw || '?').slice(0, 2).toUpperCase(), text: raw || 'changed' };
        }

        function getSvnRawStatus(item) {
          return String((item && item.status) || '').trim();
        }

        function canSvnRevert(item) {
          var raw = getSvnRawStatus(item);
          return raw === 'M' || raw === 'A' || raw === 'D' || raw === 'R' || raw === 'C' || raw === '!';
        }

        function canSvnDiff(item, isDirectory) {
          var raw = getSvnRawStatus(item);
          return !!item && !isDirectory && raw !== 'X' && raw !== 'I';
        }

        function showSvnContextMenu(ev, target) {
          if (!svnContextMenuEl || !target) return;
          ev.preventDefault();
          ev.stopPropagation();
          hideSvnContextMenu();

          var item = target.item || null;
          var targetPath = target.path || (item && item.fsPath) || '';
          var isDirectory = !!target.isDirectory;
          var raw = getSvnRawStatus(item);

          function menuItem(label, enabled, run) {
            var row = document.createElement('div');
            row.className = 'vcs-context-item' + (enabled ? '' : ' disabled');
            row.textContent = label;
            if (enabled) {
              row.addEventListener('click', function (clickEv) {
                clickEv.preventDefault();
                clickEv.stopPropagation();
                hideSvnContextMenu();
                run();
              });
            }
            svnContextMenuEl.appendChild(row);
          }

          function separator() {
            var sep = document.createElement('div');
            sep.className = 'vcs-context-separator';
            svnContextMenuEl.appendChild(sep);
          }

	          menuItem('Open', !!item && !isDirectory && !!item.fsPath, function () {
	            vscode.postMessage({ type: 'openSvnFile', path: item.fsPath });
	          });
	          menuItem('Open System Folder', !!targetPath, function () {
	            vscode.postMessage({ type: 'svnRevealInOS', path: targetPath });
	          });
	          menuItem('Diff', canSvnDiff(item, isDirectory), function () {
	            vscode.postMessage({ type: 'svnDiffPath', path: item.fsPath });
	          });
	          menuItem('History', !!item && !isDirectory && !!item.fsPath && raw !== '?' && raw !== 'I', function () {
	            vscode.postMessage({ type: 'svnHistoryPath', path: item.fsPath });
	          });
          separator();
          menuItem('Update', !!targetPath, function () {
            vscode.postMessage({ type: 'svnUpdatePath', path: targetPath });
          });
          menuItem('Commit...', !!targetPath, function () {
            vscode.postMessage({ type: 'svnCommitPath', path: targetPath });
          });
          separator();
          menuItem('Add', !!item && raw === '?' && !!item.fsPath, function () {
            vscode.postMessage({ type: 'svnAddPath', path: item.fsPath });
          });
          menuItem('Revert', !!item && canSvnRevert(item) && !!item.fsPath, function () {
            vscode.postMessage({ type: 'svnRevertPath', path: item.fsPath });
          });
          separator();
          menuItem('Refresh', true, function () {
            vscode.postMessage({ type: 'refreshSvn' });
          });

          svnContextMenuEl.style.left = '0px';
          svnContextMenuEl.style.top = '0px';
          svnContextMenuEl.classList.add('visible');
          var rect = svnContextMenuEl.getBoundingClientRect();
          var x = Math.min(ev.clientX, Math.max(0, window.innerWidth - rect.width - 4));
          var y = Math.min(ev.clientY, Math.max(0, window.innerHeight - rect.height - 4));
          svnContextMenuEl.style.left = x + 'px';
          svnContextMenuEl.style.top = y + 'px';
        }

        var summary = document.createElement('div');
        summary.className = 'refs-toolbar';

        var status = document.createElement('div');
        status.className = 'refs-status';
        status.textContent = svnSnapshot.status || 'SVN';
        summary.appendChild(status);
        svnPanelEl.appendChild(summary);

        if (!svnSnapshot.available) {
          var empty = document.createElement('div');
          empty.className = 'refs-empty';
          empty.textContent = 'SVN is not available for the current workspace.';
          svnPanelEl.appendChild(empty);
          return;
        }

	        var allSvnItems = Array.isArray(svnSnapshot.items) ? svnSnapshot.items : [];
	        var visibleSvnItems = showSvnUnversioned
	          ? allSvnItems
	          : allSvnItems.filter(function (item) { return getSvnRawStatus(item) !== '?'; });
	        var hiddenUnversioned = allSvnItems.length - visibleSvnItems.length;

	        var meta = document.createElement('div');
	        meta.className = 'refs-load-more-meta';
	        var rootName = svnSnapshot.workingCopyRoot
	          ? svnSnapshot.workingCopyRoot.replace(/\\\\/g, '/').split('/').pop()
	          : 'working copy';
	        meta.textContent = 'Changed: ' + visibleSvnItems.length + ' · ' + rootName
	          + (hiddenUnversioned ? ' · hidden unversioned: ' + hiddenUnversioned : '');
	        svnPanelEl.appendChild(meta);

	        if (!visibleSvnItems.length) {
	          var clean = document.createElement('div');
	          clean.className = 'refs-empty';
	          clean.textContent = allSvnItems.length ? 'Only unversioned SVN files are hidden.' : 'No local SVN changes.';
	          svnPanelEl.appendChild(clean);
	          return;
	        }

        var changedHeader = document.createElement('div');
        changedHeader.className = 'refs-file-title';
        changedHeader.textContent = 'Working Copy Changes';
        svnPanelEl.appendChild(changedHeader);

        if (!window.__svnTreeExpanded) window.__svnTreeExpanded = {};
        if (typeof window.__svnTreeDefaultExpanded !== 'boolean') window.__svnTreeDefaultExpanded = true;

        function getSvnItemPath(item) {
          var raw = String((item && (item.path || item.fsPath)) || '').replace(/\\\\/g, '/');
          var root = String(svnSnapshot.workingCopyRoot || '').replace(/\\\\/g, '/');
          if (root && raw.indexOf(root + '/') === 0) {
            raw = raw.substring(root.length + 1);
          }
          raw = raw.replace(/^\\.\\//, '');
          if (!raw) raw = String((item && item.fsPath) || 'unknown');
          return raw;
        }

        function createSvnTree(items) {
          var root = { name: '', key: '', fsPath: '', dirs: {}, files: [], count: 0, item: null };
          (items || []).forEach(function (item) {
            var normalized = getSvnItemPath(item);
            var parts = normalized.split('/').filter(Boolean);
            if (!parts.length) {
              parts = [normalized || 'unknown'];
            }
            var allParts = parts.slice();
            var itemFsParts = String((item && item.fsPath) || '').replace(/\\\\/g, '/').split('/').filter(Boolean);
            var fileName = parts.pop();
            var node = root;
            var prefix = '';
            parts.forEach(function (part, index) {
              prefix = prefix ? prefix + '/' + part : part;
              if (!node.dirs[part]) {
                node.dirs[part] = { name: part, key: prefix, fsPath: '', dirs: {}, files: [], count: 0, item: null };
              }
              if (!node.dirs[part].fsPath && itemFsParts.length >= allParts.length) {
                var fsPrefixLength = itemFsParts.length - (allParts.length - index - 1);
                var prefixParts = itemFsParts.slice(0, Math.max(0, fsPrefixLength));
                node.dirs[part].fsPath = (item.fsPath && item.fsPath.charAt(0) === '/' ? '/' : '') + prefixParts.join('/');
              }
              node = node.dirs[part];
              node.count += 1;
            });
            root.count += 1;
            node.files.push({ name: fileName || normalized, item: item });
          });

          function absorbDirectoryItems(node) {
            var kept = [];
            node.files.forEach(function (file) {
              var dir = node.dirs[file.name];
              if (dir) {
                dir.item = file.item;
              } else {
                kept.push(file);
              }
            });
            node.files = kept;
            Object.keys(node.dirs).forEach(function (name) {
              absorbDirectoryItems(node.dirs[name]);
            });
          }

          absorbDirectoryItems(root);
          return root;
        }

        function renderSvnLeaf(item, labelText, parent) {
          var row = document.createElement('div');
          row.className = 'pinex-item p4-file-row';
          row.title = item.path || item.fsPath || '';

          var actionInfo = getSvnActionInfo(item);
          var badge = document.createElement('span');
          badge.className = 'p4-action-badge ' + actionInfo.key;
          badge.textContent = actionInfo.label;
          badge.title = actionInfo.text;

          var nameSpan = document.createElement('span');
          nameSpan.className = 'p4-file-name';
          nameSpan.textContent = (labelText || item.path || item.fsPath || '') + ' ';

          var metaSpan = document.createElement('span');
          metaSpan.className = 'p4-file-meta';
          metaSpan.textContent = actionInfo.text;

          row.appendChild(badge);
          row.appendChild(nameSpan);
          row.appendChild(metaSpan);

          if (item.fsPath) {
            row.addEventListener('dblclick', function (ev) {
              ev.stopPropagation();
              vscode.postMessage({ type: 'openSvnFile', path: item.fsPath });
            });
          }
          row.addEventListener('contextmenu', function (ev) {
            showSvnContextMenu(ev, {
              item: item,
              path: item.fsPath,
              isDirectory: false
            });
          });

          parent.appendChild(row);
        }

        function renderSvnDir(node, parent) {
          var key = 'svn:' + node.key;
          if (typeof window.__svnTreeExpanded[key] !== 'boolean') {
            window.__svnTreeExpanded[key] = window.__svnTreeDefaultExpanded;
          }
          var expanded = !!window.__svnTreeExpanded[key];
          var dirWrap = document.createElement('div');
          dirWrap.className = 'vcs-tree-dir';

          var row = document.createElement('div');
          row.className = 'vcs-tree-dir-row';
          row.title = node.key || node.name;

          var chevron = document.createElement('span');
          chevron.className = 'vcs-tree-chevron';
          chevron.textContent = expanded ? '▼' : '▶';
          row.appendChild(chevron);

          if (node.item) {
            var actionInfo = getSvnActionInfo(node.item);
            var badge = document.createElement('span');
            badge.className = 'p4-action-badge ' + actionInfo.key;
            badge.textContent = actionInfo.label;
            badge.title = actionInfo.text;
            row.appendChild(badge);
          }

          var label = document.createElement('span');
          label.className = 'vcs-tree-folder';
          label.textContent = node.name || node.key || 'folder';
          row.appendChild(label);

          var count = document.createElement('span');
          count.className = 'p4-file-meta';
          count.textContent = String(collectSvnTreeCount(node));
          row.appendChild(count);

          row.addEventListener('click', function () {
            window.__svnTreeExpanded[key] = !window.__svnTreeExpanded[key];
            renderSvn();
          });
          if (node.item && node.item.fsPath) {
            row.addEventListener('dblclick', function (ev) {
              ev.stopPropagation();
              vscode.postMessage({ type: 'openSvnFile', path: node.item.fsPath });
            });
          }
          row.addEventListener('contextmenu', function (ev) {
            showSvnContextMenu(ev, {
              item: node.item,
              path: node.fsPath || (node.item && node.item.fsPath) || '',
              isDirectory: true
            });
          });

          dirWrap.appendChild(row);
          if (expanded) {
            var children = document.createElement('div');
            children.className = 'vcs-tree-children';
            renderSvnTreeChildren(node, children);
            dirWrap.appendChild(children);
          }
          parent.appendChild(dirWrap);
        }

        function collectSvnTreeCount(node) {
          var total = node.files.length + (node.item ? 1 : 0);
          Object.keys(node.dirs).forEach(function (name) {
            total += collectSvnTreeCount(node.dirs[name]);
          });
          return total;
        }

        function renderSvnTreeChildren(node, parent) {
          Object.keys(node.dirs).sort(function (a, b) { return a.localeCompare(b); }).forEach(function (name) {
            renderSvnDir(node.dirs[name], parent);
          });
          node.files.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }).forEach(function (file) {
            renderSvnLeaf(file.item, file.name, parent);
          });
        }

	        var treeRoot = createSvnTree(visibleSvnItems);
        var treeWrap = document.createElement('div');
        treeWrap.className = 'vcs-tree';
        renderSvnTreeChildren(treeRoot, treeWrap);
        svnPanelEl.appendChild(treeWrap);
      }

      function renderReferences() {
        if (!refsSessionListEl || !refsResultListEl) return;
        refsSessionListEl.innerHTML = '';
        refsResultListEl.innerHTML = '';

        if (!allReferenceSessions || !allReferenceSessions.length) {
          var empty = document.createElement('div');
          empty.className = 'refs-empty';
          empty.textContent = 'No results yet. Right-click in the editor and choose "Find References Ex" / "Find Implementations Ex".';
          refsSessionListEl.appendChild(empty);
          return;
        }

        // 确定当前激活会话
        var active = null;
        for (var i = 0; i < allReferenceSessions.length; i++) {
          if (allReferenceSessions[i] && allReferenceSessions[i].id === activeReferenceSessionId) {
            active = allReferenceSessions[i];
            break;
          }
        }
        if (!active) {
          active = allReferenceSessions[allReferenceSessions.length - 1];
          activeReferenceSessionId = active.id;
          persistState();
        }

        // 渲染会话列表（固定的会标记📌；可多次固定）
        allReferenceSessions.forEach(function (s) {
          var row = document.createElement('div');
          row.className = 'refs-session-item' + (s.id === activeReferenceSessionId ? ' active' : '');
          var mode = (s && s.mode) ? s.mode : 'references';
          // 会话标签：用英文首字母区分
          var modeText = (mode === 'implementations') ? 'I' : 'R';
          // 需求：列表显示“所在类.符号”；详细信息放到 tooltip（包含文件与行号）
          var tip = (s.query && s.query.uri)
            ? ('[' + modeText + '] ' + (s.title || s.query.symbol) + ' @ ' + s.query.uri + ':' + (s.query.line + 1))
            : (s.title || '');
          row.title = tip;

          var modeSpan = document.createElement('span');
          modeSpan.className = 'refs-session-mode ' + (mode === 'implementations' ? 'impl' : 'ref');
          modeSpan.textContent = modeText;
          modeSpan.title = (mode === 'implementations') ? 'Find Implementations' : 'Find References';

          var titleSpan = document.createElement('span');
          titleSpan.className = 'refs-session-title';
          // 需求：不在前方显示固定图标，只通过右侧📌按钮状态表达
          titleSpan.textContent = (s.title || 'References');

          var metaSpan = document.createElement('span');
          metaSpan.className = 'refs-session-meta';
          var count = (s.results && s.results.length) ? s.results.length : 0;
          metaSpan.textContent = String(count);

          var pinSpan = document.createElement('span');
          pinSpan.className = 'refs-session-action refs-session-pin' + (s.pinned ? ' pinned' : '');
          pinSpan.textContent = '📌';
          pinSpan.title = s.pinned ? 'Unpin this result' : 'Pin this result (keep history)';

          var delSpan = document.createElement('span');
          delSpan.className = 'refs-session-action';
          delSpan.textContent = '×';
          delSpan.title = 'Delete this result';

          row.appendChild(modeSpan);
          row.appendChild(titleSpan);
          row.appendChild(metaSpan);
          row.appendChild(pinSpan);
          row.appendChild(delSpan);

          row.addEventListener('click', function () {
            activeReferenceSessionId = s.id;
            persistState();
            vscode.postMessage({ type: 'selectReferenceSession', id: s.id });
            renderReferences();
          });
          pinSpan.addEventListener('click', function (ev) {
            ev.stopPropagation();
            vscode.postMessage({ type: 'toggleReferenceSessionPin', id: s.id, pinned: !s.pinned });
          });
          delSpan.addEventListener('click', function (ev) {
            ev.stopPropagation();
            vscode.postMessage({ type: 'deleteReferenceSession', id: s.id });
          });

          refsSessionListEl.appendChild(row);
        });

        // 渲染结果列表：按“类(容器)”分组，点击展开显示引用位置（类似 VS Code 搜索结果）
        var totalResults = (active && typeof active.totalCount === 'number') ? active.totalCount : ((active && active.results) ? active.results.length : 0);
        var storedResults = (active && active.results) ? active.results.length : 0;
        if (active && active.id && typeof refsVisibleCountBySession[active.id] !== 'number') {
          refsVisibleCountBySession[active.id] = Math.min(500, storedResults);
        }
        var visibleLimit = active && active.id ? Math.min(refsVisibleCountBySession[active.id] || 500, storedResults) : storedResults;
        var results = (active && active.results) ? active.results.slice(0, visibleLimit) : [];
        var activeMode = (active && active.mode) ? active.mode : 'references';
        var isFieldOrPropertyQuery = (activeMode === 'references') && active && active.query && (active.query.kind === 'field' || active.query.kind === 'property');
        var isMethodQuery = (activeMode === 'references') && active && active.query && active.query.kind === 'method';
        if (isMethodQuery && refsMethodFilter === 'calls') {
          results = results.filter(function (r) {
            return (r.callRole || 'noncall') === 'call';
          });
        }
        // toolbar：展开/收起
        var toolbar = document.createElement('div');
        toolbar.className = 'refs-toolbar';
        if (refsSearching) {
          var searchingEl = document.createElement('div');
          searchingEl.className = 'refs-searching';
          searchingEl.textContent = '⏳ Searching...';
          toolbar.appendChild(searchingEl);
        } else {
          var statusEl = document.createElement('div');
          statusEl.className = 'refs-status';
          statusEl.textContent = totalResults > storedResults
            ? ('Results: ' + totalResults + ' total, ' + storedResults + ' loaded, ' + visibleLimit + ' shown')
            : ('Results: ' + totalResults + ' total, ' + visibleLimit + ' shown');
          toolbar.appendChild(statusEl);
        }

        // 字段查询：读/写过滤三态（全部/只读/只写）——仅对“引用”有效
        if (isFieldOrPropertyQuery) {
          var allBtn = document.createElement('button');
          allBtn.className = 'refs-toolbar-btn filter-all' + (refsAccessFilter === 'all' ? ' active' : '');
          allBtn.type = 'button';
          allBtn.textContent = 'RW';
          allBtn.title = 'Show: Read + Write';

          var readBtn = document.createElement('button');
          readBtn.className = 'refs-toolbar-btn filter-read' + (refsAccessFilter === 'read' ? ' active' : '');
          readBtn.type = 'button';
          readBtn.textContent = 'R';
          readBtn.title = 'Show: Read only';

          var writeBtn = document.createElement('button');
          writeBtn.className = 'refs-toolbar-btn filter-write' + (refsAccessFilter === 'write' ? ' active' : '');
          writeBtn.type = 'button';
          writeBtn.textContent = 'W';
          writeBtn.title = 'Show: Write only';

          function setFilter(next) {
            refsAccessFilter = next;
            persistState();
            renderReferences();
          }

          allBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setFilter('all');
          });
          readBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setFilter('read');
          });
          writeBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setFilter('write');
          });

          // 过滤按钮放在前面
          toolbar.appendChild(allBtn);
          toolbar.appendChild(readBtn);
          toolbar.appendChild(writeBtn);
        }
        if (isMethodQuery) {
          var methodAllBtn = document.createElement('button');
          methodAllBtn.className = 'refs-toolbar-btn filter-all' + (refsMethodFilter === 'all' ? ' active' : '');
          methodAllBtn.type = 'button';
          methodAllBtn.textContent = 'All';
          methodAllBtn.title = 'Show: All references';

          var callsBtn = document.createElement('button');
          callsBtn.className = 'refs-toolbar-btn filter-calls' + (refsMethodFilter === 'calls' ? ' active' : '');
          callsBtn.type = 'button';
          callsBtn.textContent = 'Call';
          callsBtn.title = 'Show: Call sites only';

          function setMethodFilter(next) {
            refsMethodFilter = next;
            persistState();
            renderReferences();
          }

          methodAllBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setMethodFilter('all');
          });
          callsBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setMethodFilter('calls');
          });

          toolbar.appendChild(methodAllBtn);
          toolbar.appendChild(callsBtn);
        }

        var expandBtn = document.createElement('button');
        expandBtn.className = 'refs-toolbar-btn';
        expandBtn.type = 'button';
        expandBtn.textContent = '⊕';
        expandBtn.title = 'Expand all';
        var collapseBtn = document.createElement('button');
        collapseBtn.className = 'refs-toolbar-btn';
        collapseBtn.type = 'button';
        collapseBtn.textContent = '⊖';
        collapseBtn.title = 'Collapse all';
        toolbar.appendChild(expandBtn);
        toolbar.appendChild(collapseBtn);
        refsResultListEl.appendChild(toolbar);

        if (!results.length) {
          var none = document.createElement('div');
          none.className = 'refs-empty';
          none.textContent = (activeMode === 'implementations')
            ? 'No implementations found.'
            : (isMethodQuery && refsMethodFilter === 'calls' ? 'No call-site references found.' : 'No references found.');
          refsResultListEl.appendChild(none);
          return;
        }


        // 展开状态：仅保存在内存 + state（按 session 维度）
        if (!window.__refsExpanded) window.__refsExpanded = {};
        if (!window.__refsExpanded[active.id]) window.__refsExpanded[active.id] = {};
        var expandedMap = window.__refsExpanded[active.id];

        function setAllExpanded(v) {
          // v=true 展开所有分组；false 全收起
          Object.keys(expandedMap).forEach(function (k) { expandedMap[k] = v; });
        }
        expandBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setAllExpanded(true);
          renderReferences();
        });
        collapseBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setAllExpanded(false);
          renderReferences();
        });

        var byContainer = {};
        results.forEach(function (r) {
          var key = r.container || (r.file || r.uri);
          if (!byContainer[key]) byContainer[key] = [];
          byContainer[key].push(r);
        });

        Object.keys(byContainer).sort().forEach(function (container) {
          var groupKey = container;
          if (typeof expandedMap[groupKey] !== 'boolean') {
            expandedMap[groupKey] = true; // 默认展开
          }

          var header = document.createElement('div');
          header.className = 'refs-group-header';

          var chevron = document.createElement('span');
          chevron.className = 'refs-chevron';
          chevron.textContent = expandedMap[groupKey] ? '▼' : '▶';

          var title = document.createElement('span');
          title.className = 'refs-group-title';
          title.textContent = container;

          var count = document.createElement('span');
          count.className = 'refs-group-count';
          count.textContent = String(byContainer[container].length);

          header.appendChild(chevron);
          header.appendChild(title);
          header.appendChild(count);

          header.addEventListener('click', function () {
            expandedMap[groupKey] = !expandedMap[groupKey];
            renderReferences();
          });

          refsResultListEl.appendChild(header);

          if (!expandedMap[groupKey]) {
            return;
          }

          var list = byContainer[container].slice().sort(function (a, b) {
            var fa = (a.file || a.uri).toLowerCase();
            var fb = (b.file || b.uri).toLowerCase();
            if (fa < fb) return -1;
            if (fa > fb) return 1;
            if (a.line < b.line) return -1;
            if (a.line > b.line) return 1;
            return a.character - b.character;
          });

          if (isMethodQuery && refsMethodFilter === 'calls') {
            list = list.filter(function (r) {
              return (r.callRole || 'noncall') === 'call';
            });
          }

          if (!list.length) {
            return;
          }

          function renderItems(items) {
            items.forEach(function (r) {
              var selKey = (active && active.id ? (refsSelectedBySession[active.id] || '') : '');
              var thisKey = (r.uri || '') + '#' + String(r.line) + ':' + String(r.character);
              var item = document.createElement('div');
              item.className = 'refs-item' + (selKey && thisKey === selKey ? ' selected' : '');
              // 需求：鼠标停靠显示 Tip（显示该行内容）
              item.title = (r.preview || '').trim();

              if (isFieldOrPropertyQuery && r.access) {
                var badge = document.createElement('span');
                badge.className = 'refs-access-badge ' + r.access;
                badge.textContent = r.access === 'write' ? 'W' : 'R';
                item.appendChild(badge);
              }

              var loc = document.createElement('span');
              loc.className = 'refs-loc';
              // 需求：条目仅显示行号 + 引用行内容（不显示文件/类名）
              loc.textContent = 'Ln ' + (r.line + 1);

              var preview = document.createElement('span');
              preview.className = 'refs-preview';
              preview.textContent = r.preview || '';

              item.appendChild(loc);
              item.appendChild(preview);

              item.addEventListener('click', function () {
                if (active && active.id) {
                  refsSelectedBySession[active.id] = thisKey;
                  persistState();
                  renderReferences();
                }
                vscode.postMessage({ type: 'revealReference', uri: r.uri, line: r.line, character: r.character });
              });
            // 需求：去掉“悬浮/悬停即预览”的逻辑（体验不好）

              refsResultListEl.appendChild(item);
            });
          }

          if (isFieldOrPropertyQuery) {
            var reads = list.filter(function (r) { return r.access === 'read'; });
            var writes = list.filter(function (r) { return r.access === 'write'; });

            if (refsAccessFilter === 'read') {
              writes = [];
            } else if (refsAccessFilter === 'write') {
              reads = [];
            }

            if (writes.length) {
              var wHeader = document.createElement('div');
              wHeader.className = 'refs-file-title';
              wHeader.textContent = 'Write (' + writes.length + ')';
              refsResultListEl.appendChild(wHeader);
              renderItems(writes);
            }
            if (reads.length) {
              var rHeader = document.createElement('div');
              rHeader.className = 'refs-file-title';
              rHeader.textContent = 'Read (' + reads.length + ')';
              refsResultListEl.appendChild(rHeader);
              renderItems(reads);
            }
          } else {
            renderItems(list);
          }
        });

        if (active && active.id && storedResults > visibleLimit) {
          var loadMoreBtn = document.createElement('button');
          loadMoreBtn.className = 'refs-load-more';
          loadMoreBtn.type = 'button';
          loadMoreBtn.textContent = 'Load more';
          loadMoreBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            maybeAutoLoadMoreReferences();
          });
          refsResultListEl.appendChild(loadMoreBtn);

          var loadMeta = document.createElement('div');
          loadMeta.className = 'refs-load-more-meta';
          loadMeta.textContent = totalResults > storedResults
            ? ('Showing ' + visibleLimit + ' of ' + storedResults + ' loaded (' + totalResults + ' total).')
            : ('Showing ' + visibleLimit + ' of ' + storedResults + '.');
          refsResultListEl.appendChild(loadMeta);
        } else if (active && totalResults > storedResults) {
          var cappedMeta = document.createElement('div');
          cappedMeta.className = 'refs-load-more-meta';
          cappedMeta.textContent = 'Showing all ' + storedResults + ' loaded results (' + totalResults + ' total).';
          refsResultListEl.appendChild(cappedMeta);
        }
      }

      // 悬停预览：交给扩展端用 VS Code 原生 Peek 实现

      // 根据行号定位类和成员
      var currentHighlightedMemberLine = -1;
      function locateSymbolByLine(line) {
        console.log('[CursorEx-WV] locateSymbolByLine: line=' + line + ', classes=' + allSymbolClasses.length);
        if (!allSymbolClasses.length) {
          console.log('[CursorEx-WV] locateSymbolByLine: no classes, abort');
          return;
        }
        
        // 找到光标所在的类（行号 >= 类起始行，且 < 下一个类的起始行）
        var targetClass = null;
        for (var i = 0; i < allSymbolClasses.length; i++) {
          var cls = allSymbolClasses[i];
          var nextClsLine = (i + 1 < allSymbolClasses.length) ? allSymbolClasses[i + 1].line : Infinity;
          if (line >= cls.line && line < nextClsLine) {
            targetClass = cls;
            break;
          }
        }
        
        if (!targetClass) {
          console.log('[CursorEx-WV] locateSymbolByLine: no class found for line ' + line);
          return;
        }
        
        console.log('[CursorEx-WV] locateSymbolByLine: found class=' + targetClass.name + ' at line=' + targetClass.line);
        
        // 如果类变了，切换到新类
        if (selectedSymbolClass !== targetClass.name) {
          console.log('[CursorEx-WV] locateSymbolByLine: switching class from ' + selectedSymbolClass + ' to ' + targetClass.name);
          selectedSymbolClass = targetClass.name;
          renderSymbols();
        }
        
        // 找到光标所在的成员
        var classMembers = allSymbolMembers.filter(function(m) {
          return m.parentClass === targetClass.name;
        });
        
        var targetMember = null;
        for (var j = 0; j < classMembers.length; j++) {
          var member = classMembers[j];
          var nextMemberLine = (j + 1 < classMembers.length) ? classMembers[j + 1].line : Infinity;
          if (line >= member.line && line < nextMemberLine) {
            targetMember = member;
            break;
          }
        }
        
        // 高亮成员
        currentHighlightedMemberLine = targetMember ? targetMember.line : -1;
        
        // 更新成员高亮
        var memberItems = symbolMemberListEl.querySelectorAll('.symbol-item');
        memberItems.forEach(function(item) {
          var itemLine = parseInt(item.getAttribute('data-line') || '-1', 10);
          if (itemLine === currentHighlightedMemberLine) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
          } else {
            item.classList.remove('active');
          }
        });
        
        // 更新类高亮
        var classItems = symbolClassListEl.querySelectorAll('.symbol-item');
        classItems.forEach(function(item) {
          if (item.getAttribute('data-name') === targetClass.name) {
            item.classList.add('active');
            item.scrollIntoView({ block: 'nearest' });
          } else {
            item.classList.remove('active');
          }
        });
      }

      // 渲染符号列表
      function renderSymbols() {
        console.log('[CursorEx-Webview] renderSymbols called, classes:', allSymbolClasses.length);
        if (!symbolClassListEl || !symbolMemberListEl) return;
        symbolClassListEl.innerHTML = '';
        symbolMemberListEl.innerHTML = '';

        // 如果没有打开文件
        if (!symbolFileUri) {
          var emptyDiv = document.createElement('div');
          emptyDiv.className = 'symbol-empty';
          emptyDiv.textContent = 'No open file.';
          symbolClassListEl.appendChild(emptyDiv);
          return;
        }

        // 如果不是 C# 文件
        if (symbolNotCs) {
          var notCsDiv = document.createElement('div');
          notCsDiv.className = 'symbol-empty';
          notCsDiv.textContent = 'Current file is not a C# file.';
          symbolClassListEl.appendChild(notCsDiv);
          return;
        }

        // 如果没有类
        if (!allSymbolClasses.length) {
          var noClassDiv = document.createElement('div');
          noClassDiv.className = 'symbol-empty';
          noClassDiv.textContent = 'No type definitions found.';
          symbolClassListEl.appendChild(noClassDiv);
          return;
        }

        // 渲染类列表
        var classTitle = document.createElement('div');
        classTitle.className = 'symbol-section-title';
        classTitle.textContent = 'Types (' + allSymbolClasses.length + ')';
        symbolClassListEl.appendChild(classTitle);

        allSymbolClasses.forEach(function (cls) {
          var item = document.createElement('div');
          item.className = 'symbol-item';
          item.setAttribute('data-name', cls.name);
          item.setAttribute('data-line', String(cls.line));
          if (cls.name === selectedSymbolClass) {
            item.classList.add('active');
          }
          item.title = cls.signature || cls.name;

          var icon = document.createElement('span');
          icon.className = 'symbol-icon ' + cls.kind;
          var kindLetter = { 'class': 'C', 'struct': 'S', 'interface': 'I', 'enum': 'E' };
          icon.textContent = kindLetter[cls.kind] || 'T';

          var name = document.createElement('span');
          name.className = 'symbol-name';
          name.textContent = cls.name;

          item.appendChild(icon);
          item.appendChild(name);

          // 点击类：选中、显示成员并跳转到定义位置
          (function(clsItem, clsData) {
            clsItem.onclick = function (e) {
              console.log('[CursorEx-Webview] Class clicked:', clsData.name, 'line:', clsData.line, 'uri:', symbolFileUri);
              selectedSymbolClass = clsData.name;
              if (symbolFileUri) {
                vscode.postMessage({ type: 'revealSymbol', uri: symbolFileUri, line: clsData.line });
              }
              renderSymbols();
            };
          })(item, cls);

          symbolClassListEl.appendChild(item);
          console.log('[CursorEx-Webview] Class item added:', cls.name);
        });

        // 渲染成员列表
        console.log('[CursorEx-Webview] Selected class:', selectedSymbolClass);
        console.log('[CursorEx-Webview] All members parentClasses:', [...new Set(allSymbolMembers.map(m => m.parentClass))]);
        var filteredMembers = allSymbolMembers.filter(function (m) {
          return m.parentClass === selectedSymbolClass;
        });
        console.log('[CursorEx-Webview] Filtered members:', filteredMembers.length);

        var visibleMembers = filteredMembers.filter(function (m) {
          if (!m || !m.kind) return true;
          if (m.kind === 'field' || m.kind === 'event') return !!symbolMemberFilters.field;
          if (m.kind === 'property') return !!symbolMemberFilters.property;
          if (m.kind === 'method' || m.kind === 'constructor') return !!symbolMemberFilters.method;
          return true;
        }).slice().sort(function (a, b) {
          var an = ((a && a.name) ? a.name : '').toLowerCase();
          var bn = ((b && b.name) ? b.name : '').toLowerCase();
          var cmp = an.localeCompare(bn);
          if (cmp !== 0) return cmp;
          return (a.line || 0) - (b.line || 0);
        });

        // 成员筛选工具栏（字段/属性/函数）
        var memberToolbar = document.createElement('div');
        memberToolbar.className = 'symbol-member-toolbar';
        var toolbarTitle = document.createElement('div');
        toolbarTitle.className = 'symbol-member-toolbar-title';
        toolbarTitle.textContent = (selectedSymbolClass || 'Members') + ' (' + visibleMembers.length + '/' + filteredMembers.length + ')';
        memberToolbar.appendChild(toolbarTitle);

        var toolbarActions = document.createElement('div');
        toolbarActions.className = 'symbol-member-toolbar-actions';
        function addFilterBtn(kindKey, iconText, titleText) {
          var btn = document.createElement('button');
          var kindClass = '';
          if (kindKey === 'field') kindClass = ' filter-field';
          else if (kindKey === 'property') kindClass = ' filter-property';
          else if (kindKey === 'method') kindClass = ' filter-method';
          btn.className = 'symbol-filter-btn' + kindClass + (symbolMemberFilters[kindKey] ? ' active' : '');
          btn.type = 'button';
          btn.textContent = iconText;
          btn.title = titleText;
          btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            symbolMemberFilters[kindKey] = !symbolMemberFilters[kindKey];
            persistState();
            renderSymbols();
          });
          toolbarActions.appendChild(btn);
        }
        addFilterBtn('field', 'F', 'Field (incl. events)');
        addFilterBtn('property', 'P', 'Property');
        addFilterBtn('method', 'M', 'Method (incl. constructors)');
        memberToolbar.appendChild(toolbarActions);
        symbolMemberListEl.appendChild(memberToolbar);

        if (!filteredMembers.length) {
          var noMemberDiv = document.createElement('div');
          noMemberDiv.className = 'symbol-empty';
          noMemberDiv.textContent = selectedSymbolClass ? 'This type has no members.' : 'Select a type.';
          symbolMemberListEl.appendChild(noMemberDiv);
          return;
        }

        // 按类型分组
        var groupOrder = ['constructor', 'field', 'property', 'event', 'method'];
        var groupNames = {
          'constructor': 'Constructor',
          'field': 'Field',
          'property': 'Property',
          'event': 'Event',
          'method': 'Method'
        };
        var kindIcons = {
          'constructor': '🔨',
          'field': 'F',
          'property': 'P',
          'event': 'E',
          'method': 'M'
        };

        groupOrder.forEach(function (kind) {
          var membersOfKind = visibleMembers.filter(function (m) { return m.kind === kind; });
          if (!membersOfKind.length) return;

          membersOfKind.forEach(function (member) {
            var item = document.createElement('div');
            item.className = 'symbol-item';
            item.setAttribute('data-line', String(member.line));
            item.title = member.signature || member.name;

            var icon = document.createElement('span');
            icon.className = 'symbol-icon ' + member.kind;
            icon.textContent = kindIcons[member.kind] || '•';

            var contentSpan = document.createElement('span');
            contentSpan.className = 'symbol-content';

            // 函数/构造函数：显示 "函数名(参数)"
            // 变量/属性：显示 "类型 变量名"
            if (kind === 'method' || kind === 'constructor') {
              // 函数名 + 参数，type 包含参数如 "(bool value)"
              var funcDisplay = member.name + (member.type || '()');
              contentSpan.textContent = funcDisplay;
            } else {
              // 类型 + 变量名，type 包含类型如 "int"、"List<ResourceID>"
              if (member.type) {
                contentSpan.innerHTML = '<span class="symbol-type-prefix">' + member.type + '</span> ' + member.name;
              } else {
                contentSpan.textContent = member.name;
              }
            }

            item.appendChild(icon);
            item.appendChild(contentSpan);

            item.addEventListener('click', function (e) {
              console.log('[CursorEx-Webview] Member clicked:', member.name, 'line:', member.line, 'uri:', symbolFileUri);
              if (symbolFileUri) {
                vscode.postMessage({ type: 'revealSymbol', uri: symbolFileUri, line: member.line });
              }
            });

            symbolMemberListEl.appendChild(item);
          });
        });
      }

      // References 面板分隔条拖拽逻辑
      (function initRefsResizer() {
        if (!refsResizer || !refsSessionListEl || !refsResultListEl) return;

        var isDragging = false;
        var startY = 0;
        var startHeight = 0;

        refsResizer.addEventListener('mousedown', function (e) {
          isDragging = true;
          startY = e.clientY;
          startHeight = refsSessionListEl.offsetHeight;
          document.body.style.cursor = 'ns-resize';
          e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
          if (!isDragging) return;
          var delta = e.clientY - startY;
          var newHeight = Math.max(40, Math.min(startHeight + delta, 300));
          refsSessionListEl.style.height = newHeight + 'px';
          refsSessionHeight = newHeight;
        });

        document.addEventListener('mouseup', function () {
          if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
            persistState();
          }
        });

        // 初始化高度
        refsSessionListEl.style.height = refsSessionHeight + 'px';
      })();

      // 符号面板分隔条拖拽逻辑
      var symbolClassHeight = 120; // 默认高度
      (function initSymbolResizer() {
        if (!symbolResizer || !symbolClassListEl || !symbolMemberListEl) return;
        
        var isDragging = false;
        var startY = 0;
        var startHeight = 0;

        symbolResizer.addEventListener('mousedown', function (e) {
          isDragging = true;
          startY = e.clientY;
          startHeight = symbolClassListEl.offsetHeight;
          document.body.style.cursor = 'ns-resize';
          e.preventDefault();
        });

        document.addEventListener('mousemove', function (e) {
          if (!isDragging) return;
          var delta = e.clientY - startY;
          var newHeight = Math.max(40, Math.min(startHeight + delta, 300));
          symbolClassListEl.style.height = newHeight + 'px';
          symbolClassHeight = newHeight;
        });

        document.addEventListener('mouseup', function () {
          if (isDragging) {
            isDragging = false;
            document.body.style.cursor = '';
          }
        });

        // 初始化高度
        symbolClassListEl.style.height = symbolClassHeight + 'px';
      })();

      // PinEx Tab 切換邏輯
      function switchPinExTab(tabName) {
        if (!isPinExTabVisible(tabName)) {
          tabName = firstVisiblePinExTab();
        }
        console.log('[CursorEx-Webview] switchPinExTab:', tabName);
        debugPinExTabs('switchPinExTab -> ' + tabName);
        pinExActiveTab = tabName;
        // 更新 Tab 按鈕狀態
        for (var i = 0; i < pinExTabs.length; i++) {
          var tab = pinExTabs[i];
          if (tab.getAttribute('data-tab') === tabName) {
            tab.classList.add('active');
          } else {
            tab.classList.remove('active');
          }
        }
        // 更新內容區域顯示
        for (var j = 0; j < pinExTabContents.length; j++) {
          var content = pinExTabContents[j];
          if ((tabName === 'todo' && content.id === 'pinex-todo-content') ||
              (tabName === 'comment' && content.id === 'pinex-comment-content') ||
              (tabName === 'pin' && content.id === 'pinex-pin-content') ||
              (tabName === 'open' && content.id === 'pinex-open-content') ||
              (tabName === 'p4' && content.id === 'pinex-p4-content') ||
              (tabName === 'svn' && content.id === 'pinex-svn-content') ||
              (tabName === 'refs' && content.id === 'pinex-refs-content') ||
              (tabName === 'symbol' && content.id === 'pinex-symbol-content')) {
            content.classList.add('active');
          } else {
            content.classList.remove('active');
          }
        }
        // 刷新對應的列表
        if (tabName === 'todo') {
          renderTodos();
        } else if (tabName === 'comment') {
          renderComments();
        } else if (tabName === 'pin') {
          renderPinEx();
        } else if (tabName === 'open') {
          renderOpenFiles();
        } else if (tabName === 'p4') {
          vscode.postMessage({ type: 'getP4Snapshot' });
          renderP4();
        } else if (tabName === 'svn') {
          vscode.postMessage({ type: 'getSvnSnapshot' });
          renderSvn();
        } else if (tabName === 'refs') {
          // 请求最新引用会话并渲染
          vscode.postMessage({ type: 'getReferenceSessions' });
          renderReferences();
        } else if (tabName === 'symbol') {
          // 请求最新符号数据
          console.log('[CursorEx-Webview] Requesting symbols...');
          vscode.postMessage({ type: 'getSymbols' });
        }
      }

      // 綁定 Tab 點擊事件
      function handlePinExTabInteraction(ev) {
          debugPinExTabs('event=' + ev.type + ', target=' + ((ev.target && ev.target.className) || ev.target && ev.target.tagName || 'unknown'));
          var target = ev.target;
          while (target && target !== pinExTabBar && (!target.classList || !target.classList.contains('pinex-tab'))) {
            target = target.parentElement;
          }
          if (!target || target === pinExTabBar) {
            debugPinExTabs('event=' + ev.type + ', no pinex-tab hit');
            return;
          }
          ev.preventDefault();
          ev.stopPropagation();
          var tabName = target.getAttribute('data-tab');
          debugPinExTabs('event=' + ev.type + ', hit=' + tabName);
          if (tabName) {
            switchPinExTab(tabName);
          }
      }
      if (pinExTabBar) {
        pinExTabBar.addEventListener('mousedown', handlePinExTabInteraction);
        pinExTabBar.addEventListener('click', handlePinExTabInteraction);
      }
      normalizePinExToolbarText();
      applyPinExTabOrder();
      applyVcsVisibility();

      for (var td = 0; td < pinExTabs.length; td++) {
        pinExTabs[td].setAttribute('draggable', 'false');
        pinExTabs[td].onclick = handlePinExTabInteraction;
        pinExTabs[td].onmousedown = handlePinExTabInteraction;
      }
      switchPinExTab(pinExActiveTab || 'todo');

      if (refsResultListEl) {
        refsResultListEl.addEventListener('scroll', function () {
          if (!refsResultListEl) return;
          var remaining = refsResultListEl.scrollHeight - refsResultListEl.scrollTop - refsResultListEl.clientHeight;
          if (remaining <= 120) {
            maybeAutoLoadMoreReferences();
          }
        });
      }

      // Tab 宽度不够时：只显示图标，隐藏文字
      (function initTabCompactMode() {
        var tabBar = document.querySelector('.pinex-tabs');
        if (!tabBar) return;

        function update() {
          tabBar.classList.remove('compact');
          var tabs = tabBar.querySelectorAll('.pinex-tab');
          if (!tabs.length) {
            return;
          }
          // Use actual overflow as the source of truth for compact mode.
          if (tabBar.scrollWidth > tabBar.clientWidth + 2) {
            tabBar.classList.add('compact');
          }
          debugPinExTabs('layout scrollWidth=' + tabBar.scrollWidth + ', clientWidth=' + tabBar.clientWidth + ', compact=' + tabBar.classList.contains('compact'));
        }

        window.__updatePinExTabLayout = update;

        try {
          var ro = new ResizeObserver(function () { update(); });
          ro.observe(tabBar);
        } catch (e) {
          // 兼容：无 ResizeObserver 时退化为 window resize
          window.addEventListener('resize', function () { update(); });
        }
        setTimeout(function () { update(); }, 50);
        requestAnimationFrame(function () { update(); });
      })();

      if (pinExClearAllBtn) {
        pinExClearAllBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!allPinEx.length) {
            return;
          }
          vscode.postMessage({ type: 'deleteAllPinEx' });
          allPinEx = [];
          pinExDirChildren = {};
          pinExDirExpanded = {};
          renderPinEx();
        });
      }

      if (pinExExpandAllBtn) {
        pinExExpandAllBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          // 進入「全部展開」模式，對所有已 PinEx 的根目錄和其所有子目錄遞歸展開
          pinExExpandAllRequested = true;
          var dirs = allPinEx.filter(function (x) { return !!x.isDirectory; });
          dirs.forEach(function (d) {
            expandPinExDirRecursive(d.uri);
          });
          renderPinEx();
        });
      }

      if (pinExCollapseAllBtn) {
        pinExCollapseAllBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          pinExExpandAllRequested = false;
          Object.keys(pinExDirExpanded).forEach(function (uri) {
            pinExDirExpanded[uri] = false;
          });
          renderPinEx();
        });
      }

      // 嘗試定位到目標文件（在目錄加載後會再次調用）
      function findPinExElementByUri(rootEl, uri) {
        if (!rootEl || !uri) return null;
        var els = rootEl.querySelectorAll('[data-uri]');
        for (var i = 0; i < els.length; i++) {
          var u = els[i].getAttribute('data-uri');
          if (u === uri) return els[i];
        }
        return null;
      }

      function tryLocateActivePinEx() {
        if (!pinExLocatePending || !pinExLocateTargetUri || !pinExListEl) return;

        // 先檢查文件是否已經可見
        var activeItem = findPinExElementByUri(pinExListEl, pinExLocateTargetUri);
        if (activeItem && typeof activeItem.scrollIntoView === 'function') {
          activeItem.scrollIntoView({ block: 'center' });
          pinExLocatePending = false;
          pinExLocateTargetUri = null;
          return;
        }

        // 查找需要展開的目錄路徑
        var dirsToExpand = [];
        
        // 先查找頂層目錄
        allPinEx.forEach(function (item) {
          if (item.isDirectory && pinExLocateTargetUri.indexOf(item.uri) === 0 && pinExLocateTargetUri !== item.uri) {
            dirsToExpand.push(item.uri);
          }
        });

        // 遞歸查找所有已加載的子目錄
        function findNestedDirs(parentUri) {
          var children = pinExDirChildren[parentUri];
          if (!Array.isArray(children)) return;
          children.forEach(function (c) {
            if (c.isDirectory && pinExLocateTargetUri.indexOf(c.uri) === 0 && pinExLocateTargetUri !== c.uri) {
              dirsToExpand.push(c.uri);
              findNestedDirs(c.uri);
      }
          });
        }
        
        dirsToExpand.forEach(function (uri) {
          findNestedDirs(uri);
        });

        // 展開所有需要展開的目錄
        var needsLoading = false;
        dirsToExpand.forEach(function (dirUri) {
          pinExDirExpanded[dirUri] = true;
          if (!pinExDirChildren[dirUri]) {
            vscode.postMessage({ type: 'listPinExDir', uri: dirUri });
            needsLoading = true;
          }
        });

        // 重新渲染
        renderPinEx();

        // 如果沒有需要加載的目錄，再次嘗試定位
        if (!needsLoading) {
          setTimeout(function () {
            var item = findPinExElementByUri(pinExListEl, pinExLocateTargetUri);
            if (item && typeof item.scrollIntoView === 'function') {
              item.scrollIntoView({ block: 'center' });
            }
            pinExLocatePending = false;
            pinExLocateTargetUri = null;
          }, 50);
        }
        // 如果有目錄正在加載，等待 pinExDirChildren 消息處理後再次調用 tryLocateActivePinEx
      }

      if (pinExLocateBtn) {
        pinExLocateBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!activePinExUri) return;
          
          // 根據當前 Tab 選擇要定位的列表
          if (pinExActiveTab === 'symbol' || pinExActiveTab === 'refs') {
            // 需求：若在 类视图/References，定位按钮应先回到“固定”Tab 再执行定位
            switchPinExTab('pin');
            // 等待一次渲染后再执行定位（避免 pinex-list 尚未可见）
            setTimeout(function () {
              if (!pinExListEl) return;
              var activeItem2 = findPinExElementByUri(pinExListEl, activePinExUri);
              if (activeItem2 && typeof activeItem2.scrollIntoView === 'function') {
                activeItem2.scrollIntoView({ block: 'center' });
                return;
              }
              pinExLocatePending = true;
              pinExLocateTargetUri = activePinExUri;
              tryLocateActivePinEx();
            }, 60);
          } else if (pinExActiveTab === 'open') {
            // 在"打開"Tab 中定位
            if (!pinExOpenListEl) return;
            var openActiveItem = pinExOpenListEl.querySelector('.pinex-item.active');
            if (openActiveItem && typeof openActiveItem.scrollIntoView === 'function') {
              openActiveItem.scrollIntoView({ block: 'center' });
            }
          } else {
            // 在"固定"Tab 中定位
            if (!pinExListEl) return;
            var activeItem = findPinExElementByUri(pinExListEl, activePinExUri);
            if (activeItem && typeof activeItem.scrollIntoView === 'function') {
              activeItem.scrollIntoView({ block: 'center' });
          return;
        }
            
            // 設置定位請求狀態並開始嘗試定位（展開目錄）
            pinExLocatePending = true;
            pinExLocateTargetUri = activePinExUri;
            tryLocateActivePinEx();
          }
        });
      }

      /**
       * 遞歸展開指定 PinEx 目錄及其所有子目錄。
       * 若當前尚未獲取該目錄的子項，會向擴展端請求一次 listPinExDir，
       * 收到回覆後在 pinExDirChildren 處理邏輯中繼續遞歸。
       * @param {string} dirUri
       */
      function expandPinExDirRecursive(dirUri) {
        if (!dirUri) return;
        pinExDirExpanded[dirUri] = true;
        var children = pinExDirChildren[dirUri];
        if (Array.isArray(children) && children.length) {
          children.forEach(function (c) {
            if (c && c.isDirectory) {
              expandPinExDirRecursive(c.uri);
            }
          });
        } else {
          vscode.postMessage({ type: 'listPinExDir', uri: dirUri });
        }
      }

      function getTodoMinHeight() {
        // 固定最小高度，不根据内容自动撑大
        return 80;
      }

      function getNoteMinHeight() {
        // 固定最小高度，不根据内容自动撑大
        return 80;
      }

      function getPinExMinHeight() {
        // 固定最小高度，不根据内容自动撑大
        return 80;
      }

      function getCardMinHeight(id) {
        if (id === 'pinex') return getPinExMinHeight();
        return 80;
      }

      function syncHeightsFromContent() {
        // 只刷新布局位置，不自动调整高度
        // 面板高度由用户手动拖拽调整
        applyHeights();
      }

      function applyHeights() {
        if (!bodyRoot) return;
        var paddingTop = 0;
        var gap = 8;
        var collapsedH = 28;

        function getSectionElement(id) {
          if (id === 'pinex') return pinExSection;
          return null;
        }

        var top = paddingTop;
        cardOrder.forEach(function (id) {
          var sectionEl = getSectionElement(id);
          if (!sectionEl) return;
          var minH = getCardMinHeight(id);
          var targetH = cardCollapsed[id]
            ? collapsedH
            : Math.max(minH, cardHeights[id] || minH);
          sectionEl.style.top = top + 'px';
          sectionEl.style.height = targetH + 'px';
          top += targetH + gap;
        });

        var total = top + 8;
        bodyRoot.style.minHeight = total + 'px';
      }

      function applyOrder() {
        if (!bodyRoot) return;

        function getSectionElement(id) {
          if (id === 'todo') return todoSection;
          if (id === 'note') return noteSection;
          if (id === 'pinex') return pinExSection;
          return null;
        }

        // 先移除，再按順序重新添加
        cardIds.forEach(function (id) {
          var el = getSectionElement(id);
          if (el && el.parentElement === bodyRoot) {
            bodyRoot.removeChild(el);
          }
        });

        cardOrder.forEach(function (id) {
          var el = getSectionElement(id);
          if (el) {
            bodyRoot.appendChild(el);
        }
        });
      }

      if (bodyRoot && resizers.length) {
        var dragging = false;
        var startY = 0;
        var startHeight = 0;
        var dragCardId = 'todo';

        function startDrag(e) {
          var target = e.currentTarget || e.target;
          if (!target || !target.getAttribute) return;
          var c = target.getAttribute('data-card');
          if (c && cardIds.indexOf(c) >= 0) {
            dragCardId = c;
          } else {
            dragCardId = 'todo';
          }

          function getSectionElement(id) {
            if (id === 'todo') return todoSection;
            if (id === 'note') return noteSection;
            if (id === 'pinex') return pinExSection;
            return null;
          }

          var sectionEl = getSectionElement(dragCardId);
          if (!sectionEl) return;

          dragging = true;
          var rect = sectionEl.getBoundingClientRect();
          startHeight = rect.height;
          startY = e.clientY;
          e.preventDefault();
        }

        resizers.forEach(function (r) {
          r.addEventListener('mousedown', startDrag);
        });

        window.addEventListener('mouseup', function () {
          if (!dragging) return;
          dragging = false;
          persistState();
        });

        window.addEventListener('mousemove', function (e) {
          if (!dragging) return;
          var dy = e.clientY - startY;
          var minH = getCardMinHeight(dragCardId);
          cardHeights[dragCardId] = Math.max(minH, startHeight + dy);
          applyHeights();
        });
      }

      function updateMoveButtons() {
        var indexMap = {};
        cardOrder.forEach(function (id, idx) {
          indexMap[id] = idx;
        });

        moveButtons.forEach(function (btn) {
          var el = btn;
          var card = el.getAttribute('data-card');
          var move = el.getAttribute('data-move');
          var hide = false;
          if (!card || typeof indexMap[card] !== 'number') {
            hide = true;
          } else {
            var idx = indexMap[card];
            if (move === 'up' && idx === 0) hide = true;
            if (move === 'down' && idx === cardOrder.length - 1) hide = true;
          }
          el.style.display = hide ? 'none' : '';
        });
      }

      // 綁定折疊（點擊標題區非工具按鈕部分）
      sectionHeaders.forEach(function (header) {
        header.addEventListener('click', function (ev) {
          var target = ev.target;
          if (target && target.classList) {
            // 點擊移動按鈕 / 搜索框 / 顯示文件名按鈕時，不觸發折疊
            if (target.classList.contains('section-move-btn') ||
                target.classList.contains('search-input') ||
                target.classList.contains('todo-toggle-files') ||
                target.classList.contains('pinex-toolbar-icon')) {
              return;
            }
          }
          var key = header.getAttribute('data-section');
          if (!key || cardIds.indexOf(key) < 0) {
            return;
          }
          cardCollapsed[key] = !cardCollapsed[key];
          applySectionCollapse();
          persistState();
        });
      });

      // 上移 / 下移 按鈕控制卡片順序
      moveButtons.forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var card = btn.getAttribute('data-card');
          var move = btn.getAttribute('data-move');
          if (!card || !move) return;

          var idx = cardOrder.indexOf(card);
          if (idx < 0) return;
          if (move === 'up' && idx > 0) {
            var tmp = cardOrder[idx - 1];
            cardOrder[idx - 1] = cardOrder[idx];
            cardOrder[idx] = tmp;
          } else if (move === 'down' && idx < cardOrder.length - 1) {
            var tmp2 = cardOrder[idx + 1];
            cardOrder[idx + 1] = cardOrder[idx];
            cardOrder[idx] = tmp2;
          }

          applyOrder();
          updateMoveButtons();
          applyHeights();
          persistState();
        });
      });

      // 初始化佈局
      try {
      applyOrder();
      updateMoveButtons();
      applyHeights();
      applySectionCollapse();
      } catch (e) {
        console.error('Layout initialization failed:', e);
        // 如果初始化失敗，嘗試重置狀態並重新初始化
        cardCollapsed = { pinex: false };
        cardHeights = { pinex: 220 };
        cardOrder = ['pinex'];
        try {
          applyOrder();
          updateMoveButtons();
          applyHeights();
          applySectionCollapse();
          persistState();
        } catch (e2) {
          console.error('Layout re-initialization also failed:', e2);
        }
      }
    }());
  </script>
</body>
</html>`;
}

function getSvnFileHistoryHtml(
  targetLabel: string,
  targetPath: string,
  entries: SvnHistoryEntry[],
  errorMessage: string
): string {
  const nonce = getNonce();
  const entryHtml = entries.map(entry => {
    const message = entry.message || '(no message)';
    const paths = entry.paths.length
      ? entry.paths.map(changedPath => {
        const copyInfo = changedPath.copyFromPath
          ? ` from ${changedPath.copyFromPath}${changedPath.copyFromRevision ? '@' + changedPath.copyFromRevision : ''}`
          : '';
        return `<div class="path-row"><span class="action">${escapeHtmlText(changedPath.action || '?')}</span><span class="changed-path">${escapeHtmlText(changedPath.path || '')}</span><span class="copy">${escapeHtmlText(copyInfo)}</span></div>`;
      }).join('')
      : '<div class="path-row muted">No changed paths reported.</div>';
    return `<article class="entry">
      <div class="entry-top">
        <div class="revision">r${escapeHtmlText(entry.revision || '?')}</div>
        <div class="meta">${escapeHtmlText(entry.author || 'unknown')} · ${escapeHtmlText(entry.date || '')}</div>
        <button data-revision="${escapeHtmlText(entry.revision)}">Diff</button>
      </div>
      <pre class="message">${escapeHtmlText(message)}</pre>
      <div class="paths">${paths}</div>
    </article>`;
  }).join('');

  const body = errorMessage
    ? `<div class="empty error">${escapeHtmlText(errorMessage)}</div>`
    : (entryHtml || '<div class="empty">No SVN history found for this file.</div>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>SVN File History</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --button: var(--vscode-button-secondaryBackground);
      --button-fg: var(--vscode-button-secondaryForeground);
      --button-hover: var(--vscode-button-secondaryHoverBackground);
      --row: var(--vscode-list-hoverBackground);
      --danger: var(--vscode-errorForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    header {
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 16px;
      font-weight: 600;
    }
    .target {
      color: var(--muted);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    main {
      padding: 10px 16px 18px;
    }
    .entry {
      border-bottom: 1px solid var(--border);
      padding: 10px 0 12px;
    }
    .entry-top {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 10px;
    }
    .revision {
      font-family: var(--vscode-editor-font-family);
      font-weight: 700;
    }
    .meta, .muted, .copy {
      color: var(--muted);
    }
    button {
      border: 1px solid var(--border);
      border-radius: 3px;
      background: var(--button);
      color: var(--button-fg);
      min-height: 24px;
      padding: 2px 10px;
      cursor: pointer;
      font: inherit;
    }
    button:hover {
      background: var(--button-hover);
    }
    .message {
      margin: 8px 0;
      white-space: pre-wrap;
      font-family: var(--vscode-font-family);
      color: var(--fg);
    }
    .paths {
      display: grid;
      gap: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .path-row {
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .action {
      display: inline-flex;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 4px;
      color: var(--fg);
    }
    .changed-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty {
      padding: 28px;
      color: var(--muted);
      text-align: center;
    }
    .empty.error {
      color: var(--danger);
      white-space: pre-wrap;
      text-align: left;
    }
  </style>
</head>
<body>
  <header>
    <h1>SVN File History</h1>
    <div class="target" title="${escapeHtmlText(targetPath)}">${escapeHtmlText(targetLabel)}</div>
  </header>
  <main>${body}</main>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      document.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var button = target.closest('button[data-revision]');
        if (!button) return;
        var revision = button.getAttribute('data-revision') || '';
        vscode.postMessage({ type: 'diffRevision', revision: revision });
      });
    })();
  </script>
</body>
</html>`;
}

function getSvnCommitWorkbenchHtml(): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>SVN Commit</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --input: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --button: var(--vscode-button-background);
      --button-fg: var(--vscode-button-foreground);
      --button-hover: var(--vscode-button-hoverBackground);
      --row-hover: var(--vscode-list-hoverBackground);
      --row-active: var(--vscode-list-activeSelectionBackground);
      --danger: var(--vscode-errorForeground);
      --warn: var(--vscode-editorWarning-foreground);
      --ok: var(--vscode-testing-iconPassed);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      overflow: hidden;
    }
    .app {
      height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      min-width: 520px;
    }
    header {
      padding: 12px 14px 10px;
      border-bottom: 1px solid var(--border);
      display: grid;
      gap: 6px;
    }
    .title-row {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      white-space: nowrap;
    }
    .status-pill {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .target {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .message-wrap {
      padding: 12px 14px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      border-bottom: 1px solid var(--border);
    }
    label {
      font-size: 12px;
      color: var(--muted);
    }
    textarea {
      width: 100%;
      min-height: 96px;
      max-height: 180px;
      resize: vertical;
      color: var(--fg);
      background: var(--input);
      border: 1px solid var(--input-border, var(--border));
      border-radius: 3px;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      outline: none;
    }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    .main {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      overflow: hidden;
    }
    .toolbar {
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--border);
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--fg));
      border-radius: 3px;
      padding: 4px 10px;
      min-height: 26px;
      cursor: pointer;
      font: inherit;
      white-space: nowrap;
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, var(--row-hover));
    }
    button.primary {
      background: var(--button);
      color: var(--button-fg);
      border-color: var(--button);
    }
    button.primary:hover:not(:disabled) { background: var(--button-hover); }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .spacer { flex: 1; min-width: 8px; }
    .chips {
      display: inline-flex;
      gap: 4px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .chip {
      padding: 3px 7px;
      min-height: 24px;
      font-size: 12px;
    }
	    .chip.active {
	      border-color: var(--vscode-focusBorder);
	      background: var(--row-active);
	      color: var(--vscode-list-activeSelectionForeground, var(--fg));
	    }
	    button.toggled {
	      border-color: var(--vscode-focusBorder);
	      background: var(--row-active);
	      color: var(--vscode-list-activeSelectionForeground, var(--fg));
	    }
    .table-wrap {
      min-height: 0;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    thead {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--bg);
    }
    th, td {
      border-bottom: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
      padding: 5px 8px;
      text-align: left;
      vertical-align: middle;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
    }
    .col-check { width: 38px; text-align: center; }
    .col-status { width: 88px; }
    .col-warning { width: 260px; }
    tbody tr { cursor: default; }
    tbody tr:hover { background: var(--row-hover); }
    tbody tr.active {
      background: var(--row-active);
      color: var(--vscode-list-activeSelectionForeground, var(--fg));
    }
    input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 20px;
      padding: 0 5px;
      border-radius: 3px;
      font-weight: 700;
      font-size: 12px;
      border: 1px solid var(--border);
      text-transform: uppercase;
    }
    .badge.modified, .badge.props { color: #9cdcfe; border-color: rgba(156,220,254,0.45); background: rgba(156,220,254,0.14); }
    .badge.added, .badge.unversioned { color: #4ec9b0; border-color: rgba(78,201,176,0.45); background: rgba(78,201,176,0.14); }
    .badge.deleted, .badge.missing, .badge.conflict { color: #f48771; border-color: rgba(244,135,113,0.45); background: rgba(244,135,113,0.14); }
    .badge.replaced { color: #d7ba7d; border-color: rgba(215,186,125,0.45); background: rgba(215,186,125,0.14); }
    .path-cell {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
    .file-name {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .muted { color: var(--muted); }
    .warn { color: var(--warn, var(--danger)); }
    .empty {
      padding: 28px;
      text-align: center;
      color: var(--muted);
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-line {
      flex: 1;
      min-width: 0;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-line.error { color: var(--danger); }
    .status-line.ok { color: var(--ok, var(--fg)); }
    @media (max-width: 720px) {
      .app { min-width: 0; }
      .col-warning { display: none; }
      .toolbar { align-items: stretch; }
      .chips { width: 100%; }
      .spacer { display: none; }
      footer { flex-wrap: wrap; }
      footer .status-line { flex-basis: 100%; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="title-row">
        <h1>SVN Commit</h1>
        <div class="status-pill" id="status-pill">Loading...</div>
      </div>
      <div class="target" id="target-label">Preparing working copy...</div>
      <div class="target" id="repo-label"></div>
    </header>

    <section class="message-wrap">
      <label for="commit-message">Message</label>
      <textarea id="commit-message" placeholder="Enter commit message"></textarea>
    </section>

    <main class="main">
      <div class="toolbar">
        <button id="btn-refresh" title="Refresh SVN status">Refresh</button>
        <button id="btn-select-all" title="Select all committable files">Select All</button>
        <button id="btn-select-none" title="Clear file selection">Select None</button>
	        <button id="btn-diff" title="Diff active file">Diff</button>
	        <button id="btn-add" title="Add selected unversioned files">Add</button>
	        <button id="btn-revert" title="Revert selected or active versioned files">Revert</button>
	        <button id="btn-toggle-unversioned" title="Hide unversioned files">?</button>
	        <span class="spacer"></span>
        <span class="chips" id="filter-chips">
          <button class="chip active" data-filter="all">All</button>
          <button class="chip" data-filter="committable">Committable</button>
          <button class="chip" data-filter="modified">Modified</button>
          <button class="chip" data-filter="added">Added</button>
          <button class="chip" data-filter="deleted">Deleted</button>
          <button class="chip" data-filter="unversioned">Unversioned</button>
          <button class="chip" data-filter="problem">Problems</button>
        </span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-check"></th>
              <th class="col-status">Status</th>
              <th>Path</th>
              <th class="col-warning">Notes</th>
            </tr>
          </thead>
          <tbody id="file-body"></tbody>
        </table>
        <div class="empty" id="empty-state">Loading SVN status...</div>
      </div>
    </main>

    <footer>
      <div class="status-line" id="status-line">Loading SVN status...</div>
      <button id="btn-cancel">Cancel</button>
      <button class="primary" id="btn-commit" disabled>Commit</button>
    </footer>
  </div>

	  <script nonce="${nonce}">
	    (function () {
	      var vscode = acquireVsCodeApi();
	      window.addEventListener('error', function (event) {
	        var message = event.message || 'Unknown webview script error';
	        var line = document.getElementById('status-line');
	        if (line) line.textContent = 'SVN Commit UI error: ' + message;
	        vscode.postMessage({ type: 'clientError', message: message });
	      });
	      window.addEventListener('unhandledrejection', function (event) {
	        var reason = event && event.reason;
	        var message = reason && reason.message ? reason.message : String(reason || 'Unhandled webview promise rejection');
	        var line = document.getElementById('status-line');
	        if (line) line.textContent = 'SVN Commit UI error: ' + message;
	        vscode.postMessage({ type: 'clientError', message: message });
	      });
	      var snapshot = null;
      var items = [];
	      var busy = false;
	      var activePath = '';
	      var filter = 'all';
	      var showUnversioned = true;

      var statusPill = document.getElementById('status-pill');
      var targetLabel = document.getElementById('target-label');
      var repoLabel = document.getElementById('repo-label');
      var messageInput = document.getElementById('commit-message');
      var fileBody = document.getElementById('file-body');
      var emptyState = document.getElementById('empty-state');
      var statusLine = document.getElementById('status-line');
      var btnRefresh = document.getElementById('btn-refresh');
      var btnSelectAll = document.getElementById('btn-select-all');
      var btnSelectNone = document.getElementById('btn-select-none');
      var btnDiff = document.getElementById('btn-diff');
	      var btnAdd = document.getElementById('btn-add');
	      var btnRevert = document.getElementById('btn-revert');
	      var btnToggleUnversioned = document.getElementById('btn-toggle-unversioned');
	      var btnCancel = document.getElementById('btn-cancel');
      var btnCommit = document.getElementById('btn-commit');
      var chips = document.getElementById('filter-chips');

      function statusClass(item) {
        var status = String(item && item.status || '').toUpperCase();
        if (status === 'M') return 'modified';
        if (status === 'P') return 'props';
        if (status === 'A') return 'added';
        if (status === 'D') return 'deleted';
        if (status === 'R') return 'replaced';
        if (status === 'C') return 'conflict';
        if (status === '?') return 'unversioned';
        if (status === '!') return 'missing';
        return 'default';
      }

      function selectedItems() {
        return items.filter(function (item) {
          return !!item.selected && !!item.canCommit;
        });
      }

      function selectedPathsOrActive() {
        var paths = selectedItems().map(function (item) { return item.fsPath; });
        if (!paths.length && activePath) {
          paths.push(activePath);
        }
        return paths;
      }

      function activeItem() {
        for (var i = 0; i < items.length; i++) {
          if (items[i].fsPath === activePath) {
            return items[i];
          }
        }
        return null;
      }

      function setStatus(message, kind) {
        statusLine.textContent = message || '';
        statusLine.classList.remove('error');
        statusLine.classList.remove('ok');
        if (kind) {
          statusLine.classList.add(kind);
        }
      }

      function setBusy(message) {
        busy = true;
        setStatus(message || 'Working...', '');
        updateButtons();
      }

      function setReady(message, kind) {
        busy = false;
        setStatus(message || '', kind || '');
        updateButtons();
      }

      function updateButtons() {
        var selected = selectedItems();
        var hasSelected = selected.length > 0;
        var hasMessage = !!(messageInput.value || '').trim();
        var active = activeItem();
        btnRefresh.disabled = busy;
        btnSelectAll.disabled = busy || !items.length;
        btnSelectNone.disabled = busy || !items.length;
        btnDiff.disabled = busy || (!active && !hasSelected);
	        btnAdd.disabled = busy || !items.some(function (item) { return item.selected && item.isUnversioned; });
	        btnRevert.disabled = busy || !(items.some(function (item) { return item.selected && item.canRevert; }) || (active && active.canRevert));
	        btnToggleUnversioned.disabled = busy;
	        btnCommit.disabled = busy || !hasMessage || !hasSelected;
	      }

	      function syncUnversionedToggle() {
	        btnToggleUnversioned.classList.toggle('toggled', showUnversioned);
	        btnToggleUnversioned.textContent = showUnversioned ? '?' : '-?';
	        btnToggleUnversioned.title = showUnversioned ? 'Hide unversioned files' : 'Show unversioned files';
	      }

	      function itemMatchesFilter(item) {
	        var cls = statusClass(item);
	        if (!showUnversioned && cls === 'unversioned') return false;
	        if (filter === 'all') return true;
        if (filter === 'committable') return !!item.canCommit;
        if (filter === 'modified') return cls === 'modified' || cls === 'props';
        if (filter === 'added') return cls === 'added';
        if (filter === 'deleted') return cls === 'deleted' || cls === 'replaced';
        if (filter === 'unversioned') return cls === 'unversioned';
        if (filter === 'problem') return cls === 'conflict' || cls === 'missing' || cls === 'default';
        return true;
      }

      function getBaseName(item) {
        var raw = String((item && (item.path || item.fsPath)) || '').replace(/\\\\/g, '/');
        var idx = raw.lastIndexOf('/');
        if (idx >= 0 && idx < raw.length - 1) {
          return raw.substring(idx + 1);
        }
        return raw || 'unknown';
      }

      function sortVisibleItems(sourceItems) {
        return (sourceItems || []).slice().sort(function (a, b) {
          return String(a.path || a.fsPath || '').localeCompare(String(b.path || b.fsPath || ''));
        });
      }

      function visibleCount() {
        return items.filter(itemMatchesFilter).length;
      }

	      function renderSummary() {
	        var selected = selectedItems().length;
	        var committable = items.filter(function (item) { return item.canCommit; }).length;
	        var total = items.length;
	        var visible = visibleCount();
	        var hiddenUnversioned = showUnversioned ? 0 : items.filter(function (item) { return statusClass(item) === 'unversioned'; }).length;
	        var base = 'Selected ' + selected + ' of ' + committable + ' committable file(s)';
	        if (visible !== total) {
	          base += ' - showing ' + visible + ' of ' + total;
	        } else {
	          base += ' - total ' + total;
	        }
	        if (hiddenUnversioned) {
	          base += ' - hidden unversioned ' + hiddenUnversioned;
	        }
	        if (!busy) {
          setStatus(base, '');
        }
      }

      function render() {
        fileBody.innerHTML = '';
	        var visible = items.filter(itemMatchesFilter);
	        emptyState.style.display = visible.length ? 'none' : 'block';
	        emptyState.textContent = items.length
	          ? (!showUnversioned && items.some(function (item) { return statusClass(item) === 'unversioned'; })
	            ? 'Unversioned files are hidden.'
	            : 'No files match this filter.')
	          : 'No local SVN changes.';

        function renderFileRow(item) {
          var row = document.createElement('tr');
          row.className = 'row-' + statusClass(item);
          if (item.fsPath === activePath) {
            row.classList.add('active');
          }
          row.title = item.path + (item.warning ? ' - ' + item.warning : '');

          var checkCell = document.createElement('td');
          checkCell.className = 'col-check';
          var checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = !!item.selected;
          checkbox.disabled = busy || !item.canCommit;
          checkbox.addEventListener('click', function (ev) {
            ev.stopPropagation();
          });
          checkbox.addEventListener('change', function () {
            item.selected = checkbox.checked;
            render();
          });
          checkCell.appendChild(checkbox);

          var statusCell = document.createElement('td');
          statusCell.className = 'col-status';
          var badge = document.createElement('span');
          badge.className = 'badge ' + statusClass(item);
          badge.textContent = item.status || '?';
          badge.title = item.statusText || '';
          statusCell.appendChild(badge);

          var pathCell = document.createElement('td');
          pathCell.className = 'path-cell';
          var fileName = document.createElement('span');
          fileName.className = 'file-name';
          fileName.textContent = getBaseName(item);
          pathCell.appendChild(fileName);

          var warningCell = document.createElement('td');
          warningCell.className = item.warning ? 'col-warning warn' : 'col-warning muted';
          warningCell.textContent = item.warning || item.statusText || '';

          row.appendChild(checkCell);
          row.appendChild(statusCell);
          row.appendChild(pathCell);
          row.appendChild(warningCell);

          row.addEventListener('click', function () {
            activePath = item.fsPath;
            render();
          });
          row.addEventListener('dblclick', function () {
            activePath = item.fsPath;
            vscode.postMessage({ type: 'diff', path: item.fsPath });
          });

          fileBody.appendChild(row);
        }

        sortVisibleItems(visible).forEach(function (item) {
          renderFileRow(item);
        });

        renderSummary();
        updateButtons();
      }

      window.addEventListener('message', function (event) {
        var message = event.data || {};
        if (message.type === 'busy') {
          setBusy(message.message || 'Working...');
        } else if (message.type === 'snapshot') {
          snapshot = message.snapshot || {};
          items = Array.isArray(snapshot.items) ? snapshot.items : [];
          activePath = items.length ? items[0].fsPath : '';
          statusPill.textContent = snapshot.status || 'SVN';
          targetLabel.textContent = snapshot.targetLabel || snapshot.targetPath || '';
          targetLabel.title = snapshot.targetPath || '';
          var repo = snapshot.url || '';
          if (snapshot.workingCopyRoot) {
            repo += repo ? ' - ' + snapshot.workingCopyRoot : snapshot.workingCopyRoot;
          }
          repoLabel.textContent = repo;
          repoLabel.title = repo;
          busy = false;
          render();
        } else if (message.type === 'operationError') {
          setReady(message.message || 'SVN operation failed.', 'error');
        } else if (message.type === 'operationInfo') {
          setReady(message.message || 'Done.', 'ok');
        }
      });

      messageInput.addEventListener('input', updateButtons);

      btnRefresh.addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh' });
      });
      btnSelectAll.addEventListener('click', function () {
        items.forEach(function (item) {
          if (item.canCommit) item.selected = true;
        });
        render();
      });
      btnSelectNone.addEventListener('click', function () {
        items.forEach(function (item) { item.selected = false; });
        render();
      });
      btnDiff.addEventListener('click', function () {
        var item = activeItem() || selectedItems()[0];
        if (!item) return;
        vscode.postMessage({ type: 'diff', path: item.fsPath });
      });
      btnAdd.addEventListener('click', function () {
        vscode.postMessage({
          type: 'add',
          paths: items.filter(function (item) { return item.selected && item.isUnversioned; }).map(function (item) { return item.fsPath; })
        });
      });
	      btnRevert.addEventListener('click', function () {
	        vscode.postMessage({ type: 'revert', paths: selectedPathsOrActive() });
	      });
	      btnToggleUnversioned.addEventListener('click', function () {
	        showUnversioned = !showUnversioned;
	        syncUnversionedToggle();
	        render();
	      });
      btnCancel.addEventListener('click', function () {
        vscode.postMessage({ type: 'cancel' });
      });
      btnCommit.addEventListener('click', function () {
        vscode.postMessage({
          type: 'commit',
          message: messageInput.value || '',
          paths: selectedItems().map(function (item) { return item.fsPath; })
        });
      });

      chips.addEventListener('click', function (ev) {
        var target = ev.target;
        if (!target || !target.getAttribute || !target.getAttribute('data-filter')) return;
        filter = target.getAttribute('data-filter');
        Array.prototype.slice.call(chips.querySelectorAll('.chip')).forEach(function (chip) {
          chip.classList.toggle('active', chip.getAttribute('data-filter') === filter);
        });
        render();
      });

	      syncUnversionedToggle();
	      updateButtons();
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

let settingsPanel: vscode.WebviewPanel | undefined;
let workspaceSearchIndexRef: WorkspaceSearchIndex | undefined;
let updateServiceRef: GithubReleaseUpdateService | undefined;

function openSettingsPanel(context: vscode.ExtensionContext): void {
  if (settingsPanel) {
    settingsPanel.title = `Cursor Tools - Settings v${EXTENSION_VERSION}`;
    settingsPanel.webview.html = getSettingsWebviewContent();
    settingsPanel.reveal();
    return;
  }

  settingsPanel = vscode.window.createWebviewPanel(
    'cursorToolSettings',
    `Cursor Tools - Settings v${EXTENSION_VERSION}`,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  settingsPanel.webview.html = getSettingsWebviewContent();

  settingsPanel.webview.onDidReceiveMessage(async msg => {
    if (!msg || typeof msg.type !== 'string') return;

    const config = vscode.workspace.getConfiguration('cursorToolWindow');

    switch (msg.type) {
      case 'getSettings':
        // 发送当前设置到 Webview
        const quickOpenKeybinding = await getQuickOpenKeybinding();
        const detectedProfile = await detectSearchProfile();
        const searchIndexSnapshot = workspaceSearchIndexRef?.getSnapshot();
        settingsPanel?.webview.postMessage({
          type: 'settings',
          detectedProfile: detectedProfile,
          searchIndexSnapshot: searchIndexSnapshot,
          global: {
            fontSize: config.get('global.fontSize', 13),
            accentColor: config.get('global.accentColor', '#0e639c'),
            textColor: config.get('global.textColor', '#f3f3f3'),
            mutedColor: config.get('global.mutedColor', '#c5c5c5'),
            bgColor: config.get('global.bgColor', '#1e1e1e'),
            borderColor: config.get('global.borderColor', '#2d2d2d'),
            vcsProvider: getSavedVcsProvider(config, context)
          },
          todo: {
            extensions: config.get('todo.extensions', ['cs', 'csx', 'js', 'jsx', 'ts', 'tsx', 'cpp', 'c', 'h', 'hpp', 'java', 'go']),
            excludeGlobs: config.get('todo.excludeGlobs', ['**/node_modules/**', '**/bin/**', '**/obj/**']),
            includeGlobs: config.get('todo.includeGlobs', []),
            contentFilter: config.get('todo.contentFilter', ''),
            hoverColor: config.get('todo.hoverColor', 'rgba(14,99,156,0.45)'),
            fontSize: config.get('todo.fontSize', 0)
          },
          comment: {
            activeColor: config.get('comment.activeColor', 'rgba(14,99,156,0.6)'),
            hoverColor: config.get('comment.hoverColor', 'rgba(14,99,156,0.45)'),
            fontSize: config.get('comment.fontSize', 0)
          },
          pinex: {
            fileExtensions: config.get('pinex.fileExtensions', []),
            activeColor: config.get('pinex.activeColor', 'rgba(14,99,156,0.6)'),
            hoverColor: config.get('pinex.hoverColor', 'rgba(14,99,156,0.45)'),
            fontSize: config.get('pinex.fontSize', 0)
          },
          search: {
            mode: config.get('search.mode', 'all'),
            fileExtensions: config.get('search.fileExtensions', ['cs', 'csx', 'js', 'jsx', 'ts', 'tsx', 'cpp', 'c', 'h', 'hpp', 'java', 'go', 'py']),
            includeDirectories: config.get('search.includeDirectories', []),
            excludeDirectories: config.get('search.excludeDirectories', ['**/node_modules/**', '**/bin/**', '**/obj/**', '**/.git/**', '**/dist/**']),
            caseSensitive: config.get('search.caseSensitive', false),
            debounceDelay: config.get('search.debounceDelay', 300),
            maxFilesToSearch: config.get('search.maxFilesToSearch', 0),
            maxContentMatches: config.get('search.maxContentMatches', 100),
            maxItems: config.get('quickOpen.maxItems', 50),
            previewLines: config.get('search.previewLines', 1)
          },
          quickOpenKeybinding: quickOpenKeybinding,
          update: updateServiceRef?.getStatusPayload()
        });
        break;
      case 'autoDetectProjectProfile':
        const profile = await detectSearchProfile();
        await config.update('search.fileExtensions', profile.searchFileExtensions, vscode.ConfigurationTarget.Global);
        await config.update('search.includeDirectories', profile.searchIncludeDirectories, vscode.ConfigurationTarget.Global);
        await config.update('search.excludeDirectories', profile.searchExcludeDirectories, vscode.ConfigurationTarget.Global);
        await config.update('todo.extensions', profile.todoExtensions, vscode.ConfigurationTarget.Global);
        await config.update('todo.includeGlobs', profile.todoIncludeGlobs, vscode.ConfigurationTarget.Global);
        await config.update('todo.excludeGlobs', profile.todoExcludeGlobs, vscode.ConfigurationTarget.Global);
        await config.update('pinex.fileExtensions', profile.pinexFileExtensions, vscode.ConfigurationTarget.Global);
        settingsPanel?.webview.postMessage({
          type: 'detectedProfileApplied',
          profile: profile
        });
        settingsPanel?.webview.postMessage({
          type: 'settings',
          detectedProfile: profile,
          global: {
            fontSize: config.get('global.fontSize', 13),
            accentColor: config.get('global.accentColor', '#0e639c'),
            textColor: config.get('global.textColor', '#f3f3f3'),
            mutedColor: config.get('global.mutedColor', '#c5c5c5'),
            bgColor: config.get('global.bgColor', '#1e1e1e'),
            borderColor: config.get('global.borderColor', '#2d2d2d'),
            vcsProvider: getSavedVcsProvider(config, context)
          },
          todo: {
            extensions: profile.todoExtensions,
            excludeGlobs: profile.todoExcludeGlobs,
            includeGlobs: profile.todoIncludeGlobs,
            contentFilter: config.get('todo.contentFilter', ''),
            hoverColor: config.get('todo.hoverColor', 'rgba(14,99,156,0.45)'),
            fontSize: config.get('todo.fontSize', 0)
          },
          comment: {
            activeColor: config.get('comment.activeColor', 'rgba(14,99,156,0.6)'),
            hoverColor: config.get('comment.hoverColor', 'rgba(14,99,156,0.45)'),
            fontSize: config.get('comment.fontSize', 0)
          },
          pinex: {
            fileExtensions: profile.pinexFileExtensions,
            activeColor: config.get('pinex.activeColor', 'rgba(14,99,156,0.6)'),
            hoverColor: config.get('pinex.hoverColor', 'rgba(14,99,156,0.45)'),
            fontSize: config.get('pinex.fontSize', 0)
          },
          search: {
            mode: config.get('search.mode', 'all'),
            fileExtensions: profile.searchFileExtensions,
            includeDirectories: profile.searchIncludeDirectories,
            excludeDirectories: profile.searchExcludeDirectories,
            caseSensitive: config.get('search.caseSensitive', false),
            debounceDelay: config.get('search.debounceDelay', 300),
            maxFilesToSearch: config.get('search.maxFilesToSearch', 0),
            maxContentMatches: config.get('search.maxContentMatches', 100),
            maxItems: config.get('quickOpen.maxItems', 50),
            previewLines: config.get('search.previewLines', 1)
          },
          quickOpenKeybinding: await getQuickOpenKeybinding(),
          update: updateServiceRef?.getStatusPayload()
        });
        vscode.window.showInformationMessage(`Applied search profile: ${profile.type}`);
        break;
      case 'checkForUpdates':
        await updateServiceRef?.checkFromSettings();
        break;
      case 'installUpdate':
        await updateServiceRef?.installFromSettings();
        break;
      case 'openKeybindings':
        // 打开快捷键设置页面
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
        // 提示用户搜索命令
        setTimeout(() => {
          vscode.window.showInformationMessage(
            '请在快捷键设置中搜索 "cursorToolWindow.quickOpen" 来配置 Quick Open 的快捷键',
            '知道了'
          );
        }, 500);
        break;
      case 'saveVcsProvider':
        if (typeof msg.value === 'string') {
          await saveVcsProvider(config, context, msg.value);
          sidebarProvider?.refreshGlobalSettings?.();
          vscode.window.setStatusBarMessage(`Cursor Tools: VCS provider set to ${normalizeVcsProviderMode(msg.value)}.`, 2000);
        }
        break;
      case 'saveSettings':
        // 保存设置
        if (msg.global) {
          if (typeof msg.global.fontSize === 'number') {
            await config.update('global.fontSize', msg.global.fontSize, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.global.accentColor === 'string') {
            await config.update('global.accentColor', msg.global.accentColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.global.textColor === 'string') {
            await config.update('global.textColor', msg.global.textColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.global.mutedColor === 'string') {
            await config.update('global.mutedColor', msg.global.mutedColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.global.bgColor === 'string') {
            await config.update('global.bgColor', msg.global.bgColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.global.borderColor === 'string') {
            await config.update('global.borderColor', msg.global.borderColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.global.vcsProvider === 'string') {
            await saveVcsProvider(config, context, msg.global.vcsProvider);
          }
        }
        if (msg.todo) {
          if (Array.isArray(msg.todo.extensions)) {
            await config.update('todo.extensions', msg.todo.extensions, vscode.ConfigurationTarget.Global);
          }
          if (Array.isArray(msg.todo.excludeGlobs)) {
            await config.update('todo.excludeGlobs', msg.todo.excludeGlobs, vscode.ConfigurationTarget.Global);
          }
          if (Array.isArray(msg.todo.includeGlobs)) {
            await config.update('todo.includeGlobs', msg.todo.includeGlobs, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.todo.contentFilter === 'string') {
            await config.update('todo.contentFilter', msg.todo.contentFilter, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.todo.hoverColor === 'string') {
            await config.update('todo.hoverColor', msg.todo.hoverColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.todo.fontSize === 'number') {
            await config.update('todo.fontSize', msg.todo.fontSize, vscode.ConfigurationTarget.Global);
          }
        }
        if (msg.comment) {
          if (typeof msg.comment.activeColor === 'string') {
            await config.update('comment.activeColor', msg.comment.activeColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.comment.hoverColor === 'string') {
            await config.update('comment.hoverColor', msg.comment.hoverColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.comment.fontSize === 'number') {
            await config.update('comment.fontSize', msg.comment.fontSize, vscode.ConfigurationTarget.Global);
          }
        }
        if (msg.pinex) {
          if (Array.isArray(msg.pinex.fileExtensions)) {
            await config.update('pinex.fileExtensions', msg.pinex.fileExtensions, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.pinex.activeColor === 'string') {
            await config.update('pinex.activeColor', msg.pinex.activeColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.pinex.hoverColor === 'string') {
            await config.update('pinex.hoverColor', msg.pinex.hoverColor, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.pinex.fontSize === 'number') {
            await config.update('pinex.fontSize', msg.pinex.fontSize, vscode.ConfigurationTarget.Global);
          }
        }
        if (msg.search) {
          if (typeof msg.search.mode === 'string') {
            await config.update('search.mode', msg.search.mode, vscode.ConfigurationTarget.Global);
          }
          if (Array.isArray(msg.search.fileExtensions)) {
            await config.update('search.fileExtensions', msg.search.fileExtensions, vscode.ConfigurationTarget.Global);
          }
          if (Array.isArray(msg.search.includeDirectories)) {
            await config.update('search.includeDirectories', msg.search.includeDirectories, vscode.ConfigurationTarget.Global);
          }
          if (Array.isArray(msg.search.excludeDirectories)) {
            await config.update('search.excludeDirectories', msg.search.excludeDirectories, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.search.caseSensitive === 'boolean') {
            await config.update('search.caseSensitive', msg.search.caseSensitive, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.search.debounceDelay === 'number') {
            await config.update('search.debounceDelay', msg.search.debounceDelay, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.search.maxFilesToSearch === 'number') {
            await config.update('search.maxFilesToSearch', msg.search.maxFilesToSearch, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.search.maxContentMatches === 'number') {
            await config.update('search.maxContentMatches', msg.search.maxContentMatches, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.search.maxItems === 'number') {
            await config.update('quickOpen.maxItems', msg.search.maxItems, vscode.ConfigurationTarget.Global);
          }
          if (typeof msg.search.previewLines === 'number') {
            await config.update('search.previewLines', msg.search.previewLines, vscode.ConfigurationTarget.Global);
          }
        }
        vscode.window.showInformationMessage('Settings saved.');
        // 通知侧边栏 Webview 刷新配置
        sidebarProvider?.refreshTodoContentFilter?.();
        sidebarProvider?.refreshPinExFilter?.();
        sidebarProvider?.refreshGlobalSettings?.();
        break;
    }
  });

  settingsPanel.onDidDispose(() => {
    settingsPanel = undefined;
  });
}

function getSettingsWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cursor Tools - Settings</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --bg-card: #252526;
      --border: #3c3c3c;
      --fg: #cccccc;
      --fg-muted: #888888;
      --accent: #0e639c;
      --accent-hover: #1177bb;
      --tab-active: #1e1e1e;
      --tab-inactive: #2d2d2d;
      --scrollbar-size: 10px;
      --scrollbar-thumb: rgba(255,255,255,0.22);
      --scrollbar-thumb-hover: rgba(255,255,255,0.32);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      background: var(--bg);
      color: var(--fg);
    }
    /* 滚动条：默认隐藏，窗口获得焦点后显示 */
    body.scrollbar-hidden * {
      scrollbar-width: none; /* Firefox */
    }
    body.scrollbar-hidden *::-webkit-scrollbar {
      width: var(--scrollbar-size);
      height: var(--scrollbar-size);
    }
    body.scrollbar-hidden *::-webkit-scrollbar-thumb {
      background-color: transparent;
    }
    body.scrollbar-hidden *::-webkit-scrollbar-track {
      background-color: transparent;
    }
    body.scrollbar-visible *::-webkit-scrollbar {
      width: var(--scrollbar-size);
      height: var(--scrollbar-size);
    }
    body.scrollbar-visible *::-webkit-scrollbar-thumb {
      background-color: var(--scrollbar-thumb);
      border-radius: 8px;
      border: 2px solid transparent;
      background-clip: content-box;
    }
    body.scrollbar-visible *::-webkit-scrollbar-thumb:hover {
      background-color: var(--scrollbar-thumb-hover);
    }
    body.scrollbar-visible *::-webkit-scrollbar-track {
      background-color: transparent;
    }
    .container {
      max-width: 700px;
      margin: 0 auto;
    }
    h1 {
      font-size: 20px;
      font-weight: 500;
      margin: 0 0 20px 0;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .version-badge {
      display: inline-block;
      margin-left: 10px;
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--panel-text-muted);
      font-size: 12px;
      vertical-align: middle;
    }
    .page-hint {
      margin: -8px 0 18px 0;
      color: var(--panel-text-muted);
      font-size: 12px;
    }
    .profile-banner {
      margin: 0 0 14px 0;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
    }
    .profile-banner strong {
      color: var(--fg);
    }
    .update-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .tab {
      padding: 10px 20px;
      cursor: pointer;
      background: var(--tab-inactive);
      border: 1px solid var(--border);
      border-bottom: none;
      margin-right: 2px;
      border-radius: 6px 6px 0 0;
      color: var(--panel-text-muted);
      transition: all 0.15s;
    }
    .tab:hover {
      background: var(--bg-card);
      color: var(--fg);
    }
    .tab.active {
      background: var(--tab-active);
      color: var(--fg);
      border-bottom: 1px solid var(--tab-active);
      margin-bottom: -1px;
    }
    .tab-content {
      display: none;
      padding: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0 6px 6px 6px;
    }
    .tab-content.active {
      display: block;
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    .form-group .hint {
      font-size: calc(var(--font-size-base) * 0.85);
      color: var(--panel-text-muted);
      margin-bottom: 8px;
    }
    .form-group input[type="text"],
    .form-group textarea {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--fg);
      font-size: 13px;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .form-group textarea {
      min-height: 80px;
      resize: vertical;
    }
    .form-group input:focus,
    .form-group textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .color-input-group {
      display: flex;
      align-items: center;
    }
    .color-input-group input[type="color"] {
      cursor: pointer;
      border-radius: 4px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
    }
    .btn {
      padding: 8px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.15s;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
    }
    .btn-secondary {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: var(--border);
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--fg-muted);
    }
  </style>
</head>
<body class="scrollbar-hidden">
  <div class="container">
    <h1>Cursor Tools Settings <span class="version-badge">v${EXTENSION_VERSION}</span></h1>
    <div class="page-hint">Install this version to confirm the latest package is active.</div>
    
    <div class="tabs">
      <div class="tab active" data-tab="global">Global</div>
      <div class="tab" data-tab="search">Search</div>
      <div class="tab" data-tab="todo">TODO</div>
      <div class="tab" data-tab="comment">COMMENT</div>
      <div class="tab" data-tab="pinex">PinEx</div>
    </div>

    <div id="tab-global" class="tab-content active">
      <div class="profile-banner">
        <div>Updates: <strong id="update-status">Ready</strong></div>
        <div class="hint" id="update-meta" style="margin-top:6px;">Current: v${EXTENSION_VERSION}</div>
        <div class="update-actions">
          <button id="btn-checkUpdates" class="btn btn-secondary">Check for Updates</button>
          <button id="btn-installUpdate" class="btn btn-primary" style="display:none;">Install Update</button>
        </div>
      </div>
      <div class="form-group">
        <label>Font size</label>
        <div class="hint">Set the tool window font size (10–20px)</div>
        <input type="number" id="global-fontSize" min="10" max="20" value="13" style="width:80px;" /> px
      </div>
      <div class="form-group">
        <label>Version control provider</label>
        <div class="hint">Controls which version-control tabs and generic VCS commands are used.</div>
        <select id="global-vcsProvider" style="width:220px;padding:6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;">
          <option value="auto">Auto detect</option>
          <option value="p4">P4 only</option>
          <option value="svn">SVN only</option>
          <option value="both">Show both</option>
          <option value="none">Hide version control</option>
        </select>
      </div>
      <div class="form-group">
        <label>Accent color</label>
        <div class="hint">Used for highlight, hover, etc.</div>
        <input type="color" id="global-accentColor" value="#0e639c" style="width:60px;height:30px;" />
      </div>
      <div class="form-group">
        <label>Primary text color</label>
        <input type="color" id="global-textColor" value="#f3f3f3" style="width:60px;height:30px;" />
      </div>
      <div class="form-group">
        <label>Secondary text color</label>
        <div class="hint">Line numbers, hints, etc.</div>
        <input type="color" id="global-mutedColor" value="#c5c5c5" style="width:60px;height:30px;" />
      </div>
      <div class="form-group">
        <label>Background color</label>
        <input type="color" id="global-bgColor" value="#1e1e1e" style="width:60px;height:30px;" />
      </div>
      <div class="form-group">
        <label>Border color</label>
        <input type="color" id="global-borderColor" value="#2d2d2d" style="width:60px;height:30px;" />
      </div>
    </div>

    <div id="tab-search" class="tab-content">
      <div class="profile-banner">
        <div>Detected project profile: <strong id="detected-project-profile">Detecting...</strong></div>
        <div class="hint" style="margin-top:6px;">Apply Search, TODO, and PinEx presets based on the current workspace type.</div>
        <button id="btn-autoDetectProfile" class="btn btn-secondary" style="margin-top:8px;">Auto Detect Project Profile</button>
      </div>
      <div class="profile-banner" style="margin-top:12px;">
        <div>Search index status: <strong id="search-index-ready">Loading...</strong></div>
        <div class="hint" id="search-index-meta" style="margin-top:6px;">Waiting for index snapshot...</div>
      </div>
      <div class="form-group">
        <label>🔍 Search Mode</label>
        <div class="hint">Choose what to search: file names, file content, or both</div>
        <select id="search-mode" style="width:200px;padding:6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;">
          <option value="all">All (File + Class + Content)</option>
          <option value="filename">File Only</option>
          <option value="class">Class Only</option>
          <option value="fileclass">File + Class</option>
          <option value="content">Content Only</option>
        </select>
      </div>
      <div class="form-group">
        <label>📁 File Extensions</label>
        <div class="hint">Only search files with these extensions (comma-separated, empty = all files)</div>
        <textarea id="search-fileExtensions" rows="2" placeholder="Leave empty to search all file types"></textarea>
      </div>
      <div class="form-group">
        <label>📂 Include Directories</label>
        <div class="hint">Only search in these directories (one per line, empty = whole workspace)</div>
        <textarea id="search-includeDirectories" rows="3" placeholder="src&#10;lib&#10;scripts"></textarea>
      </div>
      <div class="form-group">
        <label>🚫 Exclude Directories</label>
        <div class="hint">Skip these directories (one per line)</div>
        <textarea id="search-excludeDirectories" rows="4" placeholder="**/node_modules/**&#10;**/bin/**&#10;**/obj/**&#10;**/.git/**"></textarea>
      </div>
      <div class="form-group">
        <label>🔠 Case Sensitive</label>
        <div class="hint">Enable case-sensitive search</div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="search-caseSensitive" style="width:18px;height:18px;" />
          <span>Match case when searching</span>
        </label>
      </div>
      <div class="form-group">
        <label>⏱️ Search Delay</label>
        <div class="hint">Wait time (ms) after typing before starting search (100-1000)</div>
        <input type="number" id="search-debounceDelay" min="100" max="1000" value="300" style="width:100px;" /> ms
      </div>
      <div class="form-group">
        <label>📊 Performance Settings</label>
        <div class="hint">Adjust for better performance or more results. Set "Max files to search" to 0 for no limit.</div>
        <div style="display:flex;flex-direction:column;gap:12px;margin-top:8px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:180px;">Max files to search:</span>
            <input type="number" id="search-maxFilesToSearch" min="0" max="5000" value="0" style="width:80px;" />
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:180px;">Max content matches:</span>
            <input type="number" id="search-maxContentMatches" min="10" max="500" value="100" style="width:80px;" />
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:180px;">Max display items:</span>
            <input type="number" id="search-maxItems" min="10" max="200" value="50" style="width:80px;" />
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="width:180px;">Preview lines:</span>
            <input type="number" id="search-previewLines" min="1" max="5" value="1" style="width:80px;" />
          </div>
        </div>
      </div>
      <div class="form-group">
        <label>⌨️ Quick Open Shortcut</label>
        <div class="hint">Default: Ctrl+T (Mac: Cmd+T). Click button to customize.</div>
        <button id="btn-openKeybindings" class="btn btn-secondary" style="margin-top:5px;">
          Open Keyboard Shortcuts Settings
        </button>
      </div>
    </div>

    <div id="tab-todo" class="tab-content">
      <div class="form-group">
        <label>File extensions to scan</label>
        <div class="hint">Comma-separated, e.g. cs, js, ts, cpp</div>
        <input type="text" id="todo-extensions" placeholder="cs, js, ts, tsx, cpp, c, h, hpp, java, go" />
      </div>
      <div class="form-group">
        <label>Excluded globs</label>
        <div class="hint">One per line or comma-separated, e.g. **/node_modules/**, **/bin/**</div>
        <textarea id="todo-excludeGlobs" placeholder="**/node_modules/**&#10;**/bin/**&#10;**/obj/**"></textarea>
      </div>
      <div class="form-group">
        <label>Included globs (empty = whole workspace)</label>
        <div class="hint">One per line or comma-separated, e.g. Assets/Scripts, Assets/Editor</div>
        <textarea id="todo-includeGlobs" placeholder="Leave empty to scan the whole workspace"></textarea>
      </div>
      <div class="form-group">
        <label>Content filter</label>
        <div class="hint">Only show TODO items containing this keyword (empty = show all)</div>
        <input type="text" id="todo-contentFilter" placeholder="e.g. BUG, FIXME, IMPORTANT" />
      </div>
      <div class="form-group">
        <label>Hover background</label>
        <div class="hint">Background color on hover (supports rgba alpha)</div>
        <div class="color-input-group">
          <input type="color" id="todo-hoverColor-picker" value="#0e639c" style="width:40px;height:28px;padding:0;border:1px solid #444;cursor:pointer;" />
          <input type="text" id="todo-hoverColor" value="rgba(14,99,156,0.45)" style="width:155px;margin-left:5px;" />
        </div>
      </div>
      <div class="form-group">
        <label>Font size</label>
        <div class="hint">0 uses global setting (10–20px)</div>
        <input type="number" id="todo-fontSize" min="0" max="20" value="0" style="width:80px;" /> px
      </div>
    </div>

    <div id="tab-comment" class="tab-content">
      <div class="form-group">
        <label>Active comment highlight</label>
        <div class="hint">Highlight color for the active comment (supports rgba alpha)</div>
        <div class="color-input-group">
          <input type="color" id="comment-activeColor-picker" value="#0e639c" style="width:40px;height:28px;padding:0;border:1px solid #444;cursor:pointer;" />
          <input type="text" id="comment-activeColor" value="rgba(14,99,156,0.6)" style="width:155px;margin-left:5px;" />
        </div>
      </div>
      <div class="form-group">
        <label>Hover background</label>
        <div class="hint">Background color on hover (supports rgba alpha)</div>
        <div class="color-input-group">
          <input type="color" id="comment-hoverColor-picker" value="#0e639c" style="width:40px;height:28px;padding:0;border:1px solid #444;cursor:pointer;" />
          <input type="text" id="comment-hoverColor" value="rgba(14,99,156,0.45)" style="width:155px;margin-left:5px;" />
        </div>
      </div>
      <div class="form-group">
        <label>Font size</label>
        <div class="hint">0 uses global setting (10–20px)</div>
        <input type="number" id="comment-fontSize" min="0" max="20" value="0" style="width:80px;" /> px
      </div>
    </div>

    <div id="tab-pinex" class="tab-content">
      <div class="form-group">
        <label>File extensions shown under folders</label>
        <div class="hint">Comma-separated, e.g. cs, ts, js (empty = show all)</div>
        <input type="text" id="pinex-fileExtensions" placeholder="Leave empty to show all files" />
      </div>
      <div class="form-group">
        <label>Active file highlight</label>
        <div class="hint">Highlight color for the active file (supports rgba alpha)</div>
        <div class="color-input-group">
          <input type="color" id="pinex-activeColor-picker" value="#0e639c" style="width:40px;height:28px;padding:0;border:1px solid #444;cursor:pointer;" />
          <input type="text" id="pinex-activeColor" value="rgba(14,99,156,0.6)" style="width:155px;margin-left:5px;" />
        </div>
      </div>
      <div class="form-group">
        <label>Hover background</label>
        <div class="hint">Background color on hover (supports rgba alpha)</div>
        <div class="color-input-group">
          <input type="color" id="pinex-hoverColor-picker" value="#0e639c" style="width:40px;height:28px;padding:0;border:1px solid #444;cursor:pointer;" />
          <input type="text" id="pinex-hoverColor" value="rgba(14,99,156,0.45)" style="width:155px;margin-left:5px;" />
        </div>
      </div>
      <div class="form-group">
        <label>Font size</label>
        <div class="hint">0 uses global setting (10–20px)</div>
        <input type="number" id="pinex-fontSize" min="0" max="20" value="0" style="width:80px;" /> px
      </div>
      <div class="form-group">
        <label>Quick Open Keyboard Shortcut</label>
        <div class="hint">Configure the keyboard shortcut for Quick Open command</div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <input type="text" id="pinex-quickOpenKeybinding" readonly style="width: 200px; background: var(--bg); cursor: not-allowed;" placeholder="Click button to configure" />
          <button class="btn btn-secondary" id="btn-openKeybindings" style="white-space: nowrap;">Open Keyboard Shortcuts</button>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn btn-secondary" id="btn-reset">Reset to defaults</button>
      <button class="btn btn-primary" id="btn-save">Save settings</button>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();

      function setScrollbarVisible(visible) {
        const b = document.body;
        if (!b) return;
        if (visible) {
          b.classList.add('scrollbar-visible');
          b.classList.remove('scrollbar-hidden');
        } else {
          b.classList.add('scrollbar-hidden');
          b.classList.remove('scrollbar-visible');
        }
      }
      // 默认隐藏；聚焦设置窗口后显示
      setScrollbarVisible(false);
      window.addEventListener('focus', () => setScrollbarVisible(true));
      window.addEventListener('blur', () => setScrollbarVisible(false));
      document.addEventListener('mousedown', () => setScrollbarVisible(true), true);

      // Tab 切换
      document.querySelectorAll('.tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          tab.classList.add('active');
          document.getElementById('tab-' + tab.getAttribute('data-tab')).classList.add('active');
        });
      });

      // 请求当前设置
      vscode.postMessage({ type: 'getSettings' });

      // 接收设置数据
      function renderSearchIndexSnapshot(snapshot) {
        if (!snapshot) return;
        var readyEl = document.getElementById('search-index-ready');
        var metaEl = document.getElementById('search-index-meta');
        if (!readyEl || !metaEl) return;

        var statusParts = [];
        statusParts.push(snapshot.ready ? 'Ready' : 'Building');
        statusParts.push(snapshot.cacheLoaded ? 'cache loaded' : 'cold start');
        if (snapshot.stale) {
          statusParts.push('refresh pending');
        }
        readyEl.textContent = statusParts.join(' / ');

        var metaParts = [
          'files: ' + (snapshot.fileCount || 0),
          'symbols: ' + (snapshot.symbolCount || 0)
        ];
        if (snapshot.lastRebuildAt) {
          metaParts.push('updated: ' + new Date(snapshot.lastRebuildAt).toLocaleString());
        }
        metaEl.textContent = metaParts.join(' | ');
      }

      function renderUpdateStatus(status) {
        status = status || {};
        var statusEl = document.getElementById('update-status');
        var metaEl = document.getElementById('update-meta');
        var checkBtn = document.getElementById('btn-checkUpdates');
        var installBtn = document.getElementById('btn-installUpdate');
        if (!statusEl || !metaEl || !checkBtn || !installBtn) return;

        statusEl.textContent = status.message || 'Ready to check for updates.';
        var current = status.currentVersion || '${EXTENSION_VERSION}';
        var metaParts = ['Current: v' + current];
        if (status.latestVersion) {
          metaParts.push('Latest: v' + String(status.latestVersion).replace(/^v/i, ''));
        }
        if (status.assetName) {
          metaParts.push(status.assetName);
        }
        if (status.checkedAt) {
          metaParts.push('Checked: ' + new Date(status.checkedAt).toLocaleString());
        }
        metaEl.textContent = metaParts.join(' | ');

        var busy = status.state === 'checking' || status.state === 'installing';
        checkBtn.disabled = busy;
        installBtn.disabled = busy;
        installBtn.style.display = status.canInstall ? '' : 'none';
      }

      renderUpdateStatus({
        currentVersion: '${EXTENSION_VERSION}',
        state: 'idle',
        message: 'Ready to check for updates.',
        canInstall: false
      });

      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'settings') {
          if (msg.detectedProfile) {
            document.getElementById('detected-project-profile').textContent = msg.detectedProfile.type || 'General';
          }
          renderSearchIndexSnapshot(msg.searchIndexSnapshot);
          if (msg.global) {
            document.getElementById('global-fontSize').value = msg.global.fontSize || 13;
            document.getElementById('global-accentColor').value = msg.global.accentColor || '#0e639c';
            document.getElementById('global-textColor').value = msg.global.textColor || '#f3f3f3';
            document.getElementById('global-mutedColor').value = msg.global.mutedColor || '#c5c5c5';
            document.getElementById('global-bgColor').value = msg.global.bgColor || '#1e1e1e';
            document.getElementById('global-borderColor').value = msg.global.borderColor || '#2d2d2d';
            document.getElementById('global-vcsProvider').value = msg.global.vcsProvider || 'auto';
          }
          if (msg.todo) {
            document.getElementById('todo-extensions').value = (msg.todo.extensions || []).join(', ');
            document.getElementById('todo-excludeGlobs').value = (msg.todo.excludeGlobs || []).join(String.fromCharCode(10));
            document.getElementById('todo-includeGlobs').value = (msg.todo.includeGlobs || []).join(String.fromCharCode(10));
            document.getElementById('todo-contentFilter').value = msg.todo.contentFilter || '';
            document.getElementById('todo-hoverColor').value = msg.todo.hoverColor || 'rgba(14,99,156,0.45)';
            document.getElementById('todo-fontSize').value = msg.todo.fontSize || 0;
            // 更新 color picker
            updateColorPickerFromText('todo-hoverColor-picker', 'todo-hoverColor');
          }
          if (msg.comment) {
            document.getElementById('comment-activeColor').value = msg.comment.activeColor || 'rgba(14,99,156,0.6)';
            document.getElementById('comment-hoverColor').value = msg.comment.hoverColor || 'rgba(14,99,156,0.45)';
            document.getElementById('comment-fontSize').value = msg.comment.fontSize || 0;
            // 更新 color pickers
            updateColorPickerFromText('comment-activeColor-picker', 'comment-activeColor');
            updateColorPickerFromText('comment-hoverColor-picker', 'comment-hoverColor');
          }
          if (msg.pinex) {
            document.getElementById('pinex-fileExtensions').value = (msg.pinex.fileExtensions || []).join(', ');
            document.getElementById('pinex-activeColor').value = msg.pinex.activeColor || 'rgba(14,99,156,0.6)';
            document.getElementById('pinex-hoverColor').value = msg.pinex.hoverColor || 'rgba(14,99,156,0.45)';
            document.getElementById('pinex-fontSize').value = msg.pinex.fontSize || 0;
            // 更新 color pickers
            updateColorPickerFromText('pinex-activeColor-picker', 'pinex-activeColor');
            updateColorPickerFromText('pinex-hoverColor-picker', 'pinex-hoverColor');
          }
          if (msg.search) {
            document.getElementById('search-mode').value = msg.search.mode || 'all';
            document.getElementById('search-fileExtensions').value = (msg.search.fileExtensions || []).join(', ');
            document.getElementById('search-includeDirectories').value = (msg.search.includeDirectories || []).join(String.fromCharCode(10));
            document.getElementById('search-excludeDirectories').value = (msg.search.excludeDirectories || []).join(String.fromCharCode(10));
            document.getElementById('search-caseSensitive').checked = msg.search.caseSensitive || false;
            document.getElementById('search-debounceDelay').value = msg.search.debounceDelay || 300;
            document.getElementById('search-maxFilesToSearch').value = typeof msg.search.maxFilesToSearch === 'number' ? msg.search.maxFilesToSearch : 0;
            document.getElementById('search-maxContentMatches').value = msg.search.maxContentMatches || 100;
            document.getElementById('search-maxItems').value = msg.search.maxItems || 50;
            document.getElementById('search-previewLines').value = msg.search.previewLines || 1;
          }
          if (typeof msg.quickOpenKeybinding === 'string') {
            document.getElementById('pinex-quickOpenKeybinding').value = msg.quickOpenKeybinding;
          }
          if (msg.update) {
            renderUpdateStatus(msg.update);
          }
        } else if (msg.type === 'detectedProfileApplied' && msg.profile) {
          document.getElementById('detected-project-profile').textContent = msg.profile.type || 'General';
        } else if (msg.type === 'searchIndexSnapshot') {
          renderSearchIndexSnapshot(msg.snapshot);
        } else if (msg.type === 'updateStatus') {
          renderUpdateStatus(msg.status);
        }
      });

      // 輔助函數：從顏色值中提取 hex（用於設置 color picker）
      function extractHexFromColor(colorStr) {
        if (!colorStr) return '#0e639c';
        // 如果已經是 hex 格式
        if (colorStr.indexOf('#') === 0) {
          return colorStr.substring(0, 7); // 只取前 7 個字符
        }
        // 如果是 rgba 或 rgb 格式，提取 RGB 值
        var match = colorStr.match(/rgba?\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
        if (match) {
          var r = parseInt(match[1], 10).toString(16).padStart(2, '0');
          var g = parseInt(match[2], 10).toString(16).padStart(2, '0');
          var b = parseInt(match[3], 10).toString(16).padStart(2, '0');
          return '#' + r + g + b;
        }
        return '#0e639c';
      }

      // 輔助函數：根據文本輸入更新 color picker
      function updateColorPickerFromText(pickerId, textId) {
        var picker = document.getElementById(pickerId);
        var textInput = document.getElementById(textId);
        if (picker && textInput) {
          picker.value = extractHexFromColor(textInput.value);
        }
      }

      // 輔助函數：當 color picker 變化時更新對應的 text input（保留透明度如果有）
      function setupColorPicker(pickerId, textId) {
        var picker = document.getElementById(pickerId);
        var textInput = document.getElementById(textId);
        if (!picker || !textInput) return;

        // 初始化 color picker 的值
        picker.value = extractHexFromColor(textInput.value);

        picker.addEventListener('input', function() {
          var currentValue = textInput.value || '';
          // 如果當前值是 rgba，保留透明度
          var match = currentValue.match(/rgba\\s*\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\s*\\)/);
          if (match) {
            var alpha = match[1];
            // 從 hex 轉換為 rgb
            var hex = picker.value;
            var r = parseInt(hex.substring(1, 3), 16);
            var g = parseInt(hex.substring(3, 5), 16);
            var b = parseInt(hex.substring(5, 7), 16);
            textInput.value = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
          } else {
            // 否則直接使用 hex
            textInput.value = picker.value;
          }
        });
      }

      // 設置所有顏色選擇器
      setupColorPicker('todo-hoverColor-picker', 'todo-hoverColor');
      setupColorPicker('comment-activeColor-picker', 'comment-activeColor');
      setupColorPicker('comment-hoverColor-picker', 'comment-hoverColor');
      setupColorPicker('pinex-activeColor-picker', 'pinex-activeColor');
      setupColorPicker('pinex-hoverColor-picker', 'pinex-hoverColor');

      var vcsProviderSelect = document.getElementById('global-vcsProvider');
      if (vcsProviderSelect) {
        vcsProviderSelect.addEventListener('change', function () {
          vscode.postMessage({
            type: 'saveVcsProvider',
            value: vcsProviderSelect.value || 'auto'
          });
        });
      }

      // 保存按钮
      document.getElementById('btn-save').addEventListener('click', function() {
        var extensions = document.getElementById('todo-extensions').value
          .split(',')
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });
        
        var excludeGlobs = document.getElementById('todo-excludeGlobs').value
          .split(/[\\n\\r,]+/)
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });
        
        var includeGlobs = document.getElementById('todo-includeGlobs').value
          .split(/[\\n\\r,]+/)
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });

        var contentFilter = (document.getElementById('todo-contentFilter').value || '').trim();

        var pinexFileExtensions = document.getElementById('pinex-fileExtensions').value
          .split(',')
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });

        var globalFontSize = parseInt(document.getElementById('global-fontSize').value, 10) || 13;
        if (globalFontSize < 10) globalFontSize = 10;
        if (globalFontSize > 20) globalFontSize = 20;

        var globalAccentColor = document.getElementById('global-accentColor').value || '#0e639c';
        var globalTextColor = document.getElementById('global-textColor').value || '#f3f3f3';
        var globalMutedColor = document.getElementById('global-mutedColor').value || '#c5c5c5';
        var globalBgColor = document.getElementById('global-bgColor').value || '#1e1e1e';
        var globalBorderColor = document.getElementById('global-borderColor').value || '#2d2d2d';
        var globalVcsProvider = document.getElementById('global-vcsProvider').value || 'auto';

        var todoHoverColor = document.getElementById('todo-hoverColor').value || 'rgba(14,99,156,0.45)';
        var todoFontSize = parseInt(document.getElementById('todo-fontSize').value, 10) || 0;
        var commentActiveColor = document.getElementById('comment-activeColor').value || 'rgba(14,99,156,0.6)';
        var commentHoverColor = document.getElementById('comment-hoverColor').value || 'rgba(14,99,156,0.45)';
        var commentFontSize = parseInt(document.getElementById('comment-fontSize').value, 10) || 0;
        var pinexActiveColor = document.getElementById('pinex-activeColor').value || 'rgba(14,99,156,0.6)';
        var pinexHoverColor = document.getElementById('pinex-hoverColor').value || 'rgba(14,99,156,0.45)';
        var pinexFontSize = parseInt(document.getElementById('pinex-fontSize').value, 10) || 0;

        // Search 设置
        var searchMode = document.getElementById('search-mode').value || 'all';
        var searchFileExtensions = document.getElementById('search-fileExtensions').value
          .split(',')
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });
        var searchIncludeDirectories = document.getElementById('search-includeDirectories').value
          .split(/[\\n\\r,]+/)
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });
        var searchExcludeDirectories = document.getElementById('search-excludeDirectories').value
          .split(/[\\n\\r,]+/)
          .map(function(s) { return s.trim(); })
          .filter(function(s) { return s.length > 0; });
        var searchCaseSensitive = document.getElementById('search-caseSensitive').checked;
        var searchDebounceDelay = parseInt(document.getElementById('search-debounceDelay').value, 10) || 300;
        var searchMaxFilesToSearch = parseInt(document.getElementById('search-maxFilesToSearch').value, 10);
        if (isNaN(searchMaxFilesToSearch) || searchMaxFilesToSearch < 0) searchMaxFilesToSearch = 0;
        var searchMaxContentMatches = parseInt(document.getElementById('search-maxContentMatches').value, 10) || 100;
        var searchMaxItems = parseInt(document.getElementById('search-maxItems').value, 10) || 50;
        var searchPreviewLines = parseInt(document.getElementById('search-previewLines').value, 10) || 1;

        vscode.postMessage({
          type: 'saveSettings',
          global: {
            fontSize: globalFontSize,
            accentColor: globalAccentColor,
            textColor: globalTextColor,
            mutedColor: globalMutedColor,
            bgColor: globalBgColor,
            borderColor: globalBorderColor,
            vcsProvider: globalVcsProvider
          },
          todo: {
            extensions: extensions,
            excludeGlobs: excludeGlobs,
            includeGlobs: includeGlobs,
            contentFilter: contentFilter,
            hoverColor: todoHoverColor,
            fontSize: todoFontSize
          },
          comment: {
            activeColor: commentActiveColor,
            hoverColor: commentHoverColor,
            fontSize: commentFontSize
          },
          pinex: {
            fileExtensions: pinexFileExtensions,
            activeColor: pinexActiveColor,
            hoverColor: pinexHoverColor,
            fontSize: pinexFontSize
          },
          search: {
            mode: searchMode,
            fileExtensions: searchFileExtensions,
            includeDirectories: searchIncludeDirectories,
            excludeDirectories: searchExcludeDirectories,
            caseSensitive: searchCaseSensitive,
            debounceDelay: searchDebounceDelay,
            maxFilesToSearch: searchMaxFilesToSearch,
            maxContentMatches: searchMaxContentMatches,
            maxItems: searchMaxItems,
            previewLines: searchPreviewLines
          }
        });
      });

      // 打开快捷键设置按钮
      document.getElementById('btn-openKeybindings').addEventListener('click', function() {
        vscode.postMessage({ type: 'openKeybindings' });
      });

      document.getElementById('btn-autoDetectProfile').addEventListener('click', function() {
        vscode.postMessage({ type: 'autoDetectProjectProfile' });
      });

      document.getElementById('btn-checkUpdates').addEventListener('click', function() {
        vscode.postMessage({ type: 'checkForUpdates' });
      });

      document.getElementById('btn-installUpdate').addEventListener('click', function() {
        vscode.postMessage({ type: 'installUpdate' });
      });

      // 重置按钮
      document.getElementById('btn-reset').addEventListener('click', function() {
        // 全局设置
        document.getElementById('global-fontSize').value = '13';
        document.getElementById('global-accentColor').value = '#0e639c';
        document.getElementById('global-textColor').value = '#f3f3f3';
        document.getElementById('global-mutedColor').value = '#c5c5c5';
        document.getElementById('global-bgColor').value = '#1e1e1e';
        document.getElementById('global-borderColor').value = '#2d2d2d';
        document.getElementById('global-vcsProvider').value = 'auto';
        // TODO 设置
        document.getElementById('todo-extensions').value = 'cs, csx, js, jsx, ts, tsx, cpp, c, h, hpp, java, go';
        document.getElementById('todo-excludeGlobs').value = '**/node_modules/**' + String.fromCharCode(10) + '**/bin/**' + String.fromCharCode(10) + '**/obj/**';
        document.getElementById('todo-includeGlobs').value = '';
        document.getElementById('todo-contentFilter').value = '';
        document.getElementById('todo-hoverColor').value = 'rgba(14,99,156,0.45)';
        document.getElementById('todo-fontSize').value = '0';
        // COMMENT 设置
        document.getElementById('comment-activeColor').value = 'rgba(14,99,156,0.6)';
        document.getElementById('comment-hoverColor').value = 'rgba(14,99,156,0.45)';
        document.getElementById('comment-fontSize').value = '0';
        // PinEx 设置
        document.getElementById('pinex-fileExtensions').value = '';
        document.getElementById('pinex-activeColor').value = 'rgba(14,99,156,0.6)';
        document.getElementById('pinex-hoverColor').value = 'rgba(14,99,156,0.45)';
        document.getElementById('pinex-fontSize').value = '0';
        document.getElementById('pinex-quickOpenKeybinding').value = 'Ctrl+T (default)';
        // Search 设置
        document.getElementById('search-mode').value = 'all';
        document.getElementById('search-fileExtensions').value = '';
        document.getElementById('search-includeDirectories').value = '';
        document.getElementById('search-excludeDirectories').value = '**/node_modules/**' + String.fromCharCode(10) + '**/bin/**' + String.fromCharCode(10) + '**/obj/**' + String.fromCharCode(10) + '**/.git/**' + String.fromCharCode(10) + '**/dist/**';
        document.getElementById('search-caseSensitive').checked = false;
        document.getElementById('search-debounceDelay').value = '300';
        document.getElementById('search-maxFilesToSearch').value = '0';
        document.getElementById('search-maxContentMatches').value = '100';
        document.getElementById('search-maxItems').value = '50';
        document.getElementById('search-previewLines').value = '1';
      });
    })();
  </script>
</body>
</html>`;
}

async function getQuickOpenKeybinding(): Promise<string> {
  // VS Code API 无法直接读取 keybindings.json 的内容
  // 返回默认值，用户可以通过按钮打开快捷键设置页面查看和修改
  return 'Ctrl+T (default)';
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
