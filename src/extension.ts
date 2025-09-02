// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
// Use require for node-fetch for CommonJS compatibility and to avoid type errors
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fetch = require('node-fetch');

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  console.log(
    'Congratulations, your extension "AI Coding Chat" is now active!'
  );

  // Register webview view provider for sidebar
  const provider = new AIChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'ai-coding-chat.chatView',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  // Register command to focus the chat view
  const disposableChat = vscode.commands.registerCommand(
    'ai-coding-chat.openChat',
    () => {
      // Reveal the activity bar view container for the extension. Using the
      // built-in workbench command ensures the WebviewView is created/visible.
      // The view container id comes from package.json (viewsContainers.activitybar.id)
      vscode.commands.executeCommand('workbench.view.extension.ai-coding-chat');
    }
  );
  context.subscriptions.push(disposableChat);

  // Register command to add selection to chat
  const disposableAddToChat = vscode.commands.registerCommand(
    'ai-coding-chat.addToChat',
    async () => {
      console.log('[DEBUG] Command triggered');
      vscode.window.showInformationMessage('Command works!');
      await provider.addSelectionToChat();
    }
  );
  context.subscriptions.push(disposableAddToChat);

  // Register command to open chat in panel
  const disposableChatPanel = vscode.commands.registerCommand(
    'ai-coding-chat.openChatPanel',
    () => {
      provider.openChatPanel();
    }
  );
  context.subscriptions.push(disposableChatPanel);
}

// This method is called when your extension is deactivated
export function deactivate() {}

class AIChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private _messageHistory: {
    role: 'user' | 'ai' | 'error' | 'loading' | 'system';
    content: string;
  }[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    // Add welcome message
    this._messageHistory.push({
      role: 'system',
      content:
        '👋 Welcome! Type @ to add files, right-click code to add selections, or ask anything directly.',
    });
    this._postMessageHistory();

    // Listen for messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'setProvider') {
        await vscode.workspace
          .getConfiguration()
          .update(
            'aiCodingChat.activeProvider',
            message.provider,
            vscode.ConfigurationTarget.Global
          );
        vscode.window.showInformationMessage(
          `AI provider set to ${message.provider}`
        );
      } else if (message.type === 'userMessage') {
        await this._handleUserMessage(message);
      } else if (message.type === 'previewEdit') {
        this._showPreviewAndApply(message.filePath, message.newContent);
      } else if (message.type === 'sendCurrentFile') {
        await this._handleSendCurrentFile();
      } else if (message.type === 'sendSelection') {
        await this._handleSendSelection();
      } else if (message.type === 'sendWorkspaceInfo') {
        await this._handleSendWorkspaceInfo();
      } else if (message.type === 'addCurrentFileContext') {
        await this._handleAddCurrentFileContext();
      } else if (message.type === 'addSelectionContext') {
        await this._handleAddSelectionContext();
      } else if (message.type === 'addWorkspaceContext') {
        await this._handleAddWorkspaceContext();
      } else if (message.type === 'showContextMenu') {
        await this._handleShowContextMenu();
      } else if (message.type === 'requestHistory') {
        this._postMessageHistory();
      } else if (message.type === 'requestFileSuggestions') {
        await this._handleFileSuggestions(message.query, message.cursorPos);
      } else if (message.type === 'addFileToContext') {
        await this._handleAddFileToContext(message.filePath);
      } else if (message.type === 'applyInline') {
        await this._handleApplyInline(message.target, message.codeBlock);
      } else if (message.type === 'webviewReady') {
        console.log('[AIChat] Webview is ready!');
      } else if (message.type === 'insertLabel') {
        // This message is handled by the webview's script, not the TypeScript provider
      }
    });
  }

  private _postMessageHistory() {
    console.log(
      'Posting message history:',
      this._messageHistory.length,
      'messages'
    );
    if (this._view) {
      this._view.webview.postMessage({
        type: 'history',
        history: this._messageHistory,
      });
    }
  }

  // Public method to add selection to chat from context menu
  public async addSelectionToChat() {
    console.log('[DEBUG] addSelectionToChat called');
    vscode.window.showInformationMessage('Add Selection triggered!');

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage('No text selected');
      return;
    }

    const selection = editor.selection;
    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop() || 'unknown';
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const label = `${fileName}:${startLine}-${endLine}`;
    const selectedText = document.getText(selection);

    // Always focus/open the chat view before inserting
    // Try to open the sidebar view. The registered openChat command will
    // reveal the view container. Wait briefly for the view provider to be
    // resolved so we can post a message to the webview. If not available,
    // fall back to opening a panel.
    await vscode.commands.executeCommand('ai-coding-chat.openChat');
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Send a message to insert the label at the cursor position
    const message = {
      type: 'insertLabel',
      label,
      contextItem: {
        type: 'selection',
        name: label,
        fileName,
        startLine,
        endLine,
        content: selectedText,
        icon: '\ud83d\udcdd',
      },
    };
    // If the sidebar webview is ready, post there; otherwise post to panel.
    if (this._view) {
      this._view.webview.postMessage(message);
      return;
    }

    // If no sidebar view yet, ensure we have a panel and post there.
    if (!this._panel) {
      this.openChatPanel();
      // wait a bit for panel to be created
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (this._panel) {
      this._panel.webview.postMessage(message);
    }
  }

  // Open chat in a separate panel that can be docked anywhere
  public openChatPanel() {
    if (this._panel) {
      this._panel.reveal();
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      'aiChatPanel',
      'AI Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri],
      }
    );

    this._panel.webview.html = this._getHtmlForWebview();

    // Send existing message history to panel
    this._postMessageHistoryToPanel();

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(async (message) => {
      // Reuse the same message handling logic
      if (message.type === 'userMessage') {
        await this._handleUserMessage(message);
      } else if (message.type === 'setProvider') {
        const config = vscode.workspace.getConfiguration();
        await config.update(
          'aiCodingChat.activeProvider',
          message.provider,
          vscode.ConfigurationTarget.Global
        );
      } else if (message.type === 'requestHistory') {
        this._postMessageHistoryToPanel();
      } else if (message.type === 'requestFileSuggestions') {
        await this._handleFileSuggestions(message.query, message.cursorPos);
      } else if (message.type === 'addFileToContext') {
        await this._handleAddFileToContext(message.filePath);
      }
    });

    this._panel.onDidDispose(() => {
      this._panel = undefined;
    });

    // Send initial history to panel
    this._postMessageHistoryToPanel();
  }

  private _postMessageHistoryToPanel() {
    if (this._panel) {
      this._panel.webview.postMessage({
        type: 'history',
        history: this._messageHistory,
      });
    }
  }

  // Handle user message with context resolution
  private async _handleUserMessage(message: any) {
    // Parse and resolve inline references like [selection], [file], [workspace]
    let fullMessage = message.text;
    const resolvedReferences: any[] = [];

    // Auto-resolve inline references
    if (fullMessage.includes('[selection]')) {
      const selectionContext = await this._getCurrentSelection();
      if (selectionContext) {
        resolvedReferences.push(selectionContext);
        fullMessage = fullMessage.replace(
          '[selection]',
          `**${selectionContext.icon} ${selectionContext.name}**`
        );
      }
    }

    if (fullMessage.includes('[file]')) {
      const fileContext = await this._getCurrentFile();
      if (fileContext) {
        resolvedReferences.push(fileContext);
        fullMessage = fullMessage.replace(
          '[file]',
          `**${fileContext.icon} ${fileContext.name}**`
        );
      }
    }

    if (fullMessage.includes('[workspace]')) {
      const workspaceContext = await this._getWorkspaceInfo();
      if (workspaceContext) {
        resolvedReferences.push(workspaceContext);
        fullMessage = fullMessage.replace(
          '[workspace]',
          `**${workspaceContext.icon} ${workspaceContext.name}**`
        );
      }
    }

    // Add context items from bubbles
    if (message.contextItems && message.contextItems.length > 0) {
      for (const item of message.contextItems) {
        if (item.type === 'file' && item.path) {
          // For file bubbles, read the actual file content
          const fileContext = await this._handleAddFileToContext(item.path);
          if (fileContext) {
            resolvedReferences.push(fileContext);
          }
        } else if (item.type === 'selection') {
          // For selection bubbles, use the stored content
          resolvedReferences.push({
            icon: item.icon || '📝',
            name: item.name,
            content: item.content,
          });
        }
      }
    }

    // Add inline references from the message text
    if (message.inlineReferences && message.inlineReferences.length > 0) {
      for (const inlineRef of message.inlineReferences) {
        const refData = inlineRef.data;
        resolvedReferences.push({
          icon: refData.icon || '📝',
          name: `${refData.fileName}:${refData.startLine}-${refData.endLine}`,
          content: refData.content,
        });

        // Replace the reference in the message text with a readable format
        fullMessage = fullMessage.replace(
          inlineRef.reference,
          `**${refData.icon} ${refData.fileName}:${refData.startLine}-${refData.endLine}**`
        );
      }
    }

    // Build final message with all context
    if (resolvedReferences.length > 0) {
      const contextContent = resolvedReferences
        .map((item: any) => {
          return `**${item.icon} ${item.name}:**\n\`\`\`\n${item.content}\n\`\`\``;
        })
        .join('\n\n');
      fullMessage = `**Context:**\n${contextContent}\n\n**Question:**\n${message.text}`;
    }

    // Add user message to history
    this._messageHistory.push({ role: 'user', content: fullMessage });
    this._postMessageHistory();
    this._postMessageHistoryToPanel();

    // Show loading indicator
    this._messageHistory.push({
      role: 'loading',
      content: 'Thinking...',
    });
    this._postMessageHistory();
    this._postMessageHistoryToPanel();

    // Call AI
    try {
      const aiResponse = await this._callAI(fullMessage, false);
      // Remove loading
      this._messageHistory = this._messageHistory.filter(
        (msg) => msg.role !== 'loading'
      );
      this._messageHistory.push({ role: 'ai', content: aiResponse });
      this._postMessageHistory();
      this._postMessageHistoryToPanel();
    } catch (err: any) {
      this._messageHistory = this._messageHistory.filter(
        (msg) => msg.role !== 'loading'
      );
      this._messageHistory.push({
        role: 'error',
        content: `Error: ${err.message}`,
      });
      this._postMessageHistory();
      this._postMessageHistoryToPanel();
    }
  }

  // Handle file suggestions for @ mentions
  private async _handleFileSuggestions(query: string, cursorPos: number) {
    console.log('_handleFileSuggestions called with query:', query);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log('No workspace folders found');
      return;
    }

    try {
      // Show all files when no query, filtered files when query exists
      const searchPattern = query ? `**/*${query}*` : '**/*';
      const files = await vscode.workspace.findFiles(
        searchPattern,
        '**/node_modules/**',
        query ? 20 : 50
      );

      console.log('Found files:', files.length);

      const suggestions = files.map((file) => ({
        name: file.path.split('/').pop() || 'unknown',
        path: file.fsPath,
        relativePath: vscode.workspace.asRelativePath(file.fsPath),
      }));

      // Send to both view and panel
      const message = {
        type: 'showFileSuggestions',
        files: suggestions,
        cursorPos,
      };

      console.log('Sending file suggestions:', suggestions.length, 'files');

      if (this._view) {
        this._view.webview.postMessage(message);
      }
      if (this._panel) {
        this._panel.webview.postMessage(message);
      }
    } catch (error) {
      console.error('Error getting file suggestions:', error);
    }
  }

  // Handle adding file to context from @ mention
  private async _handleAddFileToContext(filePath: string) {
    try {
      const fileUri = vscode.Uri.file(filePath);
      const content = (await vscode.workspace.fs.readFile(fileUri)).toString();
      const fileName = filePath.split(/[\\/]/).pop() || 'unknown';
      const relativePath = vscode.workspace.asRelativePath(filePath);

      // Return context item for use in message processing
      return {
        icon: '📄',
        name: fileName,
        path: relativePath,
        content:
          content.length > 2000
            ? content.substring(0, 2000) + '\n... (truncated)'
            : content,
      };
    } catch (error) {
      console.error('Error adding file to context:', error);
      return null;
    }
  }

  private _getHtmlForWebview(): string {
    const config = vscode.workspace.getConfiguration();
    const currentProvider = config.get<string>(
      'aiCodingChat.activeProvider',
      'gpt'
    );
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval'; img-src data: https:;">
        <title>AI Coding Chat</title>
        <style>
          :root {
            --vscode-font-family: var(--vscode-font-family);
            --vscode-font-size: var(--vscode-font-size);
            --vscode-foreground: var(--vscode-foreground);
            --vscode-background: var(--vscode-sideBar-background);
            --vscode-input-background: var(--vscode-input-background);
            --vscode-input-foreground: var(--vscode-input-foreground);
            --vscode-input-border: var(--vscode-input-border);
            --vscode-button-background: var(--vscode-button-background);
            --vscode-button-foreground: var(--vscode-button-foreground);
            --vscode-button-hoverBackground: var(--vscode-button-hoverBackground);
            --vscode-button-secondaryBackground: var(--vscode-button-secondaryBackground);
            --vscode-button-secondaryForeground: var(--vscode-button-secondaryForeground);
            --vscode-button-secondaryHoverBackground: var(--vscode-button-secondaryHoverBackground);
            --vscode-panel-border: var(--vscode-panel-border);
            --vscode-textLink-foreground: var(--vscode-textLink-foreground);
            --vscode-badge-background: var(--vscode-badge-background);
            --vscode-badge-foreground: var(--vscode-badge-foreground);
          }
          
          * {
            box-sizing: border-box;
          }
          
          body { 
            font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            margin: 0; 
            padding: 0;
            background: var(--vscode-background);
            color: var(--vscode-foreground);
            height: 100%;
            overflow: hidden;
            display: flex;
            flex-direction: column;
          }
          
          #header { 
            padding: 12px 16px;
            background: var(--vscode-sideBarSectionHeader-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
          }
          
          #header label {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            color: var(--vscode-foreground);
          }
          
          #provider-select {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            padding: 4px 8px;
            font-size: 12px;
            min-width: 80px;
          }
          
          #provider-select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
          }
          
          #include-context {
            margin-right: 4px;
          }
          
          .message { 
            margin: 0; 
            padding: 8px 12px;
            border-radius: 8px;
            max-width: 85%;
            word-wrap: break-word;
            font-size: 13px;
            line-height: 1.4;
            position: relative;
          }
          
          .user { 
            background: var(--vscode-textBlockQuote-background, #007acc20);
            border: 1px solid var(--vscode-textBlockQuote-border, #007acc40);
            align-self: flex-end;
            margin-left: auto;
          }
          
          .ai { 
            background: var(--vscode-textCodeBlock-background, #1e1e1e10);
            border: 1px solid var(--vscode-panel-border, #333);
            align-self: flex-start;
          }
          
          .loading { 
            background: var(--vscode-notificationsInfoIcon-foreground, #3794ff20);
            border: 1px solid var(--vscode-notificationsInfoIcon-foreground, #3794ff40);
            color: var(--vscode-notificationsInfoIcon-foreground, #3794ff);
            font-style: italic;
            align-self: flex-start;
          }
          
          .error { 
            background: var(--vscode-errorBackground, #f48771);
            border: 1px solid var(--vscode-errorBorder, #e74c3c);
            color: var(--vscode-errorForeground, #ffffff);
            align-self: flex-start;
          }
          
          .system { 
            background: var(--vscode-badge-background, #4d4d4d);
            border: 1px solid var(--vscode-panel-border, #333);
            color: var(--vscode-badge-foreground, #ffffff);
            font-style: italic;
            align-self: flex-start;
            font-size: 12px;
          }
          
          #input-section {
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-background);
            position: sticky;
            bottom: 0;
            z-index: 10;
          }
          
          #input-row { 
            display: flex;
            padding: 12px;
            gap: 8px;
            align-items: center;
          }
          
          #user-input { 
            flex: 1;
            padding: 8px 12px;
            font-size: 13px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            resize: none;
            min-height: 20px;
            max-height: 100px;
            overflow-y: auto;
          }
          
          #user-input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
          }
          
          #user-input::placeholder {
            color: var(--vscode-input-placeholderForeground);
          }
          
          .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.15s ease;
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }
          
          .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
          }
          
          .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
          }
          
          .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-panel-border);
          }
          
          .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
          }
          
          .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          
          .btn-group {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
          }
          
          #chat-outer { 
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            overflow: hidden;
          }
          
          #chat-container { 
            flex: 1;
            padding: 8px 12px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 8px;
            background: var(--vscode-background);
            min-height: 0;
          }
          
          pre, code { 
            background: var(--vscode-textCodeBlock-background);
            color: var(--vscode-textPreformat-foreground);
            border-radius: 4px;
            padding: 2px 6px;
            font-family: var(--vscode-editor-font-family, 'Courier New', monospace);
          }
          
          pre {
            padding: 8px 12px;
            overflow-x: auto;
            border: 1px solid var(--vscode-panel-border);
          }
          
          .apply-btn {
            margin-top: 8px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: background-color 0.15s ease;
          }
          
          .apply-btn:hover {
            background: var(--vscode-button-hoverBackground);
          }
          
          /* Scrollbar styling */
          ::-webkit-scrollbar {
            width: 8px;
          }
          
          ::-webkit-scrollbar-track {
            background: var(--vscode-scrollbarSlider-background);
          }
          
          ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background);
            border-radius: 4px;
          }
          
          ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground);
          }
          
          /* Icon styles */
          .codicon {
            font-family: codicon;
            font-size: 14px;
          }
          
          /* Context bubbles */
          .context-bubbles {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 8px;
            padding: 0 12px;
          }
          
          .context-bubble {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 12px;
            padding: 2px 8px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 4px;
            max-width: 200px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          
          .context-bubble .remove-btn {
            background: none;
            border: none;
            color: var(--vscode-button-secondaryForeground);
            cursor: pointer;
            padding: 0;
            margin-left: 2px;
            font-size: 10px;
            opacity: 0.7;
          }
          
          .context-bubble .remove-btn:hover {
            opacity: 1;
          }
          
          #clear-context {
            margin-left: auto;
          }
        </style>
      </head>
      <body>
        <div id="header">
          <label for="provider-select">Provider:</label>
          <select id="provider-select">
            <option value="gpt"${
              currentProvider === 'gpt' ? ' selected' : ''
            }>GPT</option>
            <option value="claude"${
              currentProvider === 'claude' ? ' selected' : ''
            }>Claude</option>
            <option value="grok"${
              currentProvider === 'grok' ? ' selected' : ''
            }>Grok</option>
            <option value="gemini"${
              currentProvider === 'gemini' ? ' selected' : ''
            }>Gemini</option>
          </select>
        </div>
        
        <div id="chat-outer">
          <div id="chat-container"></div>
          <div id="input-section">
            <div id="context-bubbles" class="context-bubbles"></div>
            <div id="input-row">
              <textarea id="user-input" placeholder="Type @ to add files or ask anything..." rows="1"></textarea>
              <button id="send-btn" class="btn btn-primary">Send</button>
            </div>
          </div>
        </div>
        <script>
          console.log('[AIChat Webview] *** SCRIPT START ***');
          let vscode;
          let chatContainer;
          let userInput;
          let sendBtn;
          let providerSelect;
          let contextBubblesContainer;
          let md = null;
          try {
            console.log('[AIChat Webview] Acquiring vscode API...');
            vscode = acquireVsCodeApi();
            console.log('[AIChat Webview] vscode API acquired:', !!vscode);
            
            console.log('[AIChat Webview] Getting DOM elements...');
            chatContainer = document.getElementById("chat-container");
            userInput = document.getElementById("user-input");
            sendBtn = document.getElementById("send-btn");
            providerSelect = document.getElementById("provider-select");
            contextBubblesContainer = document.getElementById("context-bubbles");
            
            console.log('[AIChat Webview] Elements found:', {
              chatContainer: !!chatContainer,
              userInput: !!userInput,
              sendBtn: !!sendBtn,
              providerSelect: !!providerSelect,
              contextBubblesContainer: !!contextBubblesContainer
            });
            
            // Skip markdown-it for now to avoid errors
            // Try to initialize markdown-it if available in the webview environment.
            // Use a try/catch and keep a safe fallback to plain-text rendering to
            // avoid runtime exceptions inside the webview.
            try {
              if (window.markdownit && typeof window.markdownit === 'function') {
                md = window.markdownit({ html: false, linkify: true, typographer: true });
              }
            } catch (e) {
              console.warn('[AIChat Webview] markdown-it init failed, falling back to plain text', e);
              md = null;
            }

            console.log('[AIChat Webview] Setting up basic functionality...');

            setTimeout(() => {
              if (vscode) {
                vscode.postMessage({ type: 'webviewReady' });
              }
            }, 100);

            console.log('[AIChat Webview] *** SETUP COMPLETE ***');
            
          } catch (error) {
            console.error('[AIChat Webview] *** SCRIPT ERROR ***:', error);
          }

          // Context items storage
          let contextItems = [];
          
          // Inline references storage - stores actual content for references like [file.js:1-10]
          let inlineReferences = new Map();

          function sendMessage() {
            const text = userInput.value.trim();
            if (text) {
              vscode.postMessage({ type: "userMessage", text, contextItems, inlineReferences });
              userInput.value = '';
              inlineReferences.clear();
              contextItems = [];
              renderContextBubbles();
            }
          }

          function autoResize() {
            userInput.style.height = 'auto';
            userInput.style.height = userInput.scrollHeight + 'px';
          }

          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'history') {
              renderHistory(message.history);
            } else if (message.type === 'showFileSuggestions') {
              showFileSuggestions(message.files, message.cursorPos);
            } else if (message.type === 'insertLabel') {
              insertInlineReference(message);
            }
          });

          // Helper to safely extract the first triple-backtick code block from text
          function extractFirstCodeBlock(text) {
            try {
              const start = text.indexOf('\`\`\`');
              if (start === -1) return null;
              const end = text.indexOf('\`\`\`', start + 3);
              if (end === -1) return null;
              const before = text.substring(0, start);
              const code = text.substring(start + 3, end);
              return { before, code };
            } catch (e) {
              console.warn('[AIChat Webview] extractFirstCodeBlock failed', e);
              return null;
            }
          }

          function renderHistory(history) {
            console.log("Rendering history:", history?.length || 0, "messages");
            if (!history || !Array.isArray(history)) {
              console.error("Invalid history received:", history);
              return;
            }
            chatContainer.innerHTML = "";
            history.forEach((msg, idx) => {
              console.log("Rendering message", idx, msg.role, msg.content?.substring(0, 50));
              const div = document.createElement("div");
              div.className = "message " + msg.role;
              // Render markdown for ai/user/system, plain for loading/error
              if (msg.role === "ai" || msg.role === "user" || msg.role === "system") {
                // If markdown-it is available use it; otherwise render plain text
                if (md && typeof md.render === 'function') {
                  try {
                    div.innerHTML = md.render(msg.content);
                  } catch (e) {
                    console.warn('[AIChat Webview] md.render failed, falling back to text', e);
                    div.textContent = msg.content;
                  }
                } else {
                  // Basic plain-text rendering to avoid script errors in the webview
                  div.textContent = msg.content;
                }
                if (msg.role === "ai") {
                  try {
                    // Safely extract first code block without using fragile regexes
                    const cb = extractFirstCodeBlock(msg.content);

                    // If the assistant included an explicit "Replace content of <path> with:" line
                    // before a code block, pick up the path to enable Preview & Apply
                    if (cb && cb.code) {
                      let filePath = null;
                      if (cb.before) {
                        const marker = 'Replace content of ';
                        const markerIdx = cb.before.indexOf(marker);
                        if (markerIdx !== -1) {
                          const after = cb.before.substring(markerIdx + marker.length);
                          const withIdx = after.indexOf(' with:');
                          if (withIdx !== -1) {
                            filePath = after.substring(0, withIdx).trim();
                          } else {
                            // fallback: take first token
                            const parts = after.trim().split(/\s+/);
                            if (parts.length > 0) filePath = parts[0];
                          }
                        }
                      }

                      if (filePath) {
                        const codeBlock = cb.code;
                        const btn = document.createElement("button");
                        btn.textContent = "Preview & Apply";
                        btn.className = "apply-btn";
                        btn.onclick = () => {
                          vscode.postMessage({ type: "previewEdit", filePath, newContent: codeBlock });
                        };
                        div.appendChild(btn);
                      }

                      // Also provide an apply-inline button (apply to selection or file)
                      let target = null;
                      if (cb.before) {
                        const lower = cb.before.toLowerCase();
                        if (lower.includes('selection')) target = 'selection';
                        else if (lower.includes('current file')) target = 'current file';
                      }

                      const inlineCode = cb.code;
                      if (inlineCode) {
                        const btn = document.createElement("button");
                        btn.textContent = target === 'selection' ? "Apply to Selection" : "Apply to Editor";
                        btn.className = "apply-btn";
                        btn.onclick = () => {
                          vscode.postMessage({ type: "applyInline", target, codeBlock: inlineCode });
                        };
                        div.appendChild(btn);
                      }
                    }
                  } catch (e) {
                    console.warn('[AIChat Webview] renderHistory: code-block processing failed', e);
                  }
                }
              } else {
                div.textContent = msg.content;
              }
              chatContainer.appendChild(div);
            });
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }

          // Handle @ mentions for file suggestions
          function handleAtMention(text, cursorPos) {
            console.log("handleAtMention called:", text, cursorPos);
            const beforeCursor = text.substring(0, cursorPos);
            const atMatch = beforeCursor.match(/@([^@\s]*)$/);
            
            if (atMatch) {
              console.log("@ detected, query:", atMatch[1]);
              const query = atMatch[1];
              vscode.postMessage({ type: "requestFileSuggestions", query, cursorPos });
            } else {
              hideFileSuggestions();
            }
          }

          // Context bubbles management
          function addContextBubble(item) {
            // Check if already exists
            if (contextItems.find(ctx => ctx.path === item.path && ctx.type === item.type)) {
              return;
            }
            
            contextItems.push(item);
            renderContextBubbles();
          }
          
          function removeContextBubble(index) {
            contextItems.splice(index, 1);
            renderContextBubbles();
          }
          
          function renderContextBubbles() {
            contextBubblesContainer.innerHTML = '';
            
            contextItems.forEach((item, index) => {
              const bubble = document.createElement('div');
              bubble.className = 'context-bubble';
              
              const icon = item.type === 'file' ? '📄' : '📝';
              const name = item.name || item.path?.split('/').pop() || 'Unknown';
              
              const iconSpan = document.createElement('span');
              iconSpan.textContent = icon;
              
              const nameSpan = document.createElement('span');
              nameSpan.textContent = name;
              nameSpan.title = item.path || '';
              
              const removeBtn = document.createElement('button');
              removeBtn.className = 'remove-btn';
              removeBtn.textContent = '×';
              removeBtn.onclick = () => removeContextBubble(index);
              
              bubble.appendChild(iconSpan);
              bubble.appendChild(nameSpan);
              bubble.appendChild(removeBtn);
              
              contextBubblesContainer.appendChild(bubble);
            });
            
            // Show/hide container based on content
            contextBubblesContainer.style.display = contextItems.length > 0 ? 'flex' : 'none';
          }
          
          // Make removeContextBubble globally accessible
          window.removeContextBubble = removeContextBubble;
          
          // Insert inline reference into input text
          function insertInlineReference(message) {
            console.log('[AIChat Webview] insertInlineReference called with:', message);
            console.log('[AIChat Webview] userInput element:', userInput);
            
            const { label: reference, contextItem } = message;
            const { content, fileName, startLine, endLine } = contextItem;
            
            // Store the reference content for later resolution
            inlineReferences.set(reference, {
              content: content,
              fileName: fileName,
              startLine: startLine,
              endLine: endLine,
              icon: '📝'
            });
            
            console.log('[AIChat Webview] Stored reference:', reference);
            console.log('[AIChat Webview] Current input value:', userInput.value);
            
            // Insert reference into input at cursor position
            const cursorPos = userInput.selectionStart;
            const text = userInput.value;
            const beforeCursor = text.substring(0, cursorPos);
            const afterCursor = text.substring(cursorPos);
            
            // Add space before reference if needed
            const needSpaceBefore = beforeCursor.length > 0 && !beforeCursor.endsWith(' ');
            const spaceBefore = needSpaceBefore ? ' ' : '';
            
            const newText = beforeCursor + spaceBefore + reference + ' ' + afterCursor;
            userInput.value = newText;
            
            console.log('[AIChat Webview] New input value:', userInput.value);
            
            // Set cursor position after the reference
            const newCursorPos = cursorPos + spaceBefore.length + reference.length + 1;
            userInput.setSelectionRange(newCursorPos, newCursorPos);
            
            // Focus input and auto-resize
            userInput.focus();
            autoResize();
            
            console.log('[AIChat Webview] Inserted inline reference:', reference);
          }
          
          function hideFileSuggestions() {
            const existing = document.querySelector('.file-suggestions');
            if (existing) {
              existing.remove();
            }
          }
          
          function showFileSuggestions(files, cursorPos) {
            console.log('showFileSuggestions called with', files.length, 'files');
            hideFileSuggestions();
            
            if (files.length === 0) {
              console.log('No files to show');
              return;
            }
            
            const suggestions = document.createElement('div');
            suggestions.className = 'file-suggestions';
            suggestions.style.cssText = 'position: absolute; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); border-radius: 4px; max-height: 200px; overflow-y: auto; z-index: 1000; min-width: 200px;';
            
            files.forEach(file => {
              const item = document.createElement('div');
              item.style.cssText = 'padding: 8px 12px; cursor: pointer; font-size: 12px; color: var(--vscode-menu-foreground);';
              item.textContent = file.name;
              item.title = file.path;
              
              item.addEventListener('mouseenter', () => {
                item.style.background = 'var(--vscode-menu-selectionBackground)';
              });
              item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
              });
              item.addEventListener('click', () => {
                insertFileReference(file, cursorPos);
                hideFileSuggestions();
              });
              
              suggestions.appendChild(item);
            });
            
            // Position suggestions
            const rect = userInput.getBoundingClientRect();
            suggestions.style.top = (rect.top - suggestions.offsetHeight) + 'px';
            suggestions.style.left = rect.left + 'px';
            
            document.body.appendChild(suggestions);
          }
          
          function insertFileReference(file, cursorPos) {
            const text = userInput.value;
            const beforeCursor = text.substring(0, cursorPos);
            const afterCursor = text.substring(cursorPos);
            const atMatch = beforeCursor.match(/@([^@\s]*)$/);
            
            if (atMatch) {
              const beforeAt = beforeCursor.substring(0, atMatch.index);
              // Remove the @ mention from text since we'll show it as label
              const insert = file.name;
              const newText = beforeAt + insert + afterCursor;
              userInput.value = newText.trim();
              userInput.focus();
              // Set cursor position after the inserted file name
              const newCursorPos = beforeAt.length + insert.length;
              userInput.setSelectionRange(newCursorPos, newCursorPos);
              // Optionally, still add as context bubble if needed (or skip)
              // addContextBubble({
              //   type: 'file',
              //   name: file.name,
              //   path: file.path,
              //   relativePath: file.relativePath || file.path
              // });
              // Add file content to context if needed
              vscode.postMessage({ type: "addFileToContext", filePath: file.path });
            }
          }

          providerSelect.addEventListener("change", (e) => {
            vscode.postMessage({ type: "setProvider", provider: e.target.value });
          });
          
          sendBtn.addEventListener("click", sendMessage);
          
          // Auto-resize textarea and handle Enter key
          userInput.addEventListener("input", (e) => {
            autoResize();
            handleAtMention(e.target.value, e.target.selectionStart);
          });
          userInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  // Main AI call dispatcher
  private async _callAI(
    userText: string,
    includeContext: boolean = true
  ): Promise<string> {
    // Handle /read and /edit commands
    if (userText.startsWith('/read ')) {
      const filePath = userText.replace('/read ', '').trim();
      return await this._handleReadFile(filePath);
    }
    if (userText.startsWith('/edit ')) {
      // Format: /edit path/to/file <new content>
      const match = userText.match(/^\/edit\s+([^\s]+)\s+([\s\S]*)$/);
      if (!match) {
        return 'Usage: /edit <file> <new content>';
      }
      const filePath = match[1];
      const newContent = match[2];
      return await this._handleEditFile(filePath, newContent);
    }

    // Add workspace context to user message if enabled
    let enhancedUserText = userText;
    if (includeContext) {
      const contextInfo = await this._getWorkspaceContext();
      enhancedUserText = contextInfo
        ? `${contextInfo}\n\n**User Question:**\n${userText}`
        : userText;
    }

    const config = vscode.workspace.getConfiguration();
    const provider = config.get<string>('aiCodingChat.activeProvider', 'gpt');
    if (provider === 'gpt') {
      return this._callOpenAIGPT(enhancedUserText);
    } else if (provider === 'claude') {
      return this._callClaudeStub(enhancedUserText);
    } else if (provider === 'grok') {
      return this._callGrokStub(enhancedUserText);
    } else if (provider === 'gemini') {
      return this._callGeminiStub(userText);
    } else {
      throw new Error('Unknown provider: ' + provider);
    }
  }

  // Get current workspace context information
  private async _getWorkspaceContext(): Promise<string | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }

    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop();
    const relativePath = vscode.workspace.asRelativePath(document.fileName);
    const languageId = document.languageId;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const workspaceName = workspaceFolder ? workspaceFolder.name : 'Unknown';

    // Get selection info if any
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    let selectionInfo = '';
    if (hasSelection) {
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      selectionInfo = `\n- Selected lines: ${startLine}-${endLine}`;
    }

    return [
      `**Current Context:**`,
      `- Workspace: ${workspaceName}`,
      `- Current file: \`${fileName}\``,
      `- File path: \`${relativePath}\``,
      `- Language: ${languageId}${selectionInfo}`,
      '',
    ].join('\n');
  }

  // Handle /read command
  private async _handleReadFile(filePath: string): Promise<string> {
    try {
      const wsFolders = vscode.workspace.workspaceFolders;
      if (!wsFolders || wsFolders.length === 0) {
        return 'No workspace folder open.';
      }
      const root = wsFolders[0].uri.fsPath;
      const absPath = require('path').resolve(root, filePath);
      if (!absPath.startsWith(root)) {
        return 'Error: Can only read files within the workspace.';
      }
      const fileUri = vscode.Uri.file(absPath);
      const content = (await vscode.workspace.fs.readFile(fileUri)).toString();
      // Limit output size for chat
      if (content.length > 4000) {
        return (
          'File is too large to display in chat (showing first 4000 chars):\n' +
          content.slice(0, 4000)
        );
      }
      return '```\n' + content + '\n```';
    } catch (err: any) {
      return 'Error reading file: ' + (err?.message || String(err));
    }
  }

  // Handle /edit command
  private async _handleEditFile(
    filePath: string,
    newContent: string
  ): Promise<string> {
    try {
      const wsFolders = vscode.workspace.workspaceFolders;
      if (!wsFolders || wsFolders.length === 0) {
        return 'No workspace folder open.';
      }
      const root = wsFolders[0].uri.fsPath;
      const absPath = require('path').resolve(root, filePath);
      if (!absPath.startsWith(root)) {
        return 'Error: Can only edit files within the workspace.';
      }
      const fileUri = vscode.Uri.file(absPath);
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(newContent));
      return `File ${filePath} updated successfully.`;
    } catch (err: any) {
      return 'Error editing file: ' + (err?.message || String(err));
    }
  }

  // Helper methods for inline reference resolution
  private async _getCurrentSelection(): Promise<any | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return null;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop() || 'unknown';
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;

    return {
      type: 'selection',
      name: `${fileName}:${startLine}-${endLine}`,
      fullName: `Selection from ${fileName} (lines ${startLine}-${endLine})`,
      content: selectedText,
      icon: '📝',
    };
  }

  private async _getCurrentFile(): Promise<any | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }

    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop() || 'unknown';
    const relativePath = vscode.workspace.asRelativePath(document.fileName);
    const content = document.getText();

    return {
      type: 'file',
      name: fileName,
      fullName: relativePath,
      content: content,
      icon: '📄',
    };
  }

  private async _getWorkspaceInfo(): Promise<any | null> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }

    const workspaceFolder = workspaceFolders[0];
    const workspaceName = workspaceFolder.name;
    const workspacePath = workspaceFolder.uri.fsPath;

    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');

      let structure = '';
      try {
        structure = execSync(
          'find . -type f -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md" | head -10',
          {
            cwd: workspacePath,
            encoding: 'utf8',
            timeout: 3000,
          }
        );
      } catch {
        const files = fs.readdirSync(workspacePath);
        structure = files.slice(0, 10).join('\n');
      }

      const projectFiles = ['package.json', 'tsconfig.json', 'README.md'];
      const existingFiles = projectFiles.filter((file) => {
        try {
          fs.accessSync(path.join(workspacePath, file));
          return true;
        } catch {
          return false;
        }
      });

      const contextContent = [
        `**Workspace: ${workspaceName}**`,
        `Path: ${workspacePath}`,
        `Project files: ${existingFiles.join(', ')}`,
        ``,
        `**Structure:**`,
        structure.trim(),
      ].join('\n');

      return {
        type: 'workspace',
        name: workspaceName,
        fullName: `Workspace: ${workspaceName}`,
        content: contextContent,
        icon: '📁',
      };
    } catch {
      return null;
    }
  }

  // OpenAI GPT integration
  private async _callOpenAIGPT(userText: string): Promise<string> {
    const config = vscode.workspace.getConfiguration();
    const apiKey = config.get<string>('aiCodingChat.gptApiKey', '');
    if (!apiKey) {
      throw new Error(
        'No OpenAI API key set. Please add it in the extension settings.'
      );
    }
    // Use gpt-3.5-turbo for now
    const url = 'https://api.openai.com/v1/chat/completions';
    const messages = [
      ...this._messageHistory
        .filter((m) => m.role === 'user' || m.role === 'ai')
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        })),
      { role: 'user', content: userText },
    ];
    const body = {
      model: 'gpt-3.5-turbo',
      messages,
      temperature: 0.7,
      stream: false,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('OpenAI API error: ' + err);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '[No response]';
  }

  // Anthropic Claude integration
  private async _callClaudeStub(userText: string): Promise<string> {
    // Real implementation
    const config = vscode.workspace.getConfiguration();
    const apiKey = config.get<string>('aiCodingChat.claudeApiKey', '');
    if (!apiKey) {
      throw new Error(
        'No Claude API key set. Please add it in the extension settings.'
      );
    }
    // Claude v1/messages endpoint
    const url = 'https://api.anthropic.com/v1/messages';
    // Build message history for Claude
    // Claude expects a single prompt string, so concatenate
    const body = {
      model: 'claude-3-opus-20240229',
      max_tokens: 1024,
      temperature: 0.7,
      messages: [{ role: 'user', content: userText }],
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('Claude API error: ' + err);
    }
    const data = await res.json();
    // Claude's response is in data.content[0].text
    return data.content?.[0]?.text?.trim() || '[No response]';
  }
  // Grok (xAI) integration
  private async _callGrokStub(userText: string): Promise<string> {
    const config = vscode.workspace.getConfiguration();
    const apiKey = config.get<string>('aiCodingChat.grokApiKey', '');
    if (!apiKey) {
      throw new Error(
        'No Grok API key set. Please add it in the extension settings.'
      );
    }
    // Grok (xAI) endpoint (assume OpenAI-compatible)
    const url = 'https://api.grok.x.ai/v1/chat/completions';
    const messages = [
      ...this._messageHistory
        .filter((m) => m.role === 'user' || m.role === 'ai')
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        })),
      { role: 'user', content: userText },
    ];
    const body = {
      model: 'grok-1',
      messages,
      temperature: 0.7,
      stream: false,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('Grok API error: ' + err);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '[No response]';
  }
  // Gemini (Google) integration
  private async _callGeminiStub(userText: string): Promise<string> {
    const config = vscode.workspace.getConfiguration();
    const apiKey = config.get<string>('aiCodingChat.geminiApiKey', '');
    if (!apiKey) {
      throw new Error(
        'No Gemini API key set. Please add it in the extension settings.'
      );
    }
    // Gemini endpoint
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`;
    // Gemini expects a list of messages as [{role: 'user', parts: [{text: ...}]}]
    const history = [
      ...this._messageHistory
        .filter((m) => m.role === 'user' || m.role === 'ai')
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.content }],
        })),
      { role: 'user', parts: [{ text: userText }] },
    ];
    const body = {
      contents: history,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error('Gemini API error: ' + err);
    }
    const data = await res.json();
    // Gemini's response is in data.candidates[0].content.parts[0].text
    return (
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[No response]'
    );
  }

  // Listen for previewEdit messages and show diff/approval
  private _showPreviewAndApply(filePath: string, newContent: string) {
    vscode.window
      .showInformationMessage(
        `Preview and apply edit to ${filePath}?`,
        'Show Diff',
        'Apply',
        'Cancel'
      )
      .then(async (choice) => {
        if (choice === 'Show Diff') {
          await this._showDiff(filePath, newContent);
        } else if (choice === 'Apply') {
          const result = await this._handleEditFile(filePath, newContent);
          this._messageHistory.push({ role: 'system', content: result });
          this._postMessageHistory();
        }
      });
  }

  private async _showDiff(filePath: string, newContent: string) {
    try {
      const wsFolders = vscode.workspace.workspaceFolders;
      if (!wsFolders || wsFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      const root = wsFolders[0].uri.fsPath;
      const absPath = require('path').resolve(root, filePath);
      if (!absPath.startsWith(root)) {
        vscode.window.showErrorMessage(
          'Can only show diff for files in workspace.'
        );
        return;
      }
      const fileUri = vscode.Uri.file(absPath);
      let oldContent = '';
      try {
        oldContent = (await vscode.workspace.fs.readFile(fileUri)).toString();
      } catch {
        oldContent = '';
      }
      const left = vscode.Uri.parse('untitled:' + filePath + ' (Current)');
      const right = vscode.Uri.parse('untitled:' + filePath + ' (Proposed)');
      await vscode.workspace.openTextDocument(left).then(() => {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(left, new vscode.Position(0, 0), oldContent);
        return vscode.workspace.applyEdit(edit);
      });
      await vscode.workspace.openTextDocument(right).then(() => {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(right, new vscode.Position(0, 0), newContent);
        return vscode.workspace.applyEdit(edit);
      });
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `Diff: ${filePath}`
      );
    } catch (err: any) {
      vscode.window.showErrorMessage(
        'Error showing diff: ' + (err?.message || String(err))
      );
    }
  }

  // Send current file content as a user message with enhanced context
  private async _handleSendCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._messageHistory.push({
        role: 'system',
        content: 'No file is currently open.',
      });
      this._postMessageHistory();
      return;
    }

    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop();
    const relativePath = vscode.workspace.asRelativePath(document.fileName);
    const content = document.getText();
    const lineCount = document.lineCount;
    const languageId = document.languageId;

    // Get workspace folder info
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const workspaceName = workspaceFolder ? workspaceFolder.name : 'Unknown';

    // Create enhanced context message
    const contextInfo = [
      `**File Context:**`,
      `- File: \`${fileName}\``,
      `- Path: \`${relativePath}\``,
      `- Language: ${languageId}`,
      `- Lines: ${lineCount}`,
      `- Workspace: ${workspaceName}`,
      ``,
      `**File Content:**`,
    ].join('\n');

    this._messageHistory.push({
      role: 'user',
      content: `${contextInfo}\n\n\`\`\`${languageId}\n${content}\`\`\``,
    });
    this._postMessageHistory();
  }

  // Send current selection as a user message with enhanced context
  private async _handleSendSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._messageHistory.push({
        role: 'system',
        content: 'No file is currently open.',
      });
      this._postMessageHistory();
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    if (!selectedText) {
      this._messageHistory.push({
        role: 'system',
        content: 'No text is selected.',
      });
      this._postMessageHistory();
      return;
    }

    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop();
    const relativePath = vscode.workspace.asRelativePath(document.fileName);
    const languageId = document.languageId;
    const startLine = selection.start.line + 1; // 1-based line numbers
    const endLine = selection.end.line + 1;
    const startChar = selection.start.character;
    const endChar = selection.end.character;

    // Get workspace folder info
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const workspaceName = workspaceFolder ? workspaceFolder.name : 'Unknown';

    // Create enhanced context message
    const contextInfo = [
      `**Selection Context:**`,
      `- File: \`${fileName}\``,
      `- Path: \`${relativePath}\``,
      `- Language: ${languageId}`,
      `- Lines: ${startLine}-${endLine}`,
      `- Characters: ${startChar}-${endChar}`,
      `- Workspace: ${workspaceName}`,
      ``,
      `**Selected Content:**`,
    ].join('\n');

    this._messageHistory.push({
      role: 'user',
      content: `${contextInfo}\n\n\`\`\`${languageId}\n${selectedText}\`\`\``,
    });
    this._postMessageHistory();
  }

  // Send workspace structure information
  private async _handleSendWorkspaceInfo() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._messageHistory.push({
        role: 'system',
        content: 'No workspace folder is open.',
      });
      this._postMessageHistory();
      return;
    }

    const workspaceFolder = workspaceFolders[0];
    const workspaceName = workspaceFolder.name;
    const workspacePath = workspaceFolder.uri.fsPath;

    // Get basic workspace structure
    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');

      let structure = '';

      // Try to get git structure first
      try {
        structure = execSync(
          'find . -type f -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md" | head -20',
          {
            cwd: workspacePath,
            encoding: 'utf8',
            timeout: 5000,
          }
        );
      } catch {
        // Fallback to reading directory
        const files = fs.readdirSync(workspacePath);
        structure = files.slice(0, 20).join('\n');
      }

      // Check for common project files
      const projectFiles = [
        'package.json',
        'tsconfig.json',
        'README.md',
        '.gitignore',
      ];
      const existingFiles = projectFiles.filter((file) => {
        try {
          fs.accessSync(path.join(workspacePath, file));
          return true;
        } catch {
          return false;
        }
      });

      const contextInfo = [
        `**Workspace Information:**`,
        `- Name: ${workspaceName}`,
        `- Path: \`${workspacePath}\``,
        `- Project files found: ${existingFiles.join(', ')}`,
        ``,
        `**Directory Structure (sample):**`,
        '```',
        structure.trim(),
        '```',
      ].join('\n');

      this._messageHistory.push({
        role: 'user',
        content: contextInfo,
      });
      this._postMessageHistory();
    } catch (error) {
      this._messageHistory.push({
        role: 'system',
        content: `Could not read workspace structure: ${error}`,
      });
      this._postMessageHistory();
    }
  }

  // Add current file as context
  private async _handleAddCurrentFileContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop();
    const relativePath = vscode.workspace.asRelativePath(document.fileName);
    const content = document.getText();

    if (this._view) {
      this._view.webview.postMessage({
        type: 'addContext',
        contextType: 'file',
        name: fileName,
        fullName: relativePath,
        content: content,
        icon: '📄',
      });
    }
  }

  // Add current selection as context
  private async _handleAddSelectionContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    if (!selectedText) {
      return;
    }

    const document = editor.document;
    const fileName = document.fileName.split(/[\\/]/).pop();
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const name = `${fileName}:${startLine}-${endLine}`;

    if (this._view) {
      this._view.webview.postMessage({
        type: 'addContext',
        contextType: 'selection',
        name: name,
        fullName: `${fileName} lines ${startLine}-${endLine}`,
        content: selectedText,
        icon: '📝',
      });
    }
  }

  // Add workspace info as context
  private async _handleAddWorkspaceContext() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const workspaceFolder = workspaceFolders[0];
    const workspaceName = workspaceFolder.name;
    const workspacePath = workspaceFolder.uri.fsPath;

    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');

      let structure = '';

      try {
        structure = execSync(
          'find . -type f -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md" | head -20',
          {
            cwd: workspacePath,
            encoding: 'utf8',
            timeout: 5000,
          }
        );
      } catch {
        const files = fs.readdirSync(workspacePath);
        structure = files.slice(0, 20).join('\n');
      }

      const projectFiles = [
        'package.json',
        'tsconfig.json',
        'README.md',
        '.gitignore',
      ];
      const existingFiles = projectFiles.filter((file) => {
        try {
          fs.accessSync(path.join(workspacePath, file));
          return true;
        } catch {
          return false;
        }
      });

      const content = [
        `Workspace: ${workspaceName}`,
        `Path: ${workspacePath}`,
        `Project files: ${existingFiles.join(', ')}`,
        ``,
        `Directory structure:`,
        structure.trim(),
      ].join('\n');

      if (this._view) {
        this._view.webview.postMessage({
          type: 'addContext',
          contextType: 'workspace',
          name: workspaceName,
          fullName: `Workspace: ${workspaceName}`,
          content: content,
          icon: '📁',
        });
      }
    } catch (error) {
      // Silent fail for workspace context
    }
  }

  // Show context menu to select what to add
  private async _handleShowContextMenu() {
    const items = [
      {
        label: '$(file) Current file',
        description: 'Add the current active file as context',
        action: 'file',
      },
      {
        label: '$(symbol-text) Selection',
        description: 'Add the current text selection as context',
        action: 'selection',
      },
      {
        label: '$(folder) Workspace',
        description: 'Add workspace information as context',
        action: 'workspace',
      },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Choose context to add',
    });

    if (selected) {
      switch (selected.action) {
        case 'file':
          await this._handleAddCurrentFileContext();
          break;
        case 'selection':
          await this._handleAddSelectionContext();
          break;
        case 'workspace':
          await this._handleAddWorkspaceContext();
          break;
      }
    }
  }

  // Apply inline code suggestion to editor
  private async _handleApplyInline(target: string | null, codeBlock: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._messageHistory.push({
        role: 'system',
        content: 'No file is currently open.',
      });
      this._postMessageHistory();
      return;
    }
    const document = editor.document;
    const edit = new vscode.WorkspaceEdit();
    let oldText = '';
    let range: vscode.Range;
    if (target === 'selection' && !editor.selection.isEmpty) {
      range = new vscode.Range(editor.selection.start, editor.selection.end);
      oldText = document.getText(range);
      edit.replace(document.uri, range, codeBlock);
    } else {
      // Whole file
      range = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      oldText = document.getText();
      edit.replace(document.uri, range, codeBlock);
    }
    await vscode.workspace.applyEdit(edit);
    this._messageHistory.push({
      role: 'system',
      content: `Applied suggestion to ${
        target === 'selection' ? 'selection' : 'entire file'
      }. [Undo]`,
    });
    this._postMessageHistory();
    // Listen for undo click in chat (simple: next user message "undo" will revert)
    const undoHandler = async (message: any) => {
      if (
        message.type === 'userMessage' &&
        message.text.trim().toLowerCase() === 'undo'
      ) {
        const undoEdit = new vscode.WorkspaceEdit();
        undoEdit.replace(document.uri, range, oldText);
        await vscode.workspace.applyEdit(undoEdit);
        this._messageHistory.push({ role: 'system', content: 'Undo applied.' });
        this._postMessageHistory();
        if (this._view) {
          this._view.webview.onDidReceiveMessage(undefined as any); // Remove handler
        }
      }
    };
    if (this._view) {
      this._view.webview.onDidReceiveMessage(undoHandler);
    }
  }
}
