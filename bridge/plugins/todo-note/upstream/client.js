// dsh-todo-note — client half.
//
// A draggable sticky note in `shell.overlay`: three shapes (note / ball /
// detail), polling the host over the plugin's own HTTP surface. No build step:
// the file is hand-wrapped in the ModuleLoader envelope and uses
// React.createElement instead of JSX.

window.__ModuleLoader__.load({
  id: 'dsh-todo-note',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } = React

    const API_GET = 'todo-note/api/get'
    const API_ACT = 'todo-note/api/act'
    const PREF_KEY = 'dsh-todo-note:prefs:v1'
    const POLL_VISIBLE = 1200
    const POLL_HIDDEN = 4000
    const POLL_FAILED = 8000
    const STRIKE_MS = 460
    const noop = () => {}

    // ---------------------------------------------------------------- copy --
    const ZH = {
      title: '待办',
      titleDetail: '待办与规划',
      now: '现在',
      next: '下一步',
      noFocus: '还没有设定焦点',
      tasks: '进行中',
      shelved: '搁置',
      recent: '最近完成',
      empty: '暂无待办，加一条提醒自己',
      addPlaceholder: '加一条待办，回车确认',
      add: '添加',
      confirm: '完成',
      reject: '没做完',
      cancel: '关闭',
      confirmHint: '已完成？',
      plan: '长期规划',
      noPlan: '还没有长期规划',
      progress: '总进度',
      goals: '最终目标',
      phases: '阶段',
      expand: '展开详情',
      collapse: '收成便利贴',
      toBall: '最小化成球',
      openIcon: '展开待办便签',
      offline: '连接中断，稍后重试',
      loading: '加载中…',
      shelve: '搁置',
      unshelve: '恢复',
      remove: '删除',
      user: '你',
      justNow: '刚刚',
      minutesAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前',
      phaseTodo: '未开始',
      phaseActive: '进行中',
      phaseDone: '已完成',
      phaseCount: '{done}/{total} 阶段',
      taskCount: '{n} 项',
      unlinked: '未关联',
      unlinkedHint: '这个会话还没有和便签建立关联。点一下就让 agent 现在关联；不点也会在它下一轮收到提醒。',
      linking: '关联中…',
      linkFailed: '没能发起关联，试试在输入框里直接让 agent 建立待办',
      linkPrompt: '请把本会话和待办便签关联起来：先调用 todo_note_read 看一眼，再用 todo_note_update 写下「现在」和「下一步」，以及 1–3 条真实任务（一条任务只写一个动作）。只做这一次。',
    }
    const EN = {
      title: 'To-do',
      titleDetail: 'To-do & plan',
      now: 'Now',
      next: 'Next',
      noFocus: 'No focus set yet',
      tasks: 'In progress',
      shelved: 'Parked',
      recent: 'Recently done',
      empty: 'Nothing yet — add a reminder',
      addPlaceholder: 'Add a to-do, press Enter',
      add: 'Add',
      confirm: 'Done',
      reject: 'Not done',
      cancel: 'Close',
      confirmHint: 'Done?',
      plan: 'Long-term plan',
      noPlan: 'No long-term plan yet',
      progress: 'Overall',
      goals: 'Final goals',
      phases: 'Phases',
      expand: 'Expand',
      collapse: 'Back to note',
      toBall: 'Minimize to ball',
      openIcon: 'Open the to-do note',
      offline: 'Disconnected, retrying',
      loading: 'Loading…',
      shelve: 'Park',
      unshelve: 'Resume',
      remove: 'Delete',
      user: 'you',
      justNow: 'just now',
      minutesAgo: '{n} min ago',
      hoursAgo: '{n} h ago',
      phaseTodo: 'Not started',
      phaseActive: 'In progress',
      phaseDone: 'Done',
      phaseCount: '{done}/{total} phases',
      taskCount: '{n} items',
      unlinked: 'Not linked',
      unlinkedHint: 'This session has no note yet. Click to ask the agent to link it now; otherwise it gets a reminder on its next turn.',
      linking: 'Linking…',
      linkFailed: 'Could not start linking — try asking the agent in the composer',
      linkPrompt: 'Link this session to the todo note: call todo_note_read first, then use todo_note_update to write the current focus, the next step, and 1-3 real tasks (one action per task). Do this once.',
    }

    const NS = 'dsh-todo-note'

    function format(text, params) {
      if (!params) return text
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
      )
    }

    function safeGet(ctx, name) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    /** Resolve the active locale id without hard-depending on the service. */
    function activeLocale(ctx) {
      try {
        const service = safeGet(ctx, 'locale')
        const snapshot = service?.getLocale?.() ?? service?.getSnapshot?.()
        const id = snapshot?.id ?? snapshot?.locale
        if (typeof id === 'string' && id) return id
      } catch {
        /* fall through to the browser */
      }
      try {
        return (navigator.languages && navigator.languages[0]) || navigator.language || 'en'
      } catch {
        return 'en'
      }
    }

    /**
     * Register both dictionaries with the Client locale service (so the visible
     * copy follows the app's language switch) and translate through it, with the
     * local dictionaries as a hard fallback when the service is absent.
     */
    function createTranslator(ctx) {
      const service = safeGet(ctx, 'locale')
      let bound
      if (service) {
        try {
          if (typeof service.register === 'function') {
            service.register(NS, 'zh', ZH)
            service.register(NS, 'en', EN)
          }
          if (typeof service.bind === 'function') bound = service.bind(NS)
        } catch {
          bound = undefined
        }
      }
      const translate = (key, params) => {
        if (typeof bound === 'function') {
          try {
            const value = bound(key, params)
            if (typeof value === 'string' && value && value !== key) return value
          } catch {
            /* fall back below */
          }
        }
        const dict = String(activeLocale(ctx)).toLowerCase().startsWith('zh') ? ZH : EN
        return format(dict[key] ?? ZH[key] ?? key, params)
      }
      return translate
    }

    // ----------------------------------------------------------------- css --
    const CSS = `
.dtn-layer{position:fixed;inset:0;pointer-events:none;z-index:80;font:inherit;color:var(--dsw-alias-label-primary,CanvasText)}
.dtn-card{--dtn-blue:#4f7cf7;position:absolute;pointer-events:auto;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);
  border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 14%,transparent));
  box-shadow:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 10%,transparent),
             0 2px 8px color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 5%,transparent);
  transition:width .34s cubic-bezier(.22,1,.36,1),height .34s cubic-bezier(.22,1,.36,1),
             left .34s cubic-bezier(.22,1,.36,1),top .34s cubic-bezier(.22,1,.36,1),
             border-radius .3s ease,box-shadow .25s ease,background-color .2s ease;
  will-change:transform,width,height;font-size:13px;line-height:1.45}
.dtn-card[data-view="ball"]{cursor:grab;border-radius:50%;display:grid;place-items:center;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,CanvasText) 9%,var(--dsw-alias-bg-layer-1,Canvas));
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,CanvasText) 24%,transparent)}
/* A hover scale animates the whole transform matrix, which fights a drag that
   uses translate: keep the lift in color and shadow instead of geometry. */
.dtn-card[data-view="ball"]:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,CanvasText) 42%,transparent);
  box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 16%,transparent)}
/* Only while the measured height is still unknown does CSS clamp the note:
   once the inline height is in place the clamp must go, otherwise a
   detail -> note switch snaps 686 -> 420 before animating to 279. */
.dtn-card[data-view="note"][data-measured="false"]{max-height:min(82vh,420px)}
.dtn-card[data-dragging="true"]{transition:none;box-shadow:0 18px 48px color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 24%,transparent);cursor:grabbing;will-change:transform;
  /* The card slides under a stationary cursor while dragging, so hover would
     hop from row to row every frame: highlight fading in/out, the shelve/delete
     cluster blinking, the tick scaling. Keep the card itself hittable (pointer
     capture and the click-to-restore shortcut live there) and take its content
     out of hit-testing instead. */
  }
.dtn-card[data-dragging="true"] > *{pointer-events:none}

.dtn-head{display:flex;align-items:center;gap:8px;padding:10px 10px 8px 12px;cursor:grab;user-select:none;flex:none}
.dtn-card[data-dragging="true"] .dtn-head{cursor:grabbing}
.dtn-title{font-weight:600;font-size:13px;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dtn-chips{display:flex;gap:4px;flex:none;align-items:center}
.dtn-chip{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);border-radius:999px;padding:0 7px;flex:none;white-space:nowrap}
.dtn-chip[data-tone="idle"]{color:var(--dsw-alias-label-secondary);background:transparent;border:1px dashed color-mix(in srgb,var(--dsw-alias-label-secondary) 42%,transparent);opacity:.9}
.dtn-link{font:inherit;cursor:pointer;transition:opacity .15s ease,background .15s ease,border-color .15s ease}
.dtn-link:hover{opacity:1;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);border-style:solid}
.dtn-link:disabled{opacity:.55;cursor:default}
.dtn-chip[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);animation:dtn-pulse 2.2s ease-in-out infinite}
.dtn-actions{display:flex;gap:2px;flex:none;opacity:.5;transition:opacity .2s}
.dtn-card:hover .dtn-actions,.dtn-actions:focus-within{opacity:1}
.dtn-icon{appearance:none;border:0;background:transparent;color:inherit;width:24px;height:24px;border-radius:7px;
  display:grid;place-items:center;cursor:pointer;padding:0;transition:background .16s ease,transform .16s ease,color .16s ease}
.dtn-icon:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}
.dtn-icon:active{transform:scale(.9)}
.dtn-icon[data-tone="primary"]{color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dtn-icon[data-tone="primary"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.dtn-icon:disabled{opacity:.45;cursor:default}
.dtn-icon[data-shape="circle"]{border-radius:50%;
  border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent)}
.dtn-icon[data-shape="circle"]:hover{border-color:var(--dsw-alias-brand-primary)}
.dtn-icon[data-shape="circle"][data-tone="primary"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.dtn-focus{padding:2px 10px 8px;flex:none;display:flex;flex-direction:column;gap:4px}
.dtn-focus-row{display:flex;gap:6px;align-items:flex-start;min-width:0;font-size:12.5px;line-height:1.5;padding:3px 7px;border-radius:8px;
  border:1px solid transparent;transition:background .25s ease,border-color .25s ease}
.dtn-focus-key{color:var(--dsw-alias-label-secondary);flex:none;font-size:10.5px;line-height:1.6;letter-spacing:.02em;font-weight:600;
  padding:0 6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent);margin-top:1px}
.dtn-focus-row[data-kind="now"]{background:color-mix(in srgb,var(--dtn-blue) 12%,transparent);
  border-color:color-mix(in srgb,var(--dtn-blue) 26%,transparent)}
.dtn-focus-row[data-kind="now"] .dtn-focus-key{color:color-mix(in srgb,var(--dtn-blue) 72%,var(--dsw-alias-label-primary));
  border-color:color-mix(in srgb,var(--dtn-blue) 40%,transparent);background:color-mix(in srgb,var(--dtn-blue) 16%,transparent)}
.dtn-focus-row[data-kind="next"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,orange) 8%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,orange) 20%,transparent)}
.dtn-focus-row[data-kind="next"] .dtn-focus-key{color:var(--dsw-alias-state-warn-primary,orange);
  border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,orange) 38%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,orange) 14%,transparent)}
.dtn-focus-val{flex:1 1 auto;min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
.dtn-focus-val[data-empty="true"]{color:var(--dsw-alias-label-secondary);opacity:.65;font-style:italic}
.dtn-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:0 6px 6px;scrollbar-width:thin;scrollbar-gutter:stable;
  scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent) transparent}
.dtn-scroll::-webkit-scrollbar{width:6px}
.dtn-scroll::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 35%,transparent);border-radius:3px}
.dtn-scroll::-webkit-scrollbar-track{background:transparent}
.dtn-section{display:flex;align-items:center;gap:8px;padding:9px 6px 3px;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:none}
.dtn-section::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 12%,transparent))}
.dtn-task{display:flex;gap:8px;align-items:flex-start;padding:6px 6px 6px 8px;border-radius:8px;position:relative;overflow:hidden;
  transition:background .18s ease}
.dtn-task[data-ghost="true"]{animation:dtn-ghost .42s cubic-bezier(.4,0,.2,1) forwards;pointer-events:none;height:var(--ghost-h,32px);box-sizing:border-box;overflow:hidden}
.dtn-task[data-ghost="true"]:hover{background:transparent}
.dtn-task[data-land="true"]{animation:dtn-land .34s cubic-bezier(.22,1,.36,1)}
/* The lifted row stays a normal row inside the list: same type scale, same
   caps, no shadow, no lift. A frame around the row body says "this is the one
   you are holding", and its position in the list says where it will land. */
.dtn-task[data-drag="true"]{cursor:grabbing;animation:none;
  box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cf7) 55%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cf7) 7%,transparent)}
.dtn-task[data-drag="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cf7) 7%,transparent)}
.dtn-task[data-drag="true"] .dtn-task-actions{display:none}
.dtn-scroll[data-sorting="true"]{cursor:grabbing}
.dtn-measure{position:absolute;left:-10000px;top:0;width:340px;visibility:hidden;pointer-events:none;contain:layout style}
.dtn-measure .dtn-task-note{display:none}
.dtn-measure .dtn-scroll{overflow:visible;flex:none}
.dtn-measure-detail{position:absolute;left:-10000px;top:0;width:560px;visibility:hidden;pointer-events:none;contain:layout style}
.dtn-measure-detail .dtn-scroll{overflow:visible;flex:none}
.dtn-task{cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.dtn-task[data-state="awaiting"]{cursor:default}
.dtn-task[data-strike="true"]{cursor:default}
.dtn-task button,.dtn-task input,.dtn-task .dtn-confirm{cursor:default}

.dtn-task:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent)}
.dtn-task[data-state="awaiting"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.dtn-tick{position:relative;flex:none;width:17px;height:17px;margin-top:1px;border-radius:50%;cursor:pointer;padding:0;
  border:1.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 30%,transparent));
  background:transparent;color:transparent;display:grid;place-items:center;
  transition:border-color .18s ease,color .18s ease,transform .18s ease}
/* The circle stays small but the button under it is 28px across, so a hurried
   click near the edge still completes the row instead of starting a drag. */
.dtn-tick::after{content:"";position:absolute;left:50%;top:50%;width:28px;height:28px;transform:translate(-50%,-50%);border-radius:50%}
.dtn-tick:hover{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);transform:scale(1.1)}
.dtn-tick:active{transform:scale(.94)}
.dtn-main{flex:1;min-width:0}
.dtn-task-title{position:relative;display:inline-block;max-width:100%;word-break:break-word;transition:color .3s ease,opacity .3s ease}
.dtn-task[data-strike="true"] .dtn-task-title{color:var(--dsw-alias-label-secondary)}
.dtn-task-title::after{content:"";position:absolute;left:-2px;right:-2px;top:52%;height:1.4px;border-radius:1px;
  background:currentColor;transform:scaleX(0);transform-origin:left center;transition:transform .34s cubic-bezier(.4,0,.2,1)}
.dtn-task[data-strike="true"] .dtn-task-title::after{transform:scaleX(1)}
.dtn-task-note{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dtn-card[data-view="note"] .dtn-task-note{display:none}
.dtn-task-meta{display:flex;gap:6px;align-items:center;margin-top:3px;font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.8}
.dtn-task-actions{position:absolute;top:3px;right:3px;display:flex;gap:1px;padding:2px;border-radius:7px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,Canvas) 92%,transparent);
  box-shadow:0 1px 5px color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 14%,transparent);
  opacity:0;pointer-events:none;transition:opacity .16s ease}
.dtn-task:hover .dtn-task-actions,.dtn-task:focus-within .dtn-task-actions{opacity:1;pointer-events:auto}
.dtn-confirm{display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-top:5px;white-space:nowrap}
.dtn-confirm .dtn-icon{width:17px;height:17px;border-radius:5px}
.dtn-confirm-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-right:2px}
.dtn-btn{font:inherit;font-size:11px;line-height:1.5;border-radius:6px;padding:2px 9px;cursor:pointer;
  color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,Canvas) 80%,transparent);
  transition:border-color .16s ease,color .16s ease,background .16s ease,transform .12s ease}
.dtn-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dtn-btn:active{transform:scale(.96)}
.dtn-btn[data-tone="primary"]{color:var(--dsw-alias-brand-primary);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dtn-btn[data-tone="ghost"]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dtn-composer{display:flex;gap:4px;align-items:center;padding:7px 8px 9px;flex:none;
  border-top:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 12%,transparent));
  animation:dtn-composer-in .22s cubic-bezier(.22,1,.36,1) both}
@keyframes dtn-composer-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dtn-input{flex:1;min-width:0;font:inherit;font-size:12px;color:inherit;background:color-mix(in srgb,var(--dsw-alias-bg-base,Canvas) 55%,transparent);
  border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:5px 8px;outline:none;
  transition:border-color .18s ease,background .18s ease}
.dtn-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dtn-input:focus{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base,Canvas)}
.dtn-plan{padding:2px 8px 4px}
.dtn-plan-title{display:flex;align-items:baseline;gap:8px;justify-content:space-between;font-size:12px;font-weight:600}
.dtn-plan-pct{font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);font-size:12px}
.dtn-plan-sub{display:flex;justify-content:space-between;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dtn-progress{height:6px;border-radius:999px;margin:6px 0 6px;overflow:hidden;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary) 18%,transparent)}
.dtn-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);
  transition:width .5s cubic-bezier(.22,1,.36,1);box-shadow:0 0 7px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}
.dtn-timeline{position:relative;margin:6px 0 2px;padding-left:24px}
.dtn-timeline::before{content:'';position:absolute;left:7px;top:9px;bottom:9px;width:2px;border-radius:2px;
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 60%,transparent)}
@keyframes dtn-spin{to{transform:rotate(360deg)}}
.dtn-phase{position:relative;display:flex;gap:8px;align-items:flex-start;padding:4px 6px 4px 4px;border-radius:7px;font-size:12px;animation:dtn-row-in .3s ease both}
.dtn-phase:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.dtn-node{position:absolute;left:-24px;top:3px;width:16px;height:16px;border-radius:50%;flex:none;
  display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;line-height:1;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent);box-sizing:border-box}
.dtn-node[data-status="done"]{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}
.dtn-node[data-status="active"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.dtn-node[data-status="active"]::after{content:'';position:absolute;inset:-4px;border-radius:50%;
  border:1.5px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 75%,transparent);
  animation:dtn-spin 2.2s linear infinite}
.dtn-branch{position:relative;margin:1px 0 3px 2px;padding-left:20px;font-size:11.5px;
  color:color-mix(in srgb,var(--dtn-blue) 78%,var(--dsw-alias-label-primary));
  display:flex;gap:6px;align-items:flex-start}
.dtn-branch::before{content:'';position:absolute;left:2px;top:0;width:13px;height:11px;
  border-left:1.5px solid color-mix(in srgb,var(--dtn-blue) 72%,transparent);
  border-bottom:1.5px solid color-mix(in srgb,var(--dtn-blue) 72%,transparent);
  border-bottom-left-radius:6px}
.dtn-branch-title{flex:1;min-width:0;word-break:break-word}
.dtn-phase-body{flex:1;min-width:0}
.dtn-phase[data-status="done"] .dtn-phase-title{color:var(--dsw-alias-label-secondary);text-decoration:line-through;text-decoration-thickness:1px}
.dtn-phase[data-status="active"] .dtn-phase-title{font-weight:600}
.dtn-phase-status{font-size:10px;color:var(--dsw-alias-label-secondary);flex:none;margin-top:2px;opacity:.8}
.dtn-goal{display:flex;gap:7px;align-items:flex-start;padding:3px 6px;font-size:12px}
.dtn-goal-mark{flex:none;width:12px;color:var(--dsw-alias-state-success-primary);margin-top:2px;font-size:11px;text-align:center}
.dtn-goal[data-done="true"] .dtn-goal-text{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.dtn-done{display:flex;gap:7px;align-items:baseline;padding:3px 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.75}
.dtn-done-title{flex:1 1 auto;min-width:0;text-decoration:line-through;text-decoration-thickness:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtn-done-when{flex:none;font-size:10px;opacity:.8}
.dtn-empty{padding:14px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;opacity:.85}
.dtn-skeleton{height:9px;border-radius:5px;margin:9px 12px;
  background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent),
    color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent),
    color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent));
  background-size:220% 100%;animation:dtn-shimmer 1.4s ease-in-out infinite}
.dtn-status{flex:none;padding:0 12px 8px;font-size:10.5px;color:var(--dsw-alias-state-warn-primary);opacity:.9}
.dtn-ball-inner{position:relative;width:100%;height:100%;display:grid;place-items:center}
.dtn-ball-ring{position:absolute;inset:4px;transform:rotate(-90deg);pointer-events:none}
.dtn-ball-count{position:relative;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.dtn-ball-badge{position:absolute;top:-1px;right:-1px;min-width:14px;height:14px;border-radius:7px;padding:0 3px;
  display:grid;place-items:center;font-size:9.5px;font-weight:700;color:var(--dsw-alias-bg-base,Canvas);
  background:var(--dsw-alias-state-warn-primary);animation:dtn-pulse 2.2s ease-in-out infinite}
@keyframes dtn-row-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dtn-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
/* Fade only. The old keyframes forced max-height:80px at 0%, so a 31px row
   instantly grew to 80px and shoved every row below it down 26px before
   collapsing again - that was the "two jumps" on strike. The row now keeps its
   height while fading; when it is dropped the FLIP pass slides the rest up. */
/* Collapse in the same pass as the fade: the row keeps its measured height for
   the first half, then closes to zero, so the rows below follow it down instead
   of sitting still and then sliding when the ghost is dropped. */
@keyframes dtn-ghost{0%{opacity:1;height:var(--ghost-h,32px);padding-top:6px;padding-bottom:6px}
  38%{opacity:0;height:var(--ghost-h,32px);padding-top:6px;padding-bottom:6px}
  100%{opacity:0;height:0;padding-top:0;padding-bottom:0}}
@keyframes dtn-strike{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes dtn-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes dtn-land{0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cf7) 22%,transparent)}100%{background:transparent}}
@keyframes dtn-shimmer{0%{background-position:120% 0}100%{background-position:-20% 0}}
@media (prefers-reduced-motion:reduce){
  .dtn-card,.dtn-task,.dtn-btn,.dtn-icon,.dtn-tick,.dtn-task-title::after{transition-duration:.01ms!important;animation-duration:.01ms!important}
  .dtn-task,.dtn-phase,.dtn-fade,.dtn-skeleton{animation:none!important}
}
`

    // ------------------------------------------------------------- transport --
    function apiUrl(path) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : undefined
      const url = new URL(path, base || (typeof location !== 'undefined' ? location.href : 'http://127.0.0.1/'))
      const here = typeof location !== 'undefined' ? location.origin : undefined
      if (here && url.origin !== here) throw new Error('todo-note: refusing a cross-origin API call')
      return url.toString()
    }

    async function callApi(path, body) {
      const response = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload?.error?.message || `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload.value
    }

    // ---------------------------------------------------------------- prefs --
    function readPrefs() {
      const fallback = { view: 'note', x: null, y: null }
      try {
        const raw = window.localStorage.getItem(PREF_KEY)
        if (!raw) return fallback
        const parsed = JSON.parse(raw)
        const view = parsed && (parsed.view === 'ball' || parsed.view === 'detail') ? parsed.view : 'note'
        const x = Number.isFinite(parsed?.x) ? parsed.x : null
        const y = Number.isFinite(parsed?.y) ? parsed.y : null
        return { view, x, y }
      } catch {
        return fallback
      }
    }

    function writePrefs(prefs) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
      } catch {
        /* a full or blocked localStorage must not break the panel */
      }
    }

    function viewport() {
      return {
        w: typeof window === 'undefined' ? 1280 : window.innerWidth,
        h: typeof window === 'undefined' ? 800 : window.innerHeight,
      }
    }

    function sizeOf(view) {
      const { h: vh } = viewport()
      if (view === 'ball') return { w: 48, h: 48, radius: 24 }
      if (view === 'detail') return { w: 560, h: Math.max(360, Math.min(720, Math.round(vh * 0.82))), radius: 18 }
      return { w: 340, h: 364, radius: 16 }
    }

    function clampPos(x, y, size) {
      const { w, h } = viewport()
      const margin = 16
      return {
        x: Math.min(Math.max(margin, Math.round(x)), Math.max(margin, w - size.w - margin)),
        y: Math.min(Math.max(margin, Math.round(y)), Math.max(margin, h - size.h - margin)),
      }
    }

    function defaultPos(size) {
      const { w, h } = viewport()
      return clampPos(w - size.w - 24, Math.max(72, Math.round(h * 0.16)), size)
    }

    const SNAP = 44

    /** Grow/shrink away from whichever edge the card is resting on. */
    /**
     * Resize around the corner of the quadrant the card currently sits in:
     * top-left keeps x/y, top-right keeps the right edge, bottom-left keeps the
     * bottom edge, bottom-right keeps both far edges. The same rule runs for
     * growing and shrinking, so note -> ball -> note and note -> detail -> note
     * both land back on the exact same rectangle.
     */
    function anchoredPos(current, currentSize, targetSize) {
      const { w: vw, h: vh } = viewport()
      const rightSide = current.x + currentSize.w / 2 >= vw / 2
      const bottomSide = current.y + currentSize.h / 2 >= vh / 2
      const x = rightSide ? current.x + currentSize.w - targetSize.w : current.x
      const y = bottomSide ? current.y + currentSize.h - targetSize.h : current.y
      return clampPos(x, y, targetSize)
    }

    /** Let a released card click to the nearest edge instead of floating loose. */
    function snapPos(x, y, size) {
      const { w: vw, h: vh } = viewport()
      const margin = 16
      let nx = x
      let ny = y
      if (Math.abs(x - margin) <= SNAP) nx = margin
      else if (Math.abs(x + size.w - (vw - margin)) <= SNAP) nx = vw - size.w - margin
      if (Math.abs(y - margin) <= SNAP) ny = margin
      else if (Math.abs(y + size.h - (vh - margin)) <= SNAP) ny = vh - size.h - margin
      return clampPos(nx, ny, size)
    }

    // ----------------------------------------------------------------- hooks --
    /** The session whose seat is on screen, or undefined when none is. */
    function useMountedSession(ctx) {
      const [sessionId, setSessionId] = useState(() => readMounted(ctx))
      useEffect(() => {
        let unsubscribe = null
        const mounted = safeGet(ctx, 'sidebarRight')?.mounted
        if (mounted && typeof mounted.getSnapshot === 'function') {
          setSessionId(mounted.getSnapshot())
          if (typeof mounted.subscribe === 'function') {
            unsubscribe = mounted.subscribe(() => setSessionId(mounted.getSnapshot()))
          }
        } else {
          const list = safeGet(ctx, 'sessions')?.list
          if (list && typeof list.getSnapshot === 'function') {
            const read = () => {
              const snapshot = list.getSnapshot()
              const ids = snapshot && Array.isArray(snapshot.ids) ? snapshot.ids : []
              return ids.length === 1 ? ids[0] : undefined
            }
            setSessionId(read())
            if (typeof list.subscribe === 'function') unsubscribe = list.subscribe(() => setSessionId(read()))
          }
        }
        return () => {
          try {
            if (typeof unsubscribe === 'function') unsubscribe()
          } catch {
            /* a disposed feed must not throw during unmount */
          }
        }
      }, [ctx])
      return sessionId
    }

    function readMounted(ctx) {
      try {
        const mounted = safeGet(ctx, 'sidebarRight')?.mounted
        return typeof mounted?.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
      } catch {
        return undefined
      }
    }

    function useTodoNote(sessionId) {
      const [state, setState] = useState({ note: null, status: 'idle', error: '' })
      const versionRef = useRef(-1)
      const [generation, setGeneration] = useState(0)

      useEffect(() => {
        if (!sessionId) {
          versionRef.current = -1
          setState({ note: null, status: 'idle', error: '' })
          return undefined
        }
        let alive = true
        let timer = 0
        versionRef.current = -1
        setState({ note: null, status: 'loading', error: '' })

        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
        const schedule = (delay) => {
          timer = window.setTimeout(loop, delay)
        }
        const loop = async () => {
          if (!alive) return
          try {
            const value = await callApi(API_GET, { sessionId, since: versionRef.current })
            if (!alive) return
            if (value && value.unchanged) {
              setState((previous) => (previous.status === 'ready' ? previous : { ...previous, status: 'ready' }))
            } else if (value && value.note) {
              versionRef.current = Number(value.version) || 0
              setState({ note: value.note, status: 'ready', error: '' })
            }
            schedule(hidden() ? POLL_HIDDEN : POLL_VISIBLE)
          } catch (error) {
            if (!alive) return
            setState((previous) => ({
              note: previous.note,
              status: previous.note ? 'ready' : 'error',
              error: String(error?.message || error),
            }))
            schedule(POLL_FAILED)
          }
        }
        const onVisibility = () => {
          if (hidden()) return
          window.clearTimeout(timer)
          loop()
        }
        loop()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          window.clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [sessionId, generation])

      const mutate = useCallback(
        async (action) => {
          if (!sessionId) throw new Error('todo-note: no session')
          const value = await callApi(API_ACT, { sessionId, action })
          if (value && value.note) {
            versionRef.current = Number(value.version) || 0
            setState({ note: value.note, status: 'ready', error: '' })
          }
          return value
        },
        [sessionId],
      )

      const reload = useCallback(() => setGeneration((n) => n + 1), [])
      return { note: state.note, status: state.status, error: state.error, mutate, reload }
    }

    // ------------------------------------------------------------------ icons --
    function svg(props, children) {
      return h(
        'svg',
        {
          width: props.size ?? 14,
          height: props.size ?? 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth ?? 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        children,
      )
    }

    const IconExpand = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M6 2H2v4' }),
        h('path', { key: 'b', d: 'M10 14h4v-4' }),
        h('path', { key: 'c', d: 'M2 2l5 5' }),
        h('path', { key: 'd', d: 'M14 14l-5-5' }),
      ])

    const IconCollapse = (props) =>
      svg(props, [
        h('path', { key: 'a', d: 'M2 6h4V2' }),
        h('path', { key: 'b', d: 'M14 10h-4v4' }),
        h('path', { key: 'c', d: 'M6 6L2 2' }),
        h('path', { key: 'd', d: 'M10 10l4 4' }),
      ])

    const IconMinimize = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M3 8h10' })])

    const IconCheck = (props) => svg(props, [h('path', { key: 'a', d: 'M3 8.5l3.2 3.2L13 5' })])

    const IconPlus = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M8 3v10' }), h('path', { key: 'b', d: 'M3 8h10' })])

    const IconClose = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M4 4l8 8' }), h('path', { key: 'b', d: 'M12 4l-8 8' })])

    const IconPause = (props) =>
      svg(props, [h('path', { key: 'a', d: 'M5.5 3.5v9' }), h('path', { key: 'b', d: 'M10.5 3.5v9' })])

    const IconPlay = (props) => svg(props, [h('path', { key: 'a', d: 'M5 3.5l7 4.5-7 4.5z' })])

    // ----------------------------------------------------------- subcomponents --
    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dtn-icon',
          title: props.title,
          'aria-label': props.title,
          'data-nodrag': 'true',
          'data-tone': props.tone,
          'data-shape': props.shape,
          disabled: Boolean(props.disabled),
          onClick: props.onClick,
        },
        props.children,
      )
    }

    function FocusBlock({ focus, t }) {
      const current = focus?.current || ''
      const next = focus?.next || ''
      return h(
        'div',
        { className: 'dtn-focus' },
        h(
          'div',
          { className: 'dtn-focus-row', 'data-kind': 'now' },
          h('span', { className: 'dtn-focus-key' }, t('now')),
          h('span', { className: 'dtn-focus-val', 'data-empty': String(!current), title: current }, current || t('noFocus')),
        ),
        next
          ? h(
              'div',
              { className: 'dtn-focus-row', 'data-kind': 'next' },
                  h('span', { className: 'dtn-focus-key' }, t('next')),
              h('span', { className: 'dtn-focus-val', title: next }, next),
            )
          : null,
      )
    }

    function TaskRow({ task, index, ghost, ghostHeight, showNote, sortable, landed, dragRow, t, onConfirm, onReject, onShelve, onRemove, onDragStart, measuring }) {
      const awaiting = task.state === 'awaiting'
      const shelved = task.state === 'shelved'
      const inert = ghost || shelved || measuring || dragRow
      return h(
        'div',
        {
          className: 'dtn-task',
          'data-state': task.state,
          'data-task-id': measuring ? undefined : task.id,
          'data-strike': ghost ? 'true' : 'false',
          'data-ghost': ghost ? 'true' : 'false',
          'data-sortable': sortable ? 'true' : undefined,
          'data-land': landed ? 'true' : undefined,
          'data-drag': dragRow ? 'true' : undefined,
          'data-measuring': measuring ? 'true' : undefined,
          'aria-hidden': measuring ? 'true' : undefined,
          style: {
            ...(ghost && ghostHeight ? { '--ghost-h': `${ghostHeight}px` } : null),
          },
          onPointerDown: inert || !sortable ? undefined : (event) => onDragStart(event, task, index),
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dtn-tick',
            title: t('confirm'),
            'aria-label': t('confirm'),
            onClick: () => onConfirm(task, index),
          },
          h(IconCheck, { size: 11, strokeWidth: 2 }),
        ),
        h(
          'div',
          { className: 'dtn-main' },
          h('div', { className: 'dtn-task-title' }, task.title),
          awaiting
            ? h(
                'div',
                { className: 'dtn-confirm' },
                h('span', { className: 'dtn-confirm-hint' }, t('confirmHint')),
                h(
                  IconButton,
                  { title: t('confirm'), tone: 'primary', onClick: () => onConfirm(task, index) },
                  h(IconCheck, { size: 11, strokeWidth: 2.2 }),
                ),
                h(IconButton, { title: t('reject'), onClick: () => onReject(task) }, h(IconClose, { size: 10, strokeWidth: 1.8 })),
              )
            : null,
          showNote && task.note ? h('div', { className: 'dtn-task-note' }, task.note) : null,
        ),
        h(
          'div',
          { className: 'dtn-task-actions' },
          h(
            IconButton,
            { title: shelved ? t('unshelve') : t('shelve'), onClick: () => onShelve(task) },
            h(shelved ? IconPlay : IconPause, { size: 12 }),
          ),
          h(IconButton, { title: t('remove'), onClick: () => onRemove(task) }, h(IconClose, { size: 12 })),
        ),
      )
    }

    function Composer({ t, onAdd, onClose }) {
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)
      const inputRef = useRef(null)
      useEffect(() => {
        const node = inputRef.current
        if (node) node.focus()
      }, [])
      const submit = async () => {
        const title = value.trim()
        if (!title || busy) return
        setBusy(true)
        try {
          await onAdd(title)
          setValue('')
          onClose()
        } catch {
          /* the parent surfaces the error line */
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'dtn-composer', 'data-nodrag': 'true' },
        h('input', {
          ref: inputRef,
          className: 'dtn-input',
          value,
          placeholder: t('addPlaceholder'),
          'aria-label': t('add'),
          maxLength: 200,
          onChange: (event) => setValue(event.target.value),
          onBlur: (event) => {
            // Clicking away with nothing typed should drop the composer; a
            // half-written draft stays until the ✗ button clears it.
            const next = event.relatedTarget
            if (next && next.closest && next.closest('.dtn-composer')) return
            if (value.trim() === '') window.setTimeout(() => onClose(), 120)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            } else if (event.key === 'Escape') {
              setValue('')
              onClose()
            }
          },
        }),
        h(IconButton, { title: t('add'), tone: 'primary', disabled: busy, onClick: submit }, h(IconCheck, { size: 13, strokeWidth: 2 })),
        h(IconButton, { title: t('cancel'), onClick: onClose }, h(IconClose, { size: 12 })),
      )
    }

    // Reordering helpers shared by the drag preview and the optimistic commit.
    // `index` counts the rows *without* the dragged one, which is also the
    // splice index, so preview and drop agree on the same slot.
    function moveToIndex(list, id, index) {
      const from = list.findIndex((task) => task.id === id)
      if (from < 0) return list
      const rest = list.slice()
      const [item] = rest.splice(from, 1)
      const target = Math.max(0, Math.min(index, rest.length))
      rest.splice(target, 0, item)
      return rest
    }

    function moveBefore(list, id, beforeId) {
      if (!beforeId) return moveToIndex(list, id, list.length - 1)
      const from = list.findIndex((task) => task.id === id)
      if (from < 0) return list
      const rest = list.slice()
      rest.splice(from, 1)
      const at = rest.findIndex((task) => task.id === beforeId)
      if (at < 0) return list
      rest.splice(at, 0, list[from])
      return rest
    }

    /**
     * The slot a lifted row belongs in, given the midpoints of the rows still in
     * the list and the vertical center of the floating row. Mids are measured
     * in the *compact* layout (the slot removed), otherwise moving the slot
     * would move the very midpoints it is compared against and the preview
     * would oscillate between two rows.
     */
    function resolveDrop(midpoints, center) {
      for (let i = 0; i < midpoints.length; i += 1) {
        if (center < midpoints[i]) return i
      }
      return midpoints.length
    }

    /**
     * Same decision as resolveDrop, but the slot only moves once the pointer is
     * `margin` past the boundary it just crossed. A hand resting near a row's
     * midpoint otherwise toggles the slot several times a second, and every
     * toggle sets the whole list in motion — that is the twitching.
     */
    function stablePreview(current, midpoints, center, margin) {
      const raw = resolveDrop(midpoints, center)
      if (raw === current) return raw
      const slack = margin > 0 ? margin : 0
      if (raw > current) {
        const edge = midpoints[current]
        if (typeof edge === 'number' && center < edge + slack) return current
      } else {
        const edge = midpoints[current - 1]
        if (typeof edge === 'number' && center > edge - slack) return current
      }
      return raw
    }

    function linkedNote(note) {
  if (!note || typeof note !== 'object') return false
  if (Number(note.linkedAt) > 0) return true
  const focus = note.focus && typeof note.focus === 'object' ? note.focus : {}
  if (String(focus.current ?? '').trim() || String(focus.next ?? '').trim()) return true
  if (Array.isArray(note.tasks) && note.tasks.length > 0) return true
  const plan = note.plan && typeof note.plan === 'object' ? note.plan : {}
  if (Array.isArray(plan.phases) && plan.phases.length > 0) return true
  if (Array.isArray(plan.goals) && plan.goals.length > 0) return true
  return false
}

function mergedRows(tasks, striking) {
      const rows = tasks.map((task, index) => ({ key: task.id, task, index, ghost: false }))
      for (const entry of striking) {
        const at = Math.min(Math.max(0, entry.index), rows.length)
        rows.splice(at, 0, { key: `${entry.task.id}:ghost`, task: entry.task, index: at, ghost: true, height: entry.height })
      }
      return rows
    }

    function PlanBlock({ plan, t, tasks }) {
      const phases = Array.isArray(plan?.phases) ? plan.phases : []
      const goals = Array.isArray(plan?.goals) ? plan.goals : []
      const weightOf = (phase) => {
        const value = Number(phase?.weight)
        return Number.isFinite(value) && value > 0 ? Math.min(5, Math.max(0.5, value)) : 1
      }
      const total = phases.reduce((sum, phase) => sum + weightOf(phase), 0)
      const done = phases.filter((phase) => phase.status === 'done').reduce((sum, phase) => sum + weightOf(phase), 0)
      const percent = total > 0 ? Math.round((done / total) * 100) : 0
      const doneCount = phases.filter((phase) => phase.status === 'done').length
      const parked = (Array.isArray(tasks) ? tasks : []).filter((task) => task.state === 'shelved')
      const fallbackPhase = phases.find((phase) => phase.status === 'active')
        ?? phases.find((phase) => phase.status !== 'done')
        ?? phases[phases.length - 1]
      const shelvedFor = (phase) => parked.filter((task) => (task.phaseId ? task.phaseId === phase.id : phase === fallbackPhase))

      if (phases.length === 0 && goals.length === 0 && !plan?.title) {
        return h('div', { className: 'dtn-empty' }, t('noPlan'))
      }
      return h(
        'div',
        { className: 'dtn-plan' },
        h(
          'div',
          { className: 'dtn-plan-title' },
          h('span', null, plan?.title || t('plan')),
          h('span', { className: 'dtn-plan-pct' }, `${percent}%`),
        ),
        h('div', { className: 'dtn-progress' }, h('div', { className: 'dtn-progress-fill', style: { width: `${percent}%` } })),
        h(
          'div',
          { className: 'dtn-plan-sub' },
          h('span', null, t('phaseCount', { done: doneCount, total: phases.length })),
          plan?.title ? h('span', null, t('progress')) : null,
        ),
        h(
          'div',
          { className: 'dtn-timeline' },
          ...phases.map((phase, index) => {
            const branches = shelvedFor(phase)
            return h(
              'div',
              { key: phase.id || phase.title, className: 'dtn-phase', 'data-status': phase.status },
              h('span', { className: 'dtn-node', 'data-status': phase.status, 'aria-hidden': 'true' }, String(index + 1)),
              h(
                'div',
                { className: 'dtn-phase-body' },
                h('div', { className: 'dtn-phase-title' }, phase.title),
                ...branches.map((task) =>
                  h(
                    'div',
                    { key: task.id, className: 'dtn-branch', 'data-shelved': 'true', title: task.note || task.title },
                    h(IconPause, { size: 10 }),
                    h('span', { className: 'dtn-branch-title' }, task.title),
                  ),
                ),
              ),
              h(
                'span',
                { className: 'dtn-phase-status' },
                phase.status === 'done' ? t('phaseDone') : phase.status === 'active' ? t('phaseActive') : t('phaseTodo'),
              ),
            )
          }),
        ),
        goals.length > 0
          ? h('div', { className: 'dtn-section' }, t('goals'))
          : null,
        ...goals.map((goal) =>
          h(
            'div',
            { key: goal.id || goal.text, className: 'dtn-goal', 'data-done': String(goal.done === true) },
            h('span', { className: 'dtn-goal-mark' }, goal.done ? '✓' : '○'),
            h('span', { className: 'dtn-goal-text' }, goal.text),
          ),
        ),
      )
    }

    function RecentBlock({ log, t }) {
      const items = Array.isArray(log) ? log.slice(0, 6) : []
      if (items.length === 0) return null
      return h(
        'div',
        null,
        h('div', { className: 'dtn-section' }, t('recent')),
        ...items.map((entry) =>
          h(
            'div',
            { key: entry.id, className: 'dtn-done' },
            h('span', { className: 'dtn-done-title', title: entry.title }, entry.title),
            h('span', { className: 'dtn-done-when' }, ago(entry.doneAt, t)),
          ),
        ),
      )
    }

    function ago(timestamp, t) {
      const then = Number(timestamp) || 0
      if (!then) return ''
      const delta = Date.now() - then
      if (delta < 60_000) return t('justNow')
      const minutes = Math.round(delta / 60_000)
      if (minutes < 60) return t('minutesAgo', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('hoursAgo', { n: hours })
      return new Date(then).toLocaleDateString()
    }

    function BallContent({ note, t }) {
      const tasks = Array.isArray(note?.tasks) ? note.tasks : []
      const open = tasks.filter((task) => task.state === 'active' || task.state === 'awaiting').length
      const awaiting = tasks.filter((task) => task.state === 'awaiting').length
      const phases = Array.isArray(note?.plan?.phases) ? note.plan.phases : []
      const total = phases.reduce((sum, phase) => sum + (Number(phase.weight) || 1), 0)
      const done = phases.filter((phase) => phase.status === 'done').reduce((sum, phase) => sum + (Number(phase.weight) || 1), 0)
      const percent = total > 0 ? Math.round((done / total) * 100) : 0
      const radius = 19
      const circumference = 2 * Math.PI * radius
      return h(
        'div',
        { className: 'dtn-ball-inner', title: t('openIcon') },
        h(
          'svg',
          { className: 'dtn-ball-ring', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
          h('circle', {
            cx: 24,
            cy: 24,
            r: radius,
            fill: 'none',
            stroke: 'var(--dsw-alias-border-l1, color-mix(in srgb, CanvasText 14%, transparent))',
            strokeWidth: 3,
          }),
          h('circle', {
            cx: 24,
            cy: 24,
            r: radius,
            fill: 'none',
            stroke: 'var(--dsw-alias-brand-primary, currentColor)',
            strokeWidth: 3,
            strokeLinecap: 'round',
            strokeDasharray: `${circumference}`,
            strokeDashoffset: `${circumference * (1 - percent / 100)}`,
            style: { transition: 'stroke-dashoffset .5s cubic-bezier(.22,1,.36,1)' },
          }),
        ),
        h('span', { className: 'dtn-ball-count' }, open > 0 ? String(open) : '✓'),
        awaiting > 0 ? h('span', { className: 'dtn-ball-badge' }, awaiting) : null,
      )
    }

    // ------------------------------------------------------------------ panel --
    function createPanel(ctx) {
      const t = createTranslator(ctx)

      function TodoPanel() {
        const sessionId = useMountedSession(ctx)
        const [prefs, setPrefs] = useState(readPrefs)
        const [striking, setStriking] = useState([])
        const [dragging, setDragging] = useState(false)
        const [position, setPosition] = useState(() => {
          const stored = readPrefs()
          const initial = sizeOf(stored.view)
          return stored.x === null || stored.y === null ? defaultPos(initial) : clampPos(stored.x, stored.y, initial)
        })
        const [composerOpen, setComposerOpen] = useState(false)
        const [linking, setLinking] = useState(false)
        const linkFailedRef = useRef('')
        const noteAnchor = useRef(null)
        const [noteHeight, setNoteHeight] = useState(null)
        // The detail view is content-sized too: it only grows to its ceiling
        // when the plan, the tasks and the recent log actually need the room.
        const [detailHeight, setDetailHeight] = useState(null)
        const detailMeasureRef = useRef(null)
        const cardRef = useRef(null)
        const dragRef = useRef(null)
        const timersRef = useRef([])
        const noteApi = useTodoNote(sessionId)
        const note = noteApi.note

        // One-shot escape hatch: ask the agent to link this session right now.
        const linkNow = useCallback(async () => {
          if (linking || !sessionId) return
          setLinking(true)
          linkFailedRef.current = ''
          try {
            const sessions = ctx.get('sessions')
            const scope = sessions?.scope?.(sessionId)
            const conversation = scope?.get?.('conversation') ?? scope?.conversation ?? ctx.get('conversation')
            if (!conversation || typeof conversation.send !== 'function') throw new Error('conversation service unavailable')
            await conversation.send(t('linkPrompt'))
          } catch (error) {
            linkFailedRef.current = t('linkFailed')
            console.warn('[todo-note] link request failed', error)
          } finally {
            setLinking(false)
          }
        }, [ctx, linking, sessionId, t])

        const view = prefs.view
        const sizeNow = useCallback(
          (which) => {
            const base = sizeOf(which)
            if (which === 'note' && noteHeight) return { ...base, h: noteHeight }
            if (which === 'detail' && detailHeight) return { ...base, h: detailHeight }
            return base
          },
          [detailHeight, noteHeight],
        )
        const size = sizeNow(view)

        // One source of truth: the rendered position; the stored copy follows it.

        // A smaller viewport must not swallow the panel.
        useEffect(() => {
          const onResize = () => {
            setPosition((previous) => (previous ? clampPos(previous.x, previous.y, sizeOf(view)) : previous))
          }
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [view])

        useEffect(
          () => () => {
            for (const timer of timersRef.current) window.clearTimeout(timer)
            timersRef.current = []
          },
          [],
        )

        useEffect(() => {
          if (!position) return
          writePrefs({ view, x: position.x, y: position.y })
        }, [position, view])

        const persist = useCallback((patch) => {
          setPrefs((previous) => ({ ...previous, ...patch }))
        }, [])

        // Height of the note body measured from the off-screen twin, which is
        // always laid out at the note width. Measuring at the moment of the
        // switch means the card animates straight to its final height instead
        // of collapsing to a stale value and correcting itself afterwards.
        const noteHeightNow = useCallback(() => {
          const box = measureRef.current
          if (!box) return null
          const focusEl = box.querySelector('.dtn-focus')
          const focusH = focusEl ? Math.ceil(focusEl.getBoundingClientRect().height) : 0
          const scroll = box.querySelector('.dtn-scroll')
          let content = headHRef.current + focusH
          if (scroll) {
            const style = getComputedStyle(scroll)
            const boxPad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
            content += Array.from(scroll.children).reduce((total, child) => {
              const childStyle = getComputedStyle(child)
              return total + child.getBoundingClientRect().height
                + (parseFloat(childStyle.marginTop) || 0) + (parseFloat(childStyle.marginBottom) || 0)
            }, boxPad)
          }
          const ceiling = Math.min(Math.max(200, Math.round(viewport().h * 0.82)), 420)
          return Math.min(Math.max(120, content + 2), ceiling)
        }, [])

        // Same trick for the detail view: measure the off-screen 560px twin
        // before the switch, so the card opens at its content height directly.
        const detailHeightNow = useCallback(() => {
          const box = detailMeasureRef.current
          if (!box) return null
          const focusEl = box.querySelector('.dtn-focus')
          const focusH = focusEl ? Math.ceil(focusEl.getBoundingClientRect().height) : 0
          const scroll = box.querySelector('.dtn-scroll')
          let content = 0
          if (scroll) {
            const style = getComputedStyle(scroll)
            const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
            content = Array.from(scroll.children).reduce((total, child) => {
              const childStyle = getComputedStyle(child)
              return total + child.getBoundingClientRect().height
                + (parseFloat(childStyle.marginTop) || 0) + (parseFloat(childStyle.marginBottom) || 0)
            }, pad)
          }
          const ceiling = Math.min(Math.max(240, Math.round(viewport().h * 0.82)), 720)
          return Math.min(Math.max(220, Math.ceil(headHRef.current + focusH + content + 2)), ceiling)
        }, [])

        const changeView = useCallback(
          (next) => {
            const target = sizeNow(next)
            if (next === 'note') {
              const measured = noteHeightNow()
              if (measured) setNoteHeight((value) => (value === measured ? value : measured))
            }
            if (next === 'detail') {
              const measured = detailHeightNow()
              if (measured) setDetailHeight((value) => (value === measured ? value : measured))
            }
            setPosition((previous) => {
              const current = previous ?? defaultPos(sizeNow(view))
              // The quadrant anchor round-trips unless clamp had to move a card
              // that no longer fits; coming home then restores the exact corner.
              if (next === 'note' && noteAnchor.current) {
                const parked = noteAnchor.current
                noteAnchor.current = null
                return clampPos(parked.x, parked.y, target)
              }
              if (view === 'note') noteAnchor.current = { x: current.x, y: current.y }
              return anchoredPos(current, sizeNow(view), target)
            })
            setComposerOpen(false)
            persist({ view: next })
          },
          [detailHeightNow, noteHeightNow, persist, sizeNow, view],
        )

        const resetPosition = useCallback(() => {
          setPosition(defaultPos(sizeOf(view)))
        }, [persist, view])

        // ------ drag: the card is moved by writing left/top straight to the
        // DOM, so it tracks the pointer 1:1. The previous transform follow kept
        // the card's .2s transform transition alive; on release the hover scale
        // and the left/top transition both started from the drag offset, so the
        // ball overshot and wobbled before settling. Now the final position is
        // written to the DOM before transitions come back: the only optional
        // motion after release is one monotonic glide into the snapped edge.
        const dragSettle = useRef(null)
        const cancelDragMotion = (card) => {
          if (!card || typeof card.getAnimations !== 'function') return
          for (const animation of card.getAnimations()) {
            if (animation.id === 'dtn-drag-settle') animation.cancel()
          }
        }
        const onPointerDown = useCallback(
          (event) => {
            if (event.button !== 0 && event.pointerType === 'mouse') return
            if (event.target && event.target.closest && event.target.closest('[data-nodrag]')) return
            const base = position ?? defaultPos(sizeOf(view))
            dragRef.current = {
              id: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              baseX: base.x,
              baseY: base.y,
              x: base.x,
              y: base.y,
              moved: false,
            }
            const card = cardRef.current
            cancelDragMotion(card)
            if (card) card.style.transform = ''
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              /* capture is a nicety; the window listeners still work */
            }
            setDragging(true)
          },
          [position, view],
        )

        const onPointerMove = useCallback(
          (event) => {
            const drag = dragRef.current
            if (!drag || drag.id !== event.pointerId) return
            const dx = event.clientX - drag.startX
            const dy = event.clientY - drag.startY
            if (!drag.moved && Math.hypot(dx, dy) < 4) return
            drag.moved = true
            const card = cardRef.current
            if (!card) return
            // Move the layer, not the layout: writing left/top every frame
            // repaints the text inside and reads as the content shivering.
            // Whole pixels matter too: a fractional offset re-rasterises the
            // text at a new subpixel origin on every frame.
            card.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`
          },
          [size],
        )

        const onPointerUp = useCallback(
          (event) => {
            const drag = dragRef.current
            if (!drag || drag.id !== event.pointerId) return
            dragRef.current = null
            const card = cardRef.current
            if (!drag.moved) {
              setDragging(false)
              if (view === 'ball') changeView('note')
              return
            }
            const dropped = clampPos(
              Math.round(drag.baseX + (event.clientX - drag.startX)),
              Math.round(drag.baseY + (event.clientY - drag.startY)),
              size,
            )
            // The ball is left exactly where it was dropped: edge snapping is
            // what made a 48px dot jump under the cursor. Wider shapes keep a
            // soft snap, but the offset is small and the glide is monotonic.
            const landed = view === 'ball' ? dropped : snapPos(dropped.x, dropped.y, size)
            const dx = dropped.x - landed.x
            const dy = dropped.y - landed.y
            if (card) {
              card.style.left = `${landed.x}px`
              card.style.top = `${landed.y}px`
              card.style.transform = dx || dy ? `translate3d(${dx}px, ${dy}px, 0)` : ''
            }
            setPosition(landed)
            dragSettle.current = { card, dx, dy }
          },
          [changeView, size, view],
        )

        // Release: transitions stay off for one more frame so the write above
        // cannot animate in from the old spot; then the card either sits still
        // (ball) or glides the few snapped pixels, once, without a bounce.
        useLayoutEffect(() => {
          const settle = dragSettle.current
          if (!settle) return
          dragSettle.current = null
          const card = settle.card && settle.card.isConnected ? settle.card : cardRef.current
          const dx = settle.dx || 0
          const dy = settle.dy || 0
          const release = () => {
            setDragging(false)
            if (!card) return
            if (!dx && !dy) {
              card.style.transform = ''
              return
            }
            const animation = card.animate(
              [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
              { duration: 140, easing: 'cubic-bezier(.2,.8,.2,1)' },
            )
            animation.id = 'dtn-drag-settle'
            animation.onfinish = () => {
              card.style.transform = ''
            }
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(release)
          else release()
        })

        // ------------------------------------------------------------ actions
        const strike = useCallback((task, index, height) => {
          setStriking((list) => [...list.filter((entry) => entry.task.id !== task.id), { task, index, height }])
          const timer = window.setTimeout(() => {
            setStriking((list) => list.filter((entry) => entry.task.id !== task.id))
            timersRef.current = timersRef.current.filter((candidate) => candidate !== timer)
          }, STRIKE_MS)
          timersRef.current.push(timer)
        }, [])

        const confirmTask = useCallback(
          (task, index) => {
            if (!task || task.id === undefined) return
            const node = cardRef.current ? cardRef.current.querySelector(`.dtn-task[data-task-id="${task.id}"]`) : null
            const height = node ? Math.round(node.getBoundingClientRect().height) : null
            strike(task, index, height)
            noteApi.mutate({ type: 'confirm_task', id: task.id }).catch(() => {})
          },
          [noteApi, strike],
        )

        const rejectTask = useCallback(
          (task) => {
            noteApi.mutate({ type: 'reject_task', id: task.id }).catch(() => {})
          },
          [noteApi],
        )

        const shelveTask = useCallback(
          (task) => {
            noteApi
              .mutate({ type: 'update_task', id: task.id, state: task.state === 'shelved' ? 'active' : 'shelved' })
              .catch(() => {})
          },
          [noteApi],
        )

        const removeTask = useCallback(
          (task) => {
            noteApi.mutate({ type: 'remove_task', id: task.id }).catch(() => {})
          },
          [noteApi],
        )

        // ------ drag to reorder: the list order *is* the priority order, so
        // dragging a row up is how the user promotes it. The row is lifted into
        // a fixed, top-most proxy, a dashed slot marks exactly where it will
        // land, and the rows around it re-flow as the pointer crosses them.
        // Pointer events live on `window`: the row leaves the list while
        // dragging, so row-bound handlers would stop receiving the moves that
        // finish the drag (that was the "cannot drop where I want" bug).
        const measureRef = useRef(null)
        const headHRef = useRef(44)
        const [taskDrag, setTaskDrag] = useState(null)
        const taskDragRef = useRef(null)
        const dragScrollRef = useRef(null)
        const [pendingMove, setPendingMove] = useState(null)
        const [landedId, setLandedId] = useState(null)

        const startTaskDrag = useCallback((event, task, index) => {
          if (event.button !== 0 && event.pointerType === 'mouse') return
          if (taskDragRef.current) return
          const target = event.target
          if (target && target.closest && target.closest('button,input,.dtn-confirm,.dtn-task-actions')) return
          // Stop the browser from starting a text selection under the row.
          event.preventDefault()
          const node = event.currentTarget
          const rect = node.getBoundingClientRect()
          const drag = {
            id: task.id,
            title: task.title,
            index,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            pointerY: event.clientY,
            // Where the pointer grabbed the row: the proxy keeps this offset,
            // so the row stays under the cursor exactly where it was picked up.
            grabOffset: event.clientY - rect.top,
            preview: index,
            active: false,
            height: rect.height,
            width: rect.width,
            mids: [],
            scrollBox: null,
            raf: null,
            lastMove: 0,
            probedAt: 0,
            detach: null,
          }
          taskDragRef.current = drag

          // Midpoints are read once, in the compact layout (the lifted row
          // removed), and kept in scroll-content coordinates. Autoscroll and
          // the row moving in the list are folded in arithmetically, so the
          // targets can never chase the slot they are compared against - that
          // feedback loop is what made the old preview jitter.
          const sampleMids = () => {
            const scroll = dragScrollRef.current
            drag.mids = []
            drag.scrollBox = scroll ? scroll.getBoundingClientRect() : null
            drag.startScroll = scroll ? scroll.scrollTop : 0
            if (!scroll || !drag.scrollBox) return
            let past = false
            for (const child of Array.from(scroll.children)) {
              if (!child.matches || !child.matches('.dtn-task[data-task-id][data-sortable="true"]')) continue
              if (child.dataset.taskId === drag.id) {
                past = true
                continue
              }
              const box = child.getBoundingClientRect()
              drag.mids.push(box.top + box.height / 2 - drag.scrollBox.top + drag.startScroll - (past ? drag.height : 0))
            }
          }

          const previewAt = () => {
            const scroll = dragScrollRef.current
            if (!scroll || !drag.scrollBox || drag.mids.length === 0) return drag.preview
            const center = drag.pointerY - drag.scrollBox.top + scroll.scrollTop + drag.height / 2 - drag.grabOffset
            // A quarter of a row of slack: enough that a hand hovering on a
            // midpoint cannot flip the slot, small enough that a real move
            // still feels immediate.
            return stablePreview(drag.preview, drag.mids, center, drag.height * 0.28)
          }

          const tick = () => {
            drag.raf = null
            if (!drag.active || taskDragRef.current !== drag) return
            const scroll = dragScrollRef.current
            if (scroll) {
              const box = scroll.getBoundingClientRect()
              const edge = 28
              const push = (distance) => Math.min(10, 3 + distance / 3)
              if (drag.pointerY < box.top + edge) scroll.scrollTop -= push(box.top + edge - drag.pointerY)
              else if (drag.pointerY > box.bottom - edge) scroll.scrollTop += push(drag.pointerY - (box.bottom - edge))
            }
            // The slot decision is sampled at ~18Hz: rescanning the list on
            // every pointer sample is what made the preview chase its own tail
            // at the row boundaries.
            const now = performance.now()
            if (now - drag.probedAt < 55) return
            drag.probedAt = now
            const preview = previewAt()
            if (preview === drag.preview) return
            drag.preview = preview
            setTaskDrag((previous) =>
              previous && previous.active
                ? { ...previous, preview, dy: drag.pointerY - drag.startY }
                : previous,
            )
          }

          const finish = (commit) => {
            if (taskDragRef.current !== drag) return
            taskDragRef.current = null
            if (drag.raf != null) cancelAnimationFrame(drag.raf)
            detach()
            let beforeId = null
            if (commit && drag.active) {
              // The preview is sampled at ~18Hz, so take one last reading here:
              // a fast flick can end between two samples.
              drag.preview = previewAt()
              const slot = cardRef.current ? cardRef.current.querySelector('.dtn-task[data-drag="true"]') : null
              for (let node = slot ? slot.nextElementSibling : null; node; node = node.nextElementSibling) {
                if (node.matches && node.matches('.dtn-task[data-task-id][data-sortable="true"]')) {
                  beforeId = node.dataset.taskId
                  break
                }
              }
            }
            const moved = commit && drag.active && drag.preview !== drag.index
            setTaskDrag(null)
            if (moved) setLandedId(drag.id)
            if (!moved) return
            // One optimistic reorder: the row lands in the slot it was dropped
            // on, so the list never snaps back before the server answers.
            setPendingMove({ id: drag.id, beforeId })
            noteApi
              .mutate({ type: 'move_task', id: drag.id, beforeId })
              .then(() => setPendingMove(null))
              .catch(() => setPendingMove(null))
          }

          const onMove = (event) => {
            if (event.pointerId !== drag.pointerId) return
            // The pointer was released while the cursor was outside the window
            // (or the app lost focus): no pointerup ever arrives, so a move with
            // no button held is the release we missed. Without this the dashed
            // slot stayed on screen for good and the row looked deleted.
            if (drag.active && event.buttons === 0) {
              finish(true)
              return
            }
            drag.pointerY = event.clientY
            drag.lastMove = performance.now()
            if (!drag.active) {
              if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return
              sampleMids()
              drag.active = true
              setTaskDrag({
                id: drag.id,
                title: drag.title,
                index: drag.index,
                preview: drag.index,
                active: true,
                dy: drag.pointerY - drag.startY,
                height: drag.height,
                width: drag.width,
              })
            }
            if (drag.raf == null) drag.raf = requestAnimationFrame(tick)
          }
          const onUp = (event) => {
            if (event.pointerId !== drag.pointerId) return
            finish(true)
          }
          const onCancel = (event) => {
            if (event.pointerId !== drag.pointerId) return
            finish(false)
          }
          const onKey = (event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            finish(false)
          }
          // A drag whose pointer release was swallowed (window lost focus, the
          // pointer left the app, a stray touch cancel) would otherwise leave the
          // list in "sorting" for good. Any new press on the page means that
          // drag is over, so settle it first.
          const onForeignDown = () => {
            if (performance.now() - drag.lastMove > 220) finish(false)
          }
          const onBlur = () => finish(false)
          const onHidden = () => {
            if (document.hidden) finish(false)
          }
          const detach = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            window.removeEventListener('pointercancel', onCancel)
            window.removeEventListener('keydown', onKey)
            window.removeEventListener('blur', onBlur)
            window.removeEventListener('pointerdown', onForeignDown, true)
            document.removeEventListener('visibilitychange', onHidden)
          }
          drag.detach = detach

          window.addEventListener('pointermove', onMove, { passive: true })
          window.addEventListener('pointerup', onUp)
          window.addEventListener('pointercancel', onCancel)
          window.addEventListener('keydown', onKey)
          window.addEventListener('blur', onBlur)
          window.addEventListener('pointerdown', onForeignDown, true)
          document.addEventListener('visibilitychange', onHidden)
        }, [noteApi])

        // A drag that is still attached when the panel unmounts must not leave
        // window listeners behind.
        useEffect(
          () => () => {
            const drag = taskDragRef.current
            taskDragRef.current = null
            if (drag && drag.detach) drag.detach()
          },
          [],
        )

        // A live drag whose row vanished (a poll dropped it, the user rejected
        // or shelved it) can never be dropped, so the dashed slot would stay
        // forever. Clear it as soon as the row is gone.
        useEffect(() => {
          if (!taskDrag || !note) return
          const tasks = Array.isArray(note.tasks) ? note.tasks : []
          if (tasks.some((task) => task.id === taskDrag.id)) return
          const drag = taskDragRef.current
          taskDragRef.current = null
          if (drag && drag.detach) drag.detach()
          setTaskDrag(null)
        }, [taskDrag, note])

        // FLIP: remember each row's top, and whenever the order changes let the
        // rows that moved slide into place instead of teleporting.
        //
        // Two rules keep this calm:
        //  - any animation still running is cancelled *before* measuring, or the
        //    next pass would measure a position in mid-flight and animate from
        //    there, which makes a fast drag look like the list is shaking;
        //  - while a row is being sorted the rows glide a little quicker (140ms
        //    instead of 210ms) so the dashed slot does not outrun them.
        const rowTops = useRef(new Map())
        const rowAnims = useRef(new WeakMap())
        useLayoutEffect(() => {
          const card = cardRef.current
          if (!card) return
          const nodes = Array.from(card.querySelectorAll('.dtn-task[data-task-id]'))
          const seen = new Set()
          for (const node of nodes) {
            const id = node.dataset.taskId
            seen.add(id)
            const running = rowAnims.current.get(node)
            if (running) {
              running.cancel()
              rowAnims.current.delete(node)
            }
            if (node.dataset.dragging === 'true') {
              rowTops.current.delete(id)
              continue
            }
            const top = node.getBoundingClientRect().top
            const previous = rowTops.current.get(id)
            const delta = previous == null ? 0 : previous - top
            if (Math.abs(delta) > 1 && Math.abs(delta) <= 160) {
              const animation = node.animate(
                [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
                { duration: sorting ? 140 : 210, easing: 'cubic-bezier(.22,1,.36,1)' },
              )
              rowAnims.current.set(node, animation)
            }
            rowTops.current.set(id, top)
          }
          for (const id of Array.from(rowTops.current.keys())) {
            if (!seen.has(id)) rowTops.current.delete(id)
          }
        })

        const addTask = useCallback(
          async (title) => {
            await noteApi.mutate({ type: 'add_task', title, by: 'user' })
          },
          [noteApi],
        )

        const loaded = Boolean(note)
        const tasks = Array.isArray(note?.tasks) ? note.tasks : []
        const strikingIds = new Set(striking.map((entry) => entry.task.id))
        const sorting = Boolean(taskDrag && taskDrag.active)
        let openTasks = tasks.filter((task) => task.state !== 'shelved' && !strikingIds.has(task.id))
        // While sorting, the lifted row is not in the list at all: it lives in
        // the fixed proxy and a dashed slot of the same height takes its place.
        // The list keeps the same total height through the whole drag, so the
        // rows around the slot never re-flow when the finger lifts - that
        // re-flow was the second animation the drop used to play.
        if (sorting) openTasks = openTasks.filter((task) => task.id !== taskDrag.id)
        else if (pendingMove) openTasks = moveBefore(openTasks, pendingMove.id, pendingMove.beforeId)
        const rows = mergedRows(openTasks, striking)
        let slotAt = -1
        if (sorting) {
          slotAt = rows.length
          let seen = 0
          for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].ghost) continue
            if (seen === taskDrag.preview) {
              slotAt = i
              break
            }
            seen += 1
          }
        }
        const linkedNow = linkedNote(note)
        const activeCount = tasks.filter((task) => task.state === 'active').length
        const awaitingCount = tasks.filter((task) => task.state === 'awaiting').length
        const shelvedTasks = tasks.filter((task) => task.state === 'shelved')

        // `sortIndex` is the row's position among the rows that can be sorted
        // (struck rows are transient ghosts). The drag preview is expressed in
        // the same number, so the first computed slot is where the row started.
        // The row that just landed keeps a soft highlight for a moment so the
        // drop reads as "it went there" instead of a silent teleport.
        useEffect(() => {
          if (!landedId) return undefined
          const timer = setTimeout(() => setLandedId(null), 380)
          return () => clearTimeout(timer)
        }, [landedId])

        const renderRow = (row, sortIndex) =>
          h(TaskRow, {
            key: row.key,
            task: row.task,
            index: sortIndex,
            ghost: row.ghost,
            ghostHeight: row.height,
            showNote: view === 'detail',
            sortable: !row.ghost,
            t,
            onConfirm: confirmTask,
            onReject: rejectTask,
            onShelve: shelveTask,
            onRemove: removeTask,
            onDragStart: startTaskDrag,
            landed: row.task.id === landedId,
          })
        // The lifted row is rendered in the list itself, at the slot it would
        // land on. It stays a plain row - same type scale, same caps, a frame
        // around the row body - so the drop position reads from the layout
        // instead of from a card floating over the list.
        const draggedRow = sorting && taskDrag ? tasks.find((task) => task.id === taskDrag.id) : null
        const slotNode =
          draggedRow
            ? h(TaskRow, {
                key: 'dragging',
                task: draggedRow,
                index: taskDrag.preview,
                ghost: false,
                showNote: false,
                sortable: false,
                dragRow: true,
                t,
                onConfirm: noop,
                onReject: noop,
                onShelve: noop,
                onRemove: noop,
                onDragStart: noop,
              })
            : null
        let compact = 0
        const listNodes = rows.flatMap((row, at) => {
          const node = renderRow(row, row.ghost ? -1 : compact)
          if (!row.ghost) compact += 1
          return at === slotAt && slotNode ? [slotNode, node] : [node]
        })
        if (slotNode && slotAt >= rows.length) listNodes.push(slotNode)

        // The note sizes itself to its content. Height is summed from the parts
        // instead of measuring the card itself: `scrollHeight` never drops below
        // `clientHeight`, so a stretched scroll box would lock the note at its
        // tallest height forever. While the width is still animating (ball ->
        // note), the text wraps into far more lines than it will settle on, so
        // wait for the target width before trusting a measurement.
        useLayoutEffect(() => {
          const card = cardRef.current
          if (!card) return
          let frames = 0
          let raf = 0
          const apply = () => {
            const source = view === 'note' ? cardRef.current : measureRef.current
            if (!source) return
            const head = cardRef.current?.querySelector('.dtn-head')
            if (head) headHRef.current = Math.ceil(head.getBoundingClientRect().height)
            const focusEl = source.querySelector('.dtn-focus')
            const focusH = focusEl ? Math.ceil(focusEl.getBoundingClientRect().height) : 0
            const scroll = source.querySelector('.dtn-scroll')
            let scrollContent = 0
            if (scroll) {
              const style = getComputedStyle(scroll)
              const box = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
              scrollContent = Array.from(scroll.children).reduce((total, child) => {
                const childStyle = getComputedStyle(child)
                return total + child.getBoundingClientRect().height
                  + (parseFloat(childStyle.marginTop) || 0) + (parseFloat(childStyle.marginBottom) || 0)
              }, box)
            }
            const composerEl = view === 'note' ? cardRef.current?.querySelector('.dtn-composer') : null
            const composerH = composerEl ? Math.ceil(composerEl.getBoundingClientRect().height) : 0
            const content = headHRef.current + focusH + Math.ceil(scrollContent) + composerH
            const ceiling = Math.min(Math.max(200, Math.round(viewport().h * 0.82)), 420)
            const next = Math.min(Math.max(120, content + 2), ceiling)
            setNoteHeight((value) => (value === next ? value : next))

            // Detail: content-sized as well, with 82vh (capped at 720px) as the
            // ceiling rather than a fixed height. `scrollHeight` of the scroll
            // box is the content height, and `scrollbar-gutter:stable` keeps the
            // wrap width constant so a scrollbar appearing cannot bounce it.
            const detailSource = view === 'detail' ? cardRef.current : detailMeasureRef.current
            if (detailSource) {
              const detailFocus = detailSource.querySelector('.dtn-focus')
              const detailFocusH = detailFocus ? Math.ceil(detailFocus.getBoundingClientRect().height) : 0
              const detailScroll = detailSource.querySelector('.dtn-scroll')
              // Same trap as the note: `scrollHeight` never drops below the
              // stretched `clientHeight`, so sum the children instead.
              let detailContent = 0
              if (detailScroll) {
                const detailStyle = getComputedStyle(detailScroll)
                const detailPad = (parseFloat(detailStyle.paddingTop) || 0) + (parseFloat(detailStyle.paddingBottom) || 0)
                detailContent = Array.from(detailScroll.children).reduce((total, child) => {
                  const childStyle = getComputedStyle(child)
                  return total + child.getBoundingClientRect().height
                    + (parseFloat(childStyle.marginTop) || 0) + (parseFloat(childStyle.marginBottom) || 0)
                }, detailPad)
              }
              const detailComposer = view === 'detail' ? cardRef.current?.querySelector('.dtn-composer') : null
              const detailComposerH = detailComposer ? Math.ceil(detailComposer.getBoundingClientRect().height) : 0
              const detailCeiling = Math.min(Math.max(240, Math.round(viewport().h * 0.82)), 720)
              const detailNext = Math.min(
                Math.max(220, Math.ceil(headHRef.current + detailFocusH + detailContent + detailComposerH + 2)),
                detailCeiling,
              )
              setDetailHeight((value) => (value === detailNext ? value : detailNext))
            }
          }
          if (view !== 'note' && view !== 'detail') {
            apply()
            return undefined
          }
          const targetWidth = sizeNow(view).w
          const measure = () => {
            const width = cardRef.current ? cardRef.current.getBoundingClientRect().width : targetWidth
            if (Math.abs(width - targetWidth) > 1.5 && frames < 90) {
              frames += 1
              raf = requestAnimationFrame(measure)
              return
            }
            apply()
          }
          measure()
          return () => cancelAnimationFrame(raf)
        }, [view, note, rows.length, composerOpen])

        if (!sessionId) return null

        const cardHeight = view === 'note' && !noteHeight ? 'auto' : `${size.h}px`
        const rootStyle = position
          ? { left: `${position.x}px`, top: `${position.y}px`, width: `${size.w}px`, height: cardHeight, borderRadius: `${size.radius}px` }
          : { visibility: 'hidden', width: `${size.w}px`, height: cardHeight }

        const card = h(
          'div',
          {
            ref: cardRef,
            className: 'dtn-card',
            'data-view': view,
            'data-measured': noteHeight ? 'true' : 'false',
            'data-dragging': String(dragging),
            style: rootStyle,
            role: 'complementary',
            'aria-label': t('title'),
            onPointerDown: view === 'ball' ? onPointerDown : undefined,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
          },
          view === 'ball'
            ? h(BallContent, { note, t })
            : h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dtn-head', onPointerDown, onDoubleClick: resetPosition, title: t('openIcon') },
                  h(
                    IconButton,
                    {
                      title: t('add'),
                      tone: composerOpen ? 'primary' : undefined,
                      shape: 'circle',
                      onClick: () => setComposerOpen((open) => !open),
                    },
                    h(IconPlus, { size: 13 }),
                  ),
                  h('span', { className: 'dtn-title' }, view === 'detail' ? t('titleDetail') : t('title')),
                  h(
                    'span',
                    { className: 'dtn-chips' },
                    loaded && !linkedNow
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dtn-chip dtn-link',
                            'data-tone': 'idle',
                            title: linkFailedRef.current || t('unlinkedHint'),
                            disabled: linking,
                            onClick: linkNow,
                          },
                          linking ? t('linking') : t('unlinked'),
                        )
                      : null,
                    loaded && linkedNow && activeCount > 0
                      ? h('span', { className: 'dtn-chip' }, t('taskCount', { n: activeCount }))
                      : null,
                    loaded && awaitingCount > 0
                      ? h('span', { className: 'dtn-chip', 'data-tone': 'warn' }, awaitingCount)
                      : null,
                  ),
                  h(
                    'span',
                    { className: 'dtn-actions' },
                    h(IconButton, { title: t('toBall'), onClick: () => changeView('ball') }, h(IconMinimize, { size: 13 })),
                    view === 'note'
                      ? h(IconButton, { title: t('expand'), onClick: () => changeView('detail') }, h(IconExpand, { size: 13 }))
                      : h(IconButton, { title: t('collapse'), onClick: () => changeView('note') }, h(IconCollapse, { size: 13 })),
                  ),
                ),
                h(
                  'div',
                  { key: `body-${view}`, className: 'dtn-fade', style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
                  h(FocusBlock, { focus: note?.focus, t }),
                  h(
                    'div',
                    { className: 'dtn-scroll', ref: dragScrollRef, 'data-sorting': sorting ? 'true' : undefined },
                    !loaded
                      ? [h('div', { key: 's1', className: 'dtn-skeleton' }), h('div', { key: 's2', className: 'dtn-skeleton', style: { width: '70%' } }), h('div', { key: 's3', className: 'dtn-skeleton', style: { width: '85%' } })]
                      : listNodes.length === 0
                        ? h('div', { className: 'dtn-empty' }, t('empty'))
                        : listNodes,
                    view === 'detail' && shelvedTasks.length > 0
                      ? [
                          h('div', { key: 'shelved', className: 'dtn-section' }, t('shelved')),
                          ...shelvedTasks.map((task, index) =>
                            h(TaskRow, {
                              key: task.id,
                              task,
                              index: rows.length + index,
                              ghost: false,
                              showNote: false,
                              t,
                              onConfirm: confirmTask,
                              onReject: rejectTask,
                              onShelve: shelveTask,
                              onRemove: removeTask,
                              sortable: false,
                              onDragStart: () => {},
                            }),
                          ),
                        ]
                      : null,
                    view === 'detail' ? [h('div', { key: 'plan', className: 'dtn-section' }, t('plan')), h(PlanBlock, { key: 'planbody', plan: note?.plan, tasks: note?.tasks, t })] : null,
                    view === 'detail' ? h(RecentBlock, { log: note?.log, t }) : null,
                  ),
                  noteApi.error && noteApi.status !== 'ready'
                    ? h('div', { className: 'dtn-status' }, t('offline'))
                    : null,
                  composerOpen ? h(Composer, { t, onAdd: addTask, onClose: () => setComposerOpen(false) }) : null,
                ),
              ),
          // Off-screen twin of the note body at the note width. Measuring this
          // instead of the live card means the height is already correct before
          // a detail -> note transition starts, so the card shrinks in one move
          // instead of shrinking and then correcting itself.
          view === 'note'
            ? null
            : h(
                'div',
                { key: 'measure', className: 'dtn-measure', ref: measureRef, 'aria-hidden': 'true' },
                h(FocusBlock, { focus: note?.focus, t }),
                h(
                  'div',
                  { className: 'dtn-scroll' },
                  !loaded
                    ? null
                    : rows.filter((row) => !row.ghost).map((row) =>
                        h(TaskRow, {
                          key: `m-${row.key}`,
                          task: row.task,
                          index: row.index,
                          ghost: false,
                          showNote: false,
                          measuring: true,
                          t,
                          sortable: false,
                          onConfirm: noop,
                          onReject: noop,
                          onShelve: noop,
                          onRemove: noop,
                          onDragStart: noop,
                        }),
                      ),
                ),
              ),

          // Off-screen twin of the detail body at 560px: the detail view sizes
          // itself to its content, and measuring before the switch avoids an
          // expand-then-shrink in two steps.
          view === 'detail'
            ? null
            : h(
                'div',
                { key: 'measure-detail', className: 'dtn-measure-detail', ref: detailMeasureRef, 'aria-hidden': 'true' },
                h(FocusBlock, { focus: note?.focus, t }),
                h(
                  'div',
                  { className: 'dtn-scroll' },
                  rows.filter((row) => !row.ghost).map((row) =>
                    h(TaskRow, {
                      key: `d-${row.key}`,
                      task: row.task,
                      index: row.index,
                      ghost: false,
                      showNote: true,
                      measuring: true,
                      t,
                      sortable: false,
                      onConfirm: noop,
                      onReject: noop,
                      onShelve: noop,
                      onRemove: noop,
                      onDragStart: noop,
                    }),
                  ),
                  shelvedTasks.length > 0
                    ? [
                        h('div', { key: 'shelved', className: 'dtn-section' }, t('shelved')),
                        ...shelvedTasks.map((task, index) =>
                          h(TaskRow, {
                            key: `ds-${task.id}`,
                            task,
                            index: rows.length + index,
                            ghost: false,
                            showNote: false,
                            measuring: true,
                            t,
                            sortable: false,
                            onConfirm: noop,
                            onReject: noop,
                            onShelve: noop,
                            onRemove: noop,
                            onDragStart: noop,
                          }),
                        ),
                      ]
                    : null,
                  h('div', { key: 'plan', className: 'dtn-section' }, t('plan')),
                  h(PlanBlock, { key: 'planbody', plan: note?.plan, tasks: note?.tasks, t }),
                  h(RecentBlock, { key: 'recent', log: note?.log, t }),
                ),
              ),
        )

        return h('div', { className: 'dtn-layer' }, card)
      }

      return TodoPanel
    }

    // ------------------------------------------------------------------ apply --
    function injectStyle(ctx) {
      if (typeof document === 'undefined') return
      const mount = () => {
        const element = document.createElement('style')
        element.setAttribute('data-dsh-todo-note', 'styles')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => element.remove()
      }
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(mount, 'todo-note-styles')
      } else {
        mount()
      }
    }

    function apply(ctx) {
      injectStyle(ctx)
      const slots = safeGet(ctx, 'slots') || ctx.slots
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        try {
          console.error('[todo-note] the slot service is unavailable; the note stays hidden')
        } catch {
          /* no console is fine */
        }
        return
      }
      const TodoPanel = createPanel(ctx)
      slots.inject('shell.overlay', () =>
        slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-todo-note',
            order: 60,
            label: 'Todo note',
          },
          TodoPanel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.internals = Object.freeze({ mergedRows, moveToIndex, moveBefore, resolveDrop, stablePreview, sizeOf, clampPos, readPrefs, createTranslator })
    return module.exports
  },
})
