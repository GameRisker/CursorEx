import * as vscode from 'vscode';

export interface LineCommentItem {
  uri: vscode.Uri;
  line: number;
  text: string;
}

export class CommentManager {
  private static readonly STORAGE_KEY = 'cursorToolWindow.comments';

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onDidActiveLineComment = new vscode.EventEmitter<{ uri: vscode.Uri; line: number } | null>();
  readonly onDidActiveLineComment = this._onDidActiveLineComment.event;

  private comments: LineCommentItem[] = [];
  private readonly decorationType: vscode.TextEditorDecorationType;
  private lastHoverKey: string | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {
    const iconPath = vscode.Uri.file(
      context.asAbsolutePath('resources/comment-gutter.svg')
    );

    this.decorationType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: iconPath,
      gutterIconSize: 'contain'
    });

    const saved = context.workspaceState.get<any[]>(CommentManager.STORAGE_KEY, []);
    if (Array.isArray(saved)) {
      for (const item of saved) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const uriStr = typeof (item as any).uri === 'string' ? (item as any).uri : undefined;
        const line = typeof (item as any).line === 'number' ? (item as any).line : NaN;
        const text = typeof (item as any).text === 'string' ? (item as any).text : '';
        if (!uriStr || isNaN(line)) {
          continue;
        }
        this.comments.push({
          uri: vscode.Uri.parse(uriStr),
          line,
          text
        });
      }
    }

    context.subscriptions.push(
      this.decorationType,
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.updateDecorations();
        this.updateCurrentLineContext();
      }),
      vscode.workspace.onDidOpenTextDocument(() => {
        this.updateDecorations();
        this.updateCurrentLineContext();
      }),
      vscode.workspace.onDidCloseTextDocument(() => {
        this.updateDecorations();
        this.updateCurrentLineContext();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateDecorations();
        this.updateCurrentLineContext();
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.updateCurrentLineContext();
      })
    );

    this.updateDecorations();
    this.updateCurrentLineContext();
  }

  getComments(): LineCommentItem[] {
    return this.comments.slice();
  }

  hasComment(uri: vscode.Uri, line: number): boolean {
    return !!this.findComment(uri, line);
  }

  getComment(uri: vscode.Uri, line: number): LineCommentItem | undefined {
    return this.findComment(uri, line);
  }

  removeComment(uri: vscode.Uri, line: number): void {
    const before = this.comments.length;
    this.comments = this.comments.filter(c => !this.sameLocation(c, uri, line));
    if (this.comments.length !== before) {
      this.save();
    }
  }

  clearAll(): void {
    if (!this.comments.length) {
      return;
    }
    this.comments = [];
    this.save();
  }

  async addOrEditComment(uri: vscode.Uri, line: number): Promise<void> {
    const existing = this.findComment(uri, line);
    const value = existing ? existing.text : '';

    const input = await vscode.window.showInputBox({
      title: existing ? '编辑注释' : '添加注释',
      value,
      placeHolder: '在此输入注释说明...',
      ignoreFocusOut: true
    });

    if (typeof input !== 'string') {
      return;
    }

    const trimmed = input.trim();

    if (!trimmed) {
      if (existing) {
        this.comments = this.comments.filter(c => !this.sameLocation(c, uri, line));
        this.save();
      }
      return;
    }

    if (existing) {
      existing.text = trimmed;
    } else {
      this.comments.push({ uri, line, text: trimmed });
    }

    this.save();
  }

  private sameLocation(item: LineCommentItem, uri: vscode.Uri, line: number): boolean {
    return item.uri.toString() === uri.toString() && item.line === line;
  }

  private findComment(uri: vscode.Uri, line: number): LineCommentItem | undefined {
    return this.comments.find(c => this.sameLocation(c, uri, line));
  }

  private save(): void {
    const raw = this.comments.map(c => ({
      uri: c.uri.toString(),
      line: c.line,
      text: c.text
    }));
    this.context.workspaceState.update(CommentManager.STORAGE_KEY, raw);
    this.updateDecorations();
    this.updateCurrentLineContext();
    this._onDidChange.fire();
  }

  private updateDecorations(): void {
    const editors = vscode.window.visibleTextEditors;
    for (const editor of editors) {
      const docUri = editor.document.uri.toString();
      const items = this.comments.filter(c => c.uri.toString() === docUri);
      const options: vscode.DecorationOptions[] = items.map(c => {
        const pos = new vscode.Position(c.line, 0);
        return {
          // 使用行首 0 長度 range，配合 gutterIconPath，只在圖標附近顯示
          range: new vscode.Range(pos, pos)
        };
      });
      editor.setDecorations(this.decorationType, options);
    }
  }

  private updateCurrentLineContext(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.commands.executeCommand('setContext', 'cursorToolWindow.commentOnLine', false);
      this._onDidActiveLineComment.fire(null);
      this.lastHoverKey = null;
      return;
    }
    const uri = editor.document.uri;
    const line = editor.selection.active.line;
    const has = this.hasComment(uri, line);
    vscode.commands.executeCommand('setContext', 'cursorToolWindow.commentOnLine', has);
    this._onDidActiveLineComment.fire(
      has ? { uri, line } : null
    );

    const key = uri.toString() + '#' + String(line);
    if (has) {
      if (this.lastHoverKey !== key) {
        this.lastHoverKey = key;
        // 自動彈出 Hover，顯示當前行對應的 Comment 內容
        vscode.commands.executeCommand('editor.action.showHover');
      }
    } else {
      this.lastHoverKey = null;
    }
  }
}

