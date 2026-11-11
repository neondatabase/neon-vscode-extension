import * as vscode from 'vscode';
import type { WorkspaceProject } from '../workspace/workspaceProject';

export class WorkspaceProjectStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'neon.workspaceProject',
    vscode.StatusBarAlignment.Left,
    50,
  );
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly workspace: WorkspaceProject,
    private readonly signedIn: () => boolean,
  ) {
    this.item.name = 'Neon Workspace Project';
    this.item.command = 'neon.selectWorkspaceProject';
    this.subscription = workspace.onDidChange(() => this.update());
    this.update();
  }

  update(): void {
    if (!this.signedIn() || !this.workspace.available) {
      this.item.hide();
      return;
    }
    const project = this.workspace.project;
    const tooltip = new vscode.MarkdownString();
    if (project) {
      this.item.text = `$(database) ${project.name.replace(/\$\(/g, '\\$(')}`;
      tooltip.appendMarkdown(`Neon project for this workspace: **`);
      tooltip.appendText(project.name);
      tooltip.appendMarkdown('**\n\n');
      const file = this.workspace.detectedFrom;
      if (file) {
        tooltip.appendMarkdown('Detected from ');
        tooltip.appendText(file);
        tooltip.appendMarkdown('. ');
      }
      tooltip.appendMarkdown('Click to change.');
    } else {
      this.item.text = '$(database) Neon';
      tooltip.appendMarkdown('Click to link this workspace to a Neon project.');
    }
    this.item.tooltip = tooltip;
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
