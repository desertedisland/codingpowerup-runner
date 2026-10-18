#!/usr/bin/env node
// codingpowerup-runner <connect|start|status>
import { connect, runnerVersion, start, status } from './commands';

const USAGE = `codingpowerup-runner ${runnerVersion()}

  connect --server <url> --code <code> [--name <name>]   pair this machine with an organisation
  start                                                  connect and stay connected
  status                                                 what this runner knows, and what the server says

The config is ~/.codingpowerup/runner.json (FACTORY_RUNNER_CONFIG or CODINGPOWERUP_HOME override it).`;

const argument = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const main = async (): Promise<void> => {

  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'connect': {
      const server = argument(rest, '--server');
      const code = argument(rest, '--code');
      if (!server || !code) throw new Error('connect needs --server <url> and --code <code>');
      await connect({ server, code, name: argument(rest, '--name') });
      return;
    }
    case 'start':
      await start();
      return; // the connection keeps the process alive
    case 'status':
      await status();
      return;
    case '--version':
    case '-v':
      console.log(runnerVersion());
      return;
    default:
      console.log(USAGE);
      if (command && command !== '--help' && command !== '-h') process.exitCode = 1;
  }

};

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
