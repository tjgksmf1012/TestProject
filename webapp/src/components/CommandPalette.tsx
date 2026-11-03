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
      category: '회의',
      shortcut: 'Enter',
      run: () => {
        onClose();
        onOpenCall();
      },
    },
    {
      id: 'kanban',
      label: '칸반 보드',
      category: '업무',
      shortcut: 'G B',
      run: () => {
        onClose();
        navigate(`/project/${projectId}/kanban`);
      },
    },
    {
      id: 'contributions',
      label: '기여도 분석 및 팀 합의 확정',
      category: '기여도',
      shortcut: 'G C',
      run: () => {
        onClose();
        navigate(`/project/${projectId}/contributions`);
      },
    },
    {
      id: 'ai-lab',
      label: 'AI 기능 체험관 (Demo Lab) — 성문 인식 & 파이프라인',
      category: 'AI',
      shortcut: 'G D',
      run: () => {
        onClose();
        navigate('/demo');
      },
    },
    {
      id: 'home',
      label: '프로젝트 홈 대시보드',
      category: '탐색',
      shortcut: 'G H',
      run: () => {
        onClose();
        navigate(`/?project=${projectId}`);
      },
    },
    {
      id: 'reports',
      label: '최종 기여도 보고서 (제출용)',
      category: '보고서',
      shortcut: 'G P',
      run: () => {
        onClose();
        window.open('/reports.html', '_blank');
      },
    },
    {
      id: 'voice-settings',
      label: '설정 (오디오·마이크·스피커)',
      category: '설정',
      shortcut: 'G V',
      run: () => {
        onClose();
        onOpenSettings('voice');
      },
    },
    {
      id: 'acct-settings',
      label: '설정 (계정·보안·초대 코드)',
      category: '설정',
      shortcut: 'G A',
      run: () => {
        onClose();
        onOpenSettings('account');
      },
    },
  ];

  const filtered = commands.filter((c) =>
    c.label.toLowerCase().includes(query.trim().toLowerCase()) ||
    c.category.toLowerCase().includes(query.trim().toLowerCase())
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
          {filtered.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--c-ink-muted)', fontSize: '13px' }}>
              일치하는 기능이나 화면이 없습니다.
            </div>
          ) : (
            filtered.map((cmd) => (
              <button
                key={cmd.id}
                type="button"
                className="dc-cmdk__item"
                onClick={cmd.run}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="dc-badge dc-badge--neutral" style={{ fontSize: '10px', padding: '1px 5px' }}>
                    {cmd.category}
                  </span>
                  <span>{cmd.label}</span>
                </div>
                <kbd className="dc-kbd">{cmd.shortcut}</kbd>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
