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

## What works (step 3 of the spec)

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
  configured projects are checked out (branch and commit), heartbeats, and reconnects with
  backoff when the line drops. It stops for good when the server says the credential is dead,
  the runner is too old for the protocol, or another instance of the same runner connected.
- `status` prints the local config and asks the server what it thinks.

Nothing runs a job yet: the job traffic arrives at step 4.

## runner.json

```json
{
  "server": { "url": "https://devapi.yellowmelon.co", "runnerId": "...", "credential": "cpr_...", "name": "droplet" },
  "projects": [
    { "key": "goalzen", "path": "~/goalzen", "checkCommand": "npm run check", "rebuildCommand": "bash scripts/rebuild.sh staging application" }
  ]
}
```

`connect` writes `server`; `projects` is the same shape the control plane's own in-process
runner reads (`IRunnerProjectConfig`). `FACTORY_RUNNER_CONFIG` names another file;
`CODINGPOWERUP_HOME` another directory.

## Development

```
npm install
npm run build        # dist/
npm run typecheck
npm run dev -- status
```

Node 20 or later. On the dev droplet the runner runs under PM2 from `ecosystem.config.js`
(`pm2 start ecosystem.config.js` after a build).
