import { refIdentity } from '@cat-cafe/shared';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import {
  blockerLabel,
  type EvolutionProgramPresentationProjection,
  preparationGaps,
  productStatus,
} from './capability-evolution-presentation';
import { EvolutionHomeActionsV2 } from './EvolutionHomeActionsV2';
import { journeyStageLabel } from './EvolutionJourney';
import { useEvolutionAssetReview } from './evolution-asset-resource';

export function EvolutionPhaseGaps({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const gaps = preparationGaps(projection);
  return (
    <span>
      {gaps.length
        ? gaps.map((gap) => blockerLabel(gap.code)).join('；')
        : '未记录阶段缺项；是否可推进仍以本轮证据为准。'}
    </span>
  );
}

function ProjectActor({ projection }: { projection: EvolutionProgramPresentationProjection }) {
  const { origin } = projection;
  const { getCatById } = useCatData();
  const activity = Object.values(projection.preparation?.sections ?? {})
    .flatMap((section) => section.activities)
    .find((entry) => entry.state === 'active' && entry.catId);
  const catId = activity?.catId ?? origin?.createdByCatId;
  const cat = catId ? getCatById(catId) : undefined;
  return (
    <span className="evolution-v2-actor">
      <small>谁在做</small>
      {cat && catId ? (
        <span className="evolution-v2-cat">
          <CatAvatar catId={catId} size={24} ring="none" />
          {cat.nickname?.trim() || cat.displayName}
        </span>
      ) : (
        '未知'
      )}
      <small>{activity ? '正在准备' : cat ? '发起猫 · 当前活动未知' : '当前活动未知'}</small>
    </span>
  );
}

function ProjectRow({
  projection,
  onSelect,
}: {
  projection: EvolutionProgramPresentationProjection;
  onSelect: () => void;
}) {
  const { program, origin } = projection;
  const asset = useEvolutionAssetReview(projection);
  const refs = asset.catalog?.currentVersionRefs;
  const titles = refs?.map(
    (ref) => asset.catalog?.versions.find((version) => refIdentity(version.versionRef) === refIdentity(ref))?.title,
  );
  const adopted = !refs
    ? '待来源核验'
    : !refs.length
      ? '尚无采用记录'
      : titles?.every(Boolean)
        ? titles.join('、')
        : `${refs.length} 个已记录版本`;
  const status = productStatus(projection);
  const phase = journeyStageLabel(projection);
  return (
    <button
      type="button"
      className="evolution-v2-project"
      data-testid={`capability-evolution-program-${program.programId}`}
      onClick={onSelect}
    >
      <span className="evolution-v2-project-name">
        <strong>{program.displayName ?? '尚未命名'}</strong>
        <small>{origin ? `来自「${origin.title}」` : '发起对话暂不可读'}</small>
      </span>
      <span className="evolution-v2-phase">
        <small>阶段</small>
        {phase}
        {program.lifecycle !== 'active' && <small>{status.label}</small>}
      </span>
      <span className="evolution-v2-gaps">
        <small>这一阶段还缺</small>
        <EvolutionPhaseGaps projection={projection} />
      </span>
      <span className="evolution-v2-adopted">
        <small>当前采用</small>
        {adopted}
      </span>
      <ProjectActor projection={projection} />
      <span className="evolution-v2-recent">
        <small>最近</small>
        <time dateTime={program.updatedAt}>
          {new Date(program.updatedAt).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </span>
      <span aria-hidden="true">›</span>
    </button>
  );
}

/** The same owner projection, laid out as a project directory rather than a repeated focus card. */
export function CapabilityEvolutionHomeV2({
  programs,
  loading,
  error,
  rejected,
  reload,
  onSelect,
  targetThreadId,
}: {
  programs: EvolutionProgramPresentationProjection[];
  loading: boolean;
  error?: string | null;
  rejected: number;
  reload: () => Promise<void>;
  onSelect: (id: string) => void;
  targetThreadId: string | null;
}) {
  const active = programs.filter((item) => item.program.lifecycle !== 'terminal');
  const completed = programs.filter((item) => item.program.lifecycle === 'terminal');
  const uncertain = loading || Boolean(error) || rejected > 0;
  return (
    <>
      <EvolutionHomeActionsV2 targetThreadId={targetThreadId} reload={reload} />
      <section aria-label="正在进行的进化项目">
        <h2 className="evolution-v2-section-title">
          正在进行 <small>{uncertain ? `已读 ${active.length}` : active.length}</small>
        </h2>
        {loading && (
          <p role="status" className="evolution-empty">
            正在读取能力进化记录…
          </p>
        )}
        {error && !programs.length && (
          <p role="status" className="evolution-empty">
            暂时无法读取进化记录，请刷新重试。
          </p>
        )}
        {!loading && !error && !programs.length && !rejected && (
          <p className="evolution-empty">还没有进化记录。点「新建目标」，把想改进的目标带到当前对话。</p>
        )}
        {rejected > 0 && (
          <p role="status" className="evolution-empty">
            {rejected} 项记录暂时无法读取，原始记录仍保留。
          </p>
        )}
        <div className="evolution-v2-projects">
          {active.map((item) => (
            <ProjectRow
              key={item.program.programId}
              projection={item}
              onSelect={() => onSelect(item.program.programId)}
            />
          ))}
        </div>
      </section>
      <section aria-label="最近完成">
        <h2 className="evolution-v2-section-title">
          最近完成 <small>{uncertain ? '待核实' : completed.length}</small>
        </h2>
        {completed.length ? (
          <div className="evolution-v2-projects">
            {completed.map((item) => (
              <ProjectRow
                key={item.program.programId}
                projection={item}
                onSelect={() => onSelect(item.program.programId)}
              />
            ))}
          </div>
        ) : (
          <p className="evolution-v2-empty">
            {uncertain
              ? '完成记录尚未读全，暂时不能确认。'
              : '还没有完成或停止的项目。完成、停止和放弃的都会留在这里，连同为什么。'}
          </p>
        )}
      </section>
    </>
  );
}
