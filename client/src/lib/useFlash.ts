/**
 * useFlash — lampeggio schermo per nuovi messaggi WhatsApp
 *
 * Verde  (#00ff44) → messaggio testo
 * Giallo (#ffe033) → messaggio audio
 * Rosso  (#ff2244) → messaggio VIP
 *
 * Funziona anche con tab in background:
 *  - lampeggio visivo quando si torna sulla tab (se non già mostrato)
 *  - titolo della pagina lampeggia con contatore non letti
 */

type FlashColor = 'green' | 'yellow' | 'red';

// Crea overlay la prima volta (singleton nel DOM)
function getOverlay(): HTMLDivElement {
  let el = document.getElementById('screen-flash-overlay') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'screen-flash-overlay';
    document.body.appendChild(el);
  }
  return el;
}

// Coda per lampeggi quando tab è in background
let pendingFlash: FlashColor | null = null;
let titleBlinkInterval: ReturnType<typeof setInterval> | null = null;
let originalTitle = '';
let pendingCount = 0;

function stopTitleBlink() {
  if (titleBlinkInterval) {
    clearInterval(titleBlinkInterval);
    titleBlinkInterval = null;
  }
  document.title = originalTitle;
  pendingCount = 0;
}

function startTitleBlink(color: FlashColor) {
  if (!originalTitle) originalTitle = document.title;
  pendingCount++;

  const emoji = color === 'red' ? '🔴' : color === 'yellow' ? '🟡' : '🟢';
  let visible = true;

  if (!titleBlinkInterval) {
    titleBlinkInterval = setInterval(() => {
      if (document.hidden) {
        document.title = visible
          ? `${emoji} (${pendingCount}) ${originalTitle}`
          : originalTitle;
        visible = !visible;
      } else {
        stopTitleBlink();
      }
    }, 600);
  }
}

function triggerFlash(color: FlashColor) {
  const overlay = getOverlay();
  // Rimuovi classi precedenti e forza reflow per riavviare animazione
  overlay.className = '';
  void overlay.offsetWidth; // reflow
  overlay.className = `flash-${color}`;
  // Pulisci dopo l'animazione
  overlay.addEventListener('animationend', () => {
    overlay.className = '';
  }, { once: true });
}

// Handler visibilità tab: quando si torna in primo piano, mostra flash pendente
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pendingFlash) {
      triggerFlash(pendingFlash);
      pendingFlash = null;
      stopTitleBlink();
    }
  });
}

/**
 * Funzione principale — chiama questa quando arriva un messaggio.
 * Se la tab è visibile: lampeggio immediato.
 * Se è in background: lampeggio appena torna in primo piano + titolo lampeggiante.
 */
export function flashScreen(color: FlashColor) {
  if (document.hidden) {
    // Tab in background: accumula e lampeggia al ritorno
    // Priorità: red > yellow > green
    if (
      pendingFlash === null ||
      (color === 'red') ||
      (color === 'yellow' && pendingFlash === 'green')
    ) {
      pendingFlash = color;
    }
    startTitleBlink(color);
  } else {
    triggerFlash(color);
  }
}
