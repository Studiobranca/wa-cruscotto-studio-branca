import { useEffect, useRef } from 'react';
import { useOverview, useWeeklyData, useHourlyData, useTodayReport, useSSE } from '../lib/hooks';
import { queryClient } from '../lib/queryClient';
import KPICard from '../components/KPICard';
import Loader from '../components/Loader';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend
} from 'recharts';
import { MessageCircle, Send, Bell, Users, TrendingUp, Inbox } from 'lucide-react';

export default function Dashboard() {
  const { data: overview, isLoading: overviewLoading } = useOverview();
  const { data: weekly = [] } = useWeeklyData();
  const { data: hourly = [] } = useHourlyData();
  const { data: todayReport = [] } = useTodayReport();
  // Suono VIP via Web Audio API
  const playVipSound = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const play = (freq: number, start: number, duration: number, vol = 0.4) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
        osc.start(ctx.currentTime + start);
        osc.stop(ctx.currentTime + start + duration);
      };
      // Doppio tono: Do5 poi Mi5 — caldo e riconoscibile
      play(523, 0,    0.18, 0.45);
      play(659, 0.22, 0.28, 0.55);
    } catch {}
  };

  const connectSSE = useSSE((type, data) => {
    if (type === 'message' && data?.type === 'received' && data?.priority === 'vip') {
      playVipSound();
    }
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    esRef.current = connectSSE();
    return () => esRef.current?.close();
  }, []);

  if (overviewLoading) return <Loader text="Caricamento dashboard..." />;

  const formatDay = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  const formatHour = (h: number) => `${h.toString().padStart(2, '0')}:00`;

  return (
    <div className="page-container">
      <header className="page-header">
        <div className="page-header-left">
          <div className="logo-mark">
            <svg viewBox="0 0 32 32" width="32" height="32" fill="none" aria-label="WA Cruscotto">
              <rect width="32" height="32" rx="8" fill="#25D366"/>
              <path d="M16 6C10.477 6 6 10.477 6 16c0 1.89.52 3.66 1.424 5.18L6 26l4.95-1.394A9.953 9.953 0 0016 26c5.523 0 10-4.477 10-10S21.523 6 16 6z" fill="white" fillOpacity="0.2"/>
              <path d="M20.5 18.5c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.47-.89-.79-1.49-1.76-1.66-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.49 0 1.46 1.07 2.87 1.22 3.07.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.19-.57-.34z" fill="white"/>
            </svg>
          </div>
          <div>
            <h1 className="page-title">WA Cruscotto</h1>
            <p className="page-subtitle">Studio Branca — Live Dashboard</p>
          </div>
        </div>
        <div className="header-badge">
          <span className="status-dot" />
          Live
        </div>
      </header>

      {/* KPI Grid */}
      <div className="kpi-grid">
        <KPICard
          title="Ricevuti Oggi"
          value={overview?.todayReceived ?? 0}
          color="green"
          icon={<MessageCircle size={20} />}
        />
        <KPICard
          title="Conversazioni"
          value={overview?.conversations ?? 0}
          color="blue"
          icon={<Users size={20} />}
        />
        <KPICard
          title="Non Letti"
          value={overview?.unread ?? 0}
          color="orange"
          icon={<Inbox size={20} />}
        />
        <KPICard
          title="Avvisi Attivi"
          value={overview?.activeAlerts ?? 0}
          color="red"
          icon={<Bell size={20} />}
        />
        <KPICard
          title="Tot. Ricevuti"
          value={overview?.totalReceived ?? 0}
          color="purple"
          icon={<TrendingUp size={20} />}
        />
        <KPICard
          title="Tot. Inviati"
          value={overview?.totalSent ?? 0}
          color="blue"
          icon={<Send size={20} />}
        />
      </div>

      {/* Weekly Chart */}
      <div className="chart-card">
        <h2 className="chart-title">Messaggi ultimi 7 giorni</h2>
        {weekly.length === 0 ? (
          <div className="chart-empty">Nessun dato ancora. I messaggi appariranno qui dopo il primo webhook.</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={weekly} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradReceived" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#25D366" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#25D366" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradSent" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#128C7E" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#128C7E" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" tickFormatter={formatDay} tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <Tooltip
                contentStyle={{ background: '#1f2937', border: 'none', borderRadius: 8, fontSize: 12 }}
                labelFormatter={formatDay}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Area type="monotone" dataKey="received" name="Ricevuti" stroke="#25D366" fill="url(#gradReceived)" strokeWidth={2} />
              <Area type="monotone" dataKey="sent" name="Inviati" stroke="#128C7E" fill="url(#gradSent)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Hourly Peak Chart */}
      <div className="chart-card">
        <h2 className="chart-title">Picchi orari oggi</h2>
        {hourly.every(h => h.count === 0) ? (
          <div className="chart-empty">Nessun messaggio ricevuto oggi.</div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={hourly} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="hour" tickFormatter={formatHour} tick={{ fontSize: 10, fill: '#9ca3af' }} interval={3} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <Tooltip
                contentStyle={{ background: '#1f2937', border: 'none', borderRadius: 8, fontSize: 12 }}
                labelFormatter={formatHour}
              />
              <Bar dataKey="count" name="Messaggi" fill="#25D366" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Today Report */}
      {todayReport.length > 0 && (
        <div className="chart-card">
          <h2 className="chart-title">Attività di oggi per contatto</h2>
          <div className="today-table-wrap">
            <table className="today-table">
              <thead>
                <tr>
                  <th>Contatto</th>
                  <th>Ricevuti</th>
                  <th>Inviati</th>
                  <th>Ultima attività</th>
                </tr>
              </thead>
              <tbody>
                {todayReport.slice(0, 20).map((row, i) => (
                  <tr key={i}>
                    <td className="contact-cell">
                      <span className="contact-avatar">{(row.contact_name || row.phone).charAt(0).toUpperCase()}</span>
                      <span>{row.contact_name || row.phone}</span>
                    </td>
                    <td className="count-received">{row.received}</td>
                    <td className="count-sent">{row.sent}</td>
                    <td className="time-cell">
                      {new Date(row.last_activity).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
