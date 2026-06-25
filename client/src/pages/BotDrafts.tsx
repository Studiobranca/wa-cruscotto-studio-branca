import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Send, Trash2, AlertTriangle, CalendarClock, CalendarCheck, Check, X } from 'lucide-react';
import { getApiBase } from '../lib/queryClient';

interface Draft {
  id: number;
  phone: string;
  contact_name: string;
  incoming_excerpt: string;
  draft_text: string;
  proposed_event: { date: string; start: string; end: string; reason: string } | null;
  needs_human: number;
  created_at: string;
}

interface BotConfig { enabled: boolean; model: string; notifyMode?: string; controlNumber?: string; autoSend?: boolean; }

interface Appointment {
  id: number;
  phone: string;
  contact_name: string;
  date: string;
  start: string;
  end?: string;
  reason?: string;
  status: string;
}

const DOW = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
function fmtDate(d: string): string {
  try {
    const dt = new Date(`${d}T12:00:00`);
    return `${DOW[dt.getDay()]} ${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;
  } catch { return d; }
}

export default function BotDrafts() {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<number, string>>({});

  const { data: drafts = [], isLoading } = useQuery<Draft[]>({
    queryKey: ['bot-drafts'],
    queryFn: async () => (await fetch(`${getApiBase()}/api/bot/drafts`)).json(),
    refetchInterval: 15000,
  });

  const { data: config } = useQuery<BotConfig>({
    queryKey: ['bot-config'],
    queryFn: async () => (await fetch(`${getApiBase()}/api/bot/config`)).json(),
  });

  async function doApprove(id: number, text: string, force: boolean): Promise<any> {
    const r = await fetch(`${getApiBase()}/api/bot/drafts/${id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, force }),
    });
    if (r.status === 409) {
      const data = await r.json();
      // Conflitto agenda: chiedi conferma e, se sì, reinvia forzando
      if (window.confirm(`${data.message}\n\n(L'appuntamento verrà comunque creato come "DA CONFERMARE".)`)) {
        return doApprove(id, text, true);
      }
      return { skipped: true };
    }
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  const approve = useMutation({
    mutationFn: ({ id, text }: { id: number; text: string }) => doApprove(id, text, false),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-drafts'] }),
  });

  const reject = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${getApiBase()}/api/bot/drafts/${id}/reject`, { method: 'POST' });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-drafts'] }),
  });

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      const r = await fetch(`${getApiBase()}/api/bot/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-config'] }),
  });

  const setNotify = useMutation({
    mutationFn: async (notifyMode: string) => {
      const r = await fetch(`${getApiBase()}/api/bot/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifyMode }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-config'] }),
  });

  const setAutoSend = useMutation({
    mutationFn: async (autoSend: boolean) => {
      const r = await fetch(`${getApiBase()}/api/bot/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoSend }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-config'] }),
  });

  // Appuntamenti in attesa di conferma (da approvazione bozza o auto-risposta)
  const { data: appointments = [] } = useQuery<Appointment[]>({
    queryKey: ['bot-appointments'],
    queryFn: async () => (await fetch(`${getApiBase()}/api/bot/appointments`)).json(),
    refetchInterval: 15000,
  });

  const confirmAppt = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${getApiBase()}/api/bot/appointments/${id}/confirm`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-appointments'] }),
  });

  const cancelAppt = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${getApiBase()}/api/bot/appointments/${id}/cancel`, { method: 'POST' });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bot-appointments'] }),
  });

  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Bozze Bot</h1>
        <p className="page-subtitle">Risposte WhatsApp proposte dall'assistente — approva prima dell'invio</p>
      </header>

      {/* Toggle bot */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bot size={18} color="#128C7E" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Chatbot clienti di lavoro</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                Genera bozze per i non-VIP. Modello: {config?.model ?? '—'}
              </div>
            </div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={config?.enabled ?? false}
              onChange={(e) => toggle.mutate(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Risposta automatica ai non‑VIP</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Se attiva, il bot risponde da solo. Le urgenze restano comunque in bozza.
            </div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={config?.autoSend ?? false}
              onChange={(e) => setAutoSend.mutate(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </div>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Avvisami su WhatsApp{config?.controlNumber ? ` (${config.controlNumber})` : ''}
          </div>
          <select
            value={config?.notifyMode ?? 'always'}
            onChange={(e) => setNotify.mutate(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, background: 'var(--bg3)', color: 'var(--text)' }}>
            <option value="always">Sempre</option>
            <option value="outside_hours">Solo fuori orario (sere/weekend)</option>
            <option value="off">Mai (solo Cruscotto)</option>
          </select>
        </div>
      </div>

      {appointments.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '4px 2px 8px' }}>
            Appuntamenti da confermare
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {appointments.map((a) => (
              <div key={a.id} className="settings-card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{a.contact_name || a.phone}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{a.phone}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
                  <CalendarCheck size={15} color="#25D366" />
                  {fmtDate(a.date)} — ore {a.start}{a.reason ? ` · ${a.reason}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => confirmAppt.mutate(a.id)}
                    disabled={confirmAppt.isPending}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      padding: '9px 14px', background: '#128C7E', color: 'white', border: 'none',
                      borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                    }}>
                    <Check size={16} /> Conferma in agenda
                  </button>
                  <button
                    onClick={() => { if (window.confirm('Annullare questo appuntamento?')) cancelAppt.mutate(a.id); }}
                    disabled={cancelAppt.isPending}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      padding: '9px 14px', background: '#f0f0f0', color: '#c62828', border: 'none',
                      borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                    }}>
                    <X size={16} /> Annulla
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div style={{ padding: 24, color: 'var(--text-dim)', textAlign: 'center' }}>Caricamento...</div>
      ) : drafts.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 32, fontSize: 14 }}>
          Nessuna bozza in attesa 🎉
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 24 }}>
          {drafts.map((d) => {
            const text = edits[d.id] ?? d.draft_text;
            return (
              <div key={d.id} className="settings-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{d.contact_name || d.phone}</span>
                  <span style={{ fontSize: 11, color: '#888' }}>{d.phone}</span>
                </div>

                {d.needs_human === 1 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
                    background: '#fff3cd', color: '#856404', padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  }}>
                    <AlertTriangle size={14} /> Urgente / da gestire di persona
                  </div>
                )}

                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontStyle: 'italic' }}>
                  Cliente: “{d.incoming_excerpt}”
                </div>

                {d.proposed_event && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
                    background: '#e8f5e9', color: '#1b5e20', padding: '6px 10px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                  }}>
                    <CalendarClock size={14} />
                    Appuntamento proposto: {fmtDate(d.proposed_event.date)} ore {d.proposed_event.start} — {d.proposed_event.reason}
                    <span style={{ fontWeight: 400, color: '#558b2f' }}>(→ evento DA CONFERMARE)</span>
                  </div>
                )}

                <textarea
                  value={text}
                  onChange={(e) => setEdits({ ...edits, [d.id]: e.target.value })}
                  rows={Math.min(8, Math.max(3, Math.ceil(text.length / 50)))}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 10,
                    border: '1px solid var(--border)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical',
                    background: 'var(--bg3)', color: 'var(--text)',
                  }}
                />

                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    onClick={() => approve.mutate({ id: d.id, text })}
                    disabled={approve.isPending}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      padding: '10px 14px', background: '#128C7E', color: 'white', border: 'none',
                      borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                    }}>
                    <Send size={16} /> Approva e invia
                  </button>
                  <button
                    onClick={() => reject.mutate(d.id)}
                    disabled={reject.isPending}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      padding: '10px 14px', background: '#f0f0f0', color: '#c62828', border: 'none',
                      borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer',
                    }}>
                    <Trash2 size={16} /> Rifiuta
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
