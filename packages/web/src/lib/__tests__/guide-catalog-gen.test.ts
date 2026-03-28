/**
 * F150: Tests for the generated guide catalog.
 *
 * Validates that:
 * 1. The generated catalog matches YAML source structure
 * 2. Registry entries have required fields
 * 3. Flow steps match runtime GuideStep interface
 * 4. Schema invariants (exit path, unique IDs) hold
 */
import { describe, expect, it } from 'vitest';
import { GUIDE_FLOWS, GUIDE_REGISTRY } from '../guide-catalog.gen';

describe('GUIDE_REGISTRY', () => {
  it('contains at least one entry', () => {
    expect(GUIDE_REGISTRY.length).toBeGreaterThan(0);
  });

  it('every entry has required fields', () => {
    for (const entry of GUIDE_REGISTRY) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.keywords).toBeInstanceOf(Array);
      expect(entry.keywords.length).toBeGreaterThan(0);
      expect(entry.category).toBeTruthy();
      expect(entry.priority).toMatch(/^P[0-3]$/);
    }
  });

  it('every registry entry has a matching flow', () => {
    for (const entry of GUIDE_REGISTRY) {
      expect(GUIDE_FLOWS[entry.id]).toBeDefined();
    }
  });
});

describe('GUIDE_FLOWS', () => {
  it('add-member flow exists with correct structure', () => {
    const flow = GUIDE_FLOWS['add-member'];
    expect(flow).toBeDefined();
    expect(flow.id).toBe('add-member');
    expect(flow.name).toBe('添加成员');
    expect(flow.steps.length).toBe(8);
  });

  it('every flow has unique step IDs', () => {
    for (const flow of Object.values(GUIDE_FLOWS)) {
      const ids = flow.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('every console_action step has a targetGuideId', () => {
    for (const flow of Object.values(GUIDE_FLOWS)) {
      for (const step of flow.steps) {
        // Steps with targetGuideId are console_action; information steps may omit it
        if (step.expectedAction !== 'confirm') {
          expect(step.targetGuideId).toBeTruthy();
        }
      }
    }
  });

  it('every flow has at least one exit path (canSkip step)', () => {
    for (const flow of Object.values(GUIDE_FLOWS)) {
      const hasExit = flow.steps.some((s) => s.canSkip === true);
      expect(hasExit).toBe(true);
    }
  });

  it('all steps have required title and instruction', () => {
    for (const flow of Object.values(GUIDE_FLOWS)) {
      for (const step of flow.steps) {
        expect(step.title).toBeTruthy();
        expect(step.instruction).toBeTruthy();
      }
    }
  });
});

describe('Registry ↔ Flow consistency', () => {
  it('no orphan flows (every flow has a registry entry)', () => {
    const registeredIds = new Set(GUIDE_REGISTRY.map((e) => e.id));
    for (const flowId of Object.keys(GUIDE_FLOWS)) {
      expect(registeredIds.has(flowId)).toBe(true);
    }
  });
});
