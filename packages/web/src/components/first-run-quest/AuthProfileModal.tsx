'use client';

import { ApiKeyCreateForm, type EditProfileData } from './ApiKeyCreateForm';

interface AuthProfileModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (profileId: string) => void;
  editProfile?: EditProfileData;
}

export function AuthProfileModal({ open, onClose, onCreated, editProfile }: AuthProfileModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-gray-900">
            {editProfile ? '编辑 API Key 账号' : '新建 API Key 账号'}
          </h4>
          <button
            type="button"
            onClick={onClose}
            className="text-lg leading-none text-gray-400 hover:text-gray-600"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>
        <ApiKeyCreateForm
          key={editProfile?.id ?? 'create'}
          editProfile={editProfile}
          onCreated={(id) => {
            onCreated(id);
            onClose();
          }}
        />
      </div>
    </div>
  );
}
