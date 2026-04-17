import { useState, useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Database,
  Send,
  Radio,
  ListTodo,
  Settings,
  FileText,
  Search,
  Repeat,
  Sun,
  Moon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard },
  { to: '/accounts', label: '号池管理', icon: Database },
  { to: '/convert', label: '转换', icon: Repeat },
  { to: '/detect', label: '检测', icon: Search },
  { to: '/push', label: '推送', icon: Send },
  { to: '/channels', label: '渠道', icon: Radio },
  { to: '/profiles', label: '模板', icon: FileText },
  { to: '/tasks', label: '任务', icon: ListTodo },
  { to: '/settings', label: '设置', icon: Settings },
];

type Theme = 'cyberpunk' | 'light';

function getInitialTheme(): Theme {
  return (localStorage.getItem('theme') as Theme) || 'cyberpunk';
}

export default function Layout() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => t === 'cyberpunk' ? 'light' : 'cyberpunk');

  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="flex flex-col w-52 shrink-0 h-screen border-r border-border bg-card">
        <div className="px-5 py-4 text-sm font-bold tracking-wider">
          <span className="opacity-50">&gt; </span>AUTH_PUSHER
        </div>
        <div className="flex-1 flex flex-col gap-0.5 px-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                    isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            );
          })}
        </div>
        <div className="px-3 py-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            className="w-full justify-center gap-2"
          >
            {theme === 'cyberpunk' ? (
              <><Sun className="h-3.5 w-3.5" /> 浅色</>
            ) : (
              <><Moon className="h-3.5 w-3.5" /> 赛博</>
            )}
          </Button>
        </div>
        <div className="px-5 py-2 text-xs text-muted-foreground">
          v1.5
        </div>
      </nav>
      <main className="flex-1 min-w-0 h-screen overflow-auto">
        <div className="p-5">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
