import path from 'path';
import express, { Request, Response } from 'express';
import { runAutomation, RunEvent } from '../runner';

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, 'public')));

type RunState = 'idle' | 'running' | 'done' | 'error';
type BroadcastEvent = RunEvent | { type: 'state'; state: RunState; error?: string };

let state: RunState = 'idle';
let lastError: string | undefined;
const sseClients = new Set<Response>();

// Records every event broadcast during the current/most-recent run, so a browser
// reconnecting mid-run (or right after) can replay what already happened instead of
// starting from a blank log. Cleared at the start of each new run.
let eventHistory: BroadcastEvent[] = [];

function broadcast(event: BroadcastEvent) {
  eventHistory.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

app.get('/api/events', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (eventHistory.length > 0) {
    for (const event of eventHistory) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } else {
    res.write(`data: ${JSON.stringify({ type: 'state', state, error: lastError })}\n\n`);
  }
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/run', (req: Request, res: Response) => {
  const { baseUrl, tag } = req.body ?? {};
  if (!baseUrl || typeof baseUrl !== 'string') {
    return res.status(400).json({ error: 'baseUrl is required' });
  }
  if (!tag || typeof tag !== 'string') {
    return res.status(400).json({ error: 'tag is required' });
  }
  if (state === 'running') {
    return res.status(409).json({ error: 'A run is already in progress' });
  }

  state = 'running';
  lastError = undefined;
  eventHistory = [];
  broadcast({ type: 'state', state });

  runAutomation({
    baseUrl,
    tag,
    onEvent: (event) => broadcast(event),
  })
    .then(() => {
      state = 'done';
      broadcast({ type: 'state', state });
    })
    .catch((err) => {
      state = 'error';
      lastError = err instanceof Error ? err.message : String(err);
      broadcast({ type: 'state', state, error: lastError });
    });

  return res.json({ started: true });
});

app.get('/api/state', (_req: Request, res: Response) => {
  res.json({ state, error: lastError });
});

app.listen(PORT, () => {
  console.log(`SeedForge listening on http://localhost:${PORT}`);
});
