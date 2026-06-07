import { Response } from 'express';

interface SSEClient {
  id: string;
  res: Response;
}

const clients: SSEClient[] = [];

export function addSSEClient(res: Response): string {
  const id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send keep-alive comment
  res.write(':ok\n\n');

  const client: SSEClient = { id, res };
  clients.push(client);

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    try {
      res.write(':heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  res.on('close', () => {
    clearInterval(heartbeat);
    const idx = clients.findIndex(c => c.id === id);
    if (idx !== -1) clients.splice(idx, 1);
    console.log(`[SSE] Client disconnected: ${id}, total: ${clients.length}`);
  });

  console.log(`[SSE] Client connected: ${id}, total: ${clients.length}`);
  return id;
}

export function broadcastEvent(eventType: string, data: any): void {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  const deadClients: string[] = [];

  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      deadClients.push(client.id);
    }
  }

  for (const id of deadClients) {
    const idx = clients.findIndex(c => c.id === id);
    if (idx !== -1) clients.splice(idx, 1);
  }
}

export function getClientCount(): number {
  return clients.length;
}
