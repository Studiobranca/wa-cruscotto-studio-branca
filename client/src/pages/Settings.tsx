import { useState, useEffect } from 'react';
import { useSettings, useSaveSettings, useSyncContacts } from '../lib/hooks';
import Loader from '../components/Loader';
import { apiRequest, getApiBase } from '../lib/queryClient';
import { Settings as SettingsIcon, RefreshCw, Webhook, Info, CheckCircle } from 'lucide-react';

export default function Settings() {
  const { data: settings = {}, isLoading } = useSettings();
  const saveSettings = useSaveSettings();
  const syncContacts = useSyncContacts();

  const [webhookUrl, setWebhookUrl] = useState('');
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [pollingStatus, setPollingStatus] = useState<string | null>(null);

  useEffect(() => {
    // Fetch webhook URL
    fetch(`${getApiBase()}/api/webhook/url`)
      .then(r => r.json())
      .then(d => setWebhookUrl(d.webhookUrl || ''))
      .catch(() => {});
  }, []);

  const handleSync = async () => {
    setSyncStatus('Sincronizzazione in corso...');
    try {
      const res = await syncContacts.mutateAsync();
      const data = await res.json();
      setSyncStatus(`Sincronizzati ${data.synced} contatti`);
      setTimeout(() => setSyncStatus(null), 4000);
    } catch (e: any) {
      setSyncStatus(`Errore: ${e.message}`);
      setTimeout(() => setSyncStatus(null), 4000);
    }
  };

  const handleStartPolling = async () => {
    try {
      const res = await apiRequest('POST', '/api/polling/start', {});
      const data = await res.json();
      setPollingStatus(data.message || 'Polling avviato');
      setTimeout(() => setPollingStatus(null), 3000);
    } catch (e: any) {
      setPollingStatus(`Errore: ${e.message}`);
    }
  };

  if (isLoading) return <Loader text="Caricamento impostazioni..." />;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Impostazioni</h1>
        <p className="page-subtitle">Configurazione WA Cruscotto</p>
      </header>

      {/* Z-API Config */}
      <div className="settings-card">
        <div className="settings-card-header">
          <SettingsIcon size={18} />
          <h2>Configurazione Z-API</h2>
        </div>
        <div className="settings-info">
          <div className="settings-row">
            <span className="settings-label">Instance ID</span>
            <span className="settings-value mono">3F439036DDF9C25F4C5C7AE31EDEB32B</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Token</span>
            <span className="settings-value mono">0AB4EBF0••••••••</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Client Token</span>
            <span className="settings-value mono">F2bcb0c8••••••••</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Status</span>
            <span className="settings-value">
              <span className="status-dot" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#25D366', marginRight: 6 }} />
              Configurato
            </span>
          </div>
        </div>
      </div>

      {/* Webhook */}
      <div className="settings-card">
        <div className="settings-card-header">
          <Webhook size={18} />
          <h2>Webhook URL</h2>
        </div>
        <p className="settings-desc">
          Configura questo URL nel pannello Z-API come webhook per i messaggi in arrivo.
        </p>
        <div className="webhook-url-box">
          <code>{webhookUrl || 'Caricamento...'}</code>
          {webhookUrl && (
            <button
              className="btn-copy"
              onClick={() => navigator.clipboard.writeText(webhookUrl)}
              title="Copia URL"
            >
              Copia
            </button>
          )}
        </div>
      </div>

      {/* Sync */}
      <div className="settings-card">
        <div className="settings-card-header">
          <RefreshCw size={18} />
          <h2>Sincronizzazione Contatti</h2>
        </div>
        <p className="settings-desc">
          Sincronizza tutti i contatti e le conversazioni da Z-API (fino a 2813 contatti).
          Il polling automatico avviene ogni 30 secondi.
        </p>
        <div className="settings-actions">
          <button className="btn-primary" onClick={handleSync} disabled={syncContacts.isPending}>
            {syncContacts.isPending ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />}
            {syncContacts.isPending ? 'Sincronizzazione...' : 'Sincronizza ora'}
          </button>
          <button className="btn-secondary" onClick={handleStartPolling}>
            Avvia Polling
          </button>
        </div>
        {syncStatus && (
          <div className="status-message">
            <CheckCircle size={14} />
            {syncStatus}
          </div>
        )}
        {pollingStatus && (
          <div className="status-message">
            <CheckCircle size={14} />
            {pollingStatus}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="settings-card">
        <div className="settings-card-header">
          <Info size={18} />
          <h2>Informazioni</h2>
        </div>
        <div className="settings-info">
          <div className="settings-row">
            <span className="settings-label">Versione</span>
            <span className="settings-value">1.0.0</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Studio</span>
            <span className="settings-value">Studio Branca</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">Database</span>
            <span className="settings-value">SQLite (Railway /data/data.db)</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">SSE</span>
            <span className="settings-value">Attivo — aggiornamenti in tempo reale</span>
          </div>
        </div>
      </div>
    </div>
  );
}
