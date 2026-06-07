import { useState, useEffect, useRef } from 'react';
import { useConversations, useMessages, useSendMessage, useSetPriority, useSSE } from '../lib/hooks';
import PriorityBadge from '../components/PriorityBadge';
import Loader from '../components/Loader';
import type { Conversation } from '../lib/types';
import { Search, Send, ArrowLeft, MoreVertical, Star, AlertTriangle, User, Volume2 } from 'lucide-react';

export default function Inbox() {
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 600);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: conversations = [], isLoading } = useConversations(false, search);
  const { data: messages = [], refetch: refetchMessages } = useMessages(selectedPhone || '');
  const sendMsg = useSendMessage(selectedPhone || '');
  const setPriority = useSetPriority(selectedPhone || '');

  const connectSSE = useSSE((type, data) => {
    if (type === 'message' && data.phone === selectedPhone) {
      refetchMessages();
    }
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    esRef.current = connectSSE();
    return () => esRef.current?.close();
  }, []);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 600);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const selectedConv = conversations.find(c => c.phone === selectedPhone);

  const handleSend = async () => {
    const text = messageInput.trim();
    if (!text || !selectedPhone) return;
    setMessageInput('');
    try {
      await sendMsg.mutateAsync(text);
    } catch (e) {
      console.error('Send error:', e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const formatTime = (ts: string) => {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      const today = new Date();
      if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      }
      return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
    } catch {
      return '';
    }
  };

  const priorityColor = (p: string) => {
    if (p === 'vip') return '#fbbf24';
    if (p === 'high') return '#f97316';
    return 'transparent';
  };

  const showList = !isMobile || !selectedPhone;
  const showChat = !isMobile || !!selectedPhone;

  return (
    <div className="inbox-layout">
      {/* Sidebar / List */}
      {showList && (
        <aside className="inbox-sidebar">
          <div className="inbox-search-wrap">
            <Search size={16} className="inbox-search-icon" />
            <input
              type="search"
              placeholder="Cerca contatto..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="inbox-search-input"
            />
          </div>

          {isLoading ? (
            <Loader text="Caricamento..." />
          ) : conversations.length === 0 ? (
            <div className="inbox-empty">
              <User size={32} opacity={0.3} />
              <p>Nessuna conversazione</p>
              <small>Sincronizza i contatti da Impostazioni</small>
            </div>
          ) : (
            <div className="conv-list">
              {conversations.map(conv => (
                <button
                  key={conv.phone}
                  className={`conv-item ${selectedPhone === conv.phone ? 'active' : ''}`}
                  onClick={() => setSelectedPhone(conv.phone)}
                  style={{ borderLeft: `3px solid ${priorityColor(conv.priority)}` }}
                >
                  <div className="conv-avatar">
                    {(conv.contactName || conv.phone).charAt(0).toUpperCase()}
                  </div>
                  <div className="conv-info">
                    <div className="conv-top">
                      <span className="conv-name">
                        {conv.contactName || conv.phone}
                      </span>
                      <span className="conv-time">{formatTime(conv.lastMessageAt)}</span>
                    </div>
                    <div className="conv-bottom">
                      <span className="conv-last">{conv.lastMessage || '—'}</span>
                      {conv.unreadCount > 0 && (
                        <span className="conv-badge">{conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>
                      )}
                    </div>
                    {conv.priority !== 'none' && (
                      <PriorityBadge priority={conv.priority} label={conv.priorityLabel} />
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>
      )}

      {/* Chat Panel */}
      {showChat && (
        <main className="chat-panel">
          {!selectedPhone ? (
            <div className="chat-empty-state">
              <div className="chat-empty-icon">
                <svg viewBox="0 0 64 64" width="64" height="64" fill="none">
                  <rect width="64" height="64" rx="16" fill="#25D366" fillOpacity="0.1"/>
                  <path d="M32 12C20.954 12 12 20.954 12 32c0 3.78 1.04 7.32 2.848 10.36L12 52l9.9-2.788A19.906 19.906 0 0032 52c11.046 0 20-8.954 20-20S43.046 12 32 12z" fill="#25D366" fillOpacity="0.3"/>
                </svg>
              </div>
              <h3>Seleziona una conversazione</h3>
              <p>Scegli un contatto dalla lista per visualizzare i messaggi</p>
            </div>
          ) : (
            <>
              {/* Chat Header */}
              <div className="chat-header">
                {isMobile && (
                  <button className="btn-back" onClick={() => setSelectedPhone(null)}>
                    <ArrowLeft size={20} />
                  </button>
                )}
                <div className="chat-avatar">
                  {(selectedConv?.contactName || selectedPhone).charAt(0).toUpperCase()}
                </div>
                <div className="chat-contact-info">
                  <div className="chat-contact-name">
                    {selectedConv?.contactName || selectedPhone}
                  </div>
                  <div className="chat-contact-phone">{selectedPhone}</div>
                </div>
                <div className="chat-header-actions">
                  <button
                    className="btn-icon"
                    onClick={() => setShowPriorityMenu(v => !v)}
                    title="Priorità"
                  >
                    <MoreVertical size={18} />
                  </button>
                  {showPriorityMenu && (
                    <div className="priority-dropdown">
                      <button onClick={() => { setPriority.mutate({ priority: 'vip', priorityLabel: 'VIP' }); setShowPriorityMenu(false); }}>
                        <Star size={14} /> VIP
                      </button>
                      <button onClick={() => { setPriority.mutate({ priority: 'high', priorityLabel: 'Alta' }); setShowPriorityMenu(false); }}>
                        <AlertTriangle size={14} /> Alta
                      </button>
                      <button onClick={() => { setPriority.mutate({ priority: 'normal', priorityLabel: 'Normale' }); setShowPriorityMenu(false); }}>
                        <User size={14} /> Normale
                      </button>
                      <button onClick={() => { setPriority.mutate({ priority: 'none', priorityLabel: '' }); setShowPriorityMenu(false); }}>
                        Nessuna
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Messages */}
              <div className="messages-area">
                {messages.length === 0 ? (
                  <div className="messages-empty">Nessun messaggio ancora</div>
                ) : (
                  messages.map(msg => (
                    <div
                      key={msg.id}
                      className={`message-bubble ${msg.direction === 'sent' ? 'sent' : 'received'}`}
                    >
                      {msg.isAudio ? (
                        <div className="audio-message">
                          <Volume2 size={16} />
                          <span>Messaggio audio</span>
                          {msg.audioUrl && (
                            <audio controls src={msg.audioUrl} style={{ height: 28 }} />
                          )}
                        </div>
                      ) : (
                        <span>{msg.content}</span>
                      )}
                      <div className="message-time">
                        {formatTime(msg.timestamp || msg.createdAt)}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="chat-input-wrap">
                <textarea
                  className="chat-input"
                  placeholder="Scrivi un messaggio..."
                  value={messageInput}
                  onChange={e => setMessageInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <button
                  className="btn-send"
                  onClick={handleSend}
                  disabled={!messageInput.trim() || sendMsg.isPending}
                >
                  <Send size={18} />
                </button>
              </div>
            </>
          )}
        </main>
      )}
    </div>
  );
}
