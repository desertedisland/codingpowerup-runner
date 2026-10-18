// The runner's log: one line per event on stdout with a timestamp, which PM2 and a terminal both
// show as they are. The moved modules call logger.info/warn/error/debug as they did in the API.
const line = (level: string, message: string): string => `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;

const logger = {
  info: (message: string): void => { console.log(line('info', message)); },
  warn: (message: string): void => { console.warn(line('warn', message)); },
  error: (message: string): void => { console.error(line('error', message)); },
  debug: (message: string): void => { if (process.env.RUNNER_DEBUG) console.log(line('debug', message)); },
};

export default logger;
