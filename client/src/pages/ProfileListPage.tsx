import { useState, useEffect } from 'react';
import { get, del } from '../api/client';
import { useFeedback } from '../components/FeedbackProvider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

interface DataProfile {
  id: string;
  name: string;
  description: string;
  fieldMapping: Record<string, string>;
  fingerprint: string[];
  builtin?: boolean;
  createdAt: string;
}

export default function ProfileListPage() {
  const [profiles, setProfiles] = useState<DataProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const { confirm, notify } = useFeedback();

  const load = () => {
    get<DataProfile[]>('/profiles').then(setProfiles).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleDelete = async (id: string, name: string) => {
    const accepted = await confirm({
      title: '删除模板',
      description: `确认删除模板「${name}」？`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!accepted) return;
    await del(`/profiles/${id}`);
    notify({ tone: 'success', title: '模板已删除', description: `已删除「${name}」` });
    load();
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">数据模板</h2>
      <p className="text-muted-foreground text-xs mb-4">
        数据模板保存了字段映射配置，上传文件时自动匹配，免去重复配置
      </p>

      {loading ? (
        <p className="text-muted-foreground">加载中...</p>
      ) : profiles.length === 0 ? (
        <Card className="text-center p-10">
          <p className="text-muted-foreground">暂无数据模板</p>
        </Card>
      ) : (
        <div className="grid gap-3">
          {profiles.map((p) => (
            <Card key={p.id} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{p.name}</span>
                  {p.builtin && <Badge variant="info">内置</Badge>}
                </div>
                {!p.builtin && (
                  <Button size="sm" variant="destructive" onClick={() => handleDelete(p.id, p.name)}>删除</Button>
                )}
              </div>
              {p.description && <p className="text-muted-foreground text-xs mb-3">{p.description}</p>}

              <div className="mb-2">
                <span className="text-muted-foreground text-xs font-semibold">字段映射:</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(p.fieldMapping).map(([std, src]) => (
                  <span key={std} className="px-2 py-0.5 rounded text-xs bg-muted border border-border">
                    <b>{std}</b> <span className="text-muted-foreground">&larr;</span> {src}
                  </span>
                ))}
              </div>

              {p.fingerprint.length > 0 && (
                <div className="mt-2">
                  <span className="text-muted-foreground text-xs">
                    指纹字段: {p.fingerprint.join(', ')}
                  </span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
