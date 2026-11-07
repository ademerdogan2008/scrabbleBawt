// worker_threads entry for the tournament pool. Builds the word engine once, then runs jobs
// posted by runJobs() one at a time and posts each JobResult back.
import { parentPort } from 'node:worker_threads';
import { getEngine } from '../engine/index.js';
import { runJob, type Job } from './tournament.js';

if (!parentPort) throw new Error('worker.ts must run inside a worker thread');
const port = parentPort;
getEngine();
port.on('message', (job: Job) => {
  try {
    port.postMessage({ result: runJob(job) });
  } catch (e) {
    port.postMessage({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
});
port.postMessage({ ready: true });
