import { useLocation, Link } from 'wouter';
import { LayoutDashboard, MessageSquare, Bot, Mail, BarChart2, Plug, Settings } from 'lucide-react';

const navItems = [
  { path: '/', label: 'Home', icon: LayoutDashboard },
  { path: '/inbox', label: 'Inbox', icon: MessageSquare },
  { path: '/bot', label: 'Bozze', icon: Bot },
  { path: '/email', label: 'Email', icon: Mail },
  { path: '/report', label: 'Report', icon: BarChart2 },
  { path: '/integrations', label: 'Connettori', icon: Plug },
  { path: '/settings', label: 'Config', icon: Settings },
];

export default function BottomNav() {
  const [location] = useLocation();

  return (
    <nav className="bottom-nav">
      {navItems.map(({ path, label, icon: Icon }) => (
        <Link key={path} href={path}>
          <a className={`bottom-nav-item ${location === path ? 'active' : ''}`}>
            <Icon size={22} strokeWidth={location === path ? 2.5 : 1.8} />
            <span>{label}</span>
          </a>
        </Link>
      ))}
    </nav>
  );
}
