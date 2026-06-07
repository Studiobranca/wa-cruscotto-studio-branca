import { useTodayReport, useOverview } from '../lib/hooks';
import Loader from '../components/Loader';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell
} from 'recharts';

export default function Report() {
  const { data: report = [], isLoading } = useTodayReport();
  const { data: overview } = useOverview();

  const formatTime = (ts: string) => {
    if (!ts) return '';
    try {
      const normalized = ts.endsWith('Z') || ts.includes('+') ? ts : ts + 'Z';
      return new Date(normalized).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  const chartData = report
    .filter(r => !r.phone?.includes('120363') && r.phone?.length >= 10)
    .slice(0, 12)
    .map(r => ({
      name: (r.contact_name || r.phone).substring(0, 18),
      received: r.received,
      sent: r.sent,
    }));

  if (isLoading) return <Loader text="Caricamento report..." />;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1 className="page-title">Report Giornaliero</h1>
        <p className="page-subtitle">{new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </header>

      {/* Summary */}
      <div className="report-summary">
        <div className="report-stat">
          <div className="report-stat-value">{overview?.todayReceived ?? 0}</div>
          <div className="report-stat-label">Messaggi ricevuti oggi</div>
        </div>
        <div className="report-stat">
          <div className="report-stat-value">{report.length}</div>
          <div className="report-stat-label">Contatti attivi</div>
        </div>
        <div className="report-stat">
          <div className="report-stat-value">{overview?.unread ?? 0}</div>
          <div className="report-stat-label">Non letti</div>
        </div>
      </div>

      {/* Chart */}
      {chartData.length > 0 && (
        <div className="chart-card">
          <h2 className="chart-title">Top contatti oggi</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#9ca3af' }} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#9ca3af' }} width={130} />
              <Tooltip
                contentStyle={{ background: '#1f2937', border: 'none', borderRadius: 8, fontSize: 12 }}
              />
              <Bar dataKey="received" name="Ricevuti" fill="#25D366" radius={[0, 3, 3, 0]} />
              <Bar dataKey="sent" name="Inviati" fill="#128C7E" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Detailed Table */}
      <div className="chart-card">
        <h2 className="chart-title">Dettaglio attività</h2>
        {report.length === 0 ? (
          <div className="chart-empty">Nessuna attività registrata oggi.</div>
        ) : (
          <div className="today-table-wrap">
            <table className="today-table">
              <thead>
                <tr>
                  <th>Contatto</th>
                  <th>Numero</th>
                  <th>Ricevuti</th>
                  <th>Inviati</th>
                  <th>Ultima att.</th>
                </tr>
              </thead>
              <tbody>
                {report.map((row, i) => (
                  <tr key={i}>
                    <td className="contact-cell">
                      <span className="contact-avatar">
                        {(row.contact_name || row.phone).charAt(0).toUpperCase()}
                      </span>
                      <span>{row.contact_name || '—'}</span>
                    </td>
                    <td style={{ fontSize: 12, color: '#9ca3af' }}>{row.phone}</td>
                    <td className="count-received">{row.received}</td>
                    <td className="count-sent">{row.sent}</td>
                    <td className="time-cell">{formatTime(row.last_activity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
