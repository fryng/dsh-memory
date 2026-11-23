/**
 * Stylesheet for the memory manager, injected once into the document head.
 *
 * Every colour is a `--dsw-alias-*` token, so the panel follows the light/dark
 * theme and the brand accent without a single hard-coded hex value. Class names
 * are prefixed with `dmx_` — the settings surface is shared with every shipped
 * plugin, and a collision here would silently restyle somebody else's page.
 */

/** Stable id for the `<style>` tag, so a re-mount (HMR) never stacks tags. */
export const CSS_TAG_ID = 'dsh-memory/memory-section.css';

const css = `
.dmx_root{display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary)}
/* The settings shell does not inherit border-box into plugin stylesheets, and a
   width:100% input with horizontal padding then overflows its flex track and
   paints over the neighbouring status control. Scope the reset to our own tree. */
.dmx_root,.dmx_root *,.dmx_root *::before,.dmx_root *::after{box-sizing:border-box}
.dmx_head{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dmx_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}

/* workspace picker */
.dmx_wsRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dmx_ws{display:inline-flex;align-items:center;gap:7px;max-width:280px;padding:5px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-settings-card-fill);font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:border-color .12s ease,background .12s ease,color .12s ease}
.dmx_ws:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dmx_ws[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary)}
.dmx_wsName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmx_wsCount{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dmx_ws[data-active=true] .dmx_wsCount{color:var(--dsw-alias-state-business-primary)}
.dmx_wsDot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dmx_wsDot[data-ready=true]{background:var(--dsw-alias-state-success-primary)}

/* path strip */
.dmx_path{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dmx_pathText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.dmx_pathText[data-missing=true]{color:var(--dsw-alias-state-warn-primary)}

/* toolbar */
.dmx_search{position:relative;flex:1 1 240px;min-width:0}
.dmx_searchIcon{position:absolute;left:10px;top:50%;transform:translateY(-50%);display:flex;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.dmx_searchInput{width:100%;height:34px;padding:0 30px 0 31px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.dmx_searchInput::placeholder{color:var(--dsw-alias-label-dimmed)}
.dmx_searchInput:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-business-tertiary)}
.dmx_clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dmx_clear:hover{color:var(--dsw-alias-label-primary)}

/* filters */
.dmx_filters{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.dmx_chips{display:flex;flex-wrap:wrap;gap:5px}
.dmx_chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border:.5px solid transparent;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font:inherit;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.dmx_chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dmx_chip[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
.dmx_chipN{font-variant-numeric:tabular-nums;opacity:.75}
.dmx_seg{display:inline-flex;flex:none;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}
.dmx_segBtn{padding:2px 9px;border:0;border-radius:7px;background:0 0;font:inherit;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s ease,color .12s ease}
.dmx_segBtn:hover{color:var(--dsw-alias-label-primary)}
.dmx_segBtn[data-active=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}

/* list */
.dmx_list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dmx_card{position:relative;display:flex;flex-direction:column;gap:7px;padding:10px 12px 9px;border:.5px solid var(--dsw-alias-border-l2);border-left-width:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);transition:border-color .12s ease}
.dmx_card:hover{border-color:var(--dsw-alias-border-l3)}
.dmx_card[data-archived=true]{background:var(--dsw-alias-bg-layer-1);opacity:.78}
.dmx_card[data-level=rule]{--dmx-accent:var(--dsw-alias-state-error-primary)}
.dmx_card[data-level=preference]{--dmx-accent:var(--dsw-alias-state-business-primary)}
.dmx_card[data-level=decision]{--dmx-accent:var(--dsw-alias-state-warn-primary)}
.dmx_card[data-level=lesson]{--dmx-accent:var(--dsw-alias-state-success-primary)}
.dmx_card[data-level=fact]{--dmx-accent:var(--dsw-alias-state-idle-primary)}
.dmx_card[data-level=project]{--dmx-accent:var(--dsw-alias-label-tertiary)}
.dmx_card{border-left-color:var(--dmx-accent,var(--dsw-alias-border-l2))}
.dmx_cardHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-height:18px}
.dmx_level{flex:none;padding:0 6px;border:.5px solid var(--dmx-accent,var(--dsw-alias-border-l3));border-radius:6px;font-size:11px;line-height:17px;font-weight:500;color:var(--dmx-accent,var(--dsw-alias-label-secondary))}
.dmx_meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.dmx_dots{display:inline-flex;align-items:center;gap:2px;margin-left:auto}
.dmx_dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-border-l3)}
.dmx_dot[data-on=true]{background:var(--dsw-alias-state-business-primary)}
.dmx_text{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;cursor:default}
.dmx_text[data-clamp=true]{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer}
.dmx_text[data-clamp=true]:hover{color:var(--dsw-alias-label-primary)}
.dmx_kw{display:flex;flex-wrap:wrap;gap:4px}
.dmx_kwItem{padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dmx_foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dmx_bar{flex:none;width:88px;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.dmx_barFill{height:100%;border-radius:2px;background:var(--dsw-alias-state-success-primary)}
.dmx_bar[data-weak=true] .dmx_barFill{background:var(--dsw-alias-state-warn-primary)}
.dmx_actions{display:flex;align-items:center;gap:4px;margin-left:auto;opacity:.55;transition:opacity .12s ease}
.dmx_card:hover .dmx_actions,.dmx_card:focus-within .dmx_actions,.dmx_actions[data-open=true]{opacity:1}

/* buttons */
.dmx_btn{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:.5px solid transparent;border-radius:7px;background:0 0;font:inherit;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,color .12s ease,border-color .12s ease}
.dmx_btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dmx_btn:disabled{opacity:.45;cursor:default}
.dmx_btn[data-tone=danger]:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.dmx_btn[data-tone=solid]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:#fff;padding:3px 12px}
.dmx_btn[data-tone=solid]:hover{opacity:.9;background:var(--dsw-alias-state-business-primary);color:#fff}
.dmx_btn[data-tone=outline]{border-color:var(--dsw-alias-border-l3)}
.dmx_btn[data-tone=arm]{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:#fff}
.dmx_btnIcon{display:flex;align-items:center}
.dmx_card *:focus-visible,.dmx_root *:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:6px}

/* editor */
.dmx_editor{display:flex;flex-direction:column;gap:7px;padding:8px 0 2px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dmx_field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dmx_label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dmx_textarea,.dmx_input{width:100%;box-sizing:border-box;padding:6px 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-base);font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.dmx_textarea{min-height:84px;resize:vertical}
.dmx_textarea:focus,.dmx_input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-business-tertiary)}
.dmx_editorRow{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}
.dmx_editorFoot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmx_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dmx_imp{display:inline-flex;gap:3px;align-items:center}
.dmx_impDot{width:16px;height:16px;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;cursor:pointer}
.dmx_impDot[data-on=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}

/* states */
.dmx_skel{height:62px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-skeleton);animation:dmxPulse 1.5s ease-in-out infinite}
@keyframes dmxPulse{0%,100%{opacity:.55}50%{opacity:.9}}
.dmx_empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:26px 16px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);text-align:center}
.dmx_emptyIcon{display:flex;color:var(--dsw-alias-label-dimmed)}
.dmx_emptyText{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-tertiary);max-width:420px}
.dmx_banner{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:12px}
.dmx_banner[data-kind=warn]{background:var(--dsw-alias-state-warn-primary)}
.dmx_toast{position:sticky;bottom:0;align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:12px;line-height:18px;box-shadow:var(--dsw-shadow-lv2);animation:dmxRise .16s ease-out}
@keyframes dmxRise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.dmx_footerHint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-dimmed)}
`;

/** Append the stylesheet once per document. */
export function installStyles(documentLike) {
  if (documentLike === undefined || documentLike === null) return;
  if (documentLike.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return;
  const tag = documentLike.createElement('style');
  tag.dataset.plugin = 'dsh-memory';
  tag.dataset.pluginCss = CSS_TAG_ID;
  tag.textContent = css;
  documentLike.head.appendChild(tag);
}
