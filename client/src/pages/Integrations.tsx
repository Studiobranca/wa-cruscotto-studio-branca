import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plug, CheckCircle, XCircle, AlertCircle, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { getApiBase } from '../lib/queryClient';

interface IntegrationStatus {
  integrations_enabled: boolean;
  google_contacts: { configured: boolean; enabled: boolean };
  google_calendar: { configured: boolean; enabled: boolean };
  notion: { configured: boolean; enabled: boolean };
  stats: Record<string, { success: number; error: number; skipped: number }>;
  queue_pending?: number;
}

interface LogEntry {
  id: number;
  integration: string;
  action: string;
  status: string;
  detail: string;
  created_at: string;
}

function StatusBadge({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  if (!configured) return (
    <span className="flex items-center gap-1 text-xs text-amber-600 font-medium">
      <AlertCircle size={13} /> Non configurato
    </span>
  );
  if (enabled) return (
    <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
      <CheckCircle size={13} /> Attivo
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-xs text-gray-400 font-medium">
      <XCircle size={13} /> Disattivato
    </span>
  );
}

export default function Integrations() {
  const qc = useQueryClient();
  const [showLogs, setShowLogs] = useState(false);

  const { data: status, isLoading } = useQuery<IntegrationStatus>({
    queryKey: ['integrations-status'],
    queryFn: async () => {
      const r = await fetch(`${getApiBase()}/api/integrations/status`);
      return r.json();
    },
    refetchInterval: 30000,
  });

  const { data: logs = [] } = useQuery<LogEntry[]>({
    queryKey: ['integrations-logs'],
    queryFn: async () => {
      const r = await fetch(`${getApiBase()}/api/integrations/logs`);
      return r.json();
    },
    enabled: showLogs,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: boolean }) => {
      const r = await fetch(`${getApiBase()}/api/integrations/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['integrations-status'] }),
  });

  if (isLoading) return (
    <div className="page-container">
      <div style={{ padding: 24, color: '#888', textAlign: 'center' }}>Caricamento...</div>
    </div>
  );

  const integrationsList = [
    {
      key: 'integration_contacts',
      toggleKey: 'integrations_enabled',
      icon: '👥',
      name: 'Google Contacts',
      description: 'Risolve automaticamente i nomi dei contatti sconosciuti cercando in Google Contacts.',
      status: status?.google_contacts,
      stats: status?.stats?.google_contacts,
    },
    {
      key: 'integration_calendar',
      toggleKey: 'integration_calendar',
      icon: '📅',
      name: 'Google Calendar',
      description: 'Crea eventi in Google Calendar quando ricevi una richiesta di appuntamento via WhatsApp.',
      status: status?.google_calendar,
      stats: status?.stats?.google_calendar,
    },
    {
      key: 'integration_notion',
      toggleKey: 'integration_notion',
      icon: '📋',
      name: 'Notion CRM',
      description: 'Salva automaticamente in Notion i messaggi di contatti VIP o con argomenti fiscali (730, IVA, ecc.).',
      status: status?.notion,
      stats: status?.stats?.notion,
    },
  ];

  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Integrazioni</h1>
        <p className="page-subtitle">
          Connettori attivi — Studio Branca
          {(status?.queue_pending ?? 0) > 0 && (
            <span style={{
              marginLeft: 8, background: '#ff9800', color: 'white',
              borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 700,
            }}>
              {status?.queue_pending} in coda
            </span>
          )}
        </p>
      </header>

      {/* Master toggle */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Plug size={18} color="#128C7E" />
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Integrazioni Automatiche</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                Attiva/disattiva tutte le integrazioni in un colpo solo
              </div>
            </div>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={status?.integrations_enabled ?? true}
              onChange={(e) => toggleMutation.mutate({ key: 'integrations_enabled', value: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>

      {/* Lista integrazioni */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {integrationsList.map(({ key, toggleKey, icon, name, description, status: s, stats }) => (
          <div key={key} className="settings-card">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12, flex: 1 }}>
                <span style={{ fontSize: 28, lineHeight: 1 }}>{icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{name}</div>
                  <div style={{ fontSize: 12, color: '#666', lineHeight: 1.4, marginBottom: 8 }}>{description}</div>
                  <StatusBadge configured={s?.configured ?? false} enabled={s?.enabled ?? false} />
                  {stats && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 10, fontSize: 11 }}>
                      <span style={{ color: '#25D366' }}>✓ {stats.success ?? 0}</span>
                      <span style={{ color: '#f44336' }}>✗ {stats.error ?? 0}</span>
                    </div>
                  )}
                  {!s?.configured && (
                    <div style={{
                      marginTop: 10,
                      padding: '8px 10px',
                      background: '#fff8e1',
                      borderRadius: 8,
                      fontSize: 11,
                      color: '#666',
                      lineHeight: 1.5,
                    }}>
                      {key === 'integration_notion'
                        ? '⚙️ Aggiungi NOTION_API_KEY nelle variabili Railway'
                        : '⚙️ Aggiungi GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN nelle variabili Railway'}
                    </div>
                  )}
                </div>
              </div>
              {s?.configured && (
                <label className="toggle-switch" style={{ flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={s?.enabled ?? false}
                    onChange={(e) => toggleMutation.mutate({ key: toggleKey, value: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Links rapidi */}
      <div className="settings-card" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>🔗 Link Rapidi</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { label: '📋 Notion CRM', url: 'https://app.notion.com/p/3784c3fbbef28191a916eb095a3f4f19' },
            { label: '📅 Google Calendar', url: 'https://calendar.google.com' },
            { label: '👥 Google Contacts', url: 'https://contacts.google.com' },
            { label: '📁 Google Drive', url: 'https://drive.google.com/drive/folders/1p-nENReR_scVUyXONTHYz0dbGFxLYLnq' },
            { label: '📄 PandaDoc', url: 'https://app.pandadoc.com' },
          ].map(({ label, url }) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer"
               style={{
                 display: 'block', padding: '10px 14px',
                 background: '#f8f9fa', borderRadius: 10,
                 fontSize: 14, fontWeight: 600, color: '#128C7E',
                 textDecoration: 'none',
               }}>
              {label} →
            </a>
          ))}
        </div>
      </div>

      {/* Log */}
      <button
        onClick={() => setShowLogs(!showLogs)}
        style={{
          width: '100%', padding: '12px 16px',
          background: '#f0f0f0', border: 'none', borderRadius: 12,
          fontSize: 14, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          marginBottom: 12,
        }}>
        <RefreshCw size={16} />
        {showLogs ? 'Nascondi' : 'Mostra'} Log Integrazioni
        {showLogs ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {showLogs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 24 }}>
          {logs.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#888', padding: 20, fontSize: 14 }}>
              Nessun log disponibile
            </div>
          ) : logs.map((log) => (
            <div key={log.id} style={{
              padding: '10px 14px',
              background: log.status === 'success' ? '#f0fdf4' : log.status === 'error' ? '#fff5f5' : '#fafafa',
              borderRadius: 10, borderLeft: `3px solid ${log.status === 'success' ? '#25D366' : log.status === 'error' ? '#f44336' : '#ccc'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 700 }}>{log.integration} · {log.action}</span>
                <span style={{ fontSize: 11, color: '#888' }}>
                  {new Date(log.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#555' }}>{log.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
