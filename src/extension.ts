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
const UPDATE_LATEST_RELEASE_URL = 'https://github.com/GameRisker/CursorEx/releases/latest';
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
  container: string; // 褰掔被鐢細绫?缁撴瀯浣?鎺ュ彛/鏋氫妇 鍚嶇О锛涙壘涓嶅埌鍒欏洖閫€涓烘枃浠跺悕
  access?: 'read' | 'write'; // 瀛楁/灞炴€ф煡璇㈡椂鍖哄垎璇诲啓
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
  scopePath: string;
  scopeLabel: string;
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
  releaseNotes?: string;
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
  body?: string;
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
  releaseNotes?: string;
  isUpdateAvailable: boolean;
}

interface LatestReleaseInfo {
  tagName: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  assetName: string;
  downloadUrl: string;
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

function httpsResolveFinalUrl(url: string, headers: Record<string, string>, redirectCount = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, response => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      response.resume();

      if (location && [301, 302, 303, 307, 308].includes(statusCode)) {
        if (redirectCount >= 5) {
          reject(new Error('Too many redirects while resolving latest release.'));
          return;
        }
        resolve(httpsResolveFinalUrl(new URL(location, url).toString(), headers, redirectCount + 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(`GitHub request failed with HTTP ${statusCode}.`));
        return;
      }

      resolve(url);
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

  private async fetchLatestReleaseInfo(): Promise<LatestReleaseInfo> {
    try {
      const release = await httpsGetJson<GithubRelease>(UPDATE_API_URL);
      const tagName = typeof release.tag_name === 'string' ? release.tag_name : '';
      const latestVersion = tagName.replace(/^v/i, '');
      const releaseUrl = typeof release.html_url === 'string' ? release.html_url : UPDATE_LATEST_RELEASE_URL;
      const releaseNotes = typeof release.body === 'string' ? release.body.trim() : '';
      const asset = (Array.isArray(release.assets) ? release.assets : []).find(item => {
        return typeof item.name === 'string' &&
          item.name.toLowerCase().endsWith('.vsix') &&
          typeof item.browser_download_url === 'string';
      });

      return {
        tagName,
        latestVersion,
        releaseUrl,
        releaseNotes,
        assetName: asset?.name || '',
        downloadUrl: asset?.browser_download_url || ''
      };
    } catch (error) {
      const apiError = getErrorMessage(error);
      const releaseUrl = await httpsResolveFinalUrl(UPDATE_LATEST_RELEASE_URL, {
        'Accept': 'text/html',
        'User-Agent': 'CursorEx-Updater'
      });
      const match = releaseUrl.match(/\/releases\/tag\/([^/?#]+)/);
      const tagName = match ? decodeURIComponent(match[1]) : '';
      const latestVersion = tagName.replace(/^v/i, '');
      const assetName = latestVersion ? `cursor-tool-window-${latestVersion}.vsix` : '';
      const downloadUrl = tagName && assetName
        ? `https://github.com/GameRisker/CursorEx/releases/download/${encodeURIComponent(tagName)}/${encodeURIComponent(assetName)}`
        : '';

      return {
        tagName,
        latestVersion,
        releaseUrl,
        releaseNotes: `GitHub API was unavailable (${apiError}); release notes could not be loaded.`,
        assetName,
        downloadUrl
      };
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
      const release = await this.fetchLatestReleaseInfo();
      const tagName = release.tagName;
      const latestVersion = release.latestVersion;
      const releaseUrl = release.releaseUrl || UPDATE_LATEST_RELEASE_URL;
      const releaseNotes = release.releaseNotes;

      const comparison = compareSemver(latestVersion, EXTENSION_VERSION);
      if (comparison === null) {
        this.latestAvailableUpdate = undefined;
        const info = this.createNoUpdateInfo(tagName || latestVersion || 'unknown', releaseUrl, releaseNotes);
        this.setStatus({
          state: 'current',
          latestVersion: tagName || latestVersion || undefined,
          releaseUrl: releaseUrl,
          releaseNotes: releaseNotes,
          message: `No compatible update found. Latest release tag is ${tagName || 'unknown'}.`,
          canInstall: false,
          checkedAt: Date.now()
        });
        return info;
      }

      if (comparison <= 0) {
        this.latestAvailableUpdate = undefined;
        const info = this.createNoUpdateInfo(latestVersion, releaseUrl, releaseNotes);
        this.setStatus({
          state: 'current',
          latestVersion: latestVersion,
          releaseUrl: releaseUrl,
          releaseNotes: releaseNotes,
          message: comparison === 0 ? 'You are on the latest version.' : `Installed version v${EXTENSION_VERSION} is newer than GitHub latest v${latestVersion}.`,
          canInstall: false,
          checkedAt: Date.now()
        });
        return info;
      }

      if (!release.assetName || !release.downloadUrl) {
        throw new Error(`Release ${tagName} does not include a VSIX asset.`);
      }

      const update: UpdateInfo = {
        currentVersion: EXTENSION_VERSION,
        latestVersion: latestVersion,
        tagName: tagName,
        releaseUrl: releaseUrl,
        assetName: release.assetName,
        downloadUrl: release.downloadUrl,
        releaseNotes: releaseNotes,
        isUpdateAvailable: true
      };

      this.latestAvailableUpdate = update;
      this.setStatus({
        state: 'available',
        latestVersion: update.latestVersion,
        releaseUrl: update.releaseUrl,
        assetName: update.assetName,
        releaseNotes: update.releaseNotes,
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
      return this.createNoUpdateInfo('unknown', UPDATE_LATEST_RELEASE_URL);
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
      releaseNotes: update.releaseNotes,
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
        releaseNotes: update.releaseNotes,
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
        releaseNotes: update.releaseNotes,
        message: `Install failed: ${getErrorMessage(error)}`,
        canInstall: true
      });
      throw error;
    }
  }

  private createNoUpdateInfo(latestVersion: string, releaseUrl: string, releaseNotes = ''): UpdateInfo {
    return {
      currentVersion: EXTENSION_VERSION,
      latestVersion: latestVersion,
      tagName: latestVersion,
      releaseUrl: releaseUrl,
      assetName: '',
      downloadUrl: '',
      releaseNotes: releaseNotes,
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
  // 鎵撳紑鏂囦欢 MRU锛堟渶杩戜娇鐢細鑱氱劍/缂栬緫锛?
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
    scopePath: '',
    scopeLabel: '',
    url: '',
    revision: '',
    items: [],
    updatedAt: 0
  };
  private pendingPinExTab: string | null = null;
  private pendingPinExLocateUri: string | null = null;
  // (FRE Preview Panel 宸茬Щ闄?

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

    // 鍏煎褰撳墠瑙勫垯锛氭渶澶氫繚鐣?1 涓€滄湭鍥哄畾鈥濈殑褰撳墠缁撴灉
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
    // workspaceState 鍏抽棴 Cursor/VS Code 鍚庝粛浼氫繚鐣?
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
        case 'logWebviewError':
          void this.appendDebugLog(`[webview-error] ${JSON.stringify({
            message: msg.message,
            source: msg.source,
            line: msg.line,
            column: msg.column,
            stack: msg.stack
          })}`);
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

    // 寤惰繜鍙戦€佹暟鎹紝纭繚 Webview 宸插噯澶囧ソ鎺ユ敹娑堟伅
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
      this.postSvnSnapshot();
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
    // 闃叉鏃犻檺澧為暱
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
    // 鑾峰彇鎵€鏈夋墦寮€鐨勬枃浠讹紙tab锛?
    const openFiles: Array<{ uri: vscode.Uri; name: string; relativePath: string; isActive: boolean }> = [];
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    
    vscode.window.tabGroups.all.forEach(group => {
      group.tabs.forEach(tab => {
        if (tab.input && typeof (tab.input as any).uri !== 'undefined') {
          const uri = (tab.input as any).uri as vscode.Uri;
          if (uri.scheme === 'file') {
            const uriStr = uri.toString();
            // 閬垮厤閲嶅
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

    // 纭繚褰撳墠娲诲姩鏂囦欢鍦?MRU 椤堕儴锛堢敤浜庢帓搴忥級
    if (activeUri) {
      try {
        this.noteOpenFileRecentlyUsed(vscode.Uri.parse(activeUri));
      } catch {
        // ignore
      }
    }

    // 鍙繚鐣欎粛鍦?openFiles 涓殑 MRU 椤?
    const openSet: { [k: string]: boolean } = {};
    for (let i = 0; i < openFiles.length; i++) {
      openSet[openFiles[i].uri.toString()] = true;
    }
    this.openFileMru = this.openFileMru.filter(u => !!openSet[u]);

    // MRU 鎺掑簭锛氭渶杩戣仛鐒?缂栬緫鐨勬枃浠舵帓鏈€涓婏紱娲诲姩鏂囦欢姘歌繙浼樺厛
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
      // 鍏滃簳锛氭寜鏂囦欢鍚嶆帓搴忥紝淇濊瘉绋冲畾
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

  private getSvnProjectDirectory(): string {
    const folders = vscode.workspace.workspaceFolders || [];
    const editorPath = vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : '';
    if (editorPath && folders.length) {
      const containing = folders
        .map(folder => folder.uri.fsPath)
        .filter(folderPath => this.isPathInside(folderPath, editorPath))
        .sort((a, b) => b.length - a.length)[0];
      if (containing) {
        return containing;
      }
    }
    return folders[0]?.uri.fsPath || this.getSvnWorkingDirectory();
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
      status: `SVN${info.revision ? ' - r' + info.revision : ''}`,
      items,
      selectedCount: items.filter(item => item.selected).length,
      committableCount: items.filter(item => item.canCommit).length,
      updatedAt: Date.now()
    };
  }

  private parseSvnStatusLine(line: string, root: string, externalPrefix = '', displayRoot = root): SvnStatusItem | null {
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
    const displayPath = this.getSvnDisplayPath(rawPath, displayRoot, fsPath);
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
      if (!clientRoot || !this.isPathInside(clientRoot, cwd)) {
        throw new Error(clientRoot
          ? `Current workspace is outside P4 client root: ${clientRoot}`
          : 'P4 client root not found.');
      }

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
        status: `Connected${clientName ? ' - ' + clientName : ''}`,
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
    const projectDir = this.getSvnProjectDirectory();
    try {
      const info = await this.getSvnInfoForTarget(projectDir);
      const root = info.workingCopyRoot || projectDir;
      const statusTarget = info.statusTarget || projectDir;
      const scopeLabel = vscode.workspace.asRelativePath(vscode.Uri.file(statusTarget), false) || path.basename(statusTarget) || statusTarget;

      const statusText = await this.runSvn(['status', statusTarget], root).catch(() => '');
      const items: SvnStatusItem[] = [];
      if (statusText) {
        let externalPrefix = '';
        for (const line of statusText.split(/\r?\n/)) {
          const externalMatch = line.match(/^Performing status on external item at ['"](.+)['"]:/);
          if (externalMatch) {
            externalPrefix = externalMatch[1].trim();
            continue;
          }
          const item = this.parseSvnStatusLine(line, root, externalPrefix, statusTarget);
          if (item) {
            items.push(item);
          }
        }
      }

      this.svnSnapshot = {
        available: true,
        status: `Connected${info.revision ? ' - r' + info.revision : ''}`,
        workingCopyRoot: root,
        scopePath: statusTarget,
        scopeLabel: scopeLabel,
        url: info.url,
        revision: info.revision,
        items: items,
        updatedAt: Date.now()
      };
    } catch (error: any) {
      this.svnSnapshot = {
        available: false,
        status: (error && error.message) ? `SVN unavailable: ${error.message}` : 'SVN unavailable',
        workingCopyRoot: '',
        scopePath: '',
        scopeLabel: '',
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
    try {
      const info = await this.getSvnInfoForTarget(uri.fsPath);
      const root = info.workingCopyRoot || path.dirname(uri.fsPath);
      const statusXml = await this.runSvn(['status', '--xml', uri.fsPath], root, { timeoutMs: 30000 }).catch(() => '');
      const item = this.parseSvnCommitStatusXml(statusXml, root).find(candidate => path.normalize(candidate.fsPath) === path.normalize(uri.fsPath));
      const status = String(item?.status || '').toUpperCase();
      if (item?.isUnversioned || status === '?') {
        vscode.window.showWarningMessage('SVN: unversioned files do not have a base revision to diff.');
        return;
      }
      if (status === 'A') {
        vscode.window.showWarningMessage('SVN: added files do not have a base revision to diff.');
        return;
      }
      if (status === '!' || status === 'D') {
        vscode.window.showWarningMessage('SVN: deleted or missing files cannot be opened in the base diff view.');
        return;
      }
      await this.openSvnBaseFileDiff(uri, root, this.getSvnDisplayPath(uri.fsPath, root, uri.fsPath));
    } catch (error) {
      vscode.window.showErrorMessage(`SVN diff failed: ${getCommandOutputFromError(error)}`);
    }
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
      await this.openSvnBaseFileDiff(vscode.Uri.file(item.fsPath), root, item.path);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`SVN diff failed: ${getCommandOutputFromError(error)}`);
      return false;
    }
  }

  private async openSvnBaseFileDiff(uri: vscode.Uri, root: string, label: string): Promise<void> {
    const baseText = await this.runSvn(['cat', '-r', 'BASE', uri.fsPath], root, { timeoutMs: 30000 });
    const diffDir = path.join(this.context.globalStorageUri.fsPath, 'svn-diff');
    await fs.mkdir(diffDir, { recursive: true });
    const ext = path.extname(uri.fsPath);
    const stem = path.basename(uri.fsPath, ext);
    const basePath = path.join(diffDir, `${toSafeFileName(stem)}-${Date.now()}.BASE${ext}`);
    await fs.writeFile(basePath, baseText, 'utf8');
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(basePath),
      uri,
      `SVN Diff: ${label || path.basename(uri.fsPath)}`
    );
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
      `${title} 鈫?${path.basename(uri.fsPath)}`
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

  // (Cursor FRE Panel 棰勮宸茬Щ闄?

  private addOrReplaceReferenceSession(session: ReferenceSession): void {
    if (!session.pinned) {
      // 瑙勫垯锛氭渶澶氫繚鐣?1 涓€滄湭鍥哄畾鈥濈殑褰撳墠缁撴灉锛涙柊鐨勬悳绱細瑕嗙洊瀹?
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

    // 鍥哄畾缁撴灉锛氬彲淇濈暀澶氭鎼滅储
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
      // 鍙栨秷鍥哄畾鍚庯紝浠嶇劧閬靛惊鈥滀粎 1 涓湭鍥哄畾缁撴灉鈥濈殑瑙勫垯
      for (let i = this.referenceSessions.length - 1; i >= 0; i--) {
        if (this.referenceSessions[i].id !== id && !this.referenceSessions[i].pinned) {
          this.referenceSessions.splice(i, 1);
        }
      }
      // 鏀惧埌鏈熬浣滀负鈥滃綋鍓嶁€?
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
          // 鍙叧蹇冪被鍨嬬鍙蜂綔涓衡€滃鍣ㄢ€?
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

    // 浼樺厛绾э細瀛楁 > 灞炴€?> 鏂规硶
    if (seenField) return 'field';
    if (seenProperty) return 'property';
    if (seenMethod) return 'method';
    return 'unknown';
  }

  private classifyFieldAccess(lineText: string, symbol: string): 'read' | 'write' | undefined {
    if (!lineText || !symbol) {
      return undefined;
    }
    // 绠€鍗曞惎鍙戝紡锛氬尮閰嶅埌鏄庢樉鍐欏叆鍒欑畻 write锛屽惁鍒欑畻 read
    // write锛歺 =, x +=, ++x, x++, x--, --x, x <<= 绛?
    // 娉ㄦ剰锛氶渶瑕佹帓闄?== 鍜?=== 姣旇緝鎿嶄綔绗?
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const writePatterns = [
      // =(?!=) 浣跨敤鍚﹀畾鍓嶇灮锛岀‘淇?= 鍚庨潰涓嶆槸 =锛屼粠鑰屾帓闄?== 鍜?===
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
    // execute*Provider 鍙兘杩斿洖 Location[] 鎴?LocationLink[]锛堢敋鑷?undefined / 娣峰悎锛?
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
      // 鍏抽敭淇锛氬厜鏍囬€氬父鍦ㄢ€滀娇鐢ㄥ鈥濓紝涓嶅湪澹版槑 range 鍐咃紝鐢ㄢ€滃悓绫绘垚鍛樺悕鈥濇帹鏂瓧娈?灞炴€?鏂规硶
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
    // 闇€姹傦細鎼滅储璁板綍涓嶆樉绀烘枃浠讹紝鍙樉绀虹被鍚?绗﹀彿鍚?
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

    // 濡傛灉缁撴灉琚埅鏂紝缁欎釜鎻愮ず
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
      // 鍏夋爣閫氬父鍦ㄢ€滀娇鐢ㄥ鈥濓紝涓嶅湪澹版槑 range 鍐咃細鐢ㄢ€滃悓绫绘垚鍛樺悕鈥濇帹鏂瓧娈?灞炴€?鏂规硶
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
    // 闇€姹傦細鎼滅储璁板綍涓嶆樉绀烘枃浠讹紝鍙樉绀虹被鍚?绗﹀彿鍚嶏紙鐢ㄤ笂鏂规ā寮忔爣绛惧尯鍒嗗紩鐢?瀹炵幇锛?
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

  // 鍙戦€佸綋鍓嶅厜鏍囪鍙峰拰鏂囦欢 URI 鍒?webview锛岀敤浜庣鍙烽潰鏉垮畾浣?
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
    
    // 鍙В鏋?C# 鏂囦欢
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
      type?: string;  // 鍙橀噺/灞炴€х殑绫诲瀷锛屾垨鍑芥暟鐨勫弬鏁?
      parentClass?: string;
    }

    const classes: SymbolItem[] = [];
    const members: SymbolItem[] = [];

    // 浣跨敤 VS Code 鍐呯疆鐨勭鍙锋彁渚涜€?
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );

      if (symbols && symbols.length > 0) {
        // 閫掑綊澶勭悊绗﹀彿
        const processSymbols = (symbolList: vscode.DocumentSymbol[], parentName?: string) => {
          for (const sym of symbolList) {
            const line = sym.range.start.line;
            const name = sym.name;
            
            // 绫诲瀷绗﹀彿
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
              // 鍛藉悕绌洪棿锛岀户缁鐞嗗瓙绗﹀彿
              if (sym.children) {
                processSymbols(sym.children, parentName);
    }
            } else if (parentName) {
              // 鎴愬憳绗﹀彿
              let kind: SymbolItem['kind'] = 'field';
              let memberName = name;
              let type = sym.detail || '';
              
              if (sym.kind === vscode.SymbolKind.Method || sym.kind === vscode.SymbolKind.Function) {
                kind = 'method';
                // name 鍙兘宸茬粡鍖呭惈鍙傛暟濡?"Method(int, string)"锛岀洿鎺ヤ娇鐢?
                type = ''; // 鏂规硶涓嶉渶瑕侀澶栫殑 type
              } else if (sym.kind === vscode.SymbolKind.Constructor) {
                kind = 'constructor';
                type = '';
              } else if (sym.kind === vscode.SymbolKind.Property) {
                kind = 'property';
                // detail 鍙兘鍖呭惈绫诲瀷淇℃伅锛屼絾涔熷彲鑳藉拰 name 鐩稿悓
              } else if (sym.kind === vscode.SymbolKind.Field || sym.kind === vscode.SymbolKind.Variable) {
                kind = 'field';
              } else if (sym.kind === vscode.SymbolKind.Event) {
                kind = 'event';
              } else if (sym.kind === vscode.SymbolKind.EnumMember) {
                kind = 'field';
                type = ''; // 鏋氫妇鎴愬憳涓嶉渶瑕佺被鍨?
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

      // 浣跨敤鎵嬪姩瑙ｆ瀽鏉ヨ幏鍙栨纭殑绫诲瀷淇℃伅
      // VS Code 绗﹀彿鎻愪緵鑰呯殑 detail 瀛楁鏍煎紡涓嶄竴鑷达紝鏃犳硶鍙潬鍦拌幏鍙栫被鍨?
      console.log('[CursorEx] Using manual parse for accurate type info');
      classes.length = 0;
      members.length = 0;
      this.parseSymbolsManually(doc, classes, members);
    } catch (e) {
      // 濡傛灉绗﹀彿鎻愪緵鑰呭け璐ワ紝浣跨敤鎵嬪姩瑙ｆ瀽
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
     * 绉婚櫎鍚屼竴琛屽唴鐨勬敞閲婏紙// 涓?/* *\/锛夛紝灏介噺閬垮厤璇激瀛楃涓?瀛楃瀛楅潰閲忋€?
     * 璇存槑锛氳繖閲屽彧澶勭悊鈥滃崟琛屽唴鈥濈殑鍧楁敞閲婏紱璺ㄨ鍧楁敞閲婁粛鐢?inMultiLineComment 閫昏緫璐熻矗銆?
     */
    const stripInlineComments = (src: string): string => {
      let out = '';
      let inStr = false; // 鏅€氬瓧绗︿覆 "..."
      let inVerbatimStr = false; // 閫愬瓧瀛楃涓?@"..."
      let inChar = false; // 瀛楃甯搁噺 'a'

      for (let idx = 0; idx < src.length; idx++) {
        const ch = src[idx];
        const next = idx + 1 < src.length ? src[idx + 1] : '';

        // 澶勭悊閫愬瓧瀛楃涓茬粨鏉燂細"" 琛ㄧず杞箟寮曞彿锛屼笉缁撴潫
        if (inVerbatimStr) {
          out += ch;
          if (ch === '"') {
            if (next === '"') {
              // "" -> 杞箟寮曞彿锛屽悶鎺変笅涓€涓?
              out += next;
              idx++;
            } else {
              inVerbatimStr = false;
            }
          }
          continue;
        }

        // 澶勭悊鏅€氬瓧绗︿覆 / 瀛楃甯搁噺
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

        // 涓嶅湪瀛楃涓?瀛楃涓細妫€娴嬫敞閲婅捣濮?
        if (ch === '/' && next === '/') {
          break; // 琛屾敞閲婏細蹇界暐鍚庣画
        }
        if (ch === '/' && next === '*') {
          // 鍚岃鍧楁敞閲婏細璺宠繃鐩村埌 */
          const end = src.indexOf('*/', idx + 2);
          if (end < 0) {
            break; // 娉ㄩ噴鍒拌灏?
          }
          idx = end + 1; // for-loop 浼氬啀 +1
          continue;
        }

        // 杩涘叆閫愬瓧瀛楃涓?@"..."
        if (ch === '@' && next === '"') {
          out += ch;
          out += next;
          idx++;
          inVerbatimStr = true;
          continue;
        }
        // 杩涘叆鏅€氬瓧绗︿覆 "..."
        if (ch === '"') {
          out += ch;
          inStr = true;
          continue;
        }
        // 杩涘叆瀛楃甯搁噺 'a'
        if (ch === '\'') {
          out += ch;
          inChar = true;
          continue;
        }

        out += ch;
      }

      return out;
    };

    // 鍖归厤绫汇€佺粨鏋勪綋銆佹帴鍙ｃ€佹灇涓?
    const classRegex = /\b(class|struct|interface|enum)\s+(\w+)/;
    // 鍖归厤鏂规硶锛堟崟鑾疯繑鍥炵被鍨嬨€佸嚱鏁板悕鍜屽弬鏁帮級
    // 鏍煎紡锛歔淇グ绗 杩斿洖绫诲瀷 鏂规硶鍚?鍙傛暟)
    const methodRegex = /^\s*(?:public|private|protected|internal|static|virtual|override|abstract|async|extern|new)\s+.*?(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*(\([^)]*\))/;
    // 鍖归厤灞炴€?- 鏍煎紡锛歔淇グ绗 绫诲瀷 灞炴€у悕 {
    const propertyRegex = /^\s*(?:public|private|protected|internal|static|virtual|override|abstract|new)\s+.*?(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*\{/;
    // 鍖归厤瀛楁 - 鏍煎紡锛歔淇グ绗 绫诲瀷 瀛楁鍚?[=|;]
    const fieldRegex = /^\s*(?:public|private|protected|internal|static|readonly|const|new)\s+.*?(\w[\w<>\[\],\.\?]*)\s+(\w+)\s*[=;]/;

    let currentClass: string | undefined;
    let currentClassKind: 'class' | 'struct' | 'interface' | 'enum' | undefined;
    let braceDepth = 0;
    let classStartDepth = 0;
    let classBodyEntered = false;  // 鏄惁宸茬粡杩涘叆绫荤殑澶ф嫭鍙峰唴閮?
    let inMultiLineComment = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      const codeLine = stripInlineComments(line);
      const trimmedCodeLine = codeLine.trim();
      
      // 璺宠繃绌鸿
      if (trimmedCodeLine === '') {
        continue;
    }

      // 澶勭悊澶氳娉ㄩ噴
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
      // 璺宠繃鍗曡娉ㄩ噴
      if (trimmedLine.startsWith('//')) {
        continue;
  }

      // 璁＄畻澶ф嫭鍙锋繁搴︼紙绠€鍗曞鐞嗭紝蹇界暐瀛楃涓蹭腑鐨勫ぇ鎷彿锛?
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

      // 璁板綍鏈鏇存柊澶ф嫭鍙锋繁搴﹀墠鐨勫眰绾э紝鐢ㄤ簬鍒ゆ柇鏄惁澶勪簬鈥滅被鍨嬮《灞傗€?
      // 杩欐牱鍙互鏀寔鏃犺闂慨楗扮鐨勬垚鍛樺０鏄庯紝鍚屾椂閬垮厤璇妸鏂规硶浣撳唴鐨勫眬閮ㄥ彉閲忓綋鎴愬瓧娈点€?
      const depthBefore = braceDepth;

      // 妫€娴嬬被瀹氫箟
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
        currentClassKind = kind;  // 淇濆瓨绫诲瀷
        classStartDepth = braceDepth;
        classBodyEntered = false;  // 杩樻病杩涘叆绫荤殑 { }
  }

      // 鏇存柊澶ф嫭鍙锋繁搴?
      braceDepth += openBraces - closeBraces;
      
      // 妫€娴嬫槸鍚﹁繘鍏ヤ簡绫荤殑澶ф嫭鍙峰唴閮?
      if (currentClass && !classBodyEntered && braceDepth > classStartDepth) {
        classBodyEntered = true;
    }
      
      // 鏋氫妇鎴愬憳妫€娴嬶紙涓嶉渶瑕佽闂慨楗扮锛?
      if (currentClass && classBodyEntered && currentClassKind === 'enum' && !classMatch) {
        // 鏋氫妇鎴愬憳鏍煎紡锛歂ame, 鎴?Name = value,
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
      
      // 鍦ㄧ被鍐呴儴妫€娴嬫垚鍛?
      const atTypeTopLevel = !!currentClass && classBodyEntered && depthBefore === classStartDepth + 1;
      
      // 妫€娴嬫垚鍛橈細宸茶繘鍏ョ被鍐呴儴锛屼笖澶勪簬绫诲瀷椤跺眰锛堜笉鍦ㄦ柟娉曚綋/璁块棶鍣ㄥ唴閮級锛屼笉鏄被瀹氫箟锛屼笉鏄灇涓撅紙鏋氫妇宸插崟鐙鐞嗭級
      if (currentClass && classBodyEntered && !classMatch && atTypeTopLevel && currentClassKind !== 'enum') {
          // 鏋勯€犲嚱鏁?- 绫诲悕鍚庣洿鎺ヨ窡鎷彿
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
          // 瀛楁 - 鏈?= 鎴?浠?缁撳熬锛堜紭鍏堟娴嬶紝閬垮厤 new Xxx() 琚鍒や负鏂规硶锛?
          // 鍖归厤鏍煎紡锛氫慨楗扮 绫诲瀷 鍙橀噺鍚?= ... 鎴?淇グ绗?绫诲瀷 鍙橀噺鍚?
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
          // 灞炴€?- 鏈?{ 浣嗘病鏈?(
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
          // 鏂规硶 - 鏈夋嫭鍙蜂絾涓嶆槸鏋勯€犲嚱鏁帮紝涓斾笉鏄瓧娈?灞炴€?
          else if (codeLine.includes('(') && codeLine.includes(')')) {
            // 鎺掗櫎甯?= new 鐨勫瓧娈靛垵濮嬪寲
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

      // 濡傛灉鍥炲埌绫诲紑濮嬬殑娣卞害锛岃鏄庣被缁撴潫浜嗭紙鍙湁鍦ㄥ凡杩涘叆绫诲唴閮ㄥ悗鎵嶆鏌ワ級
      if (currentClass && classBodyEntered && braceDepth <= classStartDepth) {
        currentClass = undefined;
        currentClassKind = undefined;
        classBodyEntered = false;
      }
    }
    
    // 鏃ュ織锛氳В鏋愮粨鏋?
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
  initQuickOpenFileLogger(context);
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

  // 鐩戝惉娲诲姩缂栬緫鍣ㄥ彉鍖栵紝閫氱煡 PinEx 楂樹寒褰撳墠鏂囦欢
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      provider.noteOpenFileRecentlyUsed(editor?.document.uri);
      // 鑻ヨ鏂囦欢宸?Pin锛屽垯鏇存柊 Pin 鐨勬渶杩戜娇鐢ㄦ椂闂?
      pinExManager.touch(editor?.document.uri);
      provider.postActiveFile(editor?.document.uri);
      provider.schedulePostOpenFiles();
    })
  );

  // 鐩戝惉缂栬緫锛堟枃鏈彉鏇达級锛氭妸鈥滄渶杩戠紪杈戔€濈殑鏂囦欢椤跺埌鏈€涓婇潰锛堣妭娴佸埛鏂板垪琛級
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

  // 鐩戝惉鍏夋爣浣嶇疆鍙樺寲锛岄€氱煡绗﹀彿闈㈡澘瀹氫綅
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

  // 鐩戝惉 Tab 鍙樺寲锛屾洿鏂版墦寮€鏂囦欢鍒楄〃
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      provider.schedulePostOpenFiles();
    })
  );

  // Hover 鎻愪緵鑰咃細鍦ㄦ湁 Comment 鐨勮涓婅繑鍥炲皪鎳夊収瀹癸紝閰嶅悎 editor.action.showHover 浣跨敤
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
        // VS Code 琛屽彿涓婁笅鏂囬€氬父鏄?1-based锛岃繖閲屽仛涓€涓嬪畨鍏ㄨ浆鎹?
        const fromCtx = args.lineNumber;
        if (fromCtx >= 1) {
          line = fromCtx - 1;
        } else if (fromCtx >= 0) {
          line = fromCtx;
        }
      }

      const uri = editor.document.uri;
      if (commentManager.hasComment(uri, line)) {
        // 宸叉湁娉ㄩ噵鍓囧埅闄?
        commentManager.removeComment(uri, line);
      } else {
        // 娌掓湁鍓囨坊鍔?/ 绶ㄨ集
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

      // 璺宠浆鍒扳€滃浐瀹氱獥鍙ｂ€濓紙渚ц竟鏍?Webview锛夊悗鍐嶅畾浣?
      try {
        await vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
      } catch {
        // ignore
      }

      // 纭繚鍒囧埌 PinEx 鍥哄畾 Tab
      provider.postSwitchPinExTab('pin');
      // 璁?PinEx 闈㈡澘灞曞紑骞舵粴鍔ㄥ埌鐩爣鏂囦欢锛堣嫢鍦ㄥ凡 PinEx 鐨勭洰褰曚腑涔熶細閫掑綊灞曞紑锛?
      provider.postPinExLocateToUri(targetUri);
    }),
    vscode.commands.registerCommand('cursorToolWindow.findReferencesEx', async () => {
      // 灏介噺鎶婁晶杈规爮灞曠ず鍑烘潵锛屾柟渚跨敤鎴风湅鍒?References Tab
      try {
        await vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
      } catch {
        // ignore
      }
      // 鑷姩璺宠浆鍒?References Tab
      provider.postSwitchPinExTab('refs');
      provider.postReferenceSearching(true);
      try {
        await provider.findReferencesExFromActiveEditor();
      } finally {
        provider.postReferenceSearching(false);
      }
    }),
    vscode.commands.registerCommand('cursorToolWindow.findImplementationsEx', async () => {
      // 灏介噺鎶婁晶杈规爮灞曠ず鍑烘潵锛屾柟渚跨敤鎴风湅鍒?References Tab
      try {
        await vscode.commands.executeCommand('cursorToolWindow.sidebar.focus');
      } catch {
        // ignore
      }
      // 鑷姩璺宠浆鍒?References Tab
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
      logQuickOpenDebug('command-trigger', { command: 'cursorToolWindow.quickOpen' });
      await showQuickOpenWindow(context, provider, pinExManager, searchIndex);
    }),
    vscode.commands.registerCommand('cursorToolWindow.quickOpenFiles', async () => {
      logQuickOpenDebug('command-trigger', { command: 'cursorToolWindow.quickOpenFiles' });
      await showQuickOpenWindow(context, provider, pinExManager, searchIndex, 'files');
    }),
    vscode.commands.registerCommand('cursorToolWindow.quickOpenClasses', async () => {
      logQuickOpenDebug('command-trigger', { command: 'cursorToolWindow.quickOpenClasses' });
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
      await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
      setTimeout(() => {
        vscode.window.showInformationMessage(
          'Search "cursorToolWindow.quickOpen" in Keyboard Shortcuts to configure Quick Open.',
          'OK'
        );
      }, 500);
    })
  );
}

let quickOpenPick: vscode.QuickPick<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; symbolKind?: string }> | undefined;
let quickOpenContext: vscode.ExtensionContext | undefined;
let quickOpenPanel: vscode.WebviewPanel | undefined;

interface QuickSearchResultItem {
  kind: 'file' | 'class' | 'content';
  label: string;
  description: string;
  uri: vscode.Uri;
  line?: number;
  pinned?: boolean;
  symbolKind?: string;
}

type QuickOpenFilterMode = 'all' | 'files' | 'classes' | 'functions';
type QuickOpenSymbolKind = 'class' | 'struct' | 'interface' | 'enum' | 'function' | 'method' | 'constructor';

const TYPE_SYMBOL_KINDS: QuickOpenSymbolKind[] = ['class', 'struct', 'interface', 'enum'];
const FUNCTION_SYMBOL_KINDS: QuickOpenSymbolKind[] = ['function', 'method', 'constructor'];

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

function isFunctionSymbolKind(kind?: string): boolean {
  return kind === 'function' || kind === 'method' || kind === 'constructor';
}

function getSymbolKindsForFilterMode(filterMode: QuickOpenFilterMode): QuickOpenSymbolKind[] | undefined {
  if (filterMode === 'classes') {
    return TYPE_SYMBOL_KINDS;
  }
  if (filterMode === 'functions') {
    return FUNCTION_SYMBOL_KINDS;
  }
  return undefined;
}

function shouldSearchFilesForFilterMode(searchMode: string, filterMode: QuickOpenFilterMode): boolean {
  return filterMode !== 'classes' && filterMode !== 'functions' && shouldSearchFiles(searchMode);
}

function shouldSearchSymbolsForFilterMode(searchMode: string, filterMode: QuickOpenFilterMode): boolean {
  return filterMode !== 'files' && shouldSearchClasses(searchMode);
}

function symbolIconForKind(kind?: string): string {
  if (kind === 'function') return 'symbol-function';
  if (kind === 'method') return 'symbol-method';
  if (kind === 'constructor') return 'symbol-constructor';
  if (kind === 'interface') return 'symbol-interface';
  if (kind === 'enum') return 'symbol-enum';
  if (kind === 'struct') return 'symbol-struct';
  return 'symbol-class';
}

function shouldSearchContent(searchMode: string): boolean {
  return searchMode === 'content';
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

let quickOpenLogFilePath: string | undefined;
let quickOpenLogWriteQueue: Promise<void> = Promise.resolve();
const QUICK_OPEN_LOG_MAX_BYTES = 2 * 1024 * 1024;

function initQuickOpenFileLogger(context: vscode.ExtensionContext): void {
  quickOpenLogFilePath = path.join(context.globalStorageUri.fsPath, 'logs', 'quick-open.log');
  logQuickOpenDebug('logger-init', {
    version: EXTENSION_VERSION,
    logFile: quickOpenLogFilePath,
    extensionPath: context.extensionPath,
    storagePath: context.globalStorageUri.fsPath
  });
}

function serializeQuickOpenLogData(data: any): string {
  if (typeof data === 'undefined') {
    return '';
  }
  try {
    return JSON.stringify(data, (_key, value) => {
      if (value instanceof vscode.Uri) {
        return value.toString();
      }
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
      }
      return value;
    });
  } catch {
    return String(data);
  }
}

function appendQuickOpenLogLine(line: string): void {
  if (!quickOpenLogFilePath) {
    return;
  }

  const targetPath = quickOpenLogFilePath;
  quickOpenLogWriteQueue = quickOpenLogWriteQueue
    .then(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      try {
        const stat = await fs.stat(targetPath);
        if (stat.size > QUICK_OPEN_LOG_MAX_BYTES) {
          await fs.rename(targetPath, `${targetPath}.old`).catch(async () => {
            await fs.unlink(targetPath).catch(() => undefined);
          });
        }
      } catch {
        // Missing log file is fine.
      }
      await fs.appendFile(targetPath, line + os.EOL, 'utf8');
    })
    .catch(err => {
      console.log('[CursorEx][QuickOpen] log-write-error:', err);
    });
}

function logQuickOpenDebug(label: string, data?: any): void {
  const payload = serializeQuickOpenLogData(data);
  appendQuickOpenLogLine(`${new Date().toISOString()} [${label}]${payload ? ' ' + payload : ''}`);

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
  maxFilesToSearch: number,
  maxContentMatches: number,
  token: vscode.CancellationToken,
  pinExManager: PinExManager
): Promise<Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }>> {
  const results: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }> = [];
  const candidateFiles = await vscode.workspace.findFiles(
    includePattern,
    excludePattern,
    getSearchResultLimit(maxFilesToSearch),
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
          description: `${fileName}:${lineIndex + 1}${isPinned ? ' P' : ''}`,
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
  pinExManager: PinExManager,
  includeSymbolKinds?: QuickOpenSymbolKind[]
): Promise<Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; symbolKind?: string }>> {
  const queryToSearch = caseSensitive ? query : query.toLowerCase();
  const results: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; symbolKind?: string }> = [];
  const seen = new Set<string>();
  const symbolKindSet = new Set(includeSymbolKinds ?? []);
  const pushResult = (name: string, uri: vscode.Uri, line: number, symbolKind: string = 'class') => {
    if (symbolKindSet.size > 0 && !symbolKindSet.has(symbolKind as QuickOpenSymbolKind)) {
      return;
    }
    const key = `${uri.toString()}:${name}:${line}:${symbolKind}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
    const isPinned = pinExManager.isPinned(uri);
    results.push({
      label: `$(${symbolIconForKind(symbolKind)}) ${name}`,
      description: `in ${fileName}${isPinned ? ' P pinned' : ''}`,
      uri: uri,
      isClass: true,
      line: line,
      symbolKind,
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
    let symbolKind = '';
    if (kind === vscode.SymbolKind.Class) {
      symbolKind = 'class';
    } else if (kind === vscode.SymbolKind.Struct) {
      symbolKind = 'struct';
    } else if (kind === vscode.SymbolKind.Interface) {
      symbolKind = 'interface';
    } else if (kind === vscode.SymbolKind.Enum) {
      symbolKind = 'enum';
    } else if (kind === vscode.SymbolKind.Function) {
      symbolKind = 'function';
    } else if (kind === vscode.SymbolKind.Method) {
      symbolKind = 'method';
    } else if (kind === vscode.SymbolKind.Constructor) {
      symbolKind = 'constructor';
    } else {
      continue;
    }
    if (symbolKindSet.size > 0 && !symbolKindSet.has(symbolKind as QuickOpenSymbolKind)) {
      continue;
    }
    if (!matchesSearchExtension(uri, searchFileExtensions) || !matchesSearchIncludeDirectories(uri, searchIncludeDirectories)) {
      continue;
    }

    const symbolNameToSearch = caseSensitive ? name : name.toLowerCase();
    const fuzzyScore = computeFilenameFuzzyScore(query, name, '');
    if (!symbolNameToSearch.includes(queryToSearch) && fuzzyScore < 0) {
      continue;
    }

    const line = (symbol.location?.range?.start?.line ?? 0) + 1;
    const key = `${uri.toString()}:${name}:${line}:${symbolKind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
    const isPinned = pinExManager.isPinned(uri);
    results.push({
      label: `$(${symbolIconForKind(symbolKind)}) ${name}`,
      description: `in ${fileName}${isPinned ? ' P pinned' : ''}`,
      uri: uri,
      isClass: true,
      line: line,
      symbolKind,
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
    const functionRegex = /\b(?:function\s+([A-Za-z_$][A-Za-z0-9_$]*)|(?:def|func)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_!?=]*)|(?:public|private|protected|internal|static|virtual|override|async|extern|sealed|abstract|partial|readonly|unsafe|final|synchronized|inline|constexpr|friend|\s)*(?:[A-Za-z_][A-Za-z0-9_:<>,\[\].?*&]*\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:\{|=>|;))/g;
    const arrowFunctionRegex = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g;
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
            const fuzzyScore = computeFilenameFuzzyScore(query, name, '');
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
              description: `in ${fileName}${isPinned ? ' P pinned' : ''}`,
              uri: uri,
              isClass: true,
              line: i + 1,
              symbolKind: match[1],
              buttons: [
                {
                  iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                  tooltip: isPinned ? 'Unpin' : 'Pin'
                }
              ]
            } as any);
          }
          functionRegex.lastIndex = 0;
          while ((match = functionRegex.exec(lines[i])) !== null) {
            const name = match[1] || match[2] || match[3];
            const symbolNameToSearch = caseSensitive ? name : name.toLowerCase();
            const fuzzyScore = computeFilenameFuzzyScore(query, name, '');
            if (!symbolNameToSearch.includes(queryToSearch) && fuzzyScore < 0) {
              continue;
            }
            pushResult(name, uri, i + 1, 'function');
          }
          arrowFunctionRegex.lastIndex = 0;
          while ((match = arrowFunctionRegex.exec(lines[i])) !== null) {
            const name = match[1];
            const symbolNameToSearch = caseSensitive ? name : name.toLowerCase();
            const fuzzyScore = computeFilenameFuzzyScore(query, name, '');
            if (!symbolNameToSearch.includes(queryToSearch) && fuzzyScore < 0) {
              continue;
            }
            pushResult(name, uri, i + 1, 'function');
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
        maxFilesToSearch,
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
    const canUseSymbolIndex = indexSnapshot.ready && indexSnapshot.symbolCount > 0;
    if (canUseSymbolIndex) {
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
          description: `${symbol.kind} in ${symbol.fileName}`,
          uri: symbol.uri,
          line: symbol.line,
          pinned: pinExManager.isPinned(symbol.uri),
          symbolKind: symbol.kind
        });
      }
    }

    if (!canUseSymbolIndex || classResults.length === 0) {
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
          pinned: pinExManager.isPinned(item.uri),
          symbolKind: (item as any).symbolKind || 'class'
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
    const key = `${item.kind}:${item.symbolKind || ''}:${item.label}:${item.uri.toString()}:${item.line || 0}`;
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
      <button class="filter-btn" data-filter="functions">Functions</button>
    </aside>
    <main class="main">
      <div class="toolbar">
        <input id="searchInput" class="search-input" type="text" placeholder="Search files, classes, and functions" />
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

    function iconFor(kind, symbolKind) {
      if (kind === 'class') {
        if (symbolKind === 'function') return 'F';
        if (symbolKind === 'method') return 'M';
        if (symbolKind === 'constructor') return 'K';
        if (symbolKind === 'interface') return 'I';
        if (symbolKind === 'enum') return 'E';
        if (symbolKind === 'struct') return 'S';
        return 'C';
      }
      if (kind === 'content') return 'T';
      return 'F';
    }

    function render() {
      const filtered = items.filter(item => {
        return matchesFilter(item);
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
          '<div class="result-icon">' + iconFor(item.kind, item.symbolKind) + '</div>' +
          '<div><div class="result-title">' + escapeHtml(item.label) + '</div><div class="result-meta">' + escapeHtml(meta || '') + '</div></div>' +
          '</div>';
      }).join('');
    }

    function isFunctionItem(item) {
      return item && (item.symbolKind === 'function' || item.symbolKind === 'method' || item.symbolKind === 'constructor');
    }

    function matchesFilter(item) {
      if (filter === 'files') return item.kind === 'file';
      if (filter === 'classes') return item.kind === 'class' && !isFunctionItem(item);
      if (filter === 'functions') return item.kind === 'class' && isFunctionItem(item);
      return true;
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
      const filtered = items.filter(item => matchesFilter(item));
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
      const filtered = items.filter(item => matchesFilter(item));
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
        pinned: !!msg.item.pinned,
        symbolKind: typeof msg.item.symbolKind === 'string' ? msg.item.symbolKind : undefined
      }, provider);
    }
  });
}

async function showQuickOpenWindow(
  context: vscode.ExtensionContext,
  provider: CursorToolSidebarProvider,
  pinExManager: PinExManager,
  searchIndex: WorkspaceSearchIndex,
  initialFilterMode: QuickOpenFilterMode = 'all'
): Promise<void> {
  const FILTER_ALL = 'all';
  const FILTER_FILES = 'files';
  const FILTER_CLASSES = 'classes';
  const FILTER_FUNCTIONS = 'functions';

  quickOpenContext = context;
  // 濡傛灉绐楀彛宸插瓨鍦紝鐩存帴鏄剧ず
  if (quickOpenPick) {
    logQuickOpenDebug('quickpick-reuse', { initialFilterMode });
    quickOpenPick.show();
    return;
  }

  logQuickOpenDebug('quickpick-create', {
    initialFilterMode,
    version: EXTENSION_VERSION,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath)
  });
  const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; symbolKind?: string }>();
  quickOpenPick = quickPick;
  let resultFilterMode: QuickOpenFilterMode = initialFilterMode;
  const filterButtons: vscode.QuickInputButton[] = [
    { iconPath: new vscode.ThemeIcon('list-filter'), tooltip: 'Show all results' },
    { iconPath: new vscode.ThemeIcon('file'), tooltip: 'Show file results only' },
    { iconPath: new vscode.ThemeIcon('symbol-class'), tooltip: 'Show class/type results only' },
    { iconPath: new vscode.ThemeIcon('symbol-function'), tooltip: 'Show function/method results only' }
  ];
  
  quickPick.placeholder = 'Search cached files, classes, and functions. Shortcuts: /f files, /c classes, /m functions, /a all';
  quickPick.matchOnDescription = true;
  quickPick.buttons = filterButtons;

  const updateQuickPickTitle = () => {
    const suffix = resultFilterMode === FILTER_FILES
      ? 'Files'
      : resultFilterMode === FILTER_CLASSES
        ? 'Classes'
        : resultFilterMode === FILTER_FUNCTIONS
          ? 'Functions'
          : 'All';
    quickPick.title = `Cursor Tools Search [${suffix}]`;
  };

  updateQuickPickTitle();
  
  // 浠?workspaceState 璇诲彇淇濆瓨鐨勭獥鍙ｅ昂瀵稿亸濂斤紙鐢ㄤ簬鏈潵鍙兘鐨勮嚜瀹氫箟绐楀彛锛?
  const savedSize = context.workspaceState.get<{ width: number; height: number }>('cursorToolWindow.quickOpen.size', { width: 800, height: 600 });
  
  // 娉ㄦ剰锛歏S Code 鐨?QuickPick 楂樺害鏄嚜鍔ㄨ绠楃殑锛屾棤娉曠洿鎺ユ帶鍒?
  // 浣嗘垜浠彲浠ラ€氳繃璁剧疆鏇村鐨?items 鏉ヨ绐楀彛鑷姩鍙橀珮

  // 鑾峰彇鎵撳紑鐨勬枃浠讹紙鎸?MRU 鎺掑簭锛?
  const openFiles = provider.getOpenFilesSorted();
  
  // 鑾峰彇鎵€鏈?PinEx 鐨勬枃浠讹紙鎺掗櫎鐩綍锛屽彧鏄剧ず鏂囦欢锛?
  const pinnedItems = pinExManager.getItemsSortedByRecent();
  const pinnedFiles = pinnedItems.filter(item => !item.isDirectory);

  // 鍒涘缓 URI 闆嗗悎锛岀敤浜庡幓閲?
  const openFileUris = new Set<string>();
  openFiles.forEach(f => openFileUris.add(f.uri.toString()));

  // 杞崲涓?QuickPickItem锛屽苟闄勫姞 URI锛堜笉鏄剧ず璺緞锛?
  const items: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; symbolKind?: string }> = [];
  
  // 1. 鍏堟坊鍔犳墦寮€鐨勬枃浠?
  openFiles.forEach(file => {
    const isPinned = pinExManager.isPinned(file.uri);
    const item: vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean } = {
      label: `$(file) ${file.name}`,
      description: file.isActive ? 'recently opened' : (isPinned ? 'P pinned' : ''),
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
  
  // 2. 鍐嶆坊鍔犳湭鎵撳紑鐨?PinEx 鏂囦欢
  pinnedFiles.forEach(pinnedItem => {
    const uriStr = pinnedItem.uri.toString();
    if (!openFileUris.has(uriStr)) {
      const name = pinnedItem.uri.fsPath.split(/[\\/]/).pop() || uriStr;
      const item: vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean } = {
        label: `$(file) ${name}`,
        description: 'P pinned',
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

  // 璇诲彇閰嶇疆鐨勬渶澶ф樉绀洪」鐩暟
  const config = vscode.workspace.getConfiguration('cursorToolWindow');
  const maxItems = config.get<number>('quickOpen.maxItems', 50);
  
  // 闄愬埗榛樿鏄剧ず鐨勯」鐩暟閲忥紙浣嗕繚鎸佹墍鏈夐」鐩敤浜庢悳绱級
  const displayItems = items.slice(0, Math.min(maxItems, items.length));
  
  quickPick.items = displayItems;
  if (displayItems.length > 0) {
    quickPick.activeItems = [displayItems[0]]; // 榛樿閫変腑绗竴涓?
  }

  let searchCancellationToken: vscode.CancellationTokenSource | null = null;
  let searchDebounceTimer: NodeJS.Timeout | null = null;

  // 鐩戝惉杈撳叆鍙樺寲锛屾悳绱㈠伐浣滃尯鏂囦欢鍜岀被
  quickPick.onDidChangeValue(async (value) => {
    // 鍙栨秷涔嬪墠鐨勬悳绱?
    if (searchCancellationToken) {
      searchCancellationToken.cancel();
      searchCancellationToken.dispose();
      searchCancellationToken = null;
    }
    
    // 娓呴櫎涔嬪墠鐨勯槻鎶栬鏃跺櫒
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
    } else if (query.startsWith('/m ') || query.startsWith('/fn ')) {
      resultFilterMode = FILTER_FUNCTIONS;
      query = query.startsWith('/m ') ? query.substring(3).trim() : query.substring(4).trim();
      updateQuickPickTitle();
    } else if (query === '/m' || query === '/fn') {
      resultFilterMode = FILTER_FUNCTIONS;
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
      // 鏃犺緭鍏ユ椂鏄剧ず鎵撳紑鐨勬枃浠讹紙闄愬埗鏁伴噺锛?
      const config = vscode.workspace.getConfiguration('cursorToolWindow');
      const maxItems = config.get<number>('quickOpen.maxItems', 50);
      const displayItems = items.slice(0, Math.min(maxItems, items.length));
      quickPick.items = displayItems;
      if (displayItems.length > 0) {
        quickPick.activeItems = [displayItems[0]];
      }
      return;
    }

    // 璇诲彇鎼滅储閰嶇疆
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

    // 浣跨敤闃叉姈寤惰繜鎼滅储
    searchDebounceTimer = setTimeout(async () => {
      searchCancellationToken = new vscode.CancellationTokenSource();
      const token = searchCancellationToken.token;
      
      try {
        quickPick.busy = true;
        
        const allResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }> = [];
        const fileResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean }> = [];
        const contentResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; isContent?: boolean }> = [];
        const classResults: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; line?: number; symbolKind?: string }> = [];

        // 鏋勫缓鏂囦欢鎼滅储妯″紡
        const includePattern = buildSearchIncludePattern(searchIncludeDirectories, searchFileExtensions);

        // 鏋勫缓鎺掗櫎妯″紡
        const excludePattern = searchExcludeDirectories.length > 0 
          ? `{${searchExcludeDirectories.join(',')}}` 
          : '**/node_modules/**';

        logQuickOpenDebug('patterns', { includePattern, excludePattern });

        const indexSnapshot = searchIndex.getSnapshot();
        const shouldQueryFiles = shouldSearchFilesForFilterMode(searchMode, resultFilterMode);
        const shouldQuerySymbols = shouldSearchSymbolsForFilterMode(searchMode, resultFilterMode);
        const symbolKinds = getSymbolKindsForFilterMode(resultFilterMode);
        let candidateFiles: vscode.Uri[] = [];
        if (shouldQueryFiles && (!indexSnapshot.ready || indexSnapshot.fileCount === 0)) {
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

        if (shouldQuerySymbols && !token.isCancellationRequested) {
          const canUseSymbolIndex = indexSnapshot.ready && indexSnapshot.symbolCount > 0;
          if (canUseSymbolIndex) {
            const indexedSymbols = await searchIndex.querySymbols(query, {
              limit: maxItems,
              includeExtensions: searchFileExtensions,
              includeDirectories: searchIncludeDirectories,
              caseSensitive,
              includeSymbolKinds: symbolKinds
            });

            for (const symbol of indexedSymbols) {
              const isPinned = pinExManager.isPinned(symbol.uri);
              classResults.push({
                label: `$(${symbolIconForKind(symbol.kind)}) ${symbol.name}`,
                description: `${symbol.kind} in ${symbol.fileName}${isPinned ? ' pinned' : ''}`,
                uri: symbol.uri,
                isClass: true,
                line: symbol.line,
                symbolKind: symbol.kind,
                buttons: [
                  {
                    iconPath: new vscode.ThemeIcon(isPinned ? 'pinned' : 'pin'),
                    tooltip: isPinned ? 'Unpin' : 'Pin'
                  }
                ]
              } as any);
            }
          }

          if (!canUseSymbolIndex || classResults.length === 0) {
            const workspaceClassResults = await searchWorkspaceClasses(
              query,
              caseSensitive,
              searchFileExtensions,
              searchIncludeDirectories,
              maxItems,
              pinExManager,
              symbolKinds
            );
            classResults.push(...workspaceClassResults);
          }
          logQuickOpenDebug('class-results', {
            count: classResults.length,
            sample: classResults.slice(0, 5).map(i => ({ label: i.label, file: i.uri?.fsPath, line: (i as any).line }))
          });
        }

        if (token.isCancellationRequested) return;

        // 1. 鎼滅储鏂囦欢鍚嶏紙濡傛灉鎼滅储妯″紡鍖呭惈鏂囦欢鍚嶏級
        if (shouldQueryFiles) {
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
              description: isOpen ? 'recently opened' : (isPinned ? 'P pinned' : ''),
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

        // 2. 鎼滅储鏂囦欢鍐呭锛堝鏋滄悳绱㈡ā寮忓寘鍚唴瀹癸級
        if (shouldSearchContent(searchMode) && !token.isCancellationRequested) {
          try {
            const workspaceContentResults = await searchWorkspaceText(
              query,
              caseSensitive,
              includePattern,
              excludePattern,
              maxFilesToSearch,
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

        if (false && (searchMode === 'content' || searchMode === 'all')) {
          const filesToSearch = candidateFiles.filter(uri =>
            matchesSearchExtension(uri, searchFileExtensions) &&
            matchesSearchIncludeDirectories(uri, searchIncludeDirectories)
          );

          // 鍦ㄦ枃浠朵腑鎼滅储鍐呭
          let contentMatchCount = 0;
          const queryToSearch = caseSensitive ? query : query.toLowerCase();
          
          for (const uri of filesToSearch) {
            if (token.isCancellationRequested || contentMatchCount >= maxContentMatches) break;
            
            try {
              const text = await readFileText(uri);
              
              // 鏌ユ壘鎵€鏈夊尮閰?
              const lines = text.split('\n');
              
              for (let lineIndex = 0; lineIndex < lines.length && contentMatchCount < maxContentMatches; lineIndex++) {
                const line = lines[lineIndex];
                const lineToSearch = caseSensitive ? line : line.toLowerCase();
                
                if (lineToSearch.includes(queryToSearch)) {
                  const fileName = uri.fsPath.split(/[\\/]/).pop() || uri.toString();
                  const isPinned = pinExManager.isPinned(uri);
                  
                  // 鑾峰彇棰勮琛?
                  let previewText = line.trim();
                  if (previewText.length > 80) {
                    previewText = previewText.substring(0, 77) + '...';
                  }
                  
                  // 妫€鏌ユ槸鍚﹀凡缁忔湁鐩稿悓鏂囦欢鐨勭浉鍚岃
                  const existingIndex = contentResults.findIndex(r => 
                    r.uri?.toString() === uri.toString() && (r as any).line === lineIndex + 1
                  );
                  
                  if (existingIndex === -1) {
                    contentResults.push({
                      label: `$(search) ${previewText}`,
                      description: `${fileName}:${lineIndex + 1}${isPinned ? ' P' : ''}`,
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
              
              // 鍚屾椂鎼滅储绫伙紙绗﹀彿锛?
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
                      
                      // 妫€鏌ユ槸鍚﹀凡缁忓瓨鍦?
                      const existingClass = classResults.find(r => 
                        r.uri?.toString() === uri.toString() && r.label.includes(symbol.name)
                      );
                      
                      if (!existingClass) {
                        classResults.push({
                          label: `$(symbol-class) ${symbol.name}`,
                          description: `in ${fileName}${isPinned ? ' P pinned' : ''}`,
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
              // 蹇界暐鏃犳硶璇诲彇鐨勬枃浠?
            }
          }
        }

        if (token.isCancellationRequested) return;

        // 鎸夋悳绱㈡ā寮忓悎骞剁粨鏋滐紝閬垮厤 Class Only 浠嶇劧娣峰叆鏂囦欢缁撴灉
        const finalResults = searchMode === 'fileclass'
          ? [
              ...(shouldQueryFiles ? fileResults : []),
              ...(shouldQuerySymbols ? classResults : []),
              ...(shouldSearchContent(searchMode) ? contentResults : [])
            ]
          : [
              ...(shouldQuerySymbols ? classResults : []),
              ...(shouldQueryFiles ? fileResults : []),
              ...(shouldSearchContent(searchMode) ? contentResults : [])
            ];
        
        // 鍘婚噸锛堝熀浜?URI + line锛?
        const seen = new Set<string>();
        const uniqueResults = finalResults.filter(item => {
          const key = `${item.uri?.toString() || ''}:${(item as any).line || 0}:${item.isClass || false}:${(item as any).symbolKind || ''}:${item.label}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        
        const filteredResults = uniqueResults.filter(item => {
          if (resultFilterMode === FILTER_FILES) {
            return !item.isClass && !(item as any).isContent;
          }
          if (resultFilterMode === FILTER_CLASSES) {
            return !!item.isClass && !isFunctionSymbolKind((item as any).symbolKind);
          }
          if (resultFilterMode === FILTER_FUNCTIONS) {
            return !!item.isClass && isFunctionSymbolKind((item as any).symbolKind);
          }
          return true;
        });

        // 闄愬埗缁撴灉鏁伴噺
        const limitedResults = filteredResults.slice(0, maxItems);
        const limitedDefaultItems = items.slice(0, Math.min(maxItems, items.length));

        logQuickOpenDebug('final-results', {
          total: finalResults.length,
          unique: uniqueResults.length,
          filtered: filteredResults.length,
          limited: limitedResults.length,
          filterMode: resultFilterMode,
          sample: limitedResults.slice(0, 10).map(i => ({
            label: i.label,
            description: i.description,
            file: i.uri?.fsPath,
            line: (i as any).line,
            isClass: (i as any).isClass,
            isContent: (i as any).isContent,
            symbolKind: (i as any).symbolKind
          }))
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
        logQuickOpenDebug('search-error', err);
        if (err instanceof Error && err.name !== 'Canceled') {
          console.error('[CursorEx] QuickOpen search error:', err);
        }
      }
    }, debounceDelay);
  });

  // 澶勭悊鎸夐挳鐐瑰嚮锛圥in/Unpin锛?
  quickPick.onDidTriggerButton(button => {
    if (button === filterButtons[0]) {
      resultFilterMode = FILTER_ALL;
    } else if (button === filterButtons[1]) {
      resultFilterMode = FILTER_FILES;
    } else if (button === filterButtons[2]) {
      resultFilterMode = FILTER_CLASSES;
    } else if (button === filterButtons[3]) {
      resultFilterMode = FILTER_FUNCTIONS;
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

  // 澶勭悊鎸夐挳鐐瑰嚮锛圥in/Unpin锛?
  quickPick.onDidTriggerItemButton(async (e) => {
    const item = e.item;
    const itemUri = item.uri;
    if (!itemUri || !quickOpenContext) {
      return;
    }
    
    await pinExManager.togglePin(itemUri);
    
    // 鐩存帴鏇存柊褰撳墠鍒楄〃锛屼笉鍏抽棴绐楀彛
    const currentValue = quickPick.value;
    const isPinned = pinExManager.isPinned(itemUri);
    const itemUriStr = itemUri.toString();
    
    // 鏇存柊褰撳墠椤圭殑鎸夐挳鐘舵€?
    const currentItems = quickPick.items;
    const updatedItems = currentItems.map(i => {
      const iUri = i.uri;
      if (iUri && iUri.toString() === itemUriStr) {
        const isClass = (i as any).isClass;
        const isActive = i.label.includes('$(circle-filled)');
        let newDescription = '';
        if (isClass) {
          newDescription = (i.description || '').replace(/P pinned/g, '').trim();
          if (isPinned) {
            newDescription += ' P pinned';
          }
        } else {
          if (isActive) {
            newDescription = 'recently opened';
          }
          if (isPinned) {
            newDescription += (newDescription ? ' ' : '') + 'P pinned';
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
    
    // 濡傛灉鏈夋悳绱㈠€硷紝閲嶆柊瑙﹀彂鎼滅储浠ユ洿鏂板垪琛?
    if (currentValue.trim()) {
      // 瑙﹀彂鎼滅储鏇存柊
      quickPick.value = currentValue + ' '; // 娣诲姞绌烘牸瑙﹀彂鏇存柊
      setTimeout(() => {
        quickPick.value = currentValue; // 鎭㈠鍘熷€?
      }, 10);
    } else {
      // 鏃犳悳绱㈡椂锛岄噸鏂版瀯寤洪粯璁ゅ垪琛?
      const openFiles = provider.getOpenFilesSorted();
      const pinnedItems = pinExManager.getItemsSortedByRecent();
      const pinnedFiles = pinnedItems.filter(pItem => !pItem.isDirectory);
      const openFileUris = new Set<string>();
      openFiles.forEach(f => openFileUris.add(f.uri.toString()));
      
      const newItems: Array<vscode.QuickPickItem & { uri?: vscode.Uri; isClass?: boolean; symbolKind?: string }> = [];
      
      openFiles.forEach(file => {
        const isPinnedFile = pinExManager.isPinned(file.uri);
        newItems.push({
          label: `$(file) ${file.name}`,
          description: file.isActive ? 'recently opened' : (isPinnedFile ? 'P pinned' : ''),
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
            description: 'P pinned',
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

  // 澶勭悊閫夋嫨
  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected || !selected.uri) {
      logQuickOpenDebug('accept-empty');
      return;
    }

    const targetUri = selected.uri;
    logQuickOpenDebug('accept-item', {
      label: selected.label,
      description: selected.description,
      uri: targetUri.fsPath,
      line: (selected as any).line,
      isClass: (selected as any).isClass,
      isContent: (selected as any).isContent,
      symbolKind: (selected as any).symbolKind
    });

    // 鏇存柊 MRU
    provider.noteOpenFileRecentlyUsed(targetUri);
    
    // 鎵撳紑鏂囦欢
    try {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      
      // 鑾峰彇琛屽彿锛堢被銆佸唴瀹规悳绱㈢粨鏋滈兘鍙兘鏈夎鍙凤級
      let targetLine: number | undefined;
      
      // 浼樺厛浣跨敤鐩存帴瀛樺偍鐨?line 灞炴€?
      if (typeof (selected as any).line === 'number') {
        targetLine = (selected as any).line - 1; // 杞崲涓?0-based
      } else if ((selected as any).detail) {
        // 浠?detail 涓В鏋愯鍙?
        const lineMatch = (selected as any).detail.match(/Line (\d+)/);
        if (lineMatch) {
          targetLine = parseInt(lineMatch[1], 10) - 1;
        }
      }
      
      // 璺宠浆鍒版寚瀹氳
      if (typeof targetLine === 'number' && targetLine >= 0) {
        const position = new vscode.Position(targetLine, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch (err) {
      logQuickOpenDebug('accept-error', err);
    }

    quickPick.dispose();
  });

  quickPick.onDidHide(() => {
    logQuickOpenDebug('quickpick-hide');
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

  // 灏濊瘯閫氳繃璁剧疆鏇村椤圭洰鏉ュ鍔犻粯璁ら珮搴?
  // VS Code 鐨?QuickPick 浼氭牴鎹」鐩暟閲忚嚜鍔ㄨ皟鏁撮珮搴?
  // 鎴戜滑鍙互閫氳繃澧炲姞榛樿鏄剧ず鐨勯」鐩暟閲忔潵璁╃獥鍙ｆ洿楂?
  // 浣?QuickPick 鏈韩涓嶆敮鎸佽嚜瀹氫箟楂樺害锛屾墍浠ヨ繖閲屾垜浠繚鎸佸師鏈夐€昏緫
  // 濡傛灉鐢ㄦ埛闇€瑕佹洿澶х殑绐楀彛锛屽彲浠ラ€氳繃鎼滅储鏉ユ樉绀烘洿澶氱粨鏋?

  quickPick.show();
}

export function deactivate() {
  // 鐒￠渶鐗规畩娓呯悊
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
    // 妫€鏌ユ枃浠舵槸鍚︽槸鐩綍
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      // 濡傛灉鏄洰褰曪紝鍦ㄨ祫婧愮鐞嗗櫒涓樉绀?
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    // 鎵撳紑鏂囦欢锛屼笉鏀瑰彉鍏夋爣浣嶇疆锛圴S Code 浼氳嚜鍔ㄦ仮澶嶄笂娆′綅缃級
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
    /* 婊氬姩鏉★細榛樿闅愯棌锛涗粎褰撳墠婊氬姩鍖哄煙(瀹瑰櫒)婵€娲绘椂鏄剧ず */
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
    /* 寮曠敤锛圧eferences锛夐潰鏉挎牱寮?*/
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
    /* 鎼滅储涓細鍦ㄤ腑闂村垎闅旀潯鏄剧ず钃濊壊杩涘害鍔ㄧ敾 */
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
      /* 榛樿鍗婇€忔槑锛堟湭鍥哄畾锛?*/
      opacity: 0.5;
      transition: opacity 0.15s, transform 0.15s, color 0.15s;
      transform: none;
    }
    .refs-session-pin:hover {
      opacity: 1;
      color: var(--accent);
    }
    .refs-session-pin.pinned {
      /* 鍥哄畾鍚庯細涓嶉€忔槑 + 鏃嬭浆瑙掑害鍙傝€?PinEx 鍥哄畾鍥炬爣 */
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
    /* 棰勮鏀逛负 VS Code 鍘熺敓 Peek锛堜笉鍐嶇敤 Webview 娴眰锛?*/
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
    /* 绗﹀彿闈㈡澘鏍峰紡 */
    .symbol-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-size: var(--pinex-font-size);
    }
    .symbol-search-toolbar {
      flex: 0 0 auto;
      padding: 4px 6px;
      border-bottom: 1px solid var(--border);
      background: #1b1b1b;
    }
    .symbol-search-toolbar .search-input {
      width: 100%;
      height: 24px;
      font-size: calc(var(--pinex-font-size, var(--font-size-base)) * 0.86);
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
      background: #1b1b1b; /* 涓?section 鑳屾櫙涓€鑷达紝閬垮厤鍗婇€忔槑閫犳垚鈥滈鑹蹭笉涓€鑷粹€?*/
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
    /* 鎴愬憳绛涢€夋寜閽細婵€娲绘€佹寜绫诲瀷閰嶈壊锛堜笌鍥炬爣涓€鑷达級 */
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
    .symbol-match {
      color: #ffffff;
      background: rgba(255, 193, 7, 0.42);
      border-radius: 2px;
      padding: 0 1px;
      font-weight: 700;
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
          <span class="section-chevron">-</span>
          <span class="section-title">TODO</span>
          <span class="scanning-indicator" id="todo-scanning" style="display:none;">* Scanning...</span>
          <div class="todo-header-toolbar">
            <span class="search-wrapper">
            <input class="search-input" id="search-input" type="text" placeholder="Search TODO..." />
              <span class="search-clear" id="search-clear-btn" title="Clear">x</span>
            </span>
            <button class="todo-toggle-files" id="toggle-files-btn">Hide</button>
          </div>
          <span class="section-actions">
            <button class="section-move-btn" data-card="todo" data-move="up">鈫?/button>
            <button class="section-move-btn" data-card="todo" data-move="down">鈫?/button>
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
              <button class="pinex-toolbar-icon" id="svn-expand-tree-btn-inline" title="Expand SVN tree">+</button>
              <button class="pinex-toolbar-icon" id="svn-collapse-tree-btn-inline" title="Collapse SVN tree">-</button>
              <button class="pinex-toolbar-icon" id="svn-toggle-unversioned-btn-inline" title="Hide unversioned files">Unversioned: On</button>
            </div>
            <div class="p4-panel scroll-area" id="svn-panel"></div>
          </div>
          <div class="vcs-context-menu" id="svn-context-menu"></div>
          <div class="pinex-tab-content" id="pinex-symbol-content">
            <div class="symbol-panel">
              <div class="symbol-class-list scroll-area" id="symbol-class-list"></div>
              <div class="symbol-resizer" id="symbol-resizer"></div>
              <div class="symbol-search-toolbar">
                <input class="search-input" id="symbol-search-input-inline" type="text" placeholder="Search members..." />
              </div>
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

      function reportWebviewError(message, source, line, column, stack) {
        try {
          vscode.postMessage({
            type: 'logWebviewError',
            message: message ? String(message) : 'unknown',
            source: source ? String(source) : '',
            line: typeof line === 'number' ? line : 0,
            column: typeof column === 'number' ? column : 0,
            stack: stack ? String(stack) : ''
          });
        } catch (_) {
          // ignore
        }
      }

      window.addEventListener('error', function (event) {
        var error = event && event.error ? event.error : null;
        reportWebviewError(
          event && event.message,
          event && event.filename,
          event && event.lineno,
          event && event.colno,
          error && error.stack
        );
      });

      window.addEventListener('unhandledrejection', function (event) {
        var reason = event && event.reason;
        reportWebviewError(
          reason && reason.message ? reason.message : reason,
          'unhandledrejection',
          0,
          0,
          reason && reason.stack
        );
      });

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

      // 榛樿闅愯棌锛氬彧鍦ㄥ綋鍓嶆粴鍔ㄥ尯鍩熻 hover/鐐瑰嚮/鑱氱劍鏃舵樉绀?
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

      // 鐐瑰嚮鏃朵粎鐐逛寒鈥滅洰鏍囨墍鍦ㄢ€濈殑婊氬姩鍖哄煙锛堣€屼笉鏄叏灞€閮芥樉绀猴級
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

      // Webview 澶辩劍鏃跺叏閮ㄩ殣钘?
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
      var symbolSearchInput = document.getElementById('symbol-search-input-inline');
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

      /** 鍗＄墖瀹氱京琛紝鐢ㄦ柤鎻忚堪鎵€鏈夐€氱敤鍗＄墖 */
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
      var symbolFilterText = '';
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
      var refsSessionHeight = 140; // References 椤堕儴鈥滀細璇濆垪琛ㄢ€濋粯璁ら珮搴?
      var refsAccessFilter = 'all'; // all | read | write 锛堜粎瀛楁鏌ヨ鏃剁敓鏁堬級
      var refsMethodFilter = 'all'; // all | calls 锛堜粎鏂规硶寮曠敤鏃剁敓鏁堬級
      var refsSearching = false;
      var refsSelectedBySession = {};
      var refsVisibleCountBySession = {};
      var p4Snapshot = { available: false, status: 'Loading P4...', clientName: '', clientRoot: '', opened: [], pendingChanges: [], updatedAt: 0 };
      var svnSnapshot = { available: false, status: 'Loading SVN...', workingCopyRoot: '', scopePath: '', scopeLabel: '', url: '', revision: '', items: [], updatedAt: 0 };
      var vcsProvider = 'auto';
      var showP4Tab = true;
      var showSvnTab = true;
      var showSvnUnversioned = true;

      setPinExBootStatus('boot: state vars ready');

      if (pinExDebugBar) {
        pinExDebugBar.textContent = 'debug bootstrapped';
      }

      // 瀹夊叏鍦版仮寰╃媭鎱嬶紝濡傛灉鍑洪尟鍓囦娇鐢ㄩ粯瑾嶅€?
      try {
        var state = (vscode.getState && vscode.getState()) || {};
        if (state && typeof state === 'object') {
          // 閫氱敤绲愭鍎厛
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
            // 鑸婄増鏈媭鎱嬮伔绉伙細todoOnTop + 鍥哄畾 COMMENT + 鏂板 PinEx 鍗＄墖
            cardOrder = state.todoOnTop
              ? ['todo', 'note', 'pinex']
              : ['note', 'todo', 'pinex'];
          }
          // 鑸婂瓧娈甸伔绉伙細鎶樼枈鐙€鎱嬭垏楂樺害
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
      if (typeof state.symbolFilterText === 'string') {
        symbolFilterText = state.symbolFilterText;
        if (symbolSearchInput) {
          symbolSearchInput.value = symbolFilterText;
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

      // 鐐烘墍鏈夊凡鐭ュ崱鐗囪榻婇粯瑾嶆姌鐤婄媭鎱嬭垏楂樺害锛岄伩鍏嶆柊澧炲崱鐗囨檪鍒拌檿鏀瑰垵濮嬪寲浠ｇ⒓
      cardIds.forEach(function (id) {
        if (typeof cardCollapsed[id] !== 'boolean') {
          cardCollapsed[id] = false;
        }
        if (typeof cardHeights[id] !== 'number') {
          cardHeights[id] = 220;
        }
      });

      // 纰轰繚 cardOrder 鏄湁鏁堢殑鏁哥祫涓斿寘鍚墍鏈夊崱鐗?
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
          symbolFilterText: symbolFilterText,
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
        svnToggleUnversionedBtn.textContent = showSvnUnversioned ? 'Unversioned: On' : 'Unversioned: Off';
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
        
        // 鍏堟噳鐢ㄩ厤缃殑鍏у閬庢烤鍣?
        var baseList = cfKeyword
          ? allTodos.filter(function(t) { return t.text.toLowerCase().indexOf(cfKeyword) >= 0; })
          : allTodos.slice();
        
        // 鍐嶆噳鐢ㄦ悳绱㈡鐨勯亷婵?
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

        // TODO 鍏у璁婃洿寰岋紝鏍规摎瀵﹂殯鍏у楂樺害鑷嫊瑾挎暣鍗＄墖楂樺害鑸囦綀灞€
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
          // 鍙’绀烘枃浠跺悕锛屼笉椤ず瀹屾暣璺緫
          var fileName = c.file || '';
          var normalizedPath = fileName.replace(/\\\\/g, '/');
          var lastSlash = normalizedPath.lastIndexOf('/');
          var baseName = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : fileName;
          textSpan.textContent = (baseName ? '[' + baseName + '] ' : '') + c.text;

          var delSpan = document.createElement('span');
          delSpan.className = 'comment-delete';
          delSpan.textContent = 'x';
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

        // 鍒楄〃鍏у璁婃洿寰岋紝鍚屾鍗＄墖楂樺害
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
          chevron.textContent = cardCollapsed[key] ? '+' : '-';
        });

        // 鎶樼枈 / 灞曢枊 涔嬪緦锛屽悓姝ラ噸鏂拌▓绠楁嚫娴崱鐗囬珮搴﹁垏浣嶇疆
        applyHeights();
      }

      window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || typeof message.type !== 'string') return;
        // 閫氱敤娑堟伅鏃ュ織
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
          renderOpenFiles(); // 鏇存柊鎵撻枊鏂囦欢鍒楄〃鐨勫浐瀹氱媭鎱?
          // 濡傛灉鏈夊緟澶勭悊鐨勫畾浣嶈姹傦紝PinEx 鏁版嵁鍒拌揪鍚庡啀灏濊瘯涓€娆?
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
          // 闈㈡澘鐙珛瀛椾綋澶у皬锛? 琛ㄧず浣跨敤鍏ㄥ眬璁剧疆锛?
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
          // 濡傛灉褰撳墠鏄鍙?Tab锛岃嚜鍔ㄥ埛鏂扮鍙锋暟鎹?
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
          // 鑻ヨ檿鏂笺€屽叏閮ㄥ睍闁嬨€嶆ā寮忥紝灏嶆柊鐛插彇鐨勫瓙鐩寗绻肩簩閬炴灞曢枊
          if (pinExExpandAllRequested) {
            message.items.forEach(function (c) {
              if (c && c.isDirectory) {
                expandPinExDirRecursive(c.uri);
              }
            });
          }
          renderPinEx();
          // 濡傛灉姝ｅ湪閫茶瀹氫綅鎿嶄綔锛岀辜绾屽槜瑭﹀畾浣?
          if (pinExLocatePending) {
            setTimeout(function() { tryLocateActivePinEx(); }, 50);
          }
        } else if (message.type === 'pinExFsChanged') {
          // 宸ョ▼鏂囦欢绯荤当璁婃洿鏅傦紝灏嶆墍鏈夊凡灞曢枊鐨勭洰閷勯噸鏂拌珛姹傚瓙闋?
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
          // 澶栭儴鍛戒护锛氳烦杞埌鍥哄畾绐楀彛鍚庯紝璁?PinEx 闈㈡澘瀹氫綅鍒版寚瀹氭枃浠?
          pinExLocatePending = true;
          pinExLocateTargetUri = message.uri;
          // 缁熶竴鍦ㄢ€滃浐瀹氣€漈ab 鍐呭畾浣?
          if (pinExActiveTab !== 'pin') {
            switchPinExTab('pin');
          }
          // 绛夊緟棣栨 PinEx 鏁版嵁鍒拌揪鍚庡啀鎵ц锛堥伩鍏嶅垵濮嬪寲闃舵鐩存帴娓呯┖ pending锛?
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
          // 濡傛灉涔嬪墠閫変腑鐨勭被涓嶅湪鏂板垪琛ㄤ腑锛岄噸缃?
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
          // 榛樿閫変腑绗竴涓被
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
            // 鍙湁褰撳墠鏂囦欢涓庣鍙锋暟鎹枃浠跺尮閰嶆椂鎵嶅畾浣?
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
          // 鑻?COMMENT 鍗€濉婅檿鏂兼敹璧风媭鎱嬶紝鐐轰簡鑳界湅鍒伴珮浜爡锛岃嚜鍕曞睍闁?
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
          // 濡傛灉鍦ㄥ浐瀹?Tab 涓旀湁鎼滅储鍏抽敭瀛楋紝鑷姩鍔犺浇鎵€鏈夌洰褰曠殑瀛愰」
          if (pinExFilterText && pinExActiveTab === 'pin') {
            var dirs = allPinEx.filter(function (x) { return !!x.isDirectory; });
            dirs.forEach(function (d) {
              expandPinExDirRecursive(d.uri);
            });
          }
          // 鏍规摎鐣跺墠 Tab 娓叉煋
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

      // 娓呯┖鎼滅储鎸夐挳浜嬩欢
      if (symbolSearchInput) {
        symbolSearchInput.addEventListener('input', function () {
          symbolFilterText = (symbolSearchInput.value || '').trim();
          persistState();
          renderSymbols();
        });
      }
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
          // 鐩存帴娓呯┖鎵€鏈夎绱氭敞閲嬶紙涓嶅啀浣跨敤鐎忚鍣?confirm锛岄伩鍏嶅湪閮ㄥ垎鐠板涓鏀旀埅锛?
          // 閫氱煡鎿村睍绔竻鐞嗘墍鏈夋敞閲?
          vscode.postMessage({ type: 'deleteAllComments' });
          // 鍚屾鏇存柊鍓嶇鐙€鎱嬶紝绔嬪嵆鍙嶆槧鍒?UI
          allComments = [];
          activeCommentKey = null;
          renderComments();
        });
      }

      function highlightActivePinEx() {
        // 楂樹寒鍥哄畾鍒楄〃涓殑娲诲嫊鏂囦欢
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
        // 楂樹寒鎵撻枊鏂囦欢鍒楄〃涓殑娲诲嫊鏂囦欢
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

        // 妾㈡煡鏂囦欢鏄惁鍖归厤寰岀洞绛涢€夛紙鎻愬墠瀹氱京锛屼緵寰岀簩浣跨敤锛?
        function matchesExtFilter(node) {
          if (!pinExFileExtensions || pinExFileExtensions.length === 0) {
            return true; // 娌掓湁绛涢€夛紝椤ず鍏ㄩ儴
          }
          if (node.isDirectory) {
            return true; // 鐩寗绺芥槸椤ず
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

        // items 宸插湪鎵╁睍绔寜鈥滄渶杩戞墦寮€/缂栬緫鈥濇帓搴忥紝杩欓噷淇濇寔椤哄簭
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

        // 鑻ユ湁鎼滅储闂滈嵉瀛楋紝鎼滅储鎵€鏈夐爡鐩紙鍖呮嫭鐩寗涓殑瀛愭枃浠讹級
        if (keyword) {
          // 鏀堕泦鎵€鏈夊彲鎼滅储鐨勯爡鐩細椤跺眰椤圭洰 + 宸插姞杞界殑鐩綍瀛愰」
          var allSearchable = items.slice();
          // 閬炴鏀堕泦鎵€鏈夊凡鍔犺級鐨勫瓙闋?
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

          // 妫€鏌ユ槸鍚︽槸褰撳墠娲诲姩鏂囦欢
          if (activePinExUri && node.uri === activePinExUri) {
            item.classList.add('active');
          }

          var textSpan = document.createElement('span');
          // 绲变竴鍙’绀烘枃浠跺悕锛屼笉椤ず瀹屾暣璺緫
          var fullPath = node.file || node.uri;
          var normalizedPath = String(fullPath).replace(/\\\\/g, '/');
          var lastSlash = normalizedPath.lastIndexOf('/');
          textSpan.textContent = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : fullPath;

          item.title = fullPath;

          item.appendChild(textSpan);

          if (canDelete) {
            var delSpan = document.createElement('span');
            delSpan.className = 'comment-delete pinex-unpin';
            delSpan.textContent = 'P';
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

        // 鐛插彇鐩寗鐨勬渶寰屼竴娈靛悕绋憋紙basename锛?
        function getDirBasename(node) {
          var full = (node && (node.file || node.uri)) || '';
          full = String(full).replace(/\\\\/g, '/');
          var idx = full.lastIndexOf('/');
          return idx >= 0 ? full.substring(idx + 1) : full;
        }

        // Compact Folders: 濡傛灉鐩寗涓嬪彧鏈変竴鍊嬪瓙鐩寗锛堟矑鏈夋枃浠讹級锛屽悎浣甸’绀?
        // 杩斿洖 { label, finalNode, chainUris }
        function getCompactedDir(node) {
          var label = getDirBasename(node);
          var chainUris = [node.uri];
          var current = node;

          while (true) {
            var children = pinExDirChildren[current.uri];
            if (!children || !Array.isArray(children)) {
              // 瀛愰爡灏氭湭杓夊叆锛岀劇娉曞绺?
              break;
            }
            var childDirs = children.filter(function (c) { return !!c.isDirectory; });
            var childFiles = children.filter(function (c) { return !c.isDirectory; });
            if (childDirs.length === 1 && childFiles.length === 0) {
              // 鍙湁涓€鍊嬪瓙鐩寗锛屽悎浣?
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
          // 瑷堢畻澹撶府寰岀殑鐩寗淇℃伅
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
          // 浠ユ渶绲傜瘈榛炵殑灞曢枊鐙€鎱嬬偤婧?
          chevron.textContent = pinExDirExpanded[finalNode.uri] ? '-' : '+';

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
            delSpan.textContent = 'P';
            delSpan.title = 'Unpin';
            header.appendChild(delSpan);

            delSpan.addEventListener('click', function (ev) {
              ev.stopPropagation();
              // 鍒櫎鏅傜敤鍘熷绡€榛炵殑 uri
              vscode.postMessage({ type: 'deletePinEx', uri: node.uri });
            });
          }

          var childrenWrap = document.createElement('div');
          childrenWrap.className = 'pinex-dir-children';

          // 浠ユ渶绲傜瘈榛炵殑灞曢枊鐙€鎱嬫覆鏌撳瓙闋?
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
              // 灞曢枊鏅傦紝鎶婇張涓婃墍鏈夌洰閷勯兘妯欒鐐哄睍闁嬶紝涓﹁珛姹傛渶绲傜瘈榛炵殑瀛愰爡
              chainUris.forEach(function (uri) {
                pinExDirExpanded[uri] = true;
              });
              vscode.postMessage({ type: 'listPinExDir', uri: finalNode.uri });
            } else {
              // 鏀惰捣鏅傦紝鎶婇張涓婃墍鏈夌洰閷勯兘妯欒鐐烘敹璧?
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

        // 鍏堟覆鏌撶洰閷勶紙鍙灞ゅ睍闁嬶級
        dirs.forEach(function (d) {
          renderDirNode(d, pinExListEl, true);
        });

        // 鍐嶆覆鏌撶洿鎺?PinEx 鐨勬枃浠?
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

        // 濡傛灉鏈夋悳绱㈤棞閸靛瓧锛岄亷婵?
        if (keyword) {
          items = items.filter(function (f) {
            return f.name.toLowerCase().indexOf(keyword) >= 0 ||
                   f.uri.toLowerCase().indexOf(keyword) >= 0;
          });
        }

        // 妾㈡煡鏂囦欢鏄惁宸茶鍥哄畾
        function isPinned(uri) {
          for (var i = 0; i < allPinEx.length; i++) {
            if (allPinEx[i].uri === uri) {
              return true;
            }
          }
          return false;
        }

        // 鎺掑簭锛氬凡鍥哄畾鐨勬枃浠舵帓鍦ㄦ渶涓婇潰
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

          // 濡傛灉鏄椿鍕曟枃浠讹紝娣诲姞楂樹寒
          if (file.isActive) {
            item.classList.add('active');
          }

          var textSpan = document.createElement('span');
          textSpan.textContent = file.name;
          item.title = file.uri;
          item.appendChild(textSpan);

          // 娣诲姞鍥哄畾鎸夐垥锛圥in 鎸夐垥锛?
          var pinSpan = document.createElement('span');
          var filePinned = isPinned(file.uri);
          pinSpan.className = 'comment-delete pinex-pin-action' + (filePinned ? ' pinned' : '');
          pinSpan.textContent = 'P';
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
        meta.textContent = 'Opened: ' + (p4Snapshot.opened || []).length + ' - Pending CLs: ' + (p4Snapshot.pendingChanges || []).length;
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
            chevron.textContent = window.__p4Expanded[groupKey] ? '-' : '+';

            var title = document.createElement('span');
            title.className = 'refs-group-title';
            if (String(cl.id).toLowerCase() === 'default') {
              title.textContent = cl.description || 'Default Changelist';
            } else {
              title.textContent = cl.id + ' - ' + cl.date + ' - ' + (cl.description || '');
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
            metaSpan.textContent = String(item.action || '').toLowerCase() + (item.change ? ' - ' + item.change : '');

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
	        var rootName = svnSnapshot.scopeLabel || (svnSnapshot.scopePath
	          ? svnSnapshot.scopePath.replace(/\\\\/g, '/').split('/').pop()
	          : (svnSnapshot.workingCopyRoot ? svnSnapshot.workingCopyRoot.replace(/\\\\/g, '/').split('/').pop() : 'project'));
	        meta.textContent = 'Changed: ' + visibleSvnItems.length + ' - ' + rootName
	          + (hiddenUnversioned ? ' - hidden unversioned: ' + hiddenUnversioned : '');
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
        changedHeader.textContent = 'Project Changes';
        svnPanelEl.appendChild(changedHeader);

        if (!window.__svnTreeExpanded) window.__svnTreeExpanded = {};
        if (typeof window.__svnTreeDefaultExpanded !== 'boolean') window.__svnTreeDefaultExpanded = true;

        function getSvnItemPath(item) {
          var raw = String((item && (item.path || item.fsPath)) || '').replace(/\\\\/g, '/');
          var root = String((svnSnapshot.scopePath || svnSnapshot.workingCopyRoot) || '').replace(/\\\\/g, '/');
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
          var nameSpan = document.createElement('span');
          nameSpan.className = 'p4-file-name';
          nameSpan.textContent = (labelText || item.path || item.fsPath || '') + ' ';

          var metaSpan = document.createElement('span');
          metaSpan.className = 'p4-file-meta';
          metaSpan.textContent = actionInfo.text;

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
          chevron.textContent = expanded ? '-' : '+';
          row.appendChild(chevron);

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

        // 纭畾褰撳墠婵€娲讳細璇?
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

        // 娓叉煋浼氳瘽鍒楄〃锛堝浐瀹氱殑浼氭爣璁梆煋岋紱鍙娆″浐瀹氾級
        allReferenceSessions.forEach(function (s) {
          var row = document.createElement('div');
          row.className = 'refs-session-item' + (s.id === activeReferenceSessionId ? ' active' : '');
          var mode = (s && s.mode) ? s.mode : 'references';
          // 浼氳瘽鏍囩锛氱敤鑻辨枃棣栧瓧姣嶅尯鍒?
          var modeText = (mode === 'implementations') ? 'I' : 'R';
          // 闇€姹傦細鍒楄〃鏄剧ず鈥滄墍鍦ㄧ被.绗﹀彿鈥濓紱璇︾粏淇℃伅鏀惧埌 tooltip锛堝寘鍚枃浠朵笌琛屽彿锛?
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
          // 闇€姹傦細涓嶅湪鍓嶆柟鏄剧ず鍥哄畾鍥炬爣锛屽彧閫氳繃鍙充晶P鎸夐挳鐘舵€佽〃杈?
          titleSpan.textContent = (s.title || 'References');

          var metaSpan = document.createElement('span');
          metaSpan.className = 'refs-session-meta';
          var count = (s.results && s.results.length) ? s.results.length : 0;
          metaSpan.textContent = String(count);

          var pinSpan = document.createElement('span');
          pinSpan.className = 'refs-session-action refs-session-pin' + (s.pinned ? ' pinned' : '');
          pinSpan.textContent = 'P';
          pinSpan.title = s.pinned ? 'Unpin this result' : 'Pin this result (keep history)';

          var delSpan = document.createElement('span');
          delSpan.className = 'refs-session-action';
          delSpan.textContent = 'x';
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

        // 娓叉煋缁撴灉鍒楄〃锛氭寜鈥滅被(瀹瑰櫒)鈥濆垎缁勶紝鐐瑰嚮灞曞紑鏄剧ず寮曠敤浣嶇疆锛堢被浼?VS Code 鎼滅储缁撴灉锛?
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
        // toolbar锛氬睍寮€/鏀惰捣
        var toolbar = document.createElement('div');
        toolbar.className = 'refs-toolbar';
        if (refsSearching) {
          var searchingEl = document.createElement('div');
          searchingEl.className = 'refs-searching';
          searchingEl.textContent = '* Searching...';
          toolbar.appendChild(searchingEl);
        } else {
          var statusEl = document.createElement('div');
          statusEl.className = 'refs-status';
          statusEl.textContent = totalResults > storedResults
            ? ('Results: ' + totalResults + ' total, ' + storedResults + ' loaded, ' + visibleLimit + ' shown')
            : ('Results: ' + totalResults + ' total, ' + visibleLimit + ' shown');
          toolbar.appendChild(statusEl);
        }

        // 瀛楁鏌ヨ锛氳/鍐欒繃婊や笁鎬侊紙鍏ㄩ儴/鍙/鍙啓锛夆€斺€斾粎瀵光€滃紩鐢ㄢ€濇湁鏁?
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

          // 杩囨护鎸夐挳鏀惧湪鍓嶉潰
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
        expandBtn.textContent = 'Expand';
        expandBtn.title = 'Expand all';
        var collapseBtn = document.createElement('button');
        collapseBtn.className = 'refs-toolbar-btn';
        collapseBtn.type = 'button';
        collapseBtn.textContent = 'Collapse';
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


        // 灞曞紑鐘舵€侊細浠呬繚瀛樺湪鍐呭瓨 + state锛堟寜 session 缁村害锛?
        if (!window.__refsExpanded) window.__refsExpanded = {};
        if (!window.__refsExpanded[active.id]) window.__refsExpanded[active.id] = {};
        var expandedMap = window.__refsExpanded[active.id];

        function setAllExpanded(v) {
          // v=true 灞曞紑鎵€鏈夊垎缁勶紱false 鍏ㄦ敹璧?
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
            expandedMap[groupKey] = true; // 榛樿灞曞紑
          }

          var header = document.createElement('div');
          header.className = 'refs-group-header';

          var chevron = document.createElement('span');
          chevron.className = 'refs-chevron';
          chevron.textContent = expandedMap[groupKey] ? '-' : '+';

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
              // 闇€姹傦細榧犳爣鍋滈潬鏄剧ず Tip锛堟樉绀鸿琛屽唴瀹癸級
              item.title = (r.preview || '').trim();

              if (isFieldOrPropertyQuery && r.access) {
                var badge = document.createElement('span');
                badge.className = 'refs-access-badge ' + r.access;
                badge.textContent = r.access === 'write' ? 'W' : 'R';
                item.appendChild(badge);
              }

              var loc = document.createElement('span');
              loc.className = 'refs-loc';
              // 闇€姹傦細鏉＄洰浠呮樉绀鸿鍙?+ 寮曠敤琛屽唴瀹癸紙涓嶆樉绀烘枃浠?绫诲悕锛?
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
            // 闇€姹傦細鍘绘帀鈥滄偓娴?鎮仠鍗抽瑙堚€濈殑閫昏緫锛堜綋楠屼笉濂斤級

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

      // 鎮仠棰勮锛氫氦缁欐墿灞曠鐢?VS Code 鍘熺敓 Peek 瀹炵幇

      // 鏍规嵁琛屽彿瀹氫綅绫诲拰鎴愬憳
      var currentHighlightedMemberLine = -1;
      function locateSymbolByLine(line) {
        console.log('[CursorEx-WV] locateSymbolByLine: line=' + line + ', classes=' + allSymbolClasses.length);
        if (!allSymbolClasses.length) {
          console.log('[CursorEx-WV] locateSymbolByLine: no classes, abort');
          return;
        }
        
        // 鎵惧埌鍏夋爣鎵€鍦ㄧ殑绫伙紙琛屽彿 >= 绫昏捣濮嬭锛屼笖 < 涓嬩竴涓被鐨勮捣濮嬭锛?
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
        
        // 濡傛灉绫诲彉浜嗭紝鍒囨崲鍒版柊绫?
        if (selectedSymbolClass !== targetClass.name) {
          console.log('[CursorEx-WV] locateSymbolByLine: switching class from ' + selectedSymbolClass + ' to ' + targetClass.name);
          selectedSymbolClass = targetClass.name;
          renderSymbols();
        }
        
        // 鎵惧埌鍏夋爣鎵€鍦ㄧ殑鎴愬憳
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
        
        // 楂樹寒鎴愬憳
        currentHighlightedMemberLine = targetMember ? targetMember.line : -1;
        
        // 鏇存柊鎴愬憳楂樹寒
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
        
        // 鏇存柊绫婚珮浜?
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

      // 娓叉煋绗﹀彿鍒楄〃
      function normalizeSymbolSearchText(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      }

      function symbolSearchAcronym(value) {
        var text = String(value || '');
        var matches = text.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
        if (!matches || !matches.length) {
          return text.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        }
        return matches.map(function (part) { return part.charAt(0); }).join('').toLowerCase();
      }

      function symbolSubsequenceMatch(query, target) {
        if (!query) return true;
        var qi = 0;
        for (var ti = 0; ti < target.length && qi < query.length; ti++) {
          if (target.charAt(ti) === query.charAt(qi)) {
            qi++;
          }
        }
        return qi === query.length;
      }

      function matchesSymbolFilter(item) {
        var query = normalizeSymbolSearchText(symbolFilterText);
        if (!query) return true;
        var normalizedName = normalizeSymbolSearchText(item && item.name);
        if (normalizedName.indexOf(query) >= 0) return true;
        var acronym = symbolSearchAcronym(item && item.name);
        if (acronym && symbolSubsequenceMatch(query, acronym)) return true;
        return symbolSubsequenceMatch(query, normalizedName);
      }

      function appendSymbolHighlightedText(parent, value) {
        var text = String(value || '');
        var query = normalizeSymbolSearchText(symbolFilterText);
        if (!query || !text) {
          parent.appendChild(document.createTextNode(text));
          return;
        }

        var marked = {};
        var lower = text.toLowerCase();
        var contiguous = lower.indexOf(symbolFilterText.toLowerCase());
        if (contiguous >= 0) {
          for (var ci = contiguous; ci < contiguous + symbolFilterText.length; ci++) {
            marked[ci] = true;
          }
        } else {
          var qi = 0;
          for (var ti = 0; ti < text.length && qi < query.length; ti++) {
            var ch = text.charAt(ti).toLowerCase();
            if (!/[a-z0-9]/.test(ch)) {
              continue;
            }
            if (ch === query.charAt(qi)) {
              marked[ti] = true;
              qi++;
            }
          }
        }

        var buffer = '';
        var bufferMarked = false;
        function flush() {
          if (!buffer) return;
          if (bufferMarked) {
            var span = document.createElement('span');
            span.className = 'symbol-match';
            span.textContent = buffer;
            parent.appendChild(span);
          } else {
            parent.appendChild(document.createTextNode(buffer));
          }
          buffer = '';
        }

        for (var i = 0; i < text.length; i++) {
          var isMarked = !!marked[i];
          if (buffer && isMarked !== bufferMarked) {
            flush();
          }
          bufferMarked = isMarked;
          buffer += text.charAt(i);
        }
        flush();
      }

      function renderSymbols() {
        console.log('[CursorEx-Webview] renderSymbols called, classes:', allSymbolClasses.length);
        if (!symbolClassListEl || !symbolMemberListEl) return;
        symbolClassListEl.innerHTML = '';
        symbolMemberListEl.innerHTML = '';

        // 濡傛灉娌℃湁鎵撳紑鏂囦欢
        if (!symbolFileUri) {
          var emptyDiv = document.createElement('div');
          emptyDiv.className = 'symbol-empty';
          emptyDiv.textContent = 'No open file.';
          symbolClassListEl.appendChild(emptyDiv);
          return;
        }

        // 濡傛灉涓嶆槸 C# 鏂囦欢
        if (symbolNotCs) {
          var notCsDiv = document.createElement('div');
          notCsDiv.className = 'symbol-empty';
          notCsDiv.textContent = 'Current file is not a C# file.';
          symbolClassListEl.appendChild(notCsDiv);
          return;
        }

        // 濡傛灉娌℃湁绫?
        if (!allSymbolClasses.length) {
          var noClassDiv = document.createElement('div');
          noClassDiv.className = 'symbol-empty';
          noClassDiv.textContent = 'No type definitions found.';
          symbolClassListEl.appendChild(noClassDiv);
          return;
        }

        // 娓叉煋绫诲垪琛?
        var selectedClassVisible = allSymbolClasses.some(function (cls) {
          return cls.name === selectedSymbolClass;
        });
        if ((!selectedSymbolClass || !selectedClassVisible) && allSymbolClasses.length > 0) {
          selectedSymbolClass = allSymbolClasses[0].name;
        }

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

          // 鐐瑰嚮绫伙細閫変腑銆佹樉绀烘垚鍛樺苟璺宠浆鍒板畾涔変綅缃?
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

        // 娓叉煋鎴愬憳鍒楄〃
        console.log('[CursorEx-Webview] Selected class:', selectedSymbolClass);
        console.log('[CursorEx-Webview] All members parentClasses:', [...new Set(allSymbolMembers.map(m => m.parentClass))]);
        var filteredMembers = symbolFilterText
          ? allSymbolMembers.slice()
          : allSymbolMembers.filter(function (m) {
              return m.parentClass === selectedSymbolClass;
            });
        console.log('[CursorEx-Webview] Filtered members:', filteredMembers.length);

        var visibleMembers = filteredMembers.filter(function (m) {
          if (!m || !m.kind) return true;
          if (symbolFilterText && !matchesSymbolFilter(m)) return false;
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

        // 鎴愬憳绛涢€夊伐鍏锋爮锛堝瓧娈?灞炴€?鍑芥暟锛?
        var memberToolbar = document.createElement('div');
        memberToolbar.className = 'symbol-member-toolbar';
        var toolbarTitle = document.createElement('div');
        toolbarTitle.className = 'symbol-member-toolbar-title';
        toolbarTitle.textContent = symbolFilterText
          ? ('Search results (' + visibleMembers.length + '/' + filteredMembers.length + ')')
          : ((selectedSymbolClass || 'Members') + ' (' + visibleMembers.length + '/' + filteredMembers.length + ')');
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
          noMemberDiv.textContent = symbolFilterText
            ? 'No members in this file.'
            : (selectedSymbolClass ? 'This type has no members.' : 'Select a type.');
          symbolMemberListEl.appendChild(noMemberDiv);
          return;
        }

        if (symbolFilterText && !visibleMembers.length) {
          var noSearchMemberDiv = document.createElement('div');
          noSearchMemberDiv.className = 'symbol-empty';
          noSearchMemberDiv.textContent = 'No matching members.';
          symbolMemberListEl.appendChild(noSearchMemberDiv);
          return;
        }

        // 鎸夌被鍨嬪垎缁?
        var groupOrder = ['constructor', 'field', 'property', 'event', 'method'];
        var groupNames = {
          'constructor': 'Constructor',
          'field': 'Field',
          'property': 'Property',
          'event': 'Event',
          'method': 'Method'
        };
        var kindIcons = {
          'constructor': 'C',
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
            icon.textContent = kindIcons[member.kind] || '?';

            var contentSpan = document.createElement('span');
            contentSpan.className = 'symbol-content';

            // 鍑芥暟/鏋勯€犲嚱鏁帮細鏄剧ず "鍑芥暟鍚?鍙傛暟)"
            // 鍙橀噺/灞炴€э細鏄剧ず "绫诲瀷 鍙橀噺鍚?
            var parentPrefix = symbolFilterText && member.parentClass ? (member.parentClass + '.') : '';
            if (kind === 'method' || kind === 'constructor') {
              // 鍑芥暟鍚?+ 鍙傛暟锛宼ype 鍖呭惈鍙傛暟濡?"(bool value)"
              contentSpan.appendChild(document.createTextNode(parentPrefix));
              appendSymbolHighlightedText(contentSpan, member.name);
              contentSpan.appendChild(document.createTextNode(member.type || '()'));
            } else {
              // 绫诲瀷 + 鍙橀噺鍚嶏紝type 鍖呭惈绫诲瀷濡?"int"銆?List<ResourceID>"
              if (member.type) {
                var typeSpan = document.createElement('span');
                typeSpan.className = 'symbol-type-prefix';
                appendSymbolHighlightedText(typeSpan, member.type);
                contentSpan.appendChild(typeSpan);
                contentSpan.appendChild(document.createTextNode(' '));
                contentSpan.appendChild(document.createTextNode(parentPrefix));
                appendSymbolHighlightedText(contentSpan, member.name);
              } else {
                contentSpan.appendChild(document.createTextNode(parentPrefix));
                appendSymbolHighlightedText(contentSpan, member.name);
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

      // References 闈㈡澘鍒嗛殧鏉℃嫋鎷介€昏緫
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

        // 鍒濆鍖栭珮搴?
        refsSessionListEl.style.height = refsSessionHeight + 'px';
      })();

      // 绗﹀彿闈㈡澘鍒嗛殧鏉℃嫋鎷介€昏緫
      var symbolClassHeight = 120; // 榛樿楂樺害
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

        // 鍒濆鍖栭珮搴?
        symbolClassListEl.style.height = symbolClassHeight + 'px';
      })();

      // PinEx Tab 鍒囨彌閭忚集
      function switchPinExTab(tabName) {
        if (!isPinExTabVisible(tabName)) {
          tabName = firstVisiblePinExTab();
        }
        console.log('[CursorEx-Webview] switchPinExTab:', tabName);
        debugPinExTabs('switchPinExTab -> ' + tabName);
        pinExActiveTab = tabName;
        // 鏇存柊 Tab 鎸夐垥鐙€鎱?
        for (var i = 0; i < pinExTabs.length; i++) {
          var tab = pinExTabs[i];
          if (tab.getAttribute('data-tab') === tabName) {
            tab.classList.add('active');
          } else {
            tab.classList.remove('active');
          }
        }
        // 鏇存柊鍏у鍗€鍩熼’绀?
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
        // 鍒锋柊灏嶆噳鐨勫垪琛?
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
          // 璇锋眰鏈€鏂板紩鐢ㄤ細璇濆苟娓叉煋
          vscode.postMessage({ type: 'getReferenceSessions' });
          renderReferences();
        } else if (tabName === 'symbol') {
          // 璇锋眰鏈€鏂扮鍙锋暟鎹?
          console.log('[CursorEx-Webview] Requesting symbols...');
          vscode.postMessage({ type: 'getSymbols' });
        }
      }

      // 缍佸畾 Tab 榛炴搳浜嬩欢
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

      // Tab 瀹藉害涓嶅鏃讹細鍙樉绀哄浘鏍囷紝闅愯棌鏂囧瓧
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
          // 鍏煎锛氭棤 ResizeObserver 鏃堕€€鍖栦负 window resize
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
          // 閫插叆銆屽叏閮ㄥ睍闁嬨€嶆ā寮忥紝灏嶆墍鏈夊凡 PinEx 鐨勬牴鐩寗鍜屽叾鎵€鏈夊瓙鐩寗閬炴灞曢枊
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

      // 鍢楄│瀹氫綅鍒扮洰妯欐枃浠讹紙鍦ㄧ洰閷勫姞杓夊緦鏈冨啀娆¤鐢級
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

        // 鍏堟鏌ユ枃浠舵槸鍚﹀凡缍撳彲瑕?
        var activeItem = findPinExElementByUri(pinExListEl, pinExLocateTargetUri);
        if (activeItem && typeof activeItem.scrollIntoView === 'function') {
          activeItem.scrollIntoView({ block: 'center' });
          pinExLocatePending = false;
          pinExLocateTargetUri = null;
          return;
        }

        // 鏌ユ壘闇€瑕佸睍闁嬬殑鐩寗璺緫
        var dirsToExpand = [];
        
        // 鍏堟煡鎵鹃爞灞ょ洰閷?
        allPinEx.forEach(function (item) {
          if (item.isDirectory && pinExLocateTargetUri.indexOf(item.uri) === 0 && pinExLocateTargetUri !== item.uri) {
            dirsToExpand.push(item.uri);
          }
        });

        // 閬炴鏌ユ壘鎵€鏈夊凡鍔犺級鐨勫瓙鐩寗
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

        // 灞曢枊鎵€鏈夐渶瑕佸睍闁嬬殑鐩寗
        var needsLoading = false;
        dirsToExpand.forEach(function (dirUri) {
          pinExDirExpanded[dirUri] = true;
          if (!pinExDirChildren[dirUri]) {
            vscode.postMessage({ type: 'listPinExDir', uri: dirUri });
            needsLoading = true;
          }
        });

        // 閲嶆柊娓叉煋
        renderPinEx();

        // 濡傛灉娌掓湁闇€瑕佸姞杓夌殑鐩寗锛屽啀娆″槜瑭﹀畾浣?
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
        // 濡傛灉鏈夌洰閷勬鍦ㄥ姞杓夛紝绛夊緟 pinExDirChildren 娑堟伅铏曠悊寰屽啀娆¤鐢?tryLocateActivePinEx
      }

      if (pinExLocateBtn) {
        pinExLocateBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!activePinExUri) return;
          
          // 鏍规摎鐣跺墠 Tab 閬告搰瑕佸畾浣嶇殑鍒楄〃
          if (pinExActiveTab === 'symbol' || pinExActiveTab === 'refs') {
            // 闇€姹傦細鑻ュ湪 绫昏鍥?References锛屽畾浣嶆寜閽簲鍏堝洖鍒扳€滃浐瀹氣€漈ab 鍐嶆墽琛屽畾浣?
            switchPinExTab('pin');
            // 绛夊緟涓€娆℃覆鏌撳悗鍐嶆墽琛屽畾浣嶏紙閬垮厤 pinex-list 灏氭湭鍙锛?
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
            // 鍦?鎵撻枊"Tab 涓畾浣?
            if (!pinExOpenListEl) return;
            var openActiveItem = pinExOpenListEl.querySelector('.pinex-item.active');
            if (openActiveItem && typeof openActiveItem.scrollIntoView === 'function') {
              openActiveItem.scrollIntoView({ block: 'center' });
            }
          } else {
            // 鍦?鍥哄畾"Tab 涓畾浣?
            if (!pinExListEl) return;
            var activeItem = findPinExElementByUri(pinExListEl, activePinExUri);
            if (activeItem && typeof activeItem.scrollIntoView === 'function') {
              activeItem.scrollIntoView({ block: 'center' });
          return;
        }
            
            // 瑷疆瀹氫綅璜嬫眰鐙€鎱嬩甫闁嬪鍢楄│瀹氫綅锛堝睍闁嬬洰閷勶級
            pinExLocatePending = true;
            pinExLocateTargetUri = activePinExUri;
            tryLocateActivePinEx();
          }
        });
      }

      /**
       * 閬炴灞曢枊鎸囧畾 PinEx 鐩寗鍙婂叾鎵€鏈夊瓙鐩寗銆?
       * 鑻ョ暥鍓嶅皻鏈嵅鍙栬┎鐩寗鐨勫瓙闋咃紝鏈冨悜鎿村睍绔珛姹備竴娆?listPinExDir锛?
       * 鏀跺埌鍥炶寰屽湪 pinExDirChildren 铏曠悊閭忚集涓辜绾岄仦姝搞€?
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
        // 鍥哄畾鏈€灏忛珮搴︼紝涓嶆牴鎹唴瀹硅嚜鍔ㄦ拺澶?
        return 80;
      }

      function getNoteMinHeight() {
        // 鍥哄畾鏈€灏忛珮搴︼紝涓嶆牴鎹唴瀹硅嚜鍔ㄦ拺澶?
        return 80;
      }

      function getPinExMinHeight() {
        // 鍥哄畾鏈€灏忛珮搴︼紝涓嶆牴鎹唴瀹硅嚜鍔ㄦ拺澶?
        return 80;
      }

      function getCardMinHeight(id) {
        if (id === 'pinex') return getPinExMinHeight();
        return 80;
      }

      function syncHeightsFromContent() {
        // 鍙埛鏂板竷灞€浣嶇疆锛屼笉鑷姩璋冩暣楂樺害
        // 闈㈡澘楂樺害鐢辩敤鎴锋墜鍔ㄦ嫋鎷借皟鏁?
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

        // 鍏堢Щ闄わ紝鍐嶆寜闋嗗簭閲嶆柊娣诲姞
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

      // 缍佸畾鎶樼枈锛堥粸鎿婃椤屽崁闈炲伐鍏锋寜閳曢儴鍒嗭級
      sectionHeaders.forEach(function (header) {
        header.addEventListener('click', function (ev) {
          var target = ev.target;
          if (target && target.classList) {
            // 榛炴搳绉诲嫊鎸夐垥 / 鎼滅储妗?/ 椤ず鏂囦欢鍚嶆寜閳曟檪锛屼笉瑙哥櫦鎶樼枈
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

      // 涓婄Щ / 涓嬬Щ 鎸夐垥鎺у埗鍗＄墖闋嗗簭
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

      // 鍒濆鍖栦綀灞€
      try {
      applyOrder();
      updateMoveButtons();
      applyHeights();
      applySectionCollapse();
      } catch (e) {
        console.error('Layout initialization failed:', e);
        // 濡傛灉鍒濆鍖栧け鏁楋紝鍢楄│閲嶇疆鐙€鎱嬩甫閲嶆柊鍒濆鍖?
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
        <div class="meta">${escapeHtmlText(entry.author || 'unknown')} - ${escapeHtmlText(entry.date || '')}</div>
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
        // 鍙戦€佸綋鍓嶈缃埌 Webview
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
        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
        setTimeout(() => {
          vscode.window.showInformationMessage(
            'Search "cursorToolWindow.quickOpen" in Keyboard Shortcuts to configure Quick Open.',
            'OK'
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
        // 淇濆瓨璁剧疆
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
        // 閫氱煡渚ц竟鏍?Webview 鍒锋柊閰嶇疆
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
    /* 婊氬姩鏉★細榛樿闅愯棌锛岀獥鍙ｈ幏寰楃劍鐐瑰悗鏄剧ず */
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
    .update-notes {
      display: none;
      max-height: 150px;
      margin-top: 10px;
      padding: 8px 10px;
      overflow: auto;
      white-space: pre-wrap;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: var(--panel-bg);
      color: var(--panel-text-muted);
      font-family: inherit;
      font-size: 12px;
      line-height: 1.5;
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
        <pre id="update-notes" class="update-notes"></pre>
      </div>
      <div class="form-group">
        <label>Font size</label>
        <div class="hint">Set the tool window font size (10-40px)</div>
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
        <label>馃攳 Search Mode</label>
        <div class="hint">Choose what to search: file names, symbols, file content, or both</div>
        <select id="search-mode" style="width:200px;padding:6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:4px;">
          <option value="all">All (File + Symbol + Content)</option>
          <option value="filename">File Only</option>
          <option value="class">Symbol Only</option>
          <option value="fileclass">File + Symbol</option>
          <option value="content">Content Only</option>
        </select>
      </div>
      <div class="form-group">
        <label>馃搧 File Extensions</label>
        <div class="hint">Only search files with these extensions (comma-separated, empty = all files)</div>
        <textarea id="search-fileExtensions" rows="2" placeholder="Leave empty to search all file types"></textarea>
      </div>
      <div class="form-group">
        <label>馃搨 Include Directories</label>
        <div class="hint">Only search in these directories (one per line, empty = whole workspace)</div>
        <textarea id="search-includeDirectories" rows="3" placeholder="src&#10;lib&#10;scripts"></textarea>
      </div>
      <div class="form-group">
        <label>馃毇 Exclude Directories</label>
        <div class="hint">Skip these directories (one per line)</div>
        <textarea id="search-excludeDirectories" rows="4" placeholder="**/node_modules/**&#10;**/bin/**&#10;**/obj/**&#10;**/.git/**"></textarea>
      </div>
      <div class="form-group">
        <label>馃敔 Case Sensitive</label>
        <div class="hint">Enable case-sensitive search</div>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" id="search-caseSensitive" style="width:18px;height:18px;" />
          <span>Match case when searching</span>
        </label>
      </div>
      <div class="form-group">
        <label>Search Delay</label>
        <div class="hint">Wait time (ms) after typing before starting search (100-1000)</div>
        <input type="number" id="search-debounceDelay" min="100" max="1000" value="300" style="width:100px;" /> ms
      </div>
      <div class="form-group">
        <label>馃搳 Performance Settings</label>
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
        <label>鈱笍 Quick Open Shortcut</label>
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
        <div class="hint">0 uses global setting (10-40px)</div>
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
        <div class="hint">0 uses global setting (10-40px)</div>
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
        <div class="hint">0 uses global setting (10-40px)</div>
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
      // 榛樿闅愯棌锛涜仛鐒﹁缃獥鍙ｅ悗鏄剧ず
      setScrollbarVisible(false);
      window.addEventListener('focus', () => setScrollbarVisible(true));
      window.addEventListener('blur', () => setScrollbarVisible(false));
      document.addEventListener('mousedown', () => setScrollbarVisible(true), true);

      // Tab 鍒囨崲
      document.querySelectorAll('.tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          tab.classList.add('active');
          document.getElementById('tab-' + tab.getAttribute('data-tab')).classList.add('active');
        });
      });

      // 璇锋眰褰撳墠璁剧疆
      vscode.postMessage({ type: 'getSettings' });

      // 鎺ユ敹璁剧疆鏁版嵁
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

      var lastUpdateStatus = null;
      function renderUpdateStatus(status) {
        status = Object.assign({}, lastUpdateStatus || {}, status || {});
        lastUpdateStatus = status;
        var statusEl = document.getElementById('update-status');
        var metaEl = document.getElementById('update-meta');
        var notesEl = document.getElementById('update-notes');
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
        if (notesEl) {
          var notes = (status.releaseNotes || '').trim();
          notesEl.textContent = notes;
          notesEl.style.display = notes ? 'block' : 'none';
        }

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
            // 鏇存柊 color picker
            updateColorPickerFromText('todo-hoverColor-picker', 'todo-hoverColor');
          }
          if (msg.comment) {
            document.getElementById('comment-activeColor').value = msg.comment.activeColor || 'rgba(14,99,156,0.6)';
            document.getElementById('comment-hoverColor').value = msg.comment.hoverColor || 'rgba(14,99,156,0.45)';
            document.getElementById('comment-fontSize').value = msg.comment.fontSize || 0;
            // 鏇存柊 color pickers
            updateColorPickerFromText('comment-activeColor-picker', 'comment-activeColor');
            updateColorPickerFromText('comment-hoverColor-picker', 'comment-hoverColor');
          }
          if (msg.pinex) {
            document.getElementById('pinex-fileExtensions').value = (msg.pinex.fileExtensions || []).join(', ');
            document.getElementById('pinex-activeColor').value = msg.pinex.activeColor || 'rgba(14,99,156,0.6)';
            document.getElementById('pinex-hoverColor').value = msg.pinex.hoverColor || 'rgba(14,99,156,0.45)';
            document.getElementById('pinex-fontSize').value = msg.pinex.fontSize || 0;
            // 鏇存柊 color pickers
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

      // 杓斿姪鍑芥暩锛氬緸椤忚壊鍊间腑鎻愬彇 hex锛堢敤鏂艰ō缃?color picker锛?
      function extractHexFromColor(colorStr) {
        if (!colorStr) return '#0e639c';
        // 濡傛灉宸茬稉鏄?hex 鏍煎紡
        if (colorStr.indexOf('#') === 0) {
          return colorStr.substring(0, 7); // 鍙彇鍓?7 鍊嬪瓧绗?
        }
        // 濡傛灉鏄?rgba 鎴?rgb 鏍煎紡锛屾彁鍙?RGB 鍊?
        var match = colorStr.match(/rgba?\\s*\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/);
        if (match) {
          var r = parseInt(match[1], 10).toString(16).padStart(2, '0');
          var g = parseInt(match[2], 10).toString(16).padStart(2, '0');
          var b = parseInt(match[3], 10).toString(16).padStart(2, '0');
          return '#' + r + g + b;
        }
        return '#0e639c';
      }

      // 杓斿姪鍑芥暩锛氭牴鎿氭枃鏈几鍏ユ洿鏂?color picker
      function updateColorPickerFromText(pickerId, textId) {
        var picker = document.getElementById(pickerId);
        var textInput = document.getElementById(textId);
        if (picker && textInput) {
          picker.value = extractHexFromColor(textInput.value);
        }
      }

      // 杓斿姪鍑芥暩锛氱暥 color picker 璁婂寲鏅傛洿鏂板皪鎳夌殑 text input锛堜繚鐣欓€忔槑搴﹀鏋滄湁锛?
      function setupColorPicker(pickerId, textId) {
        var picker = document.getElementById(pickerId);
        var textInput = document.getElementById(textId);
        if (!picker || !textInput) return;

        // 鍒濆鍖?color picker 鐨勫€?
        picker.value = extractHexFromColor(textInput.value);

        picker.addEventListener('input', function() {
          var currentValue = textInput.value || '';
          // 濡傛灉鐣跺墠鍊兼槸 rgba锛屼繚鐣欓€忔槑搴?
          var match = currentValue.match(/rgba\\s*\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\s*\\)/);
          if (match) {
            var alpha = match[1];
            // 寰?hex 杞夋彌鐐?rgb
            var hex = picker.value;
            var r = parseInt(hex.substring(1, 3), 16);
            var g = parseInt(hex.substring(3, 5), 16);
            var b = parseInt(hex.substring(5, 7), 16);
            textInput.value = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
          } else {
            // 鍚﹀墖鐩存帴浣跨敤 hex
            textInput.value = picker.value;
          }
        });
      }

      // 瑷疆鎵€鏈夐鑹查伕鎿囧櫒
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

      // 淇濆瓨鎸夐挳
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

        // Search 璁剧疆
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

      // 鎵撳紑蹇嵎閿缃寜閽?
      document.getElementById('btn-openKeybindings').addEventListener('click', function() {
        vscode.postMessage({ type: 'openKeybindings' });
      });

      document.getElementById('btn-autoDetectProfile').addEventListener('click', function() {
        vscode.postMessage({ type: 'autoDetectProjectProfile' });
      });

      document.getElementById('btn-checkUpdates').addEventListener('click', function() {
        renderUpdateStatus({
          state: 'checking',
          message: 'Checking GitHub Releases...',
          canInstall: false,
          checkedAt: Date.now()
        });
        vscode.postMessage({ type: 'checkForUpdates' });
      });

      document.getElementById('btn-installUpdate').addEventListener('click', function() {
        renderUpdateStatus({
          state: 'installing',
          message: 'Preparing update install...',
          canInstall: false
        });
        vscode.postMessage({ type: 'installUpdate' });
      });

      // 閲嶇疆鎸夐挳
      document.getElementById('btn-reset').addEventListener('click', function() {
        // 鍏ㄥ眬璁剧疆
        document.getElementById('global-fontSize').value = '13';
        document.getElementById('global-accentColor').value = '#0e639c';
        document.getElementById('global-textColor').value = '#f3f3f3';
        document.getElementById('global-mutedColor').value = '#c5c5c5';
        document.getElementById('global-bgColor').value = '#1e1e1e';
        document.getElementById('global-borderColor').value = '#2d2d2d';
        document.getElementById('global-vcsProvider').value = 'auto';
        // TODO 璁剧疆
        document.getElementById('todo-extensions').value = 'cs, csx, js, jsx, ts, tsx, cpp, c, h, hpp, java, go';
        document.getElementById('todo-excludeGlobs').value = '**/node_modules/**' + String.fromCharCode(10) + '**/bin/**' + String.fromCharCode(10) + '**/obj/**';
        document.getElementById('todo-includeGlobs').value = '';
        document.getElementById('todo-contentFilter').value = '';
        document.getElementById('todo-hoverColor').value = 'rgba(14,99,156,0.45)';
        document.getElementById('todo-fontSize').value = '0';
        // COMMENT 璁剧疆
        document.getElementById('comment-activeColor').value = 'rgba(14,99,156,0.6)';
        document.getElementById('comment-hoverColor').value = 'rgba(14,99,156,0.45)';
        document.getElementById('comment-fontSize').value = '0';
        // PinEx 璁剧疆
        document.getElementById('pinex-fileExtensions').value = '';
        document.getElementById('pinex-activeColor').value = 'rgba(14,99,156,0.6)';
        document.getElementById('pinex-hoverColor').value = 'rgba(14,99,156,0.45)';
        document.getElementById('pinex-fontSize').value = '0';
        document.getElementById('pinex-quickOpenKeybinding').value = 'Ctrl+T (default)';
        // Search 璁剧疆
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
  // VS Code API 鏃犳硶鐩存帴璇诲彇 keybindings.json 鐨勫唴瀹?
  // 杩斿洖榛樿鍊硷紝鐢ㄦ埛鍙互閫氳繃鎸夐挳鎵撳紑蹇嵎閿缃〉闈㈡煡鐪嬪拰淇敼
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
