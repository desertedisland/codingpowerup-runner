// Ports for the applications the runner starts: free ones from the configured range, never one
// another started application already holds
import net from 'net';
import { IApplicationPorts } from '@yellowmelon/factory-global-types';

export const DEFAULT_PORT_RANGE = { from: 20000, to: 20999 };

const isFree = (port: number): Promise<boolean> => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

export const findFreePort = async (range: { from: number; to: number }, taken: Set<number>): Promise<number> => {
  for (let port = range.from; port <= range.to; port += 1) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`No free port between ${range.from} and ${range.to}`);
};

// Two ports for an application: its API and its client
export const allocatePorts = async (range: { from: number; to: number }, taken: Set<number>): Promise<IApplicationPorts> => {
  const api = await findFreePort(range, taken);
  const client = await findFreePort(range, new Set([...taken, api]));
  return { api, client };
};
