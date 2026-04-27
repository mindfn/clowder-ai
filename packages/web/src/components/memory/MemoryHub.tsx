'use client';

import React from 'react';
import { KnowledgeFeed } from '../workspace/KnowledgeFeed';
import { EvidenceSearch } from './EvidenceSearch';
import { HealthReport } from './HealthReport';
import { IndexStatus } from './IndexStatus';
import { MemoryNav, type MemoryTab } from './MemoryNav';

interface MemoryHubProps {
  readonly activeTab?: MemoryTab;
  readonly initialQuery?: string;
}

export function MemoryHub({ activeTab = 'feed', initialQuery }: MemoryHubProps) {
  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]" data-testid="memory-hub">
      <div className="flex flex-1 flex-col m-3 mt-2 rounded-2xl bg-[var(--console-card-bg)] shadow-[var(--console-shadow-soft)] overflow-hidden">
        <header className="flex items-center gap-3 border-b border-[var(--console-border-soft)] px-5 py-3">
          <MemoryNav active={activeTab} />
        </header>

        <main className="flex-1 overflow-y-auto p-5">
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
          {activeTab === 'health' && (
            <div data-testid="memory-tab-health">
              <HealthReport />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
