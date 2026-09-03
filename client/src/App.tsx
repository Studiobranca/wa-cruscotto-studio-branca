import { useEffect, useRef } from 'react';
import { Switch, Route } from 'wouter';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { useSSE } from './lib/hooks';
import { flashScreen } from './lib/useFlash';
import BottomNav from './components/BottomNav';
import InAppBrowserWarning from './components/InAppBrowserWarning';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Report from './pages/Report';
import Settings from './pages/Settings';
import Integrations from './pages/Integrations';
import BotDrafts from './pages/BotDrafts';
import Email from './pages/Email';

// ─── Suoni via Web Audio API ──────────────────────────────────────────────────
// Genera i toni sinteticamente — nessun file audio da caricare.
function playSound(type: 'message' | 'audio' | 'vip') {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const play = (freq: number, start: number, dur: number, vol = 0.35) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };

    if (type === 'vip') {
      // Doppio tono caldo: Do5 → Mi5 (VIP — più squillante)
      play(523, 0,    0.18, 0.50);
      play(659, 0.22, 0.28, 0.60);
    } else if (type === 'audio') {
      // Tono singolo morbido: La4 (messaggio vocale)
      play(440, 0, 0.25, 0.40);
    } else {
      // Tono breve: Sol4 (messaggio testo — discreto)
      play(392, 0, 0.15, 0.30);
    }
  } catch {
    // Web Audio non disponibile (Safari/iOS con restrizioni) — silenzioso
  }
}

// ─── Componente radice con SSE globale ───────────────────────────────────────
function AppInner() {
  const connectSSE = useSSE((type, data) => {
    if (type === 'message' && data?.type === 'received') {
      const isVip   = data?.priority === 'vip' || data?.priority === 'high';
      const isAudio = !!data?.isAudio;

      // 1. Suono
      if (isVip)        playSound('vip');
      else if (isAudio) playSound('audio');
      else              playSound('message');

      // 2. Flash schermo: rosso=VIP, giallo=audio, verde=testo
      if (isVip)        flashScreen('red');
      else if (isAudio) flashScreen('yellow');
      else              flashScreen('green');
    }
  });

  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    esRef.current = connectSSE();
    return () => esRef.current?.close();
  }, []);

  return (
    <div className="app-root">
      <InAppBrowserWarning />
      <div className="app-content">
        <Switch>
          <Route path="/"            component={Dashboard}    />
          <Route path="/inbox"       component={Inbox}        />
          <Route path="/report"      component={Report}       />
          <Route path="/settings"    component={Settings}     />
          <Route path="/integrations" component={Integrations} />
          <Route path="/bot"         component={BotDrafts}    />
          <Route path="/email"       component={Email}        />
        </Switch>
      </div>
      <BottomNav />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}
