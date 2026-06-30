import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, UserCheck, RefreshCw, CheckCircle2, Inbox as InboxIcon } from 'lucide-react';
import { getApiBase } from '../lib/queryClient';

interface EmailRow {
  id: number;
  account: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  email_date: string;
  category: string;
  matched_client: string | null;
  replied: number;
}
interface EmailStatus {
  configured: { name: string; user: string }[];
  autoReply: boolean;
  lastPoll: { at: string; ok: boolean; stored: number; error?: string } | null;
}

const CATS: { key: string; label: string }[] = [
  { key: 'lavoro', label: 'Lavoro' },
  { key: 'altro', label: 'Altro' },
  { key: 'automatica', label: 'Automatiche' },
  { key: '', label: 'Tutte' },
];

function fmtWhen(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return s; }
}

function catColor(c: string): { bg: string; fg: string } {
  if (c === 'lavoro') return { bg: '#e8f5e9', fg: '#1b5e20' };
  if (c === 'automatica') return { bg: '#eceff1', fg: '#546e7a' };
  return { bg: '#fff8e1', fg: '#8d6e00' };
}

export default function Email() {
  const qc = useQueryClient();
  const [cat, setCat] = useState('lavoro');

  const { data: status } = useQuery<EmailStatus>({
    queryKey: ['emails-status'],
    queryFn: async () => (await fetch(`${getApiBase()}/api/emails/status`)).json(),
    refetchInterval: 30000,
  });

  const { data: emailsData, isLoading } = useQuery<{ emails: EmailRow[] }>({
    queryKey: ['emails', cat],
    queryFn: async () => (await fetch(`${getApiBase()}/api/emails?limit=150${cat ? `&category=${cat}` : ''}`)).json(),
    refetchInterval: 20000,
  });
  const emails = emailsData?.emails ?? [];

  const markClient = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${getApiBase()}/api/emails/${id}/mark-client`, { method: 'POST' });
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['emails'] }); },
  });

  const configured = status?.configured ?? [];

  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Email</h1>
        <p className="page-subtitle">Posta in arrivo dello studio — Tiscali e iCloud (sola lettura)</p>
      </header>

      {/* Stato */}
      <div className="settings-card" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Mail size={18} color="#128C7E" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {configured.length ? `${configured.length} caselle collegate` : 'Nessuna casella collegata'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {configured.map((c) => c.user).join(' · ') || 'Imposta le credenziali su Railway'}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={13} /> Ultimo controllo: {status?.lastPoll ? `${fmtWhen(status.lastPoll.at)} (${status.lastPoll.ok ? 'ok' : 'errore'})` : '—'}
          </span>
          <span>Risposta automatica: <b>{status?.autoReply ? 'attiva' : 'off'}</b></span>
        </div>
      </div>

      {/* Filtri categoria */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {CATS.map((c) => (
          <button key={c.key} onClick={() => setCat(c.key)}
            style={{
              padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: '1px solid var(--border)',
              background: cat === c.key ? '#128C7E' : 'var(--bg3)',
              color: cat === c.key ? 'white' : 'var(--text)',
            }}>
            {c.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div style={{ padding: 24, color: 'var(--text-dim)', textAlign: 'center' }}>Caricamento...</div>
      ) : emails.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#888', padding: 32, fontSize: 14 }}>
          <InboxIcon size={28} style={{ opacity: 0.4 }} /><div style={{ marginTop: 8 }}>Nessuna email in questa categoria</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 24 }}>
          {emails.map((m) => {
            const col = catColor(m.category);
            return (
              <div key={m.id} className="settings-card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {m.from_name || m.from_addr}
                      {m.matched_client && <span style={{ color: '#1b5e20', fontWeight: 600 }}> · {m.matched_client}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.from_addr}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, background: col.bg, color: col.fg, fontWeight: 700 }}>{m.category}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{m.account} · {fmtWhen(m.email_date)}</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{m.subject}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m.snippet}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                  {m.replied === 1 && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#1b5e20', fontWeight: 600 }}>
                      <CheckCircle2 size={14} /> Risposta inviata
                    </span>
                  )}
                  {m.category !== 'lavoro' && (
                    <button onClick={() => markClient.mutate(m.id)} disabled={markClient.isPending}
                      style={{
                        marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
                        padding: '6px 12px', background: 'var(--bg3)', color: 'var(--text)',
                        border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      }}>
                      <UserCheck size={14} /> Segna cliente
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
