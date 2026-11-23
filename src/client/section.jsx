/**
 * The memory manager panel: list, search, edit, archive, restore.
 *
 * Design notes
 * - The list is the primary surface. Everything else (filters, badges, the
 *   editor) is arranged around it so the common case — "what does the agent
 *   remember about this workspace?" — costs zero clicks.
 * - Editing happens inline. A modal would hide the surrounding context, and the
 *   whole point of this panel is judging one memory against its neighbours.
 * - Archive, never delete. The control says「归档」and the hint says it is
 *   reversible, because a memory store is the one place where an irreversible
 *   click is unacceptable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconArchiveOutlineRegular,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconDatabaseOutlineRegular,
  IconEditOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconUnarchiveOutlineRegular,
  IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';

/** Search is debounced so a Chinese IME commit does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 220;

/** Levels in the order the filter row shows them: rules first, trivia last. */
const LEVEL_ORDER = ['rule', 'preference', 'decision', 'lesson', 'project', 'fact'];

const LEVEL_LABEL = {
  fact: 'levelFact',
  preference: 'levelPreference',
  rule: 'levelRule',
  decision: 'levelDecision',
  lesson: 'levelLesson',
  project: 'levelProject',
};

const SUB_LABEL = {
  overview: 'subOverview',
  structure: 'subStructure',
  decisions: 'subDecisions',
  quotes: 'subQuotes',
  ops: 'subOps',
  todo: 'subTodo',
};

/** Ebbinghaus retention, mirroring the Host's ranking so the two never disagree. */
function retentionOf(item, now) {
  const ageDays = Math.max(0, (now - (item.updatedAt || now)) / 86400000);
  const stability = 4 * (1 + 0.5 * ((item.importance || 1) - 1)) * (1 + Math.min(3, item.useCount || 0) * 0.25);
  return Math.max(0.02, Math.min(1, Math.exp(-ageDays / stability)));
}

/** Relative time, localized through the same dictionary as the rest of the panel. */
function relativeText(t, stamp, now) {
  if (!stamp) return '';
  const delta = Math.max(0, now - stamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo').replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo').replace('{n}', String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return t('daysAgo').replace('{n}', String(days));
  return t('monthsAgo').replace('{n}', String(Math.floor(days / 30)));
}

/** Absolute timestamp for the title attribute — hover answers "exactly when". */
function absoluteText(stamp) {
  if (!stamp) return '';
  const date = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Small level badge + label. */
function LevelBadge({ t, level }) {
  return <span className="dmx_level">{t(LEVEL_LABEL[level] ?? 'levelFact')}</span>;
}

/** Five-dot importance meter; read-only in the card, clickable in the editor. */
function ImportanceDots({ t, value, onChange }) {
  const dots = [1, 2, 3, 4];
  return (
    <span className="dmx_imp" title={`${t('importance')} ${value}/4`} aria-label={`${t('importance')} ${value}/4`}>
      {dots.map((n) => (
        <button
          key={n}
          type="button"
          className="dmx_impDot"
          data-on={n <= value ? 'true' : 'false'}
          disabled={onChange === undefined}
          onClick={() => onChange?.(n)}
          aria-label={`${t('importance')} ${n}`}
        />
      ))}
    </span>
  );
}

/** Keyword chips, deduplicated and capped so one fat row cannot dominate the card. */
function KeywordRow({ keywords }) {
  const list = useMemo(() => {
    const parts = String(keywords ?? '')
      .split(/[\s,，、]+/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    return [...new Set(parts)].slice(0, 12);
  }, [keywords]);
  if (list.length === 0) return null;
  return (
    <div className="dmx_kw">
      {list.map((word) => (
        <span key={word} className="dmx_kwItem">{word}</span>
      ))}
    </div>
  );
}

/** One memory. Owns only its own expand/arm state so the list never re-renders broadly. */
function MemoryCard({ t, item, draft, busy, now, onEdit, onDraft, onSave, onCancel, onArchive, onRestore }) {
  const [expanded, setExpanded] = useState(false);
  const [armed, setArmed] = useState(false);
  const archived = item.status === 'archived';
  const editing = draft !== undefined;
  const retention = retentionOf(item, now);
  const long = item.content.length > 120;

  // Disarm the destructive button on blur-by-timeout: an armed state that
  // survives indefinitely turns a hover-misclick into a lost memory.
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <li
      className="dmx_card"
      data-level={item.level}
      data-archived={archived ? 'true' : 'false'}
    >
      <div className="dmx_cardHead">
        <LevelBadge t={t} level={item.level} />
        {item.project !== '' && (
          <span className="dmx_meta" title={item.project}>
            {item.project === '全局' ? t('globalScope') : item.project}
            {item.subcategory !== '' && SUB_LABEL[item.subcategory] !== undefined
              ? ` · ${t(SUB_LABEL[item.subcategory])}`
              : ''}
          </span>
        )}
        <span className="dmx_dots" title={`${t('importance')} ${item.importance}/4`}>
          {[1, 2, 3, 4].map((n) => (
            <span key={n} className="dmx_dot" data-on={n <= item.importance ? 'true' : 'false'} />
          ))}
        </span>
        <span className="dmx_actions" data-open={armed ? 'true' : 'false'}>
          {!archived && (
            <button type="button" className="dmx_btn" onClick={() => (editing ? onCancel(item) : onEdit(item))} disabled={busy}>
              <IconEditOutlineRegular size={13} />
              {editing ? t('cancel') : t('editEntry')}
            </button>
          )}
          {archived ? (
            <button type="button" className="dmx_btn" onClick={() => onRestore(item)} disabled={busy}>
              <IconUnarchiveOutlineRegular size={13} />
              {t('restore')}
            </button>
          ) : (
            <button
              type="button"
              className="dmx_btn"
              data-tone={armed ? 'arm' : 'danger'}
              title={t('archiveHint')}
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                onArchive(item);
              }}
              disabled={busy}
            >
              <IconArchiveOutlineRegular size={13} />
              {armed ? t('confirmArchive') : t('archive')}
            </button>
          )}
        </span>
      </div>

      {editing ? (
        <div className="dmx_editor">
          <div className="dmx_field">
            <label className="dmx_label" htmlFor={`dmx-content-${item.id}`}>{t('fieldContent')}</label>
            <textarea
              id={`dmx-content-${item.id}`}
              className="dmx_textarea"
              value={draft.content}
              spellCheck={false}
              onChange={(event) => onDraft(item.id, { content: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onCancel(item);
                } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  onSave(item);
                }
              }}
            />
          </div>
          <div className="dmx_field">
            <label className="dmx_label" htmlFor={`dmx-kw-${item.id}`}>{t('fieldKeywords')}</label>
            <input
              id={`dmx-kw-${item.id}`}
              className="dmx_input"
              value={draft.keywords}
              placeholder={t('keywordsHint')}
              spellCheck={false}
              onChange={(event) => onDraft(item.id, { keywords: event.target.value })}
            />
          </div>
          <div className="dmx_editorRow">
            <div className="dmx_field">
              <span className="dmx_label">{t('fieldImportance')}</span>
              <ImportanceDots t={t} value={draft.importance} onChange={(n) => onDraft(item.id, { importance: n })} />
            </div>
            <span className="dmx_hint">{t('shortcutSave')}</span>
          </div>
          <div className="dmx_editorFoot">
            <button type="button" className="dmx_btn" data-tone="solid" onClick={() => onSave(item)} disabled={busy}>
              {t('save')}
            </button>
            <button type="button" className="dmx_btn" onClick={() => onCancel(item)} disabled={busy}>
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p
            className="dmx_text"
            data-clamp={long && !expanded ? 'true' : 'false'}
            onClick={() => {
              if (long) setExpanded((value) => !value);
            }}
            title={long ? (expanded ? t('collapse') : t('expand')) : undefined}
          >
            {item.content}
          </p>
          <KeywordRow keywords={item.keywords} />
          <div className="dmx_foot">
            <span className="dmx_bar" data-weak={retention < 0.35 ? 'true' : 'false'} title={t('retentionHint')}>
              <span className="dmx_barFill" style={{ width: `${Math.round(retention * 100)}%` }} />
            </span>
            <span title={`${t('retention')} ${Math.round(retention * 100)}%`}>{Math.round(retention * 100)}%</span>
            <span>·</span>
            <span>{item.useCount} {t('uses')}</span>
            <span>·</span>
            <span title={absoluteText(item.updatedAt)}>{t('updated')} {relativeText(t, item.updatedAt, now)}</span>
          </div>
        </>
      )}
    </li>
  );
}

/** Skeleton rows while the first page loads. */
function Skeleton() {
  return (
    <ul className="dmx_list" aria-hidden="true">
      {[0, 1, 2].map((n) => (
        <li key={n} className="dmx_skel" />
      ))}
    </ul>
  );
}

export function MemorySection(props) {
  const { t, useMemoryPanel, useMemoryDrafts } = props;
  const state = useMemoryPanel((value) => value);
  const drafts = useMemoryDrafts((value) => value);

  const [term, setTerm] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const booted = useRef(false);

  // `bootstrap` is stable across renders (it closes over the store), so this
  // runs exactly once per mount — a settings page remount must not refetch.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void props.bootstrap();
  }, [props]);

  // Keep relative times honest while the panel stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Debounce the search box into the filter.
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = term.trim();
      if (trimmed === state.filter.query) return;
      props.setFilter({ query: trimmed });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [term, state.filter.query, props]);

  // The toast is a transient confirmation, not a persistent status.
  useEffect(() => {
    if (state.toast === '') return undefined;
    const timer = setTimeout(() => props.clearToast(), 1800);
    return () => clearTimeout(timer);
  }, [state.toast, props]);

  const onArchive = useCallback((item) => void props.archive(item), [props]);
  const onRestore = useCallback((item) => void props.restore(item), [props]);
  const onSave = useCallback((item) => void props.save(item), [props]);

  const counts = state.stats?.levels ?? {};
  const levelChips = useMemo(
    () => LEVEL_ORDER.filter((level) => (counts[level] ?? 0) > 0 || state.filter.level === level),
    [counts, state.filter.level],
  );
  const fileName = `${state.dataDir.replace(/[\\/]+$/, '')}/memory.db`;
  const query = state.filter.query;

  return (
    <div className="dmx_root">
      <h2 className="dmx_head">{t('title')}</h2>
      <p className="dmx_intro">{t('intro')}</p>

      {state.error !== '' && (
        <div className="dmx_banner" data-kind={state.error === t('errorUnavailable') ? 'warn' : 'error'} role="alert">
          <IconWarningOutlineRegular size={14} />
          <span>{state.error}</span>
          <button type="button" className="dmx_btn" onClick={() => void props.bootstrap()}>
            {t('retry')}
          </button>
        </div>
      )}

      {state.phase === 'boot' && <p className="dmx_hint">{t('loadingWorkspaces')}</p>}

      {state.phase !== 'boot' && state.workspaces.length === 0 && (
        <div className="dmx_empty">
          <span className="dmx_emptyIcon"><IconDatabaseOutlineRegular size={22} /></span>
          <p className="dmx_emptyText">{t('noWorkspace')}</p>
        </div>
      )}

      {state.workspaces.length > 0 && (
        <>
          <div className="dmx_wsRow" role="tablist" aria-label={t('workspaces')}>
            {state.workspaces.map((entry) => (
              <button
                key={entry.path}
                type="button"
                role="tab"
                className="dmx_ws"
                data-active={entry.path === state.selected ? 'true' : 'false'}
                aria-selected={entry.path === state.selected}
                title={entry.path}
                onClick={() => props.select(entry.path)}
              >
                <span className="dmx_wsDot" data-ready={entry.exists ? 'true' : 'false'} />
                <span className="dmx_wsName">{entry.title}</span>
                <span className="dmx_wsCount">{entry.exists ? entry.active : '–'}</span>
              </button>
            ))}
          </div>

          <div className="dmx_path">
            <IconDatabaseOutlineRegular size={12} />
            <span className="dmx_pathText" data-missing={state.missing ? 'true' : 'false'} title={`${state.selected}\\${fileName.replace(/\//g, '\\')}`}>
              {fileName}
            </span>
            {state.missing && <span>{t('noBase')}</span>}
          </div>

          <div className="dmx_filters">
            <div className="dmx_search">
              <span className="dmx_searchIcon"><IconSearchOutlineRegular size={13} /></span>
              <input
                className="dmx_searchInput"
                value={term}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchPlaceholder')}
                spellCheck={false}
                onChange={(event) => setTerm(event.target.value)}
              />
              {term !== '' && (
                <button type="button" className="dmx_clear" onClick={() => setTerm('')} aria-label={t('cancel')}>
                  <IconCloseOutlineRegular size={11} />
                </button>
              )}
            </div>
            <div className="dmx_seg" role="group" aria-label={t('filterStatus')}>
              {[
                ['active', 'statusActive'],
                ['archived', 'statusArchived'],
                ['all', 'statusAll'],
              ].map(([value, key]) => (
                <button
                  key={value}
                  type="button"
                  className="dmx_segBtn"
                  data-active={state.filter.status === value ? 'true' : 'false'}
                  aria-pressed={state.filter.status === value}
                  onClick={() => props.setFilter({ status: value })}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <button type="button" className="dmx_btn" data-tone="outline" onClick={() => void props.refresh()}>
              <IconRefreshOutlineRegular size={13} />
              {t('refresh')}
            </button>
          </div>

          {levelChips.length > 0 && (
            <div className="dmx_chips">
              <button
                type="button"
                className="dmx_chip"
                data-active={state.filter.level === '' ? 'true' : 'false'}
                aria-pressed={state.filter.level === ''}
                onClick={() => props.setFilter({ level: '' })}
              >
                {t('filterAllLevels')}
              </button>
              {levelChips.map((level) => (
                <button
                  key={level}
                  type="button"
                  className="dmx_chip"
                  data-active={state.filter.level === level ? 'true' : 'false'}
                  aria-pressed={state.filter.level === level}
                  onClick={() => props.setFilter({ level: state.filter.level === level ? '' : level })}
                >
                  {t(LEVEL_LABEL[level])}
                  <span className="dmx_chipN">{counts[level] ?? 0}</span>
                </button>
              ))}
            </div>
          )}

          {(state.phase === 'items' || state.phase === 'boot') && <Skeleton />}

          {state.phase === 'ready' && state.items.length === 0 && (
            <div className="dmx_empty">
              <span className="dmx_emptyIcon"><IconDatabaseOutlineRegular size={22} /></span>
              <p className="dmx_emptyText">
                {query !== '' || state.filter.level !== '' ? t('noMatch') : state.missing ? t('noBase') : t('noMemory')}
              </p>
            </div>
          )}

          {state.phase === 'ready' && state.items.length > 0 && (
            <ul className="dmx_list">
              {state.items.map((item) => (
                <MemoryCard
                  key={item.id}
                  t={t}
                  item={item}
                  draft={drafts.get(item.id)}
                  busy={state.busyId === item.id}
                  now={now}
                  onEdit={(target) => props.openDraft(target)}
                  onDraft={(id, patch) => props.editDraft(id, patch)}
                  onCancel={(target) => props.closeDraft(target.id)}
                  onSave={onSave}
                  onArchive={onArchive}
                  onRestore={onRestore}
                />
              ))}
            </ul>
          )}

          {state.phase === 'ready' && state.total > state.items.length && (
            <p className="dmx_footerHint">{t('totalLabel').replace('{n}', String(state.total))}</p>
          )}
        </>
      )}

      {state.toast !== '' && (
        <div className="dmx_toast" role="status">
          <IconCheckOutlineRegular size={12} />
          <span>{state.toast}</span>
        </div>
      )}
    </div>
  );
}

export { LEVEL_ORDER, LEVEL_LABEL, retentionOf, relativeText };
