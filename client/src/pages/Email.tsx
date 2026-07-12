import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, UserCheck, UserX, Truck, Scale, RefreshCw, CheckCircle2, Inbox as InboxIcon, Settings2, X, Phone, Calendar, FileText, MessageSquare } from 'lucide-react';
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
interface ContactEntry { value: string; name: string | null; type: 'cliente' | 'fornitore' | 'ignorato' | 'cgt'; phone: string | null; created_at: string }
interface ContactProfile {
  contact: ContactEntry;
  appointments: { date: string; start: string; end: string | null; reason: string | null; status: string; created_at: string }[];
  docNotes: { summary: string; created_at: string }[];
  emailHistory: { subject: string; snippet: string; email_date: string; category: string }[];
  whatsapp: { phone: string; contact_name: string | null; last_message: string | null; last_message_at: string | null; total_received: number; total_sent: number } | null;
}

const CATS: { key: string; label: string }[] = [
  { key: 'lavoro', label: 'Lavoro' },
  { key: 'fornitore', label: 'Fornitori' },
  { key: 'commissione_tributaria', label: 'CGT' },
  { key: 'altro', label: 'Altro' },
  { key: 'automatica', label: 'Automatiche' },
  { key: 'ignorata', label: 'Ignorate' },
  { key: '', label: 'Tutte' },
];

const RUBRICA_TABS: { key: 'cliente' | 'fornitore' | 'ignorato' | 'cgt'; label: string; bg: string; fg: string }[] = [
  { key: 'cliente', label: 'Clienti', bg: '#e8f5e9', fg: '#1b5e20' },
  { key: 'fornitore', label: 'Fornitori', bg: '#e3f2fd', fg: '#0d47a1' },
  { key: 'cgt', label: 'Commissione Tributaria', bg: '#ede7f6', fg: '#4527a0' },
  { key: 'ignorato', label: 'Ignorati', bg: '#ffebee', fg: '#b71c1c' },
];

function fmtWhen(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return s; }
}

function catColor(c: string): { bg: string; fg: string } {
  if (c === 'lavoro') return { bg: '#e8f5e9', fg: '#1b5e20' };
  if (c === 'fornitore') return { bg: '#e3f2fd', fg: '#0d47a1' };
  if (c === 'commissione_tributaria') return { bg: '#ede7f6', fg: '#4527a0' };
  if (c === 'automatica') return { bg: '#eceff1', fg: '#546e7a' };
  if (c === 'ignorata') return { bg: '#ffebee', fg: '#b71c1c' };
  return { bg: '#fff8e1', fg: '#8d6e00' };
}

export default function Email() {
  const qc = useQueryClient();
  const [cat, setCat] = useState('lavoro');
  const [showManage, setShowManage] = useState(false);
  const [rubricaTab, setRubricaTab] = useState<'cliente' | 'fornitore' | 'ignorato' | 'cgt'>('cliente');
  const [selected, setSelected] = useState<string | null>(null);

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

  const { data: contactsData } = useQuery<{ contacts: ContactEntry[] }>({
    queryKey: ['contacts', rubricaTab],
    queryFn: async () => (await fetch(`${getApiBase()}/api/contacts?type=${rubricaTab}`)).json(),
    enabled: showManage,
  });
  const contactsList = contactsData?.contacts ?? [];

  const { data: profile } = useQuery<ContactProfile>({
    queryKey: ['contact-profile', selected],
    queryFn: async () => (await fetch(`${getApiBase()}/api/contacts/${encodeURIComponent(selected!)}/profile`)).json(),
    enabled: !!selected,
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['emails'] });
    qc.invalidateQueries({ queryKey: ['contacts'] });
    qc.invalidateQueries({ queryKey: ['contact-profile'] });
  };

  const markClient = useMutation({
    mutationFn: async (id: number) => (await fetch(`${getApiBase()}/api/emails/${id}/mark-client`, { method: 'POST' })).json(),
    onSuccess: invalidateAll,
  });
  const markFornitore = useMutation({
    mutationFn: async (id: number) => (await fetch(`${getApiBase()}/api/emails/${id}/mark-fornitore`, { method: 'POST' })).json(),
    onSuccess: invalidateAll,
  });
  const markNotClient = useMutation({
    mutationFn: async (id: number) => (await fetch(`${getApiBase()}/api/emails/${id}/mark-not-client`, { method: 'POST' })).json(),
    onSuccess: invalidateAll,
  });
  const markCGT = useMutation({
    mutationFn: async (id: number) => (await fetch(`${getApiBase()}/api/emails/${id}/mark-cgt`, { method: 'POST' })).json(),
    onSuccess: invalidateAll,
  });
  const removeContact = useMutation({
    mutationFn: async (value: string) => (await fetch(`${getApiBase()}/api/contacts/${encodeURIComponent(value)}`, { method: 'DELETE' })).json(),
    onSuccess: () => { invalidateAll(); setSelected(null); },
  });

  const configured = status?.configured ?? [];
  const tabColor = RUBRICA_TABS.find((t) => t.key === rubricaTab)!;

  return (
    <div className="page-container">
      <header className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <h1 className="page-title">Email</h1>
          <p className="page-subtitle">Posta in arrivo dello studio — Tiscali e iCloud (sola lettura)</p>
        </div>
        <button onClick={() => setShowManage((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 8,
            border: '1px solid var(--border)', background: showManage ? '#128C7E' : 'var(--bg3)',
            color: showManage ? 'white' : 'var(--text)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}>
          <Settings2 size={14} /> Rubrica
        </button>
      </header>

      {showManage && (
        <div className="settings-card" style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: 10 }}>
            Clienti e fornitori marcati da un'email vengono collegati in automatico, per nome, a una
            conversazione WhatsApp già nota. Clicca un contatto per vedere la scheda (appuntamenti,
            documenti, cronologia).
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {RUBRICA_TABS.map((t) => (
              <button key={t.key} onClick={() => { setRubricaTab(t.key); setSelected(null); }}
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  border: '1px solid var(--border)',
                  background: rubricaTab === t.key ? t.bg : 'var(--bg3)',
                  color: rubricaTab === t.key ? t.fg : 'var(--text)',
                }}>
                {t.label}
              </button>
            ))}
          </div>

          {contactsList.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Nessun contatto in questa lista.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
              {contactsList.map((c) => (
                <div key={c.value}>
                  <div onClick={() => setSelected(selected === c.value ? null : c.value)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12,
                      background: selected === c.value ? tabColor.bg : 'var(--bg3)', borderRadius: 6, padding: '6px 9px', cursor: 'pointer',
                    }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {c.name ? `${c.name} — ` : ''}{c.value}
                      {c.phone && <Phone size={11} style={{ opacity: 0.6, flexShrink: 0 }} />}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); removeContact.mutate(c.value); }} title="Rimuovi dalla rubrica"
                      style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: tabColor.fg, flexShrink: 0 }}>
                      <X size={13} />
                    </button>
                  </div>

                  {selected === c.value && profile && (
                    <div style={{ padding: '10px 12px', background: 'var(--bg2)', borderRadius: 6, marginTop: 4, fontSize: 12 }}>
                      {profile.whatsapp ? (
                        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <MessageSquare size={13} color="#128C7E" />
                          <span>{profile.whatsapp.contact_name || profile.whatsapp.phone} · {profile.whatsapp.total_received} ricevuti / {profile.whatsapp.total_sent} inviati</span>
                        </div>
                      ) : (
                        <div style={{ marginBottom: 8, color: 'var(--text-dim)' }}>Nessuna conversazione WhatsApp collegata.</div>
                      )}

                      <div style={{ marginBottom: 6, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <Calendar size={13} /> Appuntamenti ({profile.appointments.length})
                      </div>
                      {profile.appointments.length === 0 ? (
                        <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>Nessuno.</div>
                      ) : profile.appointments.slice(0, 5).map((a, i) => (
                        <div key={i} style={{ color: 'var(--text-muted)', marginBottom: 3 }}>
                          {a.date} {a.start} — {a.reason || 'appuntamento'} <i>({a.status})</i>
                        </div>
                      ))}

                      <div style={{ margin: '8px 0 6px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5 }}>
                        <FileText size={13} /> Richieste/documenti ({profile.docNotes.length})
                      </div>
                      {profile.docNotes.length === 0 ? (
                        <div style={{ color: 'var(--text-dim)' }}>Nessuna.</div>
                      ) : profile.docNotes.slice(0, 5).map((n, i) => (
                        <div key={i} style={{ color: 'var(--text-muted)', marginBottom: 3 }}>{n.summary}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {m.category !== 'ignorata' && (
                      <button onClick={() => markNotClient.mutate(m.id)} disabled={markNotClient.isPending}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '6px 12px', background: 'var(--bg3)', color: '#b71c1c',
                          border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}>
                        <UserX size={14} /> Non è cliente
                      </button>
                    )}
                    {m.category !== 'fornitore' && (
                      <button onClick={() => markFornitore.mutate(m.id)} disabled={markFornitore.isPending}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '6px 12px', background: 'var(--bg3)', color: '#0d47a1',
                          border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}>
                        <Truck size={14} /> Fornitore
                      </button>
                    )}
                    {m.category !== 'commissione_tributaria' && (
                      <button onClick={() => markCGT.mutate(m.id)} disabled={markCGT.isPending}
                        title="Da ricollegare a un procedimento (Commissione Tributaria / Corte di Giustizia Tributaria), anche se non è PEC"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '6px 12px', background: 'var(--bg3)', color: '#4527a0',
                          border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}>
                        <Scale size={14} /> Commissione Tributaria
                      </button>
                    )}
                    {m.category !== 'lavoro' && (
                      <button onClick={() => markClient.mutate(m.id)} disabled={markClient.isPending}
                        title="Autorizza le risposte automatiche via email per questo mittente"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 5,
                          padding: '6px 12px', background: 'var(--bg3)', color: '#1b5e20',
                          border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        }}>
                        <UserCheck size={14} /> È cliente
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
