import { useQuery } from '@tanstack/react-query';
import { getApiBase } from '../lib/queryClient';
import { CheckCircle, Clock, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

interface RequestEntry {
  id: number;
  content: string;
  timestamp: string;
  keywords: string[];
  evaded: boolean;
  reply: { content: string; timestamp: string; delayMinutes: number } | null;
  repeated: boolean;
  repeatCount: number;
  previousOccurrences: { timestamp: string; evaded: boolean; replyTimestamp: string | null }[];
}

interface Topic {
  topic: string;
  count: number;
  evadedCount: number;
  pendingCount: number;
  requests: RequestEntry[];
}

interface RequestsData {
  totalRequests: number;
  evaded: number;
  pending: number;
  repeated: number;
  topics: Topic[];
  requests: RequestEntry[];
}

function fmtDate(ts: string) {
  try {
    return new Date(ts).toLocaleString('it-IT', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ts; }
}

function fmtDelay(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}g`;
}

function RequestCard({ r }: { r: RequestEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`request-card ${r.evaded ? 'evaded' : 'pending'} ${r.repeated ? 'repeated' : ''}`}>
      <div className="request-card-header" onClick={() => setOpen(o => !o)}>
        <div className="request-meta">
          <span className="request-date">{fmtDate(r.timestamp)}</span>
          {r.repeated && (
            <span className="request-badge badge-repeated" title={`Richiesta già fatta ${r.repeatCount} volta/e`}>
              <RefreshCw size={11} /> già chiesto
            </span>
          )}
        </div>
        <div className="request-status">
          {r.evaded
            ? <span className="request-badge badge-evaded"><CheckCircle size={12} /> Evaso · {r.reply ? fmtDelay(r.reply.delayMinutes) : ''}</span>
            : <span className="request-badge badge-pending"><Clock size={12} /> In attesa</span>
          }
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      <p className="request-text">{r.content}</p>

      {open && (
        <div className="request-detail">
          {r.keywords.length > 0 && (
            <div className="request-keywords">
              {r.keywords.map(k => <span key={k} className="kw-chip">{k}</span>)}
            </div>
          )}

          {r.evaded && r.reply && (
            <div className="request-reply">
              <span className="reply-label">Risposta ({fmtDate(r.reply.timestamp)})</span>
              <p className="reply-text">{r.reply.content}</p>
            </div>
          )}

          {r.repeated && r.previousOccurrences.length > 0 && (
            <div className="request-history">
              <span className="reply-label">Occorrenze precedenti</span>
              {r.previousOccurrences.map((occ, i) => (
                <div key={i} className="occ-row">
                  <span>{fmtDate(occ.timestamp)}</span>
                  {occ.evaded
                    ? <span className="request-badge badge-evaded"><CheckCircle size={10}/> evaso {occ.replyTimestamp ? fmtDate(occ.replyTimestamp) : ''}</span>
                    : <span className="request-badge badge-pending"><Clock size={10}/> non evaso</span>
                  }
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RequestsPanel({ phone }: { phone: string }) {
  const [activeTab, setActiveTab] = useState<'pending' | 'evaded' | 'all'>('pending');
  const [expandedTopic, setExpandedTopic] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<RequestsData>({
    queryKey: ['requests', phone],
    queryFn: async () => {
      const r = await fetch(`${getApiBase()}/api/conversations/${phone}/requests`);
      if (!r.ok) throw new Error('Errore caricamento richieste');
      return r.json();
    },
    staleTime: 30000,
  });

  if (isLoading) return <div className="requests-loading">Analisi richieste...</div>;
  if (error || !data) return <div className="requests-error">Impossibile caricare le richieste</div>;
  if (data.totalRequests === 0) return (
    <div className="requests-empty">
      <p>Nessuna richiesta rilevata nella conversazione.</p>
    </div>
  );

  const filteredRequests = data.requests.filter(r =>
    activeTab === 'all' ? true : activeTab === 'pending' ? !r.evaded : r.evaded
  );

  return (
    <div className="requests-panel">
      {/* KPI bar */}
      <div className="requests-kpi">
        <div className="kpi-box kpi-total">
          <span className="kpi-n">{data.totalRequests}</span>
          <span className="kpi-l">Totali</span>
        </div>
        <div className="kpi-box kpi-evaded">
          <CheckCircle size={14} />
          <span className="kpi-n">{data.evaded}</span>
          <span className="kpi-l">Evase</span>
        </div>
        <div className="kpi-box kpi-pending">
          <Clock size={14} />
          <span className="kpi-n">{data.pending}</span>
          <span className="kpi-l">In attesa</span>
        </div>
        {data.repeated > 0 && (
          <div className="kpi-box kpi-repeated">
            <RefreshCw size={14} />
            <span className="kpi-n">{data.repeated}</span>
            <span className="kpi-l">Ripetute</span>
          </div>
        )}
      </div>

      {/* Argomenti ricorrenti */}
      {data.topics.length > 1 && (
        <div className="requests-topics">
          <p className="topics-title">Argomenti</p>
          {data.topics.map(t => (
            <div key={t.topic} className="topic-row" onClick={() => setExpandedTopic(expandedTopic === t.topic ? null : t.topic)}>
              <div className="topic-info">
                <span className="topic-name">{t.topic}</span>
                <span className="topic-counts">
                  {t.evadedCount > 0 && <span className="badge-evaded-sm">✓ {t.evadedCount}</span>}
                  {t.pendingCount > 0 && <span className="badge-pending-sm">⏳ {t.pendingCount}</span>}
                </span>
              </div>
              <div className="topic-bar">
                <div className="topic-bar-evaded" style={{ width: `${(t.evadedCount / t.count) * 100}%` }} />
                <div className="topic-bar-pending" style={{ width: `${(t.pendingCount / t.count) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Filtri tab */}
      <div className="requests-tabs">
        <button className={activeTab === 'pending' ? 'req-tab active' : 'req-tab'} onClick={() => setActiveTab('pending')}>
          <Clock size={13}/> In attesa ({data.pending})
        </button>
        <button className={activeTab === 'evaded' ? 'req-tab active' : 'req-tab'} onClick={() => setActiveTab('evaded')}>
          <CheckCircle size={13}/> Evase ({data.evaded})
        </button>
        <button className={activeTab === 'all' ? 'req-tab active' : 'req-tab'} onClick={() => setActiveTab('all')}>
          Tutte ({data.totalRequests})
        </button>
      </div>

      {/* Lista richieste */}
      <div className="requests-list">
        {filteredRequests.length === 0
          ? <p className="requests-empty-tab">Nessuna richiesta in questa categoria.</p>
          : filteredRequests.map(r => <RequestCard key={r.id} r={r} />)
        }
      </div>
    </div>
  );
}
