export interface Conversation {
  id: number;
  phone: string;
  contactName: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  totalReceived: number;
  totalSent: number;
  autoReplyEnabled: number;
  autoReplyMessage: string | null;
  isArchived: number;
  priority: 'none' | 'normal' | 'high' | 'vip';
  priorityLabel: string | null;
  isGroup?: number;
  createdAt: string;
}

export interface Message {
  id: number;
  messageId: string;
  phone: string;
  contactName: string;
  content: string;
  direction: 'received' | 'sent';
  timestamp: string;
  isRead: number;
  isAudio: number;
  audioUrl: string | null;
  isImage: number;
  imageUrl: string | null;
  caption: string | null;
  originalContent: string | null;
  detectedLanguage: string | null;
  transcription?: string | null;
  transcriptionStatus?: string | null;
  createdAt: string;
}

export interface AnalyticsOverview {
  totalReceived: number;
  totalSent: number;
  todayReceived: number;
  unread: number;
  activeAlerts: number;
  conversations: number;
}

export interface WeeklyData {
  date: string;
  received: number;
  sent: number;
}

export interface HourlyData {
  hour: number;
  count: number;
}

export interface TodayReport {
  phone: string;
  contact_name: string;
  received: number;
  sent: number;
  last_activity: string;
}

export interface Settings {
  [key: string]: string;
}
