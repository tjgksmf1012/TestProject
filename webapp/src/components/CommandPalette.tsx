import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface CommandPaletteProps {
  open: boolean;
  projectId?: number;
  onClose: () => void;
  onOpenCall: () => void;
  onOpenSettings: (tab: 'voice' | 'account' | 'display') => void;
}

export function CommandPalette({
  open,
  projectId = 1,
  onClose,
  onOpenCall,
  onOpenSettings,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const commands = [
    {
      id: 'call',
      label: '화상 회의실 열기',
      shortcut: 'Enter',
      run: () => {
        onClose();
        onOpenCall();
      },
    },
    {
      id: 'voice-settings',
      label: '설정 (오디오·비디오)',
      shortcut: 'G V',
      run: () => {
        onClose();
        onOpenSettings('voice');
      },
    },
    {
      id: 'acct-settings',
      label: '설정 (계정·보안)',
      shortcut: 'G A',
      run: () => {
        onClose();
        onOpenSettings('account');
      },
    },
    {
      id: 'kanban',
      label: '칸반 보드',
      shortcut: 'G B',
      run: () => {
        onClose();
        navigate(`/project/${projectId}/kanban`);
      },
    },
    {
      id: 'contributions',
      label: '기여도 분석',
      shortcut: 'G C',
      run: () => {
        onClose();
        navigate(`/project/${projectId}/contributions`);
      },
    },
    {
      id: 'ai-lab',
      label: 'AI 기능 체험관 (Demo Lab)',
      shortcut: 'G D',
      run: () => {
        onClose();
        navigate(projectId ? `/project/${projectId}/demo` : '/demo');
      },
    },
    {
      id: 'home',
      label: '프로젝트 홈',
      shortcut: 'G H',
      run: () => {
        onClose();
        navigate(`/?project=${projectId}`);
      },
    },
  ];

  const filtered = commands.filter((c) =>
    c.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div
      className="dc-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="빠른 명령어 팔레트"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dc-cmdk">
        <input
          className="dc-cmdk__input"
          placeholder="채널 이동 또는 기능 실행... (ESC로 닫기)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="dc-cmdk__list">
          {filtered.map((cmd) => (
            <button
              key={cmd.id}
              type="button"
              className="dc-cmdk__item"
              onClick={cmd.run}
            >
              <span>{cmd.label}</span>
              <kbd className="dc-kbd">{cmd.shortcut}</kbd>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
