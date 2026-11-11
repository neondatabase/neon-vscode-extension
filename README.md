# Neon for VS Code

Browse and manage your [Neon](https://neon.com) Postgres projects, branches, computes, and databases without leaving the editor.

## Features

- **Projects tree.** Organizations, projects, branches, computes, databases, and roles in the Neon activity bar view, with details on hover.
- **Projects.** Create, rename, and delete projects, or open them in the Neon Console.
- **Branches.** Create a branch from any branch, rename it, set it as the default, or delete it.
- **Computes.** Start and suspend a compute from its row and watch its state change.
- **Connection strings.** Copy a pooled or direct connection string for any branch or database.
- **Workspace project.** Link a workspace to a Neon project. The linked project is pinned to the top of the tree and shown in the status bar.
- **Detection from `.env`.** If a connection string in the workspace's `.env` files points at one of your projects, the workspace is linked to it automatically. A project you pick yourself always wins.

## Getting started

1. Open the **Neon** view in the activity bar.
2. Select **Sign in to Neon** and approve the request in your browser.
3. Expand a project to see its branches, then a branch to see its compute, databases, and roles.

Right-click any row for its actions. The most common ones also appear as buttons on the row.

## Commands

All commands are under the **Neon** category in the Command Palette.

| Command                   | What it does                                                 |
| ------------------------- | ------------------------------------------------------------ |
| Sign In / Sign Out        | Connect or disconnect your Neon account                      |
| Refresh                   | Reload the projects tree                                     |
| Create Project…           | Create a project in an organization and region you choose    |
| Create Branch…            | Create a branch in a project                                 |
| Copy Connection String    | Copy a connection string for a project, branch, and database |
| Open in Neon Console      | Open a project or branch in the browser                      |
| Select Workspace Project… | Choose which project this workspace works with               |
| Unlink Workspace Project  | Remove the workspace's project link                          |

Rename, delete, set default, start, suspend, and copy ID are available from the row menus in the tree.

## Settings

| Setting                               | Default   | Description                                                                                                  |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `neon.connectionString.pooled`        | `true`    | Copy pooled (PgBouncer) connection strings. Turn off for migrations and tools that need a direct connection. |
| `neon.workspaceProject.detectFromEnv` | `true`    | Link the workspace to the project its `.env` connection strings point at.                                    |
| `neon.oauth.clientId`                 | `neonctl` | The registered Neon OAuth client used to sign in. Sign out before changing it.                               |

## Privacy and security

- Sign-in uses OAuth in your browser. The extension never sees your password.
- Tokens are kept in VS Code's secret storage and are revoked when you sign out.
- `.env` files are read locally and never leave your machine. Only the compute host name is compared against the computes in your Neon projects.

## Requirements

VS Code 1.101 or later.

## Development

```bash
npm install
```

```bash
npm run check
```

Open the folder in VS Code and press F5 with **Run Neon Extension** selected to launch an Extension Development Host. Use `npm run watch` to rebuild on change, then run **Developer: Reload Window** in the development window.

To build a `.vsix`:

```bash
npm run package
```
