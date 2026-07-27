import express from 'express';
import path from 'path';
import './db.js'; // Initialize database
import routes from './routes.js';
import { startPolling } from './polling.js';
import { startMaintenance } from './maintenance.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS for development
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, client-token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// API Routes
app.use('/api', routes);

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  // In CJS bundle, __dirname is the dist/ folder
  const distPath = path.join(process.cwd(), 'dist', 'public');
  app.use(express.static(distPath));
  app.get('*', (req: any, res: any) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`[Server] WA Cruscotto running on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Start polling after server is ready
  setTimeout(() => {
    startPolling(Number(process.env.POLL_INTERVAL_MS) || 30000);
  }, 2000);

  // Manutenzione: digest giornaliero + watchdog flusso messaggi
  startMaintenance();

  // Notifiche d'agenda verso Mariano (numero di controllo): DIGEST 08:00 + REMINDER T-10.
  // Scheduler interno dedicato (tick 60s) — ISOLATO: un suo errore non tocca il resto.
  setTimeout(async () => {
    try {
      const an = await import('./agenda_notify.js');
      an.startAgendaNotifier();
    } catch (e: any) {
      console.error('[AgendaNotify] scheduler non avviato (isolato, resto del bot intatto):', e.message);
    }
  }, 3000);

  // Posta in arrivo (IMAP, sola lettura) — ISOLATA: import dinamico in try/catch così
  // un eventuale problema del modulo email non può MAI tirare giù il bot WhatsApp.
  // Il poller parte solo se sono presenti le credenziali (EMAIL_*_PASS).
  setTimeout(async () => {
    try {
      const mail = await import('./email.js');
      mail.startEmailPoller();
    } catch (e: any) {
      console.error('[Email] modulo non avviato (isolato, bot non impattato):', e.message);
    }
  }, 5000);
});

export default app;
