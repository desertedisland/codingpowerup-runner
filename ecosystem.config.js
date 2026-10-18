// PM2 process definition for the runner on the CodingPowerUp dev droplet, where version 1 runs
// beside factory-api. `pm2 start ecosystem.config.js` from this directory after `npm run build`.
// The runner needs no port: it dials out to the control plane.
const fs = require('fs');
const path = require('path');

// The runner's own .env (git-ignored) holds what the agent runs under: CLAUDE_CODE_OAUTH_TOKEN
// from `claude setup-token`. Without the file the agent falls back to the machine's own login.
const envFile = path.join(__dirname, '.env');

module.exports = {
  apps: [
    {
      name: 'codingpowerup-runner',
      cwd: __dirname,
      script: 'dist/cli/main.js',
      args: 'start',
      node_args: fs.existsSync(envFile) ? `--env-file=${envFile}` : undefined,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
