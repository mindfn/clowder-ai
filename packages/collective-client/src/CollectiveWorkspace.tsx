import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChannelContent } from './ChannelContentTabs.js';
import { ChannelNavigation } from './ChannelNavigation.js';
import { CollectiveChannelWorkspace } from './CollectiveChannelWorkspace.js';
import { CollectiveHome } from './CollectiveHome.js';
import {
  channelDestinations,
  readChannelEntry,
  saveChannelPosition,
  writeChannelTarget,
} from './channel-navigation.js';
import type { CollectiveEventEnvelope, CollectiveWorkProjection } from './client-types.js';
import { type RoadmapReturn, visibleCollectiveCats } from './collective-workspace-model.js';
import { DemoSpotlight } from './first-entry/DemoSpotlight.js';
import { EntrySpotlight } from './first-entry/EntrySpotlight.js';
import { useFirstEntryGuide } from './first-entry/use-first-entry-guide.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import type { MemberSelection } from './MemberPanel.js';
import { ProductShell } from './ProductShell.js';
import type { RoadmapViewState } from './roadmap-view-model.js';
import type { useCollectiveClient } from './use-collective-client.js';
import { useHostContext } from './use-host-context.js';
import { HostWorkPermissionContext } from './use-host-work-policy.js';

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This canonical coordinator owns the inherited Host, guide, roadmap, and destination transitions; the rendered Channel scene is split out so this batch reduces complexity below the main baseline without duplicating navigation state.
export function CollectiveWorkspace({
  embedded,
  client,
}: {
  readonly embedded: boolean;
  readonly client: ReturnType<typeof useCollectiveClient>;
}) {
  const { snapshot } = client;
  const namespace = collectiveClientNamespace(snapshot) ?? '';
  const previousNamespace = useRef(namespace);
  const initialEntry = readChannelEntry(namespace);
  const [channelId, setChannelId] = useState(initialEntry.channelId);
  const [destination, setDestination] = useState<'home' | 'channel'>(initialEntry.destination);
  const [focusEventId, setFocusEventId] = useState<string>();
  const [content, setContent] = useState<ChannelContent>('conversation');
  const [roadmapViews, setRoadmapViews] = useState<Readonly<Record<string, RoadmapViewState>>>({});
  const [roadmapReturn, setRoadmapReturn] = useState<RoadmapReturn>();
  const [query, setQuery] = useState('');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberSelection | 'members'>();
  const participants = snapshot.participants ?? [];
  const channels = channelDestinations(snapshot.events, participants);
  const host = useHostContext(
    embedded,
    snapshot,
    channelId,
    channels.map((channel) => channel.id),
    client.hostHumanSession,
  );
  const firstEntry = useFirstEntryGuide({
    embedded,
    ready: Boolean(snapshot.me?.auth && snapshot.collective && snapshot.meta),
    serviceInstanceId: snapshot.meta?.serviceInstanceId,
    collectiveId: snapshot.collective?.collectiveId,
    humanId: snapshot.me?.human.humanId,
    paired: host.paired,
    connectionId: host.connectionId,
    publishedCatCount: host.participationReady?.catCount,
    participants: snapshot.participants,
    events: snapshot.events,
  });
  const previousFirstEntryPhase = useRef<typeof firstEntry.phase>();
  const enterFirstEntryChannel = useCallback(() => {
    setDestination('channel');
    setChannelId('general');
    writeChannelTarget('general');
    setContent('conversation');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
  }, [host.hide]);
  useEffect(() => {
    const guideStarted = firstEntry.phase === 'playing' && previousFirstEntryPhase.current !== 'playing';
    previousFirstEntryPhase.current = firstEntry.phase;
    if (guideStarted && destination === 'home') enterFirstEntryChannel();
  }, [destination, enterFirstEntryChannel, firstEntry.phase]);
  useEffect(() => {
    if (!host.focusWork) return;
    setDestination('channel');
    setFocusEventId(host.focusWork.eventId);
    setContent('conversation');
    setRoadmapReturn(undefined);
    setChannelId(host.focusWork.channelId);
    writeChannelTarget(host.focusWork.channelId);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
  }, [host.focusWork]);
  const showCafe = () => {
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.show('cats');
  };
  const replayGuide = () => {
    enterFirstEntryChannel();
    firstEntry.replay();
  };
  const beginPair = () => {
    enterFirstEntryChannel();
    firstEntry.beginPair();
    void client.pairHost();
  };
  const selectChannel = (id: string, eventId?: string) => {
    setDestination('channel');
    setFocusEventId(eventId);
    setContent('conversation');
    setRoadmapReturn(undefined);
    host.hide();
    setChannelId(id);
    writeChannelTarget(id);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
  };
  const showHome = () => {
    setDestination('home');
    setFocusEventId(undefined);
    setContent('conversation');
    setRoadmapReturn(undefined);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
    writeChannelTarget();
  };
  useEffect(() => {
    if (previousNamespace.current !== namespace) return;
    saveChannelPosition(namespace, channelId);
  }, [namespace, channelId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A world namespace change is the reset signal; Host callbacks must not replay this reset.
  useEffect(() => {
    const worldChanged = previousNamespace.current !== namespace;
    previousNamespace.current = namespace;
    setContent('conversation');
    setRoadmapReturn(undefined);
    setRoadmapViews({});
    if (!worldChanged) return;
    const nextEntry = readChannelEntry(namespace);
    setDestination(nextEntry.destination);
    setChannelId(nextEntry.channelId);
    setFocusEventId(undefined);
    setQuery('');
    setSelectedMember(undefined);
    setNavigationOpen(false);
    host.hide();
  }, [namespace]);
  if (!snapshot.collective || !snapshot.me) return null;
  const openMember = (event: CollectiveEventEnvelope) => {
    host.hide();
    setSelectedMember(
      event.actor.kind === 'human'
        ? { kind: 'human', humanId: event.actor.humanId }
        : { kind: 'agent', connectionId: event.actor.provenance.connectionId, catId: event.actor.provenance.catId },
    );
  };
  const members = snapshot.members;
  const visibleCats = visibleCollectiveCats(participants, members);
  const roadmapView = roadmapViews[channelId];
  const updateRoadmapView = (view: RoadmapViewState) =>
    setRoadmapViews((current) => ({ ...current, [channelId]: view }));
  const openRoadmapMessage = (work: CollectiveWorkProjection, view: RoadmapViewState, eventId: string) => {
    const roadmap = snapshot.collaboration?.roadmaps.find((candidate) => candidate.roadmapId === view.roadmapId);
    setRoadmapViews((current) => ({ ...current, [channelId]: view }));
    setRoadmapReturn({ channelId, label: roadmap?.title ?? 'Roadmap', view });
    setFocusEventId(eventId);
    setDestination('channel');
    setContent('conversation');
    host.hide();
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setQuery('');
    setChannelId(work.sourceLocation.channelId);
    writeChannelTarget(work.sourceLocation.channelId);
  };
  const returnToRoadmap = () => {
    if (!roadmapReturn) return;
    setRoadmapViews((current) => ({ ...current, [roadmapReturn.channelId]: roadmapReturn.view }));
    setFocusEventId(undefined);
    setDestination('channel');
    setChannelId(roadmapReturn.channelId);
    writeChannelTarget(roadmapReturn.channelId);
    setContent('roadmap');
    setRoadmapReturn(undefined);
    host.hide();
    setSelectedMember(undefined);
    setNavigationOpen(false);
    setQuery('');
  };

  return (
    <HostWorkPermissionContext.Provider
      value={{ connectionId: host.connectionId, request: host.requestWorkPermission }}
    >
      <ProductShell
        embedded={embedded}
        collective={snapshot.collective}
        collectives={snapshot.me.collectives}
        onSelectCollective={client.selectCollective}
        onHome={showHome}
        connection={snapshot.connection}
        canSteward={snapshot.collective.role === 'steward'}
        canPair={Boolean(snapshot.me.auth) && !host.paired}
        pairNudge={firstEntry.phase === 'browsing'}
        canLeave={snapshot.collective.role === 'member'}
        headerMeta={
          members
            ? `${members.cafes.length} 个 Café · ${members.humans.length + visibleCats.length} 位成员`
            : '正在读取成员…'
        }
        notice={snapshot.notice}
        onInvite={() => void client.createInvite()}
        onPair={beginPair}
        onLeave={() => void client.leaveCollective()}
        onCafe={host.available ? showCafe : undefined}
        onReplayGuide={firstEntry.narrator ? replayGuide : undefined}
        navigationOpen={navigationOpen || firstEntry.phase === 'entry'}
        onCloseNavigation={() => setNavigationOpen(false)}
        destinations={
          <ChannelNavigation
            channels={channels}
            channelId={destination === 'channel' ? channelId : undefined}
            query={query}
            onQuery={(value) => {
              setQuery(value);
              if (!value.trim()) return;
              setDestination('channel');
              writeChannelTarget(channelId);
            }}
            onSelect={selectChannel}
            guideCatCount={
              firstEntry.phase === 'playing' && firstEntry.beat === 0
                ? firstEntry.arrivalComplete
                  ? firstEntry.ownCats.length
                  : 0
                : undefined
            }
            onMembers={() => {
              host.hide();
              setDestination('channel');
              writeChannelTarget(channelId);
              setSelectedMember('members');
              setNavigationOpen(false);
            }}
          />
        }
      >
        {destination === 'home' ? (
          <CollectiveHome
            collective={snapshot.collective}
            events={snapshot.events}
            collaboration={snapshot.collaboration}
            connection={snapshot.connection}
            error={snapshot.error}
            onOpenNavigation={() => setNavigationOpen((value) => !value)}
            onOpenEvent={selectChannel}
          />
        ) : (
          <CollectiveChannelWorkspace
            channelId={channelId}
            client={client}
            content={content}
            firstEntry={firstEntry}
            focusEventId={focusEventId}
            host={host}
            namespace={namespace}
            onContent={(next) => {
              setContent(next);
              if (next === 'roadmap') setRoadmapReturn(undefined);
            }}
            onMember={openMember}
            onNavigation={() => setNavigationOpen((value) => !value)}
            onOpenRoadmapMessage={openRoadmapMessage}
            onReplayGuide={replayGuide}
            onReturnToRoadmap={roadmapReturn ? returnToRoadmap : undefined}
            onRoadmapView={updateRoadmapView}
            onSelectChannel={selectChannel}
            query={query}
            roadmapReturnLabel={roadmapReturn?.label}
            roadmapView={roadmapView}
            selectedMember={selectedMember}
            setSelectedMember={setSelectedMember}
          />
        )}
      </ProductShell>
      {firstEntry.phase === 'entry' && <EntrySpotlight onPair={beginPair} onBrowse={firstEntry.browse} />}
      {firstEntry.phase === 'playing' && destination === 'channel' && channelId === 'general' && (
        <DemoSpotlight
          beat={firstEntry.beat}
          selectedCats={firstEntry.ownCats}
          arrivalComplete={firstEntry.arrivalComplete}
          onNext={firstEntry.next}
          onSkip={firstEntry.finish}
        />
      )}
      {firstEntry.phase === 'handoff' && firstEntry.handoffCaptionVisible && firstEntry.narrator && (
        <section className="demo-caption demo-handoff-caption" data-handoff-caption aria-label="轮到你">
          <h2>换你来</h2>
          <p>@ {firstEntry.narrator.displayName} 试试</p>
        </section>
      )}
    </HostWorkPermissionContext.Provider>
  );
}
