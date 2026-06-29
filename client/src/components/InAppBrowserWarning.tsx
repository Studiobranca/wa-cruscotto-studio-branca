import { useState } from 'react';

// I browser integrati di WhatsApp/Instagram/Facebook/ecc. (in-app webview) hanno una
// loro barra nativa che a volte intercetta i tocchi sui bottoni in fondo alla pagina,
// senza che il sito possa accorgersene. Avvisa l'utente e indica la via d'uscita:
// aprire la pagina nel browser vero (Safari/Chrome) tramite il menu ⋯ /condividi.
function detectInAppBrowser(): string | null {
  const ua = navigator.userAgent || '';
  if (/\bWhatsApp\b/i.test(ua)) return 'WhatsApp';
  if (/Instagram/i.test(ua)) return 'Instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook';
  if (/\bLine\//i.test(ua)) return 'Line';
  if (/Twitter/i.test(ua)) return 'Twitter/X';
  return null;
}

export default function InAppBrowserWarning() {
  const [app] = useState(detectInAppBrowser);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem('iab-warning-dismissed') === '1');

  if (!app || dismissed) return null;

  function dismiss() {
    sessionStorage.setItem('iab-warning-dismissed', '1');
    setDismissed(true);
  }

  return (
    <div style={{
      background: '#fff3cd', color: '#856404', padding: '10px 14px', fontSize: 13,
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      borderBottom: '1px solid rgba(0,0,0,0.08)',
    }}>
      <span>
        ⚠️ Stai aprendo questa pagina dal browser di {app}: alcuni bottoni potrebbero non rispondere.
        Tocca <b>⋯</b> o l'icona di condivisione in alto e scegli <b>"Apri in Safari/Chrome"</b>.
      </span>
      <button onClick={dismiss} style={{
        background: 'none', border: 'none', color: '#856404', fontSize: 16, fontWeight: 700,
        cursor: 'pointer', flexShrink: 0, lineHeight: 1, padding: 4,
      }}>×</button>
    </div>
  );
}
