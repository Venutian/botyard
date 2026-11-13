# Custom agents

Botyard's map shows the yard's own crew. The phone app also lists, under "Other live sessions",
the coding-agent sessions that are working on this computer right now and that the yard did not
start. An agent of your own can appear in that list without an adapter: it writes one small JSON
file describing itself.

## Where the files go

One `.json` file per agent in `~/.botyard/agents/` (the `agents` folder of the yard's home). On
Windows that is `%USERPROFILE%\.botyard\agents\`. Set `BOTYARD_STATUS_DIR` to use another folder.

The files are read as soon as that folder exists.

## The file

```json
{
  "id": "my-worker",
  "title": "Review the checkout flow",
  "project": "storefront",
  "cwd": "C:\\work\\storefront",
  "status": "working"
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Letters, digits, `_`, `-` or `.`, up to 100 characters. Keep it unique across your agents |
| `status` | yes | `working`, `waiting`, `blocked`, `idle` or `done`. Only `working` is listed |
| `title` | | The first line of the row. Defaults to the id |
| `project` | | The second line of the row. Defaults to the last folder of `cwd`, then to *Custom agents* |
| `cwd` | | Absolute folder the agent works in |
| `updatedAt` | | Epoch milliseconds. Without it, the file's modification time is used |

An agent is listed while its status is `working` and the file was updated in the last 30
minutes, so a crashed agent does not work forever. Rewrite the file at least that often while it
works. `message`, `model`, `url`, `archived` and `createdAt` are read too, and nothing shows them
at the moment.

## Writing it safely

Write to a temporary name and rename it to `.json`, so Botyard never reads half a file.
Files over 64 KB, broken JSON and records with a bad `id` or `status` are skipped. Delete the
file to remove the agent.

Botyard only reads these files. It never runs anything they name.

## VS Code chat

VS Code's built-in chat is read without any setup, including chats that use custom or local
models. Regular VS Code and Insiders are both read. Set `BOTYARD_VSCODE_USER_DIR` to a
VS Code `User` folder if yours lives somewhere else.
