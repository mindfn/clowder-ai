'use client';

import { useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { ConfigData } from '../config-viewer-types';
import { preferenceHeads } from '../routing-context/routing-context-commands';
import { useRoutingContext } from '../routing-context/useRoutingContext';
import { OpenTeamWorkspaceButton } from '../settings/OpenTeamWorkspaceButton';
import { useMembersCopy, useMemberText } from './editor-presentation';
import { MemberTable } from './MemberTable';
import { memberTransport, routingSubjectName } from './member-projection';
import { useMemberList } from './useMemberList';
import './members.css';

export function MemberListPage({
  registryLoading = false,
  registryKnown = true,
  onRetryRegistry,
  config,
  cats,
  onAddMember,
  onEditMember,
  onEditCoCreator,
  onToggleAvailability,
  togglingCatId,
}: {
  registryLoading?: boolean;
  registryKnown?: boolean;
  onRetryRegistry?: () => void;
  config: ConfigData;
  cats: CatData[];
  onAddMember: () => void;
  onEditMember: (cat: CatData) => void;
  onEditCoCreator: () => void;
  onToggleAvailability: (cat: CatData) => void;
  togglingCatId: string | null;
}) {
  const t = useMemberText();
  const copy = useMembersCopy();
  const list = useMemberList(cats);
  const routing = useRoutingContext();
  const [filter, setFilter] = useState('all');
  const [transport, setTransport] = useState('all');
  const visible = list.allCats.filter(
    (cat) =>
      (filter === 'all' || (cat.roster?.available === false ? filter === 'disabled' : filter === 'enabled')) &&
      (transport === 'all' || memberTransport(cat) === transport),
  );
  const preferences = preferenceHeads(routing.data?.preferenceRevisions ?? []).filter((p) => p.lifecycle === 'active');
  return (
    <section className="members-v2" data-testid="member-list-page">
      <header className="member-list-heading">
        <div>
          <h2>{t('成员与运行时')}</h2>
          <p>{t('家里的成员、各自用的模型、接入方式，以及现在能不能接活。')}</p>
        </div>
        <button type="button" className="member-button member-primary" onClick={onAddMember}>
          {t('添加成员')}
        </button>
      </header>
      <div className="member-defaults">
        <label>
          <span>
            <strong>{t('默认猫')}</strong>
            <small>{t('新对话里没有 @ 谁时，由这只猫回复')}</small>
          </span>
          <select
            aria-label={t('默认猫')}
            value={list.defaultId}
            disabled={list.defaultLoading || list.savingDefault || !list.defaultKnown}
            onChange={(event) => void list.saveDefault(event.target.value)}
          >
            {!list.defaultId && <option value="">{list.defaultLoading ? t('正在读取…') : t('未确认')}</option>}
            {list.defaultId && !cats.some((c) => c.id === list.defaultId) && (
              <option value={list.defaultId}>{t('当前默认猫不在名单中')}</option>
            )}
            {cats
              .filter((cat) => cat.roster?.available !== false || cat.id === list.defaultId)
              .map((cat) => (
                <option key={cat.id} value={cat.id} disabled={cat.roster?.available === false}>
                  {cat.nickname || cat.displayName} · {cat.defaultModel}
                  {cat.roster?.available === false ? t('（已停用）') : ''}
                </option>
              ))}
          </select>
        </label>
        {list.defaultError && (
          <p role="alert">
            {t(list.defaultError)}{' '}
            <button
              type="button"
              className="member-button"
              disabled={list.defaultLoading || list.savingDefault}
              onClick={() => void list.retryDefault()}
            >
              {t('重试')}
            </button>
          </p>
        )}
        <div className="member-preferences">
          <div>
            <strong>{t('派活偏好')}</strong>
            {routing.error || !routing.data ? (
              <p>{routing.loading ? t('正在读取…') : t('派活偏好暂不可读')}</p>
            ) : preferences.length === 0 ? (
              <p>{t('没有设置派活偏好')}</p>
            ) : (
              preferences.map((p) => (
                <p key={p.revisionId}>
                  {copy.preference(
                    p.prefer.map((s) => routingSubjectName(s, cats, copy.poolName)).join(' · '),
                    p.over.map((s) => routingSubjectName(s, cats, copy.poolName)).join(' · '),
                    p.appliesWhen.intent ?? '',
                  )}
                  {p.appliesWhen.requireEligible && (
                    <span>
                      {' '}
                      ·{' '}
                      {copy.eligibility(
                        p.appliesWhen.requireEligible
                          .map((s) => routingSubjectName(s, cats, copy.poolName))
                          .join(' · '),
                      )}
                    </span>
                  )}
                  <small>
                    {p.rationale}
                    {p.reviewAfter && p.reviewAfter <= Date.now() ? ` · ${t('已到复核时间')}` : ''}
                  </small>
                </p>
              ))
            )}
          </div>
          <OpenTeamWorkspaceButton label={t('打开猫猫团队')} />
        </div>
      </div>
      <div className="member-filters">
        <div role="group" aria-label={t('成员筛选')}>
          {[
            ['all', '全部'],
            ['enabled', '已启用'],
            ['disabled', '已停用'],
          ].map(([id, label]) => (
            <button
              type="button"
              className="member-button"
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {copy.filterCount(
                t(label),
                cats.filter(
                  (c) => id === 'all' || (c.roster?.available === false ? id === 'disabled' : id === 'enabled'),
                ).length,
              )}
            </button>
          ))}
        </div>
        <label>
          {t('接入方式')}{' '}
          <select
            value={transport}
            onChange={(event) => setTransport(event.target.value)}
            aria-label={t('接入方式筛选')}
          >
            {['all', 'CLI', 'App Server', 'ACP', '云端'].map((id) => (
              <option key={id} value={id}>
                {t(id === 'all' ? '全部' : id)}
              </option>
            ))}
          </select>
        </label>
        <small>{t('拖动左侧排序；键盘用上下方向键')}</small>
      </div>
      {list.orderError && (
        <p role="alert" className="member-error">
          {t(list.orderError)}
        </p>
      )}
      {routing.error && (
        <p role="alert">
          {t('当前状态读取失败')}{' '}
          <button type="button" className="member-button" onClick={() => void routing.refresh()}>
            {t('重试')}
          </button>
        </p>
      )}
      <MemberTable
        config={config}
        cats={cats}
        visible={visible}
        list={list}
        routing={routing}
        filter={filter}
        transport={transport}
        onEditMember={onEditMember}
        onEditCoCreator={onEditCoCreator}
        onToggleAvailability={onToggleAvailability}
        togglingCatId={togglingCatId}
      />
      {visible.length === 0 && (
        <div className="member-empty">
          <p>
            {t(
              !registryKnown
                ? registryLoading
                  ? '正在读取成员名单…'
                  : '成员名单读取失败'
                : cats.length === 0
                  ? '没有成员'
                  : '没有符合筛选的成员',
            )}
          </p>
          {!registryKnown && !registryLoading && (
            <button type="button" className="member-button" onClick={onRetryRegistry}>
              {t('重试')}
            </button>
          )}
          {cats.length > 0 && (
            <button
              type="button"
              className="member-button"
              onClick={() => {
                setFilter('all');
                setTransport('all');
              }}
            >
              {t('清除筛选')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
