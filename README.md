# CodingPowerUp Runner

The runner for [CodingPowerUp](https://github.com/desertedisland/zenfactory): the process a user
installs on a machine they control that holds the repositories, the development tools and the
AI credentials, connects outbound to the CodingPowerUp control plane over a WebSocket, and does
the development work it is asked to do as typed jobs: worktrees and branches, agent turns,
checks, builds, starting the application, browser tests, commits and pushes.

Version 1 targets Linux and runs on the CodingPowerUp dev droplet beside the control plane's
API. Other platforms come later: the code is one TypeScript core with a `src/platform/` layer
for what differs per OS, wrapped by the CLI now and by service installers and a tray later.

The specification is `docs/runner/SPEC.md` in the zenfactory repository. The protocol types
are `@yellowmelon/factory-global-types` (its `runner/` folder), linked from the zenfactory
checkout beside this one until the package is published.

## What works (steps 3 and 4 of the spec)

```
codingpowerup-runner connect --server https://devapi.yellowmelon.co --code ABCD-EFGH [--name laptop]
codingpowerup-runner start
codingpowerup-runner status
```

- `connect` redeems a pairing code (from the Runners page, owners only, ten minutes, one use)
  for this runner's credential and writes it into `~/.codingpowerup/runner.json` next to the
  projects. The file is private to the user; it is the only copy of the credential.
- `start` connects to `<server>/runner/ws`, registers with the credential, reports what the
  machine can do (git, Node, Docker, Playwright's browser, Claude Code signed in) and which
  configured projects are checked out, heartbeats, reconnects with backoff, and **does the
  jobs** the control plane sends: worktrees and branches, agent turns (the Claude Agent SDK,
  running under `CLAUDE_CODE_OAUTH_TOKEN` from the runner's `.env` or the machine's own
  `claude` login), the project's check command through a build queue, commits, landing on the
  release and pushing, the git history, preview rebuilds. Every job is in `~/.codingpowerup/jobs.json`
  until its result has reached the server, so a job is never run twice and a dropped line loses
  nothing; a runner that restarted reports what it was running as failed.
- `status` prints the local config and asks the server what it thinks.

The owner's permission switches (run the agent, run commands, push, start applications) reach
the runner at register and whenever they change, and a job a switch forbids is refused here as
well as on the control plane.

The agent's live tools (the plan tools, the Explore tools, the Build-mode question) are
answered by the control plane over the socket, one `CALLBACK` frame per call. The owner's
uploaded files are fetched per session into `~/.codingpowerup/attachments`, read-only to the
agent.

Layout: `src/connection` (the socket), `src/jobs` (dispatcher, ledger, handlers), `src/agents`
(the Agent SDK turn, its tool server and guards), `src/git` (checkouts, worktrees, history),
`src/queue` (the build queue), `src/process` (commands, detached starts, the child
environment), `src/preview` (rebuilds), `src/attachments`, `src/repositories` and `src/config`
(runner.json), `src/platform` (what differs per OS).

## runner.json

```json
{
  "server": { "url": "https://devapi.yellowmelon.co", "runnerId": "...", "credential": "cpr_...", "name": "droplet" },
  "capacity": { "concurrency": 2, "worktreeRoot": "~/.codingpowerup/worktrees" },
  "projects": [
    { "key": "goalzen", "path": "~/goalzen", "checkCommand": "npm run check", "rebuildCommand": "bash scripts/rebuild.sh staging application" }
  ]
}
```

`connect` writes `server`; `capacity` is optional (two builds at once and
`~/.codingpowerup/worktrees` by default); `projects` is `IRunnerProjectConfig[]` from the shared
types. `FACTORY_RUNNER_CONFIG` names another file; `CODINGPOWERUP_HOME` another directory.

## Development

```
npm install
npm run build        # dist/
npm run typecheck
npm run dev -- status
```

Node 20 or later. On the dev droplet the runner runs under PM2 from `ecosystem.config.js`
(`pm2 start ecosystem.config.js` after a build), which loads the runner's own `.env`
(git-ignored) when there is one: put `CLAUDE_CODE_OAUTH_TOKEN=...` there, from
`claude setup-token`, so the agent runs under the subscription. The tests
(`npm test`) use throwaway git repositories and a stub of the Agent SDK.
