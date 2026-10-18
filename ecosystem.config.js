// PM2 process definition for the runner on the CodingPowerUp dev droplet, where version 1 runs
// beside factory-api. `pm2 start ecosystem.config.js` from this directory after `npm run build`.
// The runner needs no port: it dials out to the control plane.
module.exports = {
  apps: [
    {
      name: 'codingpowerup-runner',
      cwd: __dirname,
      script: 'dist/cli/main.js',
      args: 'start',
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
