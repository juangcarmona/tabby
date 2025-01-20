import { ChatEditCommand } from "tabby-agent";
import { Config } from "../Config";
import {
  CancellationTokenSource,
  QuickPickItem,
  ThemeIcon,
  QuickPickItemKind,
  window,
  TextEditor,
  Selection,
  Position,
  QuickPick,
  QuickPickItemButtonEvent,
} from "vscode";
import { Client } from "../lsp/Client";
import { ContextVariables } from "../ContextVariables";
import { getLogger } from "../logger";
import { diffChars } from "diff";

export class InlineEditController {
  private readonly logger = getLogger("InlineEditController");
  private chatEditCancellationTokenSource: CancellationTokenSource | null = null;
  private quickPick: QuickPick<EditCommand>;

  private recentlyCommand: string[] = [];
  private suggestedCommand: ChatEditCommand[] = [];
  private originalText: string | null = null;

  constructor(
    private client: Client,
    private config: Config,
    private contextVariables: ContextVariables,
    private editor: TextEditor,
    private editLocation: EditLocation,
    private userCommand?: string,
  ) {
    this.recentlyCommand = this.config.chatEditRecentlyCommand.slice(0, this.config.maxChatEditHistory);

    const fetchingSuggestedCommandCancellationTokenSource = new CancellationTokenSource();
    this.client.chat.provideEditCommands(
      { location: editLocation },
      { commands: this.suggestedCommand, callback: () => this.updateQuickPickList() },
      fetchingSuggestedCommandCancellationTokenSource.token,
    );

    const quickPick = window.createQuickPick<EditCommand>();
    quickPick.placeholder = "Enter the command for editing";
    quickPick.matchOnDescription = true;
    quickPick.onDidChangeValue(() => this.updateQuickPickList());
    quickPick.onDidHide(() => {
      fetchingSuggestedCommandCancellationTokenSource.cancel();
    });
    quickPick.onDidAccept(this.onDidAccept, this);
    quickPick.onDidTriggerItemButton(this.onDidTriggerItemButton, this);

    this.quickPick = quickPick;
  }

  async start() {
    this.logger.log(`Start inline edit with user command: ${this.userCommand}`);
    this.userCommand ? await this.provideEditWithCommand(this.userCommand) : this.quickPick.show();
  }

  private async onDidAccept() {
    const command = this.quickPick.selectedItems[0]?.value;
    this.quickPick.hide();
    if (!command) {
      return;
    }
    if (command && command.length > 200) {
      window.showErrorMessage("Command is too long.");
      return;
    }
    await this.provideEditWithCommand(command);
  }

  private async provideEditWithCommand(command: string) {
    const startPosition = new Position(this.editLocation.range.start.line, this.editLocation.range.start.character);
    const endPosition = new Position(this.editLocation.range.end.line, this.editLocation.range.end.character);

    this.originalText = this.editor.document.getText(new Selection(startPosition, endPosition));

    if (!this.userCommand) {
      const updatedRecentlyCommand = [command]
        .concat(this.recentlyCommand.filter((item) => item !== command))
        .slice(0, this.config.maxChatEditHistory);
      await this.config.updateChatEditRecentlyCommand(updatedRecentlyCommand);
    }

    this.editor.selection = new Selection(startPosition, startPosition);
    this.contextVariables.chatEditInProgress = true;
    this.chatEditCancellationTokenSource = new CancellationTokenSource();
    this.logger.log(`Provide edit with command: ${command}`);
    try {
      const token = await this.client.chat.provideEdit(
        {
          location: this.editLocation,
          command,
          format: "previewChanges",
        },
        this.chatEditCancellationTokenSource.token,
      );
      if (token) {
        await this.highlightChanges(token);
      }
    } catch (error) {
      if (typeof error === "object" && error && "message" in error && typeof error["message"] === "string") {
        window.showErrorMessage(error["message"]);
      }
    }
    this.chatEditCancellationTokenSource.dispose();
    this.chatEditCancellationTokenSource = null;
    this.contextVariables.chatEditInProgress = false;
    this.editor.selection = new Selection(startPosition, startPosition);
  }



  private async highlightChanges(token: string) {
    const editorContent = this.editor.document.getText();
    const startMarker = `<<<<<< ${token}`;
    const endMarker = `>>>>>> ${token}`;
  
    this.logger.log(`Original Text:\n${this.originalText}`);
    this.logger.log(`Editor Content (After Provide Edit):\n${editorContent}`);
  
    const startMarkerIndex = editorContent.indexOf(startMarker);
    const endMarkerIndex = editorContent.indexOf(endMarker);

    this.logger.debug("Start Marker Index:", startMarkerIndex);
    this.logger.debug("End Marker Index:", endMarkerIndex);
  
    if (startMarkerIndex === -1 || endMarkerIndex === -1) {
      this.logger.error("Unable to find change markers in the document.");
      return;
    }
  
    // Determinar el rango del texto original y modificado
    const startOfModifiedText = editorContent.indexOf("\n", startMarkerIndex) + 1;
    const endOfModifiedText = editorContent.lastIndexOf("\n", endMarkerIndex);
    this.logger.debug("Start of Modified Text:", startOfModifiedText);
    this.logger.debug("End of Modified Text:", endOfModifiedText);
  
    const modifiedText = editorContent.slice(startOfModifiedText, endOfModifiedText).trim();
    this.logger.debug("Modified Text:", modifiedText);
  
    if (!this.originalText) {
      this.logger.error("Original text is missing.");
      return;
    }
  
    // Dividir las líneas de texto
    const originalTextLines = this.originalText.split("\n");
    const fullDiffLines = modifiedText.split("\n");
    this.logger.debug("originalTextLines:", originalTextLines);
    this.logger.debug("fullDiffLines:", fullDiffLines);
  
    this.logger.log(`Number of Original Text Lines: ${originalTextLines.length}`);
    const modifiedLines = fullDiffLines.slice(originalTextLines.length-1);
  
    this.logger.log(`Modified Lines:\n${JSON.stringify(modifiedLines, null, 2)}`);
  
    // Determinar el offset de las líneas modificadas en el editor
    // const modifiedStartLine = originalTextLines.length; // Donde empieza el texto modificado
    const modifiedTextStartIndex = editorContent.indexOf(modifiedLines.join("\n"), startOfModifiedText);
  
    // Usar `diff` para comparar caracteres entre el texto original y el modificado
    const differences = diffChars(this.originalText, modifiedLines.join("\n"));
  
    const decorationRanges: Selection[] = [];
    let currentModifiedIndex = modifiedTextStartIndex; // Índice absoluto dentro del editor
    this.logger.debug(`Modified Text Start Index: ${modifiedTextStartIndex}`);
  
    this.logger.log(`Diff Results:\n${JSON.stringify(differences, null, 2)}`);
  
    for (const part of differences) {
      if (part.added) {
        this.logger.log(`Added part detected: "${part.value}"`);
        for (const char of part.value) {
          const absoluteIndex = currentModifiedIndex;
  
          // Obtener la posición exacta en el editor
          const start = this.editor.document.positionAt(absoluteIndex);
          const end = new Position(start.line, start.character + 1);
  
          decorationRanges.push(new Selection(start, end));
          this.logger.log(`Highlighted char: "${char}" at ${start.line}:${start.character}`);
  
          currentModifiedIndex++;
        }
      } else if (part.removed) {
        this.logger.log(`Removed part detected (ignored): "${part.value}"`);
      } else {
        this.logger.log(`Unchanged part detected: "${part.value}"`);
        currentModifiedIndex += part.value.length;
      }
    }
  
    // Aplicar decoraciones a los caracteres modificados
    const decorationType = window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 255, 255, 0.3)"
    });
    
  
    this.editor.setDecorations(decorationType, decorationRanges);
  
    this.logger.log(`Highlighted changes for token: ${token}`);
  }
  
  
  



  private async onDidTriggerItemButton(event: QuickPickItemButtonEvent<EditCommand>) {
    const item = event.item;
    const button = event.button;
    if (button.iconPath instanceof ThemeIcon && button.iconPath.id === "settings-remove") {
      const index = this.recentlyCommand.indexOf(item.value);
      if (index !== -1) {
        this.recentlyCommand.splice(index, 1);
        await this.config.updateChatEditRecentlyCommand(this.recentlyCommand);
        this.updateQuickPickList();
      }
    }

    if (button.iconPath instanceof ThemeIcon && button.iconPath.id === "edit") {
      this.quickPick.value = item.value;
    }
  }

  private updateQuickPickList() {
    const input = this.quickPick.value;
    const list: (QuickPickItem & { value: string })[] = [];
    list.push(
      ...this.suggestedCommand.map((item) => ({
        label: item.label,
        value: item.command,
        iconPath: item.source === "preset" ? new ThemeIcon("run") : new ThemeIcon("spark"),
        description: item.source === "preset" ? item.command : "Suggested",
      })),
    );
    if (list.length > 0) {
      list.push({
        label: "",
        value: "",
        kind: QuickPickItemKind.Separator,
        alwaysShow: true,
      });
    }
    const recentlyCommandToAdd = this.recentlyCommand.filter((item) => !list.find((i) => i.value === item));
    list.push(
      ...recentlyCommandToAdd.map((item) => ({
        label: item,
        value: item,
        iconPath: new ThemeIcon("history"),
        description: "History",
        buttons: [
          {
            iconPath: new ThemeIcon("edit"),
          },
          {
            iconPath: new ThemeIcon("settings-remove"),
          },
        ],
      })),
    );
    if (input.length > 0 && !list.find((i) => i.value === input)) {
      list.unshift({
        label: input,
        value: input,
        iconPath: new ThemeIcon("run"),
        description: "",
        alwaysShow: true,
      });
    }
    this.quickPick.items = list;
  }
}

interface EditCommand extends QuickPickItem {
  value: string;
}

interface EditLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}
