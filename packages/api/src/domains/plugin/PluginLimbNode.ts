import type { ILimbNode, LimbCapability, LimbInvokeResult, LimbNodeStatus } from '@cat-cafe/shared';

export class PluginLimbNode implements ILimbNode {
  readonly nodeId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly capabilities: LimbCapability[];

  constructor(decl: {
    nodeId: string;
    displayName: string;
    platform: string;
    capabilities: LimbCapability[];
  }) {
    this.nodeId = decl.nodeId;
    this.displayName = decl.displayName;
    this.platform = decl.platform;
    this.capabilities = decl.capabilities;
  }

  async register(): Promise<void> {}

  async invoke(command: string): Promise<LimbInvokeResult> {
    return {
      success: false,
      error: `Plugin limb '${this.nodeId}' requires platform-specific adapter for '${command}'`,
    };
  }

  async healthCheck(): Promise<LimbNodeStatus> {
    return 'offline';
  }

  async deregister(): Promise<void> {}
}
