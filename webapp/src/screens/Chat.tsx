import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useProjects } from '../api/hooks.ts';
import { AppShell } from '../components/AppShell.tsx';
import { ChatWorkspace } from '../components/ChatWorkspace.tsx';
import { Problem } from '../components/Problem.tsx';
import { channelTitle, type ChatChannel } from '@lib/chat/view.ts';
import { describeLoadFailure } from '@lib/ui/load.ts';
import { ApiError } from '../api/client.ts';

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export default function Chat() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const pid = Number(projectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedChannelParam = Number(searchParams.get('channel') ?? '0');

  const projectsQuery = useProjects();
  const [activeChannel, setActiveChannel] = useState<ChatChannel | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  return (
    <AppShell
      projectId={pid}
      title={activeChannel ? `채팅 · ${channelTitle(activeChannel)}` : '채팅'}
      actions={
        <div className="tf-row-actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-expanded={showSearch}
            onClick={() => setShowSearch((v) => !v)}
          >
            {showSearch ? '검색 닫기' : '대화 찾기'}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            aria-expanded={showCreateChannel}
            onClick={() => setShowCreateChannel((v) => !v)}
          >
            {showCreateChannel ? '채널 추가 닫기' : '+ 채널 만들기'}
          </button>
        </div>
      }
    >
      {projectsQuery.isError && (
        <Problem>
          <span>{describeLoadFailure('프로젝트 목록', statusOf(projectsQuery.error))}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void projectsQuery.refetch()}
          >
            다시 시도
          </button>
        </Problem>
      )}

      <ChatWorkspace
        projectId={pid}
        initialChannelId={requestedChannelParam}
        showCreateChannel={showCreateChannel}
        onShowCreateChannelChange={setShowCreateChannel}
        showSearch={showSearch}
        onShowSearchChange={setShowSearch}
        onActiveChannelChange={setActiveChannel}
        onChannelUrlSync={(channelId) => {
          const next = new URLSearchParams(searchParams);
          next.set('channel', String(channelId));
          setSearchParams(next, { replace: true });
        }}
        onNavigate={(to) => navigate(to)}
      />
    </AppShell>
  );
}
