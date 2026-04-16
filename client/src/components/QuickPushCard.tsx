import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Zap, Radio, Database } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface Channel {
  id: string;
  name: string;
  pusherType: string;
  enabled: boolean;
  defaultAccountFilter?: {
    planType?: string;
    excludeDisabled?: boolean;
    excludeExpired?: boolean;
  };
}

interface QuickPushCardProps {
  channels: Channel[];
}

export function QuickPushCard({ channels }: QuickPushCardProps) {
  const navigate = useNavigate();

  if (channels.length === 0) return null;

  return (
    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
      {channels.map((ch) => {
        const defaultFilter = ch.defaultAccountFilter;
        const planType = defaultFilter?.planType;
        const excludeDisabled = defaultFilter?.excludeDisabled ?? true;
        const excludeExpired = defaultFilter?.excludeExpired ?? true;

        return (
          <Card
            key={ch.id}
            className="p-4 cursor-pointer hover:border-primary/70 hover:shadow-md transition-all group"
            onClick={() => navigate(`/push?channel=${ch.id}`)}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-md bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                <Zap className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-sm truncate">{ch.name}</h3>
                  <Badge variant="info" className="text-[10px] shrink-0">
                    {ch.pusherType}
                  </Badge>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  <Radio className="h-3 w-3" />
                  <span>快速推送</span>
                </div>
                {(planType || excludeDisabled || excludeExpired) && (
                  <div className="flex flex-wrap gap-1 text-xs">
                    {planType && (
                      <Badge variant="muted" className="text-[10px]">
                        <Database className="h-2.5 w-2.5 mr-1" />
                        {planType}
                      </Badge>
                    )}
                    {excludeDisabled && (
                      <Badge variant="muted" className="text-[10px]">
                        排除禁用
                      </Badge>
                    )}
                    {excludeExpired && (
                      <Badge variant="muted" className="text-[10px]">
                        排除过期
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </div>
            <Button
              variant="primary"
              size="sm"
              className="w-full mt-3"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/push?channel=${ch.id}`);
              }}
            >
              立即推送
            </Button>
          </Card>
        );
      })}
    </div>
  );
}
