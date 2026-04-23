'use client';

import { useState } from 'react';
import { BrakeSettingsPanel } from '../BrakeSettingsPanel';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';
import { HubCommandsTab } from '../HubCommandsTab';
import { HubGovernanceTab } from '../HubGovernanceTab';
import { HubLeaderboardTab } from '../HubLeaderboardTab';
import { HubMemoryTab } from '../HubMemoryTab';
import { HubRoutingPolicyTab } from '../HubRoutingPolicyTab';
import { HubToolUsageTab } from '../HubToolUsageTab';
import { DEFAULT_OPS_SUBSECTION, OPS_SUBSECTIONS } from './ops-nav-config';
import { ServiceStatusPanel } from './ServiceStatusPanel';

export function OpsContent() {
  const [activeTab, setActiveTab] = useState(DEFAULT_OPS_SUBSECTION);

  return (
    <div>
      <div className="flex gap-1 mb-4 flex-wrap">
        {OPS_SUBSECTIONS.map((sub) => (
          <button
            key={sub.id}
            type="button"
            onClick={() => setActiveTab(sub.id)}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              activeTab === sub.id
                ? 'bg-cocreator-primary text-white'
                : 'bg-cafe-surface-elevated text-cafe-secondary hover:bg-cocreator-bg'
            }`}
          >
            {sub.label}
          </button>
        ))}
      </div>
      <OpsSubsectionContent subsection={activeTab} />
    </div>
  );
}

function OpsSubsectionContent({ subsection }: { subsection: string }) {
  switch (subsection) {
    case 'usage':
      return (
        <div className="space-y-6">
          <HubRoutingPolicyTab />
          <HubToolUsageTab />
        </div>
      );
    case 'leaderboard':
      return <HubLeaderboardTab />;
    case 'memory':
      return (
        <>
          <ServiceStatusPanel filterFeatures={['memory-semantic-search']} title="语义搜索服务" />
          <div className="mt-4">
            <HubMemoryTab />
          </div>
        </>
      );
    case 'health':
      return (
        <div className="space-y-6">
          <ServiceStatusPanel title="外部服务总览" />
          <HubGovernanceTab />
          <BrakeSettingsPanel />
        </div>
      );
    case 'commands':
      return <HubCommandsTab />;
    case 'rescue':
      return <HubClaudeRescueSection />;
    default:
      return null;
  }
}
