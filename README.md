# CodingPowerUp Runner

The runner for [CodingPowerUp](https://github.com/desertedisland/zenfactory): the process a user
installs on a machine they control that holds the repositories, the development tools and the
AI credentials, connects outbound to the CodingPowerUp control plane over a WebSocket, and does
the development work it is asked to do as typed jobs: worktrees and branches, agent turns,
checks, builds, starting the application, browser tests, commits and pushes.

Version 1 targets Linux and runs on the CodingPowerUp dev droplet beside the control plane's
API. Other platforms come later.

The specification is `docs/runner/SPEC.md` in the zenfactory repository. The protocol types
come from the published `@yellowmelon/factory-global-types` package.

Nothing is built yet: the runner package arrives at step 3 of the spec.
