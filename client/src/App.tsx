import { Switch, Route } from 'wouter';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import BottomNav from './components/BottomNav';
import Dashboard from './pages/Dashboard';
import Inbox from './pages/Inbox';
import Report from './pages/Report';
import Settings from './pages/Settings';
import Integrations from './pages/Integrations';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="app-root">
        <div className="app-content">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/inbox" component={Inbox} />
            <Route path="/report" component={Report} />
            <Route path="/settings" component={Settings} />
            <Route path="/integrations" component={Integrations} />
          </Switch>
        </div>
        <BottomNav />
      </div>
    </QueryClientProvider>
  );
}
