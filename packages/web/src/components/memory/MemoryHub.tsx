'use client';

import React from 'react';
import { KnowledgeFeed } from '../workspace/KnowledgeFeed';
import { EvidenceSearch } from './EvidenceSearch';
import { IndexStatus } from './IndexStatus';
import { MemoryNav, type MemoryTab } from './MemoryNav';

interface MemoryHubProps {
  readonly activeTab?: MemoryTab;
  readonly initialQuery?: string;
  readonly initialReferrerThread?: string | null;
}

export function MemoryHub({ activeTab = 'feed', initialQuery, initialReferrerThread = null }: MemoryHubProps) {
  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]" data-testid="memory-hub">
      <div className="flex flex-1 flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3">
        <header className="space-y-3 px-9 pt-8 pb-4">
          <div>
            <h1 className="text-2xl font-bold text-cafe">记忆</h1>
            <p className="mt-1 text-[13px] text-cafe-secondary">查看知识涌现、检索证据和索引健康状态</p>
          </div>
          <MemoryNav active={activeTab} initialReferrerThread={initialReferrerThread} />
        </header>

        <main className="flex-1 overflow-y-auto px-9 pb-8">
          {activeTab === 'feed' && (
            <div data-testid="memory-tab-feed">
              <KnowledgeFeed />
            </div>
          )}
          {activeTab === 'search' && (
            <div data-testid="memory-tab-search">
              <EvidenceSearch initialQuery={initialQuery} />
            </div>
          )}
          {activeTab === 'status' && (
            <div data-testid="memory-tab-status">
              <IndexStatus />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
